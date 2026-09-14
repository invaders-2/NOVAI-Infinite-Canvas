/* 触屏/手写笔 → 鼠标事件桥接（Pointer Events 承载层）
   画布交互（平移/拖节点/连线/框选）全部基于 mouse 事件实现。本层把 pointerdown/pointermove/pointerup
   规范化为现有逻辑能消费的合成事件，让同一份 mouse 处理器同时服务鼠标、触控板、触摸屏三类输入：
   - 鼠标：不干预（pointerType==='mouse' 直接放行，原生 mouse 事件直达画布处理器）；
   - 触控板：浏览器原生发 wheel（双指滚动）与 ctrl+wheel（捏合），直达画布 wheel 处理器，不经过本层；
   - 触屏/手写笔（本层职责）：
       单指/单笔 → mousedown/mousemove/mouseup(+click/dblclick)，拖节点/框选/平移画布与鼠标一致；
       双指捏合 → 带 ctrlKey 的 wheel（deltaY = -100·ln(间距比)，1:1 直接操纵），走画布已有的
                  "触控板捏合缩放"分支，缩放中心 = 双指中点；事件带 __novaTouchPinch 标记；
       双指拖动 → 无修饰 wheel（deltaX/deltaY = 中点位移，单次 ≤60px 分段，低于 isMouseWheel 的
                  100 阈值），走画布已有的"触控板双指平移"分支；事件带 __novaTouchPan 标记。
   Safari 兜底：iPad Safari 的捏合若触发 gesturestart/gesturechange，由画布自身的 gesture 处理器接管；
   本层在双指手势期间挂 window.__novaTouchGestureActive，画布 gesture 处理器见标记即跳过，避免双重缩放。
   规则：
   - 可编辑控件（input/textarea/select/contenteditable）与音视频上的触摸不转换，保留原生行为；
   - 位于可滚动容器内（项目列表、工具栏横向滚动、各面板）的触摸不转换，保留原生滚动和点按；
   - 监听用冒泡阶段：局部已有的 touch/pointer 处理 stopPropagation 后自然跳过桥接；
   - 无 Pointer Events 的老浏览器回退到 Touch Events 合成路径（行为与上一版一致）。 */
