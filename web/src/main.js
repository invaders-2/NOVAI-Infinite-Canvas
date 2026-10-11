import { createApp } from 'vue';
import './styles/ds.css';
import './styles/app.css';
import App from './App.vue';
import { initEnv } from './lib/env.js';
import { initBridge } from './lib/bridge.js';
import { initMenus } from './lib/menus.js';
import { initAutoTranslate } from './lib/autoTranslate.js';

// 主题：theme.js 切的是 html.theme-dark，设计系统认 data-theme，两边保持一致
function syncThemeAttr() {
    const dark = document.documentElement.classList.contains('theme-dark');
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}
syncThemeAttr();
window.addEventListener('studio-theme-change', syncThemeAttr);

initEnv();
initBridge();
// 弹层层：挂在 <html> 下、<body> 外。界面缩放时 theme.js 会给 body 加 transform: scale()，
// body 里的 position:fixed 弹层就会以 body 为参照、坐标和 getBoundingClientRect 对不上（子菜单错位、鼠标移过去就消失）。
// 旧版 GPT 对话也是把子菜单挪到 documentElement 下解决的；所有 <Teleport> 都指向这里。
if (!document.getElementById('nv-layer')) { const layer = document.createElement('div'); layer.id = 'nv-layer'; document.documentElement.appendChild(layer); }
createApp(App).mount('#app');
initMenus();
initAutoTranslate();
// 兜底：任何异常都不让启动遮罩永久挡住
setTimeout(() => document.documentElement.classList.remove('studio-route-booting'), 3000);
