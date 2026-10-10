// 大图滚轮缩放 + 拖拽平移（移植自 static/js/image-preview.js 的 attach），并补上按钮用的 zoomBy / reset。
// 以光标（或画框中心）为锚点缩放；zoom ≤ 1 时归位；双击复位。
import { ref, computed } from 'vue';

export function usePanZoom(frameRef, opts = {}) {
    const minZoom = opts.minZoom || 1;
    const maxZoom = opts.maxZoom || 6;
    const zoom = ref(1);
    const pan = ref({ x: 0, y: 0 });
    const panning = ref(false);
    let drag = null;

    const style = computed(() => ({ transform: `translate(${pan.value.x}px, ${pan.value.y}px) scale(${zoom.value})`, transformOrigin: '0 0' }));
    const percent = computed(() => Math.round(zoom.value * 100) + '%');

    function reset() { zoom.value = 1; pan.value = { x: 0, y: 0 }; drag = null; panning.value = false; }

    function zoomAt(factor, lx, ly) {
        const el = frameRef.value;
        if (!el) return;
        if (lx == null) { const r = el.getBoundingClientRect(); lx = r.width / 2; ly = r.height / 2; }
        const before = { x: (lx - pan.value.x) / zoom.value, y: (ly - pan.value.y) / zoom.value };
        const nz = Math.max(minZoom, Math.min(maxZoom, zoom.value * factor));
        zoom.value = nz;
        pan.value = nz <= 1.001 ? { x: 0, y: 0 } : { x: lx - before.x * nz, y: ly - before.y * nz };
    }
    function zoomBy(factor) { zoomAt(factor); }

    function onWheel(e) {
        e.preventDefault();
        const r = frameRef.value.getBoundingClientRect();
        zoomAt(e.deltaY > 0 ? 0.9 : 1.1, e.clientX - r.left, e.clientY - r.top);
    }
    function onDown(e) {
        if (e.button !== 0 || zoom.value <= 1.001) return;
        if (e.target.closest('[data-no-pan], button, a, input, textarea')) return;
        drag = { sx: e.clientX, sy: e.clientY, ox: pan.value.x, oy: pan.value.y };
        panning.value = true;
        e.preventDefault();
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }
    function onMove(e) {
        if (!drag) return;
        pan.value = { x: drag.ox + e.clientX - drag.sx, y: drag.oy + e.clientY - drag.sy };
    }
    function onUp() {
        drag = null; panning.value = false;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
    }
    function onDblClick(e) { if (zoom.value <= 1.001) return; e.preventDefault(); reset(); }

    return { zoom, percent, style, panning, reset, zoomBy, onWheel, onDown, onDblClick, minZoom, maxZoom };
}
