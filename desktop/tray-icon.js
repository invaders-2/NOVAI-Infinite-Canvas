// NOVAI Desktop — 托盘图标路径选择
// 纯函数（只依赖 path），供 main.js 使用并由 tests/test_desktop_tray_icon.js 覆盖。
// 打包后 icons 通过 extraResources 落在 Resources/icons（asar 之外），开发时在 desktop/icons。

'use strict';

const path = require('path');

// Windows 托盘首选 .ico（自带多尺寸，系统按 DPI 挑选），其它平台用 png。
const FORMAT_ORDER = {
    win32: ['ico', 'png'],
    darwin: ['png', 'ico'],
    linux: ['png', 'ico'],
};
// Windows 回退到 png 时按托盘栅格尺寸缩到 16px，否则系统会把大图直接塞进托盘、糊成一团。
const WIN_TRAY_RASTER_SIZE = 16;
// macOS 菜单栏高度 22pt。拿 512px 原图直接建 NSStatusItem，系统会把整排「菜单栏附加项」
// 折叠成一个空白分组——音乐、电池、Wi-Fi 等图标全部消失（实测可稳定复现）。
// 所以 macOS 优先用专用的 22pt 模板图（黑图形 + alpha，系统按明暗自动反色）。
const MAC_TRAY_RASTER_SIZE = 22;
const MAC_TRAY_TEMPLATE_FILE = 'menubarTemplate.png';

function trayIconCandidates(platform, dirs) {
    const order = FORMAT_ORDER[platform] || ['png', 'ico'];
    const roots = (Array.isArray(dirs) ? dirs : []).filter(Boolean);
    const candidates = [];
    if (platform === 'darwin') {
        for (const dir of roots) {
            candidates.push({
                path: path.join(dir, MAC_TRAY_TEMPLATE_FILE),
                format: 'png',
                resize: 0,
                template: true,
            });
        }
    }
    for (const format of order) {
        for (const dir of roots) {
            candidates.push({
                path: path.join(dir, 'icon.' + format),
                format: format,
                resize: platform === 'win32' && format === 'png'
                    ? WIN_TRAY_RASTER_SIZE
                    : (platform === 'darwin' && format === 'png' ? MAC_TRAY_RASTER_SIZE : 0),
            });
        }
    }
    return candidates;
}

function firstExistingTrayIcon(platform, dirs, exists) {
    const check = typeof exists === 'function' ? exists : require('fs').existsSync;
    for (const candidate of trayIconCandidates(platform, dirs)) {
        if (check(candidate.path)) return candidate;
    }
    return null;
}

module.exports = {
    trayIconCandidates: trayIconCandidates,
    firstExistingTrayIcon: firstExistingTrayIcon,
    WIN_TRAY_RASTER_SIZE: WIN_TRAY_RASTER_SIZE,
    MAC_TRAY_RASTER_SIZE: MAC_TRAY_RASTER_SIZE,
    MAC_TRAY_TEMPLATE_FILE: MAC_TRAY_TEMPLATE_FILE,
};
