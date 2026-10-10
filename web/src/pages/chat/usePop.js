// 输入框里的几个弹层（模型 / 尺寸 / 思考强度）：Teleport 到 body，按触发按钮的位置 fixed 定位，
// 优先向上弹、上方放不下才向下（与旧 positionModelPicker 同一规则）；同一时间只开一个；点外面 / Esc 关闭。
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';

const activePop = ref('');
export const POP_Z = 2300;

export function placeNear(anchor, pop, opts = {}) {
    if (!anchor || !pop) return;
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const safe = 12, gap = opts.gap == null ? 6 : opts.gap;
    pop.style.maxHeight = '';
    const w = pop.offsetWidth;
    const h = pop.scrollHeight;
    const cap = opts.maxH || Math.round(vh * 0.7);
    const up = r.top - safe - gap, down = vh - r.bottom - safe - gap;
    let above = opts.prefer !== 'below';
    if ((above ? up : down) < Math.min(h, cap) && (above ? down : up) > (above ? up : down)) above = !above;
    const H = Math.max(96, Math.min(h, cap, above ? up : down));
    let left = opts.align === 'center' ? r.left + r.width / 2 - w / 2 : (opts.align === 'right' ? r.right - w : r.left);
    left = Math.max(safe, Math.min(left, vw - w - safe));
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(above ? r.top - gap - H : r.bottom + gap) + 'px';
    pop.style.maxHeight = Math.round(H) + 'px';
    pop.dataset.side = above ? 'up' : 'down';
}

// 子菜单：贴在主弹层右侧、与悬停行对齐，右侧放不下翻到左侧；窄屏改为铺在主弹层下方
export function placeBeside(row, main, sub) {
    if (!row || !main || !sub) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const safe = 8, gap = 4;
    const mr = main.getBoundingClientRect(), rr = row.getBoundingClientRect();
    sub.style.maxHeight = '';
    const w = sub.offsetWidth;
    const H = Math.min(sub.scrollHeight, vh - safe * 2);
    let left, top;
    if (vw < 720) {
        left = Math.max(safe, Math.min(mr.left, vw - w - safe));
        top = mr.bottom + gap;
        if (top + H > vh - safe) top = Math.max(safe, mr.top - H - gap);
    } else {
        left = mr.right + gap;
        if (left + w > vw - safe) left = mr.left - w - gap;
        if (left < safe) left = Math.max(safe, Math.min(mr.right + gap, vw - w - safe));
        top = rr.top - 5;
        if (top + H > vh - safe) top = vh - H - safe;
        if (top < safe) top = safe;
    }
    sub.style.left = Math.round(left) + 'px';
    sub.style.top = Math.round(top) + 'px';
    sub.style.maxHeight = Math.round(H) + 'px';
}

// name：弹层名（互斥用）；anchorRef / popRef：触发按钮与弹层；extra()：还算「里面」的元素（子菜单）
export function usePop(name, anchorRef, popRef, opts = {}) {
    const open = ref(false);
    const place = () => placeNear(anchorRef.value, popRef.value, typeof opts.place === 'function' ? opts.place() : opts.place);
    function toggle(force) {
        open.value = typeof force === 'boolean' ? force : !open.value;
        if (open.value) { activePop.value = name; nextTick(place); }
        else if (activePop.value === name) activePop.value = '';
    }
    watch(activePop, v => { if (v !== name && open.value) open.value = false; });
    watch(open, v => { if (!v && opts.onClose) opts.onClose(); });
    function inside(target) {
        const els = [anchorRef.value, popRef.value].concat(opts.extra ? opts.extra() : []);
        return els.some(el => el && el.contains(target));
    }
    const onDown = e => { if (open.value && !inside(e.target)) toggle(false); };
    const onKey = e => { if (open.value && e.key === 'Escape') toggle(false); };
    const onResize = () => { if (open.value) place(); };
    onMounted(() => {
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', onResize);
    });
    onBeforeUnmount(() => {
        document.removeEventListener('pointerdown', onDown, true);
        document.removeEventListener('keydown', onKey);
        window.removeEventListener('resize', onResize);
    });
    return { open, toggle, place };
}

export function closeAllPops() { activePop.value = ''; }
