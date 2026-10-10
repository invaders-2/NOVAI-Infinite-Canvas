import { state } from './store.js';

export function pyApi() {
    return (window.pywebview && window.pywebview.api) || null;
}

// 与旧外壳 initFramelessTitlebar 相同的判断：Windows 桌面 = 自绘无边框标题栏；macOS 桌面 = 原生透明标题栏
function detect() {
    const ua = (navigator.userAgent || '').toLowerCase();
    const isDesktop = !!window.pywebview || ua.includes('pywebview');
    if (!isDesktop) return '';
    const isWin = (navigator.platform || '').toLowerCase().includes('win') || ua.includes('windows');
    return isWin ? 'windows' : 'mac';
}

export function initEnv() {
    state.desktop = detect();
    if (!state.desktop) {
        // pywebview 注入有延迟，和旧外壳一样重试 4 秒
        let tries = 0;
        const timer = setInterval(() => {
            state.desktop = detect();
            if (state.desktop || ++tries > 20) clearInterval(timer);
        }, 200);
    }
    window.addEventListener('studio-theme-change', e => { state.theme = e.detail.theme; });
    window.addEventListener('studio-lang-change', e => { state.lang = e.detail.lang; });
}

export function getGeneralSettings() {
    try { return JSON.parse(localStorage.getItem('studio_general_settings') || '{}') || {}; } catch (e) { return {}; }
}
