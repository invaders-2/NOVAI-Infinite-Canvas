// 子菜单统一行为（用户要求：子菜单交互动效用原先的）——
// 页面上出现的每个下拉菜单 / 弹出列表都自动挂上旧版的「滑块高亮」（NovaGlide）：
//   .nv-menu                 → 选项 .nv-menu-item，选中类 is-on
//   [data-glide="选择器"]     → 选项为该选择器，选中类取 data-glide-active（默认 on）
// 用 MutationObserver 接住 v-if / Teleport 新挂出来的菜单，组件里不用逐个写。
import NovaGlide from './novaGlide.js';

function attachOne(el) {
    if (!NovaGlide || !el || el.__nvGlide) return;
    if (el.matches('.nv-menu')) NovaGlide.attach(el, { item: '.nv-menu-item', activeClass: 'is-on' });
    else if (el.dataset && el.dataset.glide) NovaGlide.attach(el, { item: el.dataset.glide, activeClass: el.dataset.glideActive || 'on' });
}
function scan(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.matches('.nv-menu, [data-glide]')) attachOne(node);
    node.querySelectorAll && node.querySelectorAll('.nv-menu, [data-glide]').forEach(attachOne);
}
export function initMenus() {
    if (typeof MutationObserver === 'undefined' || !document.body) return;
    scan(document.documentElement);
    new MutationObserver(records => {
        for (const r of records) for (const n of r.addedNodes) scan(n);
    }).observe(document.documentElement, { childList: true, subtree: true });   // body 和 #nv-layer 都要管
}