(function(){
    if(window.__touchMouseBridgeInstalled) return;
    window.__touchMouseBridgeInstalled = true;
    window.__novaTouchBridgeVersion = 2;

    const TAP_MOVE = 8;      // px，位移超过视为拖动，不再补发 click
    const TAP_TIME = 600;    // ms，按住超过视为长按拖动而非点击
    const DBL_TIME = 350;    // ms，两次点按间隔小于此发 dblclick
    const DBL_DIST = 32;     // px
    const PAN_MIN = 2;       // px，双指中点累积位移低于此不发平移（防抖）
    const PAN_CHUNK = 60;    // px，单次合成 wheel 的最大位移（必须低于 isMouseWheel 的 100 阈值）
    const PINCH_MIN_LOG = 0.004; // 捏合间距 log 比累积阈值（≈0.4% 缩放变化）
    const PINCH_DELTA_PER_LOG = 100; // 与画布 ctrl+wheel 分支 factor=exp(-deltaY*0.01) 互为逆运算

    /* —— shouldSkip 缓存机制 ——
       每次触摸都 getComputedStyle + scrollHeight/clientHeight 遍历祖先会触发强制布局重排，
       用 WeakMap 缓存每个元素的滚动状态，仅在首次访问和 resize 后重新计算。 */
    const scrollCache = new WeakMap();
    let cacheStamp = Date.now();

    window.addEventListener('resize', () => {
        cacheStamp = Date.now();
    }, { passive: true });

    function shouldSkip(target){
        if(!(target instanceof Element)) return true;
        if(target.closest('input, textarea, select, audio, video, [contenteditable=""], [contenteditable="true"]')) return true;
        let node = target;
        while(node && node !== document.body && node !== document.documentElement){
            let cached = scrollCache.get(node);
            if(!cached || cached.stamp !== cacheStamp){
                const cs = getComputedStyle(node);
                cached = {
                    stamp: cacheStamp,
                    scrollableY: /(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 1,
                    scrollableX: /(auto|scroll)/.test(cs.overflowX) && node.scrollWidth > node.clientWidth + 1
                };
                scrollCache.set(node, cached);
            }
            if(cached.scrollableY || cached.scrollableX) return true;
            node = node.parentElement;
        }
        return false;
    }

    function fire(type, x, y, opts = {}){
        const target = document.elementFromPoint(x, y) || opts.fallback || document.body;
        target.dispatchEvent(new MouseEvent(type, {
            bubbles: true, cancelable: true, composed: true, view: window,
            clientX: x, clientY: y,
            button: 0,
            buttons: opts.buttons || 0,
            detail: opts.detail || 1
        }));
    }

    function fireWheel(x, y, deltaX, deltaY, opts = {}){
        const target = document.elementFromPoint(x, y) || document.body;
        const ev = new WheelEvent('wheel', {
            bubbles: true, cancelable: true, composed: true, view: window,
            clientX: x, clientY: y,
            deltaX: deltaX, deltaY: deltaY, deltaMode: 0,
            ctrlKey: Boolean(opts.ctrlKey)
        });
        if(opts.pan) ev.__novaTouchPan = true;
        if(opts.pinch) ev.__novaTouchPinch = true;
        target.dispatchEvent(ev);
    }

    /* —— 手势状态 ——
       pointers：当前按下的 touch/pen 指针表；
       drag：单指拖拽（合成 mouse 事件）；pinch：双指手势（合成 wheel）；
       skipped：首个触点落在可滚动/可编辑区域时整段手势不桥接。 */
    const pointers = new Map();
    let drag = null;
    let pinch = null;
    let skipped = false;
    let lastTap = { time: 0, x: 0, y: 0 };

    function pinchFromPointers(){
        const pts = [...pointers.values()];
        if(pts.length < 2) return null;
        const a = pts[0], b = pts[1];
        return {
            d: Math.hypot(a.x - b.x, a.y - b.y),
            x: (a.x + b.x) / 2,
            y: (a.y + b.y) / 2
        };
    }

    function endPinch(){
        if(!pinch) return;
        pinch = null;
        window.__novaTouchGestureActive = false;
    }

    function resetIfIdle(){
        if(pointers.size === 0){
            skipped = false;
            drag = null;
            endPinch();
        }
    }

    function onPointerDown(e){
        if(e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if(pointers.size === 1){
            skipped = shouldSkip(e.target);
            if(skipped) return;
            drag = { id: e.pointerId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, time: Date.now(), moved: false, fallback: e.target };
            fire('mousedown', e.clientX, e.clientY, { buttons: 1, fallback: e.target });
            return;
        }
        if(pointers.size === 2){
            if(drag){ fire('mouseup', drag.x, drag.y, { fallback: drag.fallback }); drag = null; }
            if(skipped || shouldSkip(e.target)) return;
            pinch = Object.assign(pinchFromPointers(), { panAccX: 0, panAccY: 0, zoomAcc: 0 });
            window.__novaTouchGestureActive = true;
            return;
        }
        endPinch(); // 三指及以上：放弃手势
    }

    function onPointerMove(e){
        if(!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if(pinch && pointers.size >= 2){
            const now = pinchFromPointers();
            if(!now) return;
            // 捏合：间距 log 比 → ctrl+wheel（缩放中心 = 双指中点）
            if(pinch.d > 0 && now.d > 0){
                pinch.zoomAcc += Math.log(now.d / pinch.d);
                if(Math.abs(pinch.zoomAcc) >= PINCH_MIN_LOG){
                    fireWheel(now.x, now.y, 0, -pinch.zoomAcc * PINCH_DELTA_PER_LOG, { ctrlKey: true, pinch: true });
                    pinch.zoomAcc = 0;
                }
            }
            // 双指拖动：中点位移 → 无修饰 wheel（内容跟随手指）
            pinch.panAccX += now.x - pinch.x;
            pinch.panAccY += now.y - pinch.y;
            let guard = 0;
            while((Math.abs(pinch.panAccX) >= PAN_MIN || Math.abs(pinch.panAccY) >= PAN_MIN) && guard++ < 64){
                const cx = Math.sign(pinch.panAccX) * Math.min(Math.abs(pinch.panAccX), PAN_CHUNK);
                const cy = Math.sign(pinch.panAccY) * Math.min(Math.abs(pinch.panAccY), PAN_CHUNK);
                fireWheel(now.x, now.y, -cx, -cy, { pan: true });
                pinch.panAccX -= cx;
                pinch.panAccY -= cy;
            }
            pinch.d = now.d; pinch.x = now.x; pinch.y = now.y;
            return;
        }
        if(!drag || e.pointerId !== drag.id) return;
        drag.x = e.clientX; drag.y = e.clientY;
        if(Math.abs(e.clientX - drag.startX) > TAP_MOVE || Math.abs(e.clientY - drag.startY) > TAP_MOVE) drag.moved = true;
        fire('mousemove', e.clientX, e.clientY, { buttons: 1, fallback: drag.fallback });
    }

    function onPointerFinish(e, canceled){
        pointers.delete(e.pointerId);
        if(pinch){
            if(pointers.size < 2) endPinch();
            resetIfIdle();
            return; // 双指手势收尾不补 click
        }
        if(!drag || e.pointerId !== drag.id){ resetIfIdle(); return; }
        const d = drag;
        drag = null;
        fire('mouseup', e.clientX, e.clientY, { fallback: d.fallback });
        if(!canceled && !d.moved && Date.now() - d.time < TAP_TIME){
            fire('click', e.clientX, e.clientY, { fallback: d.fallback });
            const now = Date.now();
            if(now - lastTap.time < DBL_TIME && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < DBL_DIST){
                fire('dblclick', e.clientX, e.clientY, { detail: 2, fallback: d.fallback });
                lastTap = { time: 0, x: 0, y: 0 };
            } else {
                lastTap = { time: now, x: e.clientX, y: e.clientY };
            }
        }
        resetIfIdle();
    }

    if(window.PointerEvent){
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', e => onPointerFinish(e, false));
        document.addEventListener('pointercancel', e => onPointerFinish(e, true));
        /* 触摸默认行为抑制：preventDefault 掉 touchstart/touchmove，阻止页面滚动、捏合缩放与
           兼容鼠标事件补发，保证 pointer 事件流不被浏览器接管（html/body 已有 touch-action:none
           的页面上浏览器本就不会抢手势，这里是双保险，也兼容没设 touch-action 的页面）。 */
        document.addEventListener('touchstart', e => {
            if(!shouldSkip(e.target)) e.preventDefault();
        }, { passive: false });
        document.addEventListener('touchmove', e => {
            if(drag || pinch) e.preventDefault();
        }, { passive: false });
    } else {
        /* —— 回退路径：无 Pointer Events 的老浏览器，用 Touch Events 合成（旧版行为） —— */
        let tDrag = null;
        let tPinch = null;
        const PINCH_STEP = 0.06;

        function touchPinchState(touches){
            const a = touches[0], b = touches[1];
            return {
                d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
                x: (a.clientX + b.clientX) / 2,
                y: (a.clientY + b.clientY) / 2
            };
        }

        document.addEventListener('touchstart', e => {
            if(e.touches.length === 1){
                const t = e.touches[0];
                if(shouldSkip(e.target)) return;
                e.preventDefault();
                tDrag = { id: t.identifier, startX: t.clientX, startY: t.clientY, x: t.clientX, y: t.clientY, time: Date.now(), moved: false, fallback: e.target };
                fire('mousedown', t.clientX, t.clientY, { buttons: 1, fallback: e.target });
            } else if(e.touches.length === 2){
                if(tDrag){ fire('mouseup', tDrag.x, tDrag.y, { fallback: tDrag.fallback }); tDrag = null; }
                if(shouldSkip(e.target)) return;
                e.preventDefault();
                tPinch = Object.assign(touchPinchState(e.touches), { panAccX: 0, panAccY: 0, zoomAcc: 0 });
                window.__novaTouchGestureActive = true;
            } else {
                tPinch = null;
                window.__novaTouchGestureActive = false;
            }
        }, { passive: false });

        document.addEventListener('touchmove', e => {
            if(tPinch && e.touches.length >= 2){
                e.preventDefault();
                const now = touchPinchState(e.touches);
                if(tPinch.d > 0 && now.d > 0){
                    tPinch.zoomAcc += Math.log(now.d / tPinch.d);
                    if(Math.abs(tPinch.zoomAcc) >= PINCH_MIN_LOG){
                        fireWheel(now.x, now.y, 0, -tPinch.zoomAcc * PINCH_DELTA_PER_LOG, { ctrlKey: true, pinch: true });
                        tPinch.zoomAcc = 0;
                    }
                }
                tPinch.panAccX += now.x - tPinch.x;
                tPinch.panAccY += now.y - tPinch.y;
                let guard = 0;
                while((Math.abs(tPinch.panAccX) >= PAN_MIN || Math.abs(tPinch.panAccY) >= PAN_MIN) && guard++ < 64){
                    const cx = Math.sign(tPinch.panAccX) * Math.min(Math.abs(tPinch.panAccX), PAN_CHUNK);
                    const cy = Math.sign(tPinch.panAccY) * Math.min(Math.abs(tPinch.panAccY), PAN_CHUNK);
                    fireWheel(now.x, now.y, -cx, -cy, { pan: true });
                    tPinch.panAccX -= cx;
                    tPinch.panAccY -= cy;
                }
                tPinch.d = now.d; tPinch.x = now.x; tPinch.y = now.y;
                return;
            }
            if(!tDrag) return;
            const t = [...e.touches].find(t => t.identifier === tDrag.id);
            if(!t) return;
            e.preventDefault();
            tDrag.x = t.clientX; tDrag.y = t.clientY;
            if(Math.abs(t.clientX - tDrag.startX) > TAP_MOVE || Math.abs(t.clientY - tDrag.startY) > TAP_MOVE) tDrag.moved = true;
            fire('mousemove', t.clientX, t.clientY, { buttons: 1, fallback: tDrag.fallback });
        }, { passive: false });

        function onTouchFinish(e){
            if(tPinch && e.touches.length < 2){ tPinch = null; window.__novaTouchGestureActive = false; }
            if(!tDrag) return;
            const t = [...e.changedTouches].find(t => t.identifier === tDrag.id);
            if(!t) return;
            const d = tDrag;
            tDrag = null;
            e.preventDefault();
            fire('mouseup', t.clientX, t.clientY, { fallback: d.fallback });
            if(e.type === 'touchcancel') return;
            if(!d.moved && Date.now() - d.time < TAP_TIME){
                fire('click', t.clientX, t.clientY, { fallback: d.fallback });
                const now = Date.now();
                if(now - lastTap.time < DBL_TIME && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < DBL_DIST){
                    fire('dblclick', t.clientX, t.clientY, { detail: 2, fallback: d.fallback });
                    lastTap = { time: 0, x: 0, y: 0 };
                } else {
                    lastTap = { time: now, x: t.clientX, y: t.clientY };
                }
            }
        }
        document.addEventListener('touchend', onTouchFinish, { passive: false });
        document.addEventListener('touchcancel', onTouchFinish, { passive: false });
    }
})();
