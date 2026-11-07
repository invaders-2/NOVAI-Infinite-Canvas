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

function trayIconCandidates(platform, dirs) {
    const order = FORMAT_ORDER[platform] || ['png', 'ico'];
    const roots = (Array.isArray(dirs) ? dirs : []).filter(Boolean);
    const candidates = [];
    for (const format of order) {
        for (const dir of roots) {
            candidates.push({
                path: path.join(dir, 'icon.' + format),
                format: format,
                resize: platform === 'win32' && format === 'png' ? WIN_TRAY_RASTER_SIZE : 0,
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
};
