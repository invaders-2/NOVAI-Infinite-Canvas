#!/usr/bin/env node
/* Electron 主窗口尺寸回归（纯 node，不启动 Electron）：
   窗口不再写死 1440x900：按 screen.getPrimaryDisplay().workArea 收敛（-40 边距）+ 居中，
   min 尺寸 min(900/600, 工作区)，保证 1366x768 / 1080p@125% / 1280x800 都落在工作区内。
   跑法：node tests/test_window_bounds.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(root, 'desktop/main.js'), 'utf8');

function topLevelFunction(src, name) {
    const lines = src.split('\n');
    const start = lines.findIndex((line) => line.startsWith('function ' + name + '('));
    if (start < 0) return '';
    for (let i = start + 1; i < lines.length; i += 1) {
        if (lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}

let pass = 0;
const fails = [];
const ok = (cond, label, extra) => { if (cond) pass += 1; else fails.push(label + (extra ? ' -> ' + JSON.stringify(extra) : '')); };
const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);

console.log('[1] computeWindowBounds 按工作区收敛');
const fnSrc = topLevelFunction(mainSrc, 'computeWindowBounds');
ok(!!fnSrc, 'main.js 里有 computeWindowBounds');
const compute = vm.runInNewContext(fnSrc + '\ncomputeWindowBounds', {});

const cases = [
    { name: '1366x768（任务栏 40）', area: { x: 0, y: 0, width: 1366, height: 728 }, want: { width: 1326, height: 688, minWidth: 900, minHeight: 600, x: 20, y: 20 } },
    { name: '1080p@125% 的 DIP 工作区 1536x808', area: { x: 0, y: 0, width: 1536, height: 808 }, want: { width: 1440, height: 768, minWidth: 900, minHeight: 600, x: 48, y: 20 } },
    { name: '2K 2560x1400', area: { x: 0, y: 0, width: 2560, height: 1400 }, want: { width: 1440, height: 900, minWidth: 900, minHeight: 600, x: 560, y: 250 } },
    { name: '4K 3840x2120', area: { x: 0, y: 0, width: 3840, height: 2120 }, want: { width: 1440, height: 900, minWidth: 900, minHeight: 600, x: 1200, y: 610 } },
    { name: '1280x800', area: { x: 0, y: 0, width: 1280, height: 800 }, want: { width: 1240, height: 760, minWidth: 900, minHeight: 600, x: 20, y: 20 } },
    { name: '副屏带偏移 x=1920', area: { x: 1920, y: 100, width: 1366, height: 728 }, want: { width: 1326, height: 688, minWidth: 900, minHeight: 600, x: 1940, y: 120 } },
];
for (const c of cases) {
    const got = compute(c.area);
    ok(same(got, c.want), c.name + '：' + JSON.stringify(got), { got, want: c.want });
    ok(got.x >= c.area.x && got.y >= c.area.y && got.x + got.width <= c.area.x + c.area.width && got.y + got.height <= c.area.y + c.area.height,
        c.name + '：窗口完全落在工作区内', got);
}
const fallback = compute(null);
ok(same(fallback, { width: 1440, height: 900, minWidth: 900, minHeight: 600 }), '拿不到工作区时退回 1440x900 / min 900x600', fallback);

console.log('[2] createWindow 接线');
ok(/screen\.getPrimaryDisplay\(\)\.workArea/.test(mainSrc), 'createWindow 读 primaryDisplay.workArea');
ok(/const bounds = computeWindowBounds\(workArea\)/.test(mainSrc), 'createWindow 调用 computeWindowBounds');
ok(/mainWindow = new BrowserWindow\(\{\s*\n\s*\.\.\.bounds,/.test(mainSrc), 'BrowserWindow 展开 bounds（尺寸 + 位置 + min）');
ok(!/width: 1440,\s*\n\s*height: 900,/.test(mainSrc), '不再写死 1440x900 建窗');

console.log('[3] macOS 红绿灯位置（14 寸错位）');
const chromeSrc = topLevelFunction(mainSrc, 'platformWindowChrome');
ok(!!chromeSrc, 'main.js 里有 platformWindowChrome');
const chromeFor = vm.runInNewContext(chromeSrc + '\nplatformWindowChrome', {});
const mac = chromeFor('darwin');
ok(same(mac, { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 20 } }), 'darwin：hiddenInset + trafficLightPosition {x:20,y:20}', mac);
ok(mac.trafficLightPosition.y === 20 && mac.trafficLightPosition.x === 20, '红绿灯 margin x=20 / y=20（左缘 20、中心≈26，对齐 TapNow/launcher）');
const win = chromeFor('win32');
ok(same(win, { titleBarStyle: 'hidden' }) && !('trafficLightPosition' in win), 'win32：hidden，不传 trafficLightPosition', win);
const linux = chromeFor('linux');
ok(same(linux, { titleBarStyle: 'default' }) && !('trafficLightPosition' in linux), 'linux：default，不传 trafficLightPosition', linux);
ok(/if \(isMac\) chrome\.trafficLightPosition = \{ x: 20, y: 20 \};/.test(chromeSrc), '只有 darwin 分支写 trafficLightPosition');
ok(/const chrome = platformWindowChrome\(process\.platform\);/.test(mainSrc), 'createWindow 按当前平台取 chrome');
ok(/mainWindow = new BrowserWindow\(\{[\s\S]{0,220}?\.\.\.chrome,/.test(mainSrc), 'BrowserWindow 展开 ...chrome');
const launcherSrc = fs.readFileSync(path.join(root, 'launcher.py'), 'utf8');
ok(/_MAC_TL_LEFT_X = 20\.0/.test(launcherSrc), 'launcher.py 红绿灯左缘同为 20');
ok(/_MAC_TL_CENTER_Y = 26\.0/.test(launcherSrc), 'launcher.py 红绿灯中心仍 26');
ok((mainSrc.match(/chrome\.trafficLightPosition =/g) || []).length === 1, 'main.js 里只有平台 helper 一处赋值');
ok(!/trafficLightPosition:/.test(mainSrc), '没有在 BrowserWindow 选项里硬编码 trafficLightPosition');

console.log('[4] 禁用 Chromium 页面缩放（防 Cmd +/- / pinch 持久化）');
ok(/setVisualZoomLevelLimits\(1, 1\)/.test(mainSrc), '创建窗口后 setVisualZoomLevelLimits(1, 1) 禁 pinch');
ok(/mainWindow\.webContents\.setZoomFactor\(1\)/.test(mainSrc) && /mainWindow\.webContents\.setZoomLevel\(0\)/.test(mainSrc),
    'resetPageZoom 同时复位 zoomFactor=1 / zoomLevel=0');
const didFinishBlock = (mainSrc.match(/mainWindow\.webContents\.on\('did-finish-load', \(\) => \{[\s\S]{0,220}?\n  \}\);/ ) || [''])[0];
ok(/resetPageZoom\('did-finish-load'\)/.test(didFinishBlock), 'did-finish-load 后复位到 100%');
ok(/onMainWindowLoaded\(\)/.test(didFinishBlock), 'did-finish-load 同时触发启动自检（bootAttempts 清零）');
ok(/webContents\.on\('zoom-changed', \(\) => resetPageZoom\('zoom-changed'\)\)/.test(mainSrc), 'zoom-changed（Cmd +/- / pinch）立即复位');
const zoomBlockAt = mainSrc.indexOf('setVisualZoomLevelLimits(1, 1)');
const userAgentAt = mainSrc.indexOf("replace('Electron', 'Electron pywebview')");
ok(zoomBlockAt > 0 && userAgentAt > zoomBlockAt, '禁 pinch 接在创建窗口之后、UA 设置之前');
ok(!/if \(isWindows\)[\s\S]{0,80}setVisualZoomLevelLimits/.test(mainSrc), '缩放锁不按平台分支（Windows/mac 都生效）');
const zoomResetCount = (mainSrc.match(/resetPageZoom\('(did-finish-load|zoom-changed)'\)/g) || []).length;
ok(zoomResetCount === 2, '两个入口都只调 resetPageZoom（实际 ' + zoomResetCount + '）');

console.log('[5] 彻底锁死页面缩放（菜单 role + 键盘）');
const menuFnSrc = topLevelFunction(mainSrc, 'menuTemplateWithoutZoom');
ok(!!menuFnSrc, 'main.js 里有 menuTemplateWithoutZoom');
const stripMenu = vm.runInNewContext(menuFnSrc + '\nmenuTemplateWithoutZoom', {});
const fakeMenu = { items: [
    { label: 'NOVAI', submenu: { items: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] } },
    { label: 'Edit', submenu: { items: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }] } },
    { label: 'View', submenu: { items: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] } },
    { label: 'Window', submenu: { items: [{ role: 'minimize' }, { role: 'zoom' }] } },
    { label: '只缩放的子菜单', submenu: { items: [{ role: 'zoomIn' }, { role: 'zoomOut' }] } },
] };
const stripped = stripMenu(fakeMenu);
const viewMenu = stripped.find((item) => item.label === 'View');
ok(!!viewMenu, '非缩放菜单保留');
const viewRoles = (viewMenu.submenu || []).map((item) => item.role).filter(Boolean);
ok(viewRoles.includes('reload') && viewRoles.includes('toggleDevTools') && viewRoles.includes('togglefullscreen'), 'View 里 reload / devtools / fullscreen 保留', viewRoles);
ok(!viewRoles.includes('zoomIn') && !viewRoles.includes('zoomOut') && !viewRoles.includes('resetZoom'), 'View 里 zoomIn/zoomOut/resetZoom 已移除', viewRoles);
ok(!stripped.some((item) => item.label === '只缩放的子菜单'), '全是缩放项的空子菜单整个移除');
const editRoles = (stripped.find((item) => item.label === 'Edit').submenu || []).map((item) => item.role);
ok(editRoles.includes('copy') && editRoles.includes('paste'), 'Edit 菜单（复制/粘贴）保留');
const allRoles = JSON.stringify(stripped).toLowerCase();
ok(!/"(zoomin|zoomout|resetzoom)"/.test(allRoles), '过滤后模板里不再有缩放 role');
ok(/Menu\.getApplicationMenu\(\)/.test(mainSrc) && /Menu\.setApplicationMenu\(Menu\.buildFromTemplate\(menuTemplateWithoutZoom\(current\)\)\)/.test(mainSrc), 'installApplicationMenuWithoutZoom 过滤默认菜单再挂回');
ok(/app\.whenReady\(\)\.then\(async \(\) => \{\s*dataDir = resolveDataDir\(\);/.test(mainSrc) && /installApplicationMenuWithoutZoom\(\);/.test(mainSrc), 'app ready 后先装无缩放菜单');
ok(/mainWindow\.webContents\.on\('before-input-event'/.test(mainSrc), '主窗口挂 before-input-event');
ok(/process\.platform === 'darwin' \? input\.meta : input\.control/.test(mainSrc), 'mac 用 meta、其它平台用 control');
ok(/zoomKeys = \['\+', '=', '-', '_', '0'\]/.test(mainSrc) && /'NumpadAdd', 'NumpadSubtract', 'Numpad0'/.test(mainSrc), '覆盖主键盘与数字键盘 +/-/0');
ok(/event\.preventDefault\(\);[\s\S]{0,80}resetPageZoom\('before-input-event'\)/.test(mainSrc), '拦截后 preventDefault + 复位 100%');
ok(/setVisualZoomLevelLimits\(1, 1\)/.test(mainSrc) && /mainWindow\.webContents\.on\('did-finish-load', \(\) => \{[\s\S]{0,220}?resetPageZoom\('did-finish-load'\)/.test(mainSrc) && /zoom-changed', \(\) => resetPageZoom/.test(mainSrc), 'pinch 限制 + 加载/zoom-changed 复位仍在');

console.log('');
if (fails.length) {
    console.error('失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.error('  ✗ ' + f));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项）');
