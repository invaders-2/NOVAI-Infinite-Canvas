// 组合式工具：大列表分批渲染 + 管理模式拖拽框选（旧版第 11 轮的 progressive grid 与 marquee selection）
import { ref, computed, watch, onBeforeUnmount } from 'vue';

const CHUNK = 120;

// units：要渲染的单元（卡片或画布分组）；key：换分组 / 筛选 / 搜索时从头来；selectedId：选中项在后面时自动放宽批次
export function useProgressive(units, key, selectedId = () => '', weight = () => 1) {
    const limit = ref(CHUNK);
    watch(key, () => { limit.value = CHUNK; });
    const shown = computed(() => {
        const list = units() || [];
        let lim = limit.value;
        const sid = selectedId();
        if (sid) {
            const idx = list.findIndex(u => u && u.id === sid);
            if (idx >= lim) lim = Math.ceil((idx + 1) / CHUNK) * CHUNK;
        }
        let n = 0, cards = 0;
        while (n < list.length && (cards < lim || n === 0)) { cards += weight(list[n]); n += 1; }
        return n;
    });
    const visible = computed(() => (units() || []).slice(0, shown.value));
    const rest = computed(() => (units() || []).slice(shown.value).reduce((s, u) => s + weight(u), 0));
    function more() { limit.value += CHUNK; }
    return { visible, rest, more, shown };
}

// 框选：在 .am-scroll 空白处按下拖动，和卡片矩形相交的加入选择（在按下时的选择基础上增加）
export function useMarquee(scrollRef, opts) {
    const box = ref(null);
    let st = null;
    function down(e) {
        if (!opts.enabled() || e.button !== 0) return;
        if (e.target.closest && e.target.closest('button,input,textarea,select,a,.am-up,[data-card-id]')) return;
        const area = scrollRef.value;
        if (!area || !area.contains(e.target)) return;
        e.preventDefault();
        st = { x: e.clientX, y: e.clientY, base: new Set(opts.get()) };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        move(e);
    }
    function move(e) {
        if (!st) return;
        const area = scrollRef.value;
        if (!area) return;
        const left = Math.min(st.x, e.clientX), top = Math.min(st.y, e.clientY);
        const right = Math.max(st.x, e.clientX), bottom = Math.max(st.y, e.clientY);
        const ar = area.getBoundingClientRect();
        box.value = {
            left: left - ar.left + area.scrollLeft + 'px', top: top - ar.top + area.scrollTop + 'px',
            width: Math.max(1, right - left) + 'px', height: Math.max(1, bottom - top) + 'px',
        };
        const next = new Set(st.base);
        area.querySelectorAll('[data-card-id]').forEach(el => {
            const r = el.getBoundingClientRect();
            if (left < r.right && right > r.left && top < r.bottom && bottom > r.top) next.add(el.dataset.cardId);
        });
        opts.set(next);
    }
    function up() {
        st = null;
        box.value = null;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (opts.end) opts.end();
    }
    onBeforeUnmount(up);
    return { box, down };
}
