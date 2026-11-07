// 图标动效契约：名字集合与 static/css/nv-icons.css 的 svg.nv-i-a-* 一一对应
export const NV_ANIM_NAMES = ['default', 'pop', 'rotate', 'spin', 'bounceY', 'slideX', 'wiggle', 'blink', 'draw', 'tilt', 'path', 'path-loop'];

// AnimateIcon 向下传的上下文；NvIcon 注入后合并 props（显式 props 优先）
export const NV_ANIM_KEY = Symbol('nv-anim');

export function normalizeAnimation(name) {
    return NV_ANIM_NAMES.includes(name) ? name : 'default';
}

export function cssTime(v) {
    return typeof v === 'number' ? v + 'ms' : String(v);
}

export function playOnce(node, cls = 'nv-i-tapped', holdMs = 900) {
    if (!node) return;
    node.classList.remove(cls);
    void node.getBoundingClientRect();
    node.classList.add(cls);
    clearTimeout(node.__nvPlayTimer);
    node.__nvPlayTimer = setTimeout(() => node.classList.remove(cls), holdMs);
}
