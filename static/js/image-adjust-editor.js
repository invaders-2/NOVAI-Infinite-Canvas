/* ════════════════════════════════════════════════════════════════
 * NOVAI 图片节点 · 专业调色（imageEditModal adjust 模式）
 * 传统画布(canvas.html/canvas.js) 与 智能画布(smart-canvas.html/smart-canvas.js) 共用。
 * 引擎：glfx.js（evanw，WebGL 实时滤镜，vendor/js/glfx.js）。
 * 布局：左侧图片（去框 + 左右拖动对比原图），右侧调色面板（设计系统 token）。
 * 入口：
 *   - HTML 模式按钮 data-image-edit-mode="adjust"
 *   - setImageEditMode 白名单加入 'adjust'（两端 js 已接线）
 *   - applyImageEdit 分发到 applyImageAdjust()（两端 js 已接线）
 *   - window.imageAdjust 桥接（两端 js 末尾提供 upload/addResult/finish/currentSource）
 * ════════════════════════════════════════════════════════════════ */
(function () {
    if (!document.getElementById('cropImage')) return;
    if (typeof fx === 'undefined' || typeof fx.canvas !== 'function') {
        console.warn('[image-adjust] glfx.js 未加载，调色不可用');
        return;
    }
    const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);
    const clamp01 = v => v < 0 ? 0 : (v > 1 ? 1 : v);
    const sliderOf = key => document.getElementById('adjustParam_' + key);
    const numOf = key => document.getElementById('adjustNum_' + key);
    const setStatus = (text) => { const el = document.getElementById('imageAdjustHint'); if (el) el.textContent = text || ''; };

    /* ── 参数元数据（映射到 glfx 滤镜）── */
    const SLIDERS = [
        { key: 'brightness', label: '亮度',       icon: 'bolt',          group: 'light',  min: -100, max: 100 },
        { key: 'contrast',   label: '对比度',     icon: 'circle-dot',    group: 'light',  min: -100, max: 100 },
        { key: 'hue',        label: '色相',       icon: 'refresh-cw',    group: 'color',  min: -100, max: 100 },
        { key: 'saturation', label: '饱和度',     icon: 'paintbrush',    group: 'color',  min: -100, max: 100 },
        { key: 'vibrance',   label: '自然饱和度', icon: 'sparkles',      group: 'color',  min: -100, max: 100 },
        { key: 'sepia',      label: '复古',       icon: 'wand-sparkles', group: 'color',  min: 0,    max: 100 },
        { key: 'sharpen',    label: '锐化',       icon: 'scan',          group: 'detail', min: 0,    max: 100 },
        { key: 'denoise',    label: '降噪',       icon: 'layers',        group: 'detail', min: 0,    max: 100 },
        { key: 'vignette',   label: '晕影',       icon: 'circle',        group: 'effect', min: 0,    max: 100 },
        { key: 'grain',      label: '颗粒',       icon: 'dice-5',        group: 'effect', min: 0,    max: 100 },
        { key: 'softFocus',  label: '柔焦',       icon: 'cloud',         group: 'effect', min: 0,    max: 100 }
    ];

    const state = {
        active: false, busy: false, raf: 0,
        fxCanvas: null, fxTexture: null,
        curve: [{ x: 0, y: 0 }, { x: 0.25, y: 0.25 }, { x: 0.5, y: 0.5 }, { x: 0.75, y: 0.75 }, { x: 1, y: 1 }],
        curveActive: false, curvePoints: null,
        compareX: 0
    };

    /* ── 曲线点列表 → glfx curves 参数 ── */
    function syncCurve() {
        const isIdentity = state.curve.every((p, i) => Math.abs(p.y - p.x) < 0.002);
        state.curveActive = !isIdentity;
        state.curvePoints = state.curve.map(p => [p.x, p.y]);
    }

    /* ── 读取参数 ── */
    function readParams() {
        const p = {};
        for (const item of SLIDERS) p[item.key] = Number(sliderOf(item.key)?.value || 0) / 100;
        return p;
    }

    /* ── DOM / UI 初始化 ── */
    function buildTools() {
        if (document.getElementById('imageAdjustTools')) return;
        const stage = document.getElementById('imageEditStage');
        if (!stage) return;
        const wrap = document.createElement('div');
        wrap.className = 'image-edit-tools image-adjust-tools active';
        wrap.id = 'imageAdjustTools';

        /* 标题 + 右上角按钮 */
        const head = document.createElement('div'); head.className = 'adjust-panel-head';
        const title = document.createElement('span'); title.className = 'adjust-panel-title'; title.textContent = '调整';
        const headActions = document.createElement('div'); headActions.className = 'adjust-head-actions';
        const reset = document.createElement('button');
        reset.type = 'button'; reset.className = 'adjust-icon-btn'; reset.id = 'imageAdjustResetBtn'; reset.title = '重置全部参数';
        reset.innerHTML = '<i data-lucide="rotate-ccw"></i>';
        const close = document.createElement('button');
        close.type = 'button'; close.className = 'adjust-icon-btn'; close.title = '关闭';
        close.innerHTML = '<i data-lucide="x"></i>';
        headActions.appendChild(reset); headActions.appendChild(close);
        head.appendChild(title); head.appendChild(headActions);
        wrap.appendChild(head);

        /* Tabs（图标按钮，点击切换） */
        const tabs = document.createElement('div'); tabs.className = 'adjust-tabs';
        const groups = [
            ['light', '光线', 'circle'], ['color', '颜色', 'paintbrush'], ['curve', '曲线', 'sliders-horizontal'], ['detail', '细节', 'zap'], ['effect', '效果', 'sparkles']
        ];
        groups.forEach((g, idx) => {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'adjust-tab-btn' + (idx === 0 ? ' active' : '');
            b.dataset.adjustTab = g[0]; b.title = g[1];
            b.innerHTML = '<i data-lucide="' + g[2] + '"></i>';
            tabs.appendChild(b);
        });
        wrap.appendChild(tabs);

        /* 参数区（按 tab 分组，点击切换显示） */
        const area = document.createElement('div'); area.className = 'adjust-slider-area';
        const GROUP_NAMES = { light: '光线', color: '颜色', curve: '曲线', detail: '细节', effect: '效果' };
        const byGroup = {};
        for (const item of SLIDERS) (byGroup[item.group] = byGroup[item.group] || []).push(item);
        groups.forEach((g, idx) => {
            const col = document.createElement('div');
            col.className = 'adjust-sliders'; col.dataset.adjustPanel = g[0];
            col.style.display = idx === 0 ? 'flex' : 'none';
            const gtitle = document.createElement('div');
            gtitle.className = 'adjust-group-title'; gtitle.textContent = GROUP_NAMES[g[0]];
            col.appendChild(gtitle);
            if (g[0] === 'curve') {
                col.appendChild(buildCurvePanel());
            } else {
                for (const item of byGroup[g[0]]) {
                    const label = document.createElement('label');
                    const span = document.createElement('span'); span.textContent = item.label;
                    const range = document.createElement('input');
                    range.type = 'range'; range.min = item.min; range.max = item.max; range.step = '0.01'; range.value = '0';
                    range.id = 'adjustParam_' + item.key;
                    const num = document.createElement('input');
                    num.type = 'number'; num.min = item.min; num.max = item.max; num.step = '0.01'; num.value = '0.00';
                    num.id = 'adjustNum_' + item.key;
                    label.appendChild(span); label.appendChild(range); label.appendChild(num);
                    col.appendChild(label);
                }
            }
            area.appendChild(col);
        });
        wrap.appendChild(area);

        /* 右侧面板：与图片区并排（stage 保持可滚动，拖拽平移才能生效）*/
        let row = document.getElementById('imageAdjustRow');
        if (!row) {
            row = document.createElement('div');
            row.id = 'imageAdjustRow';
            row.className = 'adjust-row';
            stage.parentNode.insertBefore(row, stage);
            row.appendChild(stage);
        }
        row.appendChild(wrap);

        /* 事件：tab 切换 */
        wrap.querySelectorAll('[data-adjust-tab]').forEach(b => b.addEventListener('click', () => {
            wrap.querySelectorAll('[data-adjust-tab]').forEach(x => x.classList.toggle('active', x === b));
            wrap.querySelectorAll('[data-adjust-panel]').forEach(x => x.style.display = x.dataset.adjustPanel === b.dataset.adjustTab ? 'flex' : 'none');
        }));
        wrap.querySelectorAll('input[type="range"]').forEach(range => {
            const key = range.id.replace('adjustParam_', '');
            range.addEventListener('input', () => {
                const num = numOf(key); if (num) num.value = Number(range.value).toFixed(2);
                scheduleAdjustRender(false);
            });
        });
        wrap.querySelectorAll('input[type="number"]').forEach(num => {
            const key = num.id.replace('adjustNum_', '');
            const item = SLIDERS.find(s => s.key === key);
            num.addEventListener('input', () => {
                let v = parseFloat(num.value);
                if (isNaN(v)) return;
                v = clamp(v, item.min, item.max);
                const range = sliderOf(key); if (range) range.value = String(v);
                scheduleAdjustRender(false);
            });
            num.addEventListener('change', () => {
                let v = parseFloat(num.value);
                if (isNaN(v)) v = 0;
                v = clamp(Math.round(v * 100) / 100, item.min, item.max);
                num.value = v.toFixed(2);
            });
        });
        document.getElementById('imageAdjustResetBtn').addEventListener('click', resetAll);
        try { window.NovaUtils && window.NovaUtils.refreshIcons && window.NovaUtils.refreshIcons(); } catch (e) {}
    }

    /* ── 曲线编辑器面板（无预设）── */
    function buildCurvePanel() {
        const panel = document.createElement('div');
        panel.className = 'adjust-curve-panel';
        const canvas = document.createElement('canvas');
        canvas.id = 'adjustCurveCanvas'; canvas.className = 'adjust-curve-canvas';
        panel.appendChild(canvas);
        const reset = document.createElement('button');
        reset.type = 'button'; reset.className = 'image-edit-btn secondary'; reset.id = 'adjustCurveResetBtn';
        reset.innerHTML = '<span>重置曲线</span>';
        panel.appendChild(reset);
        return panel;
    }
    function initCurveEditor() {
        const canvas = document.getElementById('adjustCurveCanvas');
        if (!canvas || canvas._inited) return;
        canvas._inited = true;
        const PAD = 10, DPR = Math.max(1, window.devicePixelRatio || 1);
        const CSS_W = 250, CSS_H = 170;
        canvas.style.width = CSS_W + 'px'; canvas.style.height = CSS_H + 'px';
        canvas.width = CSS_W * DPR; canvas.height = CSS_H * DPR;
        const ctx = canvas.getContext('2d'); ctx.scale(DPR, DPR);
        const plot = () => ({ w: CSS_W - PAD * 2, h: CSS_H - PAD * 2, ox: PAD, oy: PAD });
        const toXY = pt => { const p = plot(); return { x: p.ox + pt.x * p.w, y: p.oy + (1 - pt.y) * p.h }; };
        const toNorm = (mx, my) => { const p = plot(); return { x: clamp01((mx - p.ox) / p.w), y: clamp01(1 - (my - p.oy) / p.h) }; };
        function draw() {
            const p = plot();
            const cs = getComputedStyle(document.documentElement);
            const curveColor = cs.getPropertyValue('--text-2').trim() || '#6e6e73';
            const gridColor = cs.getPropertyValue('--border-2').trim() || 'rgba(0,0,0,.12)';
            const diagColor = cs.getPropertyValue('--text-3').trim() || '#86868b';
            const pointFill = cs.getPropertyValue('--surface').trim() || '#ffffff';
            ctx.clearRect(0, 0, CSS_W, CSS_H);
            ctx.strokeStyle = gridColor; ctx.lineWidth = 1;
            for (let i = 1; i < 4; i++) {
                const x = p.ox + p.w * i / 4, y = p.oy + p.h * i / 4;
                ctx.beginPath(); ctx.moveTo(x, p.oy); ctx.lineTo(x, p.oy + p.h); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(p.ox, y); ctx.lineTo(p.ox + p.w, y); ctx.stroke();
            }
            ctx.strokeStyle = diagColor;
            ctx.beginPath(); ctx.moveTo(p.ox, p.oy + p.h); ctx.lineTo(p.ox + p.w, p.oy); ctx.stroke();
            ctx.strokeStyle = curveColor; ctx.lineWidth = 2; ctx.beginPath();
            const xs = state.curve.map(pt => pt.x), ys = state.curve.map(pt => pt.y);
            for (let i = 0; i <= 64; i++) {
                const x = i / 64; let seg = 0;
                for (let j = 0; j < 4; j++) { if (x >= xs[j] && x <= xs[j + 1]) { seg = j; break; } }
                const p0 = ys[Math.max(0, seg - 1)], p1 = ys[seg], p2 = ys[seg + 1], p3 = ys[Math.min(4, seg + 2)];
                const t = (x - xs[seg]) / (xs[seg + 1] - xs[seg]); const t2 = t * t, t3 = t2 * t;
                const y = clamp01((-0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3) * t3 + (p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3) * t2 + (-0.5 * p0 + 0.5 * p2) * t + p1);
                const pt = toXY({ x, y });
                if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
            }
            ctx.stroke();
            state.curve.forEach((pt, idx) => {
                const c = toXY(pt);
                ctx.beginPath(); ctx.arc(c.x, c.y, idx === 0 || idx === 4 ? 3 : 5, 0, Math.PI * 2);
                ctx.fillStyle = pointFill; ctx.fill();
                ctx.strokeStyle = curveColor; ctx.lineWidth = 2; ctx.stroke();
            });
        }
        canvas._draw = draw;
        let dragIndex = -1;
        canvas.addEventListener('pointerdown', e => {
            const rect = canvas.getBoundingClientRect();
            const mx = (e.clientX - rect.left) * (CSS_W / rect.width);
            const my = (e.clientY - rect.top) * (CSS_H / rect.height);
            let best = -1, bestD = 12;
            state.curve.forEach((pt, idx) => {
                if (idx === 0 || idx === 4) return;
                const c = toXY(pt); const d = Math.hypot(c.x - mx, c.y - my);
                if (d < bestD) { bestD = d; best = idx; }
            });
            if (best >= 0) { dragIndex = best; canvas.setPointerCapture(e.pointerId); }
        });
        canvas.addEventListener('pointermove', e => {
            if (dragIndex < 0) return;
            const rect = canvas.getBoundingClientRect();
            const mx = (e.clientX - rect.left) * (CSS_W / rect.width);
            const my = (e.clientY - rect.top) * (CSS_H / rect.height);
            state.curve[dragIndex].y = toNorm(mx, my).y;
            syncCurve(); draw(); scheduleAdjustRender(false);
        });
        canvas.addEventListener('pointerup', () => { dragIndex = -1; });
        canvas.addEventListener('pointercancel', () => { dragIndex = -1; });
        document.getElementById('adjustCurveResetBtn').addEventListener('click', resetCurve);
        draw();
    }
    function resetCurve() {
        state.curve = [{ x: 0, y: 0 }, { x: 0.25, y: 0.25 }, { x: 0.5, y: 0.5 }, { x: 0.75, y: 0.75 }, { x: 1, y: 1 }];
        syncCurve();
        const cv = document.getElementById('adjustCurveCanvas'); if (cv && cv._draw) cv._draw();
        scheduleAdjustRender(false);
    }

    /* ── 重置 ── */
    function resetSliders() {
        for (const item of SLIDERS) {
            const s = sliderOf(item.key); if (s) s.value = '0';
            const n = numOf(item.key); if (n) n.value = '0.00';
        }
    }
    function resetAll() {
        resetSliders();
        resetCurve();
        state.compareX = 0;
        updateCompare();
        scheduleAdjustRender(false);
    }

    /* ── 对比分割线（左右拖动对比原图）── */
    function ensureCompareDivider() {
        const holder = document.getElementById('cropCanvas');
        if (!holder) return;
        let div = document.getElementById('adjustCompareDivider');
        if (!div) {
            div = document.createElement('div');
            div.id = 'adjustCompareDivider';
            div.className = 'adjust-compare-divider';
            holder.appendChild(div);
            let dragging = false;
            div.addEventListener('pointerdown', e => {
                dragging = true; div.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation();
            });
            div.addEventListener('pointermove', e => {
                if (!dragging) return;
                const rect = holder.getBoundingClientRect();
                if (rect.width < 1) return;
                state.compareX = clamp01((e.clientX - rect.left) / rect.width) * 100;
                updateCompare();
            });
            div.addEventListener('pointerup', () => { dragging = false; });
            div.addEventListener('pointercancel', () => { dragging = false; });
        }
    }
    function updateCompare() {
        const cv = document.getElementById('imageAdjustCanvas');
        const div = document.getElementById('adjustCompareDivider');
        if (cv) cv.style.clipPath = state.compareX > 0 ? 'inset(0 0 0 ' + state.compareX + '%)' : 'none';
        if (div) {
            div.style.left = state.compareX + '%';
            div.style.opacity = state.compareX > 0 ? '1' : '.85';
        }
    }

    /* ── glfx 渲染 ── */
    function setupFxCanvas() {
        const img = document.getElementById('cropImage');
        if (!img || !img.naturalWidth) return;
        const maxSide = 1400;
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const off = document.createElement('canvas');
        off.width = w; off.height = h;
        off.getContext('2d').drawImage(img, 0, 0, w, h);
        if (!state.fxCanvas) state.fxCanvas = fx.canvas();
        if (state.fxTexture) state.fxTexture.destroy();
        state.fxTexture = state.fxCanvas.texture(off);
        state.fxCanvas.draw(state.fxTexture).update();
        const holder = document.getElementById('cropCanvas');
        if (holder && state.fxCanvas.parentNode !== holder) {
            state.fxCanvas.id = 'imageAdjustCanvas';
            state.fxCanvas.className = 'image-edit-canvas-adjust';
            holder.appendChild(state.fxCanvas);
        }
        ensureCompareDivider();
        updateCompare();
    }
    function applyFilters(c, p) {
        if (p.brightness !== 0 || p.contrast !== 0) c.brightnessContrast(p.brightness, p.contrast);
        if (p.hue !== 0 || p.saturation !== 0) c.hueSaturation(p.hue, p.saturation);
        if (p.vibrance !== 0) c.vibrance(p.vibrance);
        if (p.sepia > 0) c.sepia(p.sepia);
        if (state.curveActive && state.curvePoints) c.curves(state.curvePoints);
        if (p.denoise > 0) c.denoise(p.denoise * 20);
        if (p.sharpen > 0) c.unsharpMask(1 + p.sharpen * 6, p.sharpen * 1.6);
        if (p.vignette > 0) c.vignette(0.5, p.vignette);
        if (p.grain > 0) c.noise(p.grain * 0.5);
        if (p.softFocus > 0) c.lensBlur(2 + p.softFocus * 12, 0.25, 0);
    }
    function scheduleAdjustRender(force) {
        if (!state.active && !force) return;
        if (state.raf) return;
        state.raf = requestAnimationFrame(() => { state.raf = 0; renderAdjustPreview(); });
    }
    function renderAdjustPreview() {
        if (!state.active || !state.fxCanvas || !state.fxTexture) return;
        const p = readParams();
        const c = state.fxCanvas;
        c.draw(state.fxTexture);
        applyFilters(c, p);
        c.update();
    }

    /* ── 应用导出 ── */
    async function renderAndApplyOutput() {
        const img = document.getElementById('cropImage');
        if (!img || !img.naturalWidth) return null;
        const p = readParams();
        const fc = fx.canvas();
        let maxSide = 16384;
        try { const gl = fc.getContext('experimental-webgl') || fc.getContext('webgl'); if (gl) maxSide = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 16384; } catch (e) {}
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const off = document.createElement('canvas');
        off.width = w; off.height = h;
        off.getContext('2d').drawImage(img, 0, 0, w, h);
        const tex = fc.texture(off);
        fc.draw(tex);
        applyFilters(fc, p);
        fc.update();
        const out = document.createElement('canvas');
        out.width = w; out.height = h;
        out.getContext('2d').drawImage(fc, 0, 0, w, h);
        return await new Promise(resolve => out.toBlob(resolve, 'image/png'));
    }
    async function applyImageAdjust() {
        if (!state.active) { setStatus('当前不在调色模式'); return; }
        const base = currentBaseName();
        setStatus('正在生成调色结果…');
        let blob = null;
        try { blob = await renderAndApplyOutput(); } catch (e) { setStatus('调色渲染失败：' + (e && e.message ? e.message : String(e))); return; }
        if (!blob) { setStatus('调色渲染失败'); return; }
        let file = null;
        if (window.imageAdjust && typeof window.imageAdjust.upload === 'function') {
            file = await window.imageAdjust.upload(blob, base + '_adjust.png');
        }
        if (!file) { setStatus('图片上传失败，未能生成调色节点'); return; }
        if (window.imageAdjust && typeof window.imageAdjust.addResult === 'function') {
            await window.imageAdjust.addResult(file, false);
        }
        if (window.imageAdjust && typeof window.imageAdjust.finish === 'function') {
            window.imageAdjust.finish();
        }
    }

    /* ── 桥接适配 ── */
    function currentEditSource() {
        const img = document.getElementById('cropImage');
        const fallback = { url: (img && img.src) || '', name: 'image' };
        if (window.imageAdjust && typeof window.imageAdjust.currentSource === 'function') {
            try { const src = window.imageAdjust.currentSource(); if (src && src.url) return src; } catch (e) {}
        }
        return fallback;
    }
    function currentBaseName() {
        const s = currentEditSource();
        return String(s.name || 'image').replace(/\.[^.]+$/, '');
    }

    /* ── 模式进入/离开 ── */
    function enterAdjustMode() {
        buildTools();
        const _tools = document.getElementById('imageAdjustTools');
        if (_tools) _tools.classList.add('active');
        initCurveEditor();
        state.active = true;
        syncCurve();
        resetSliders();
        state.compareX = 0;
        try { setupFxCanvas(); }
        catch (e) { setStatus('WebGL 初始化失败，调色不可用：' + (e && e.message ? e.message : String(e))); state.fxCanvas = null; }
        updateCompare();
        scheduleAdjustRender(true);
    }
    function leaveAdjustMode() {
        state.active = false;
        const cv = document.getElementById('imageAdjustCanvas');
        if (cv) cv.style.visibility = '';
        if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; }
        const div = document.getElementById('adjustCompareDivider');
        if (div) div.remove();
        state.compareX = 0;
        /* 还原 DOM：把图片区从并排行里移回原位 */
        const row = document.getElementById('imageAdjustRow');
        if (row && row.parentNode) {
            const st = document.getElementById('imageEditStage');
            if (st) row.parentNode.insertBefore(st, row);
            row.remove();
        }
    }
    window.scheduleAdjustRender = function (force) { scheduleAdjustRender(!!force); };
    window.imageAdjustEnterMode = enterAdjustMode;
    window.imageAdjustLeaveMode = leaveAdjustMode;
    window.applyImageAdjust = applyImageAdjust;
    window.imageAdjustIsAdjustMode = () => state.active;
})();
