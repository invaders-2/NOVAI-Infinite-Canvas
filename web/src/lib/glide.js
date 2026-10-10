// 滑块高亮（与现有 shared/glide.js 同一套行为）：一个高亮元素跟随悬停项，离开后回到选中项。
// host 里放一个 [data-glide-pill] 元素；line=true 时只跟宽度和 x（下划线样式）。
import { onMounted, onBeforeUnmount, nextTick } from 'vue';

export function useGlide(hostRef, selector, opts = {}) {
    let hovered = null;
    let ro = null;
    const pill = () => hostRef.value && hostRef.value.querySelector(':scope > [data-glide-pill]');
    const active = () => hostRef.value && hostRef.value.querySelector(selector + '.is-on');
    function place(el, instant) {
        const p = pill();
        if (!p) return;
        if (!el) { p.style.opacity = '0'; return; }
        if (instant) p.style.transition = 'none';
        if (opts.line) { p.style.transform = `translateX(${el.offsetLeft}px)`; p.style.width = el.offsetWidth + 'px'; }
        else { p.style.transform = `translate(${el.offsetLeft - 2}px, 0)`; p.style.width = el.offsetWidth + 'px'; }
        p.style.opacity = '1';
        if (instant) { void p.offsetWidth; p.style.transition = ''; }
    }
    function over(e) {
        const it = e.target.closest(selector);
        if (!it || !hostRef.value.contains(it) || it === hovered) return;
        hovered = it; place(it);
    }
    function leave() { hovered = null; place(active()); }
    function refresh() { nextTick(() => place(hovered || active())); }
    onMounted(() => {
        const h = hostRef.value;
        if (!h) return;
        h.classList.add('glide-ready');
        h.addEventListener('pointerover', over);
        h.addEventListener('pointerleave', leave);
        nextTick(() => place(active(), true));
        // 字体加载完成 / 尺寸变化后重新量一次
        ro = new ResizeObserver(() => place(hovered || active(), true));
        ro.observe(h);
    });
    onBeforeUnmount(() => { if (ro) ro.disconnect(); });
    return { refresh };
}
