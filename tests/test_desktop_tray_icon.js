#!/usr/bin/env node
/*
 * 桌面端托盘图标选择回归测试（零依赖）。
 *
 * 背景：Windows 安装版关窗后没有托盘图标，进程既关不掉也再次打不开。
 * 根因之一是打包清单没带 icons，托盘创建失败 → tray=null → 关窗直接退出/窗口藏到不存在的托盘里。
 * 这里覆盖 desktop/tray-icon.js 的平台格式优先级、目录优先级、png 回退缩放，
 * 以及 main.js / package.json 里必须保持的接线，避免再次回到「Windows 没托盘」。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { trayIconCandidates, firstExistingTrayIcon, WIN_TRAY_RASTER_SIZE, MAC_TRAY_RASTER_SIZE, MAC_TRAY_TEMPLATE_FILE } = require('../desktop/tray-icon');

const root = path.join(__dirname, '..');
const readText = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let pass = 0;
const fails = [];
const ok = (condition, label) => {
    if (condition) pass += 1;
    else fails.push(label);
};
const winDirs = ['/res/icons', '/app/icons'];

console.log('[1] trayIconCandidates：平台格式优先级');
const win = trayIconCandidates('win32', winDirs);
ok(win.length === 4, 'win32 两个目录 × 两种格式 = 4 个候选（实际 ' + win.length + '）');
ok(win[0].format === 'ico' && win[0].path === path.join('/res/icons', 'icon.ico'), 'win32 首选资源目录的 icon.ico');
ok(win[1].format === 'ico' && win[1].path === path.join('/app/icons', 'icon.ico'), '同格式内按目录优先级（资源目录 → 应用目录）');
ok(win[2].format === 'png' && win[3].format === 'png', 'ico 全部试完才回退 png');
ok(win[2].resize === WIN_TRAY_RASTER_SIZE && WIN_TRAY_RASTER_SIZE === 16, 'win32 回退 png 时缩放到 16px');
ok(win[0].resize === 0, 'ico 不缩放（自带多尺寸）');
ok(win.every((item) => item.path.endsWith('icon.' + item.format)), '每个候选的路径扩展名与 format 一致');

const mac = trayIconCandidates('darwin', winDirs);
ok(mac.length === 6, 'darwin 两个目录 ×（模板 + png + ico）= 6 个候选（实际 ' + mac.length + '）');
ok(mac[0].template === true && mac[0].path === path.join('/res/icons', 'menubarTemplate.png'), 'darwin 首选资源目录的 22pt 菜单栏模板图');
ok(mac[1].template === true && mac[1].path === path.join('/app/icons', 'menubarTemplate.png'), '模板图同样按目录优先级回退');
ok(mac[0].resize === 0, '模板图不缩放（本身就是 22pt + @2x）');
const macPng = mac.filter((item) => !item.template && item.format === 'png');
ok(macPng.length === 2 && macPng[0].resize === MAC_TRAY_RASTER_SIZE && MAC_TRAY_RASTER_SIZE === 22, 'darwin 回退 icon.png 时缩到 22px（512px 原图会让整排菜单栏图标消失）');
ok(mac.filter((item) => item.format === 'ico').every((item) => item.resize === 0), 'darwin 的 ico 不做缩放');
const linux = trayIconCandidates('linux', winDirs);
ok(linux[0].format === 'png' && linux[0].resize === 0, 'linux 首选 png 且不缩放');
ok(trayIconCandidates('aix', winDirs)[0].format === 'png', '未知平台回退 png 优先，不抛异常');

console.log('[2] trayIconCandidates：脏输入');
const filtered = trayIconCandidates('win32', ['', null, undefined, '/app/icons']);
ok(filtered.length === 2 && filtered[0].path === path.join('/app/icons', 'icon.ico'), '空/非字符串目录被过滤');
ok(trayIconCandidates('win32', null).length === 0, 'dirs 非数组时返回空数组，不抛异常');

console.log('[3] firstExistingTrayIcon：回退顺序');
const onlyPng = (candidatePath) => candidatePath.endsWith('icon.png');
const pickedPng = firstExistingTrayIcon('win32', winDirs, onlyPng);
ok(pickedPng && pickedPng.format === 'png' && pickedPng.resize === 16, 'Windows 只有 png 时回退 png 并标记缩放到 16px');
ok(pickedPng.path === path.join('/res/icons', 'icon.png'), '回退时仍优先资源目录');
const onlyIco = (candidatePath) => candidatePath.endsWith('icon.ico');
const pickedIco = firstExistingTrayIcon('win32', winDirs, onlyIco);
ok(pickedIco && pickedIco.path === path.join('/res/icons', 'icon.ico'), '存在 ico 时选资源目录 ico');
ok(firstExistingTrayIcon('win32', winDirs, () => false) === null, '全部缺失返回 null（调用方据此打明确日志）');
ok(firstExistingTrayIcon('darwin', winDirs, () => true).template === true, 'darwin 有模板图时优先取模板图');
ok(firstExistingTrayIcon('darwin', winDirs, (candidatePath) => candidatePath.endsWith('icon.png')).resize === MAC_TRAY_RASTER_SIZE, 'darwin 只有 icon.png 时也要求缩到 22px');

console.log('[4] 打包清单：图标与 helper 必须进包');
const pkg = JSON.parse(readText('desktop/package.json'));
const files = (pkg.build && pkg.build.files) || [];
ok(files.includes('main.js'), 'files 含 main.js');
ok(files.includes('tray-icon.js'), 'files 含 tray-icon.js（require 得到）');
const extra = ((pkg.build && pkg.build.extraResources) || []).map((item) => String(item.from || '') + '->' + String(item.to || ''));
ok(extra.some((item) => item.indexOf('icons/icon.png') === 0), 'extraResources 带 icons/icon.png（asar 外可读）');
ok(extra.some((item) => item.indexOf('icons/icon.ico') === 0), 'extraResources 带 icons/icon.ico（Windows 托盘首选）');
ok(fs.existsSync(path.join(root, 'desktop/icons/icon.png')), '仓库里存在 desktop/icons/icon.png');
ok(fs.existsSync(path.join(root, 'desktop/icons/icon.ico')), '仓库里存在 desktop/icons/icon.ico');
ok(extra.some((item) => item.indexOf('icons/' + MAC_TRAY_TEMPLATE_FILE) === 0), 'extraResources 带 macOS 菜单栏模板图（asar 外可读）');
ok(extra.some((item) => item.indexOf('icons/menubarTemplate@2x.png') === 0), 'extraResources 带模板图 @2x（Retina 不糊）');
// 模板图尺寸：PNG IHDR 里直接读，避免引入图像依赖
const pngSize = (absPath) => {
    const buf = fs.readFileSync(absPath);
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};
const template1x = pngSize(path.join(root, 'desktop/icons', MAC_TRAY_TEMPLATE_FILE));
const template2x = pngSize(path.join(root, 'desktop/icons/menubarTemplate@2x.png'));
ok(template1x.width === MAC_TRAY_RASTER_SIZE && template1x.height === MAC_TRAY_RASTER_SIZE, '模板图是 ' + MAC_TRAY_RASTER_SIZE + '×' + MAC_TRAY_RASTER_SIZE + '（实际 ' + template1x.width + '×' + template1x.height + '）');
ok(template2x.width === MAC_TRAY_RASTER_SIZE * 2 && template2x.height === MAC_TRAY_RASTER_SIZE * 2, '模板图 @2x 是 ' + (MAC_TRAY_RASTER_SIZE * 2) + '×' + (MAC_TRAY_RASTER_SIZE * 2) + '（实际 ' + template2x.width + '×' + template2x.height + '）');

console.log('[5] main.js 接线：托盘 / 关闭到托盘 / 单实例 / 生命周期');
const main = readText('desktop/main.js');
ok(/nativeImage\.createFromPath\(candidatePath\)/.test(main), '用 nativeImage.createFromPath 加载托盘图标');
ok(/firstExistingTrayIcon\(process\.platform, dirs, probe\)/.test(main), '托盘图标走 tray-icon.js 的候选回退');
ok(/if \(found\.resize\) image = image\.resize\(/.test(main), 'png 回退按候选要求缩放');
ok(/if \(found\.template\)/.test(main), '模板图走单独的接线分支');
ok(/image\.setTemplateImage\(true\)/.test(main), 'macOS 模板图必须 setTemplateImage(true)（否则不会随明暗反色）');
ok(/@2x\.png/.test(main), '模板图补 @2x 表示，Retina 下不糊');
ok(/process\.platform === 'darwin'[\s\S]{0,220}tray\.on\('click', \(\) => \{ showMainWindow\(\); \}\)/.test(main), 'macOS 左键单击直接打开主界面');
ok(/tray\.on\('right-click'[\s\S]{0,120}popUpContextMenu\(menu\)/.test(main), 'macOS 右键弹出托盘菜单（退出入口还在）');
ok(/\} else \{[\s\S]{0,160}tray\.setContextMenu\(menu\)/.test(main), '非 macOS 保持「点击弹菜单」不变');
ok(/找不到可用托盘图标，已尝试: /.test(main), '图标缺失时打出已尝试路径的明确日志');
ok(/托盘不可用：图标加载失败/.test(main), '托盘不可用时给出明确日志，不静默 tray=null');

const readyAt = main.indexOf('app.whenReady()');
const trayAt = main.indexOf('createTray();', readyAt);
const bootAt = main.indexOf('const requested = Number(process.env.NOVAI_PORT)', readyAt);
ok(readyAt > 0 && trayAt > readyAt, 'createTray 在 app.whenReady() 里调用');
ok(bootAt > 0 && trayAt < bootAt, '托盘创建早于后端启动/窗口创建（窗口失败也还有托盘）');

const closeAt = main.indexOf("mainWindow.on('close'");
const closeBlock = main.slice(closeAt, main.indexOf('mainWindow.on(', closeAt + 10));
ok(/if \(!ensureTray\(\)\)/.test(closeBlock), '关窗时先确保托盘可用');
ok(/e\.preventDefault\(\)[\s\S]{0,80}mainWindow\.hide\(\)/.test(closeBlock), '托盘可用时 preventDefault + hide（收进托盘）');
ok(/if \(isQuitting\) return;/.test(closeBlock), '真正退出时放行 close（不被收进托盘挡住）');

const ipcCloseAt = main.indexOf("case 'close':");
const ipcCloseBlock = main.slice(ipcCloseAt, ipcCloseAt + 420);
ok(ipcCloseBlock.indexOf('ensureTray()') > 0 && /mainWindow\.hide\(\)/.test(ipcCloseBlock), '标题栏关闭按钮同样走「关闭到托盘」');
ok(/mainWindow\.close\(\)/.test(ipcCloseBlock), '托盘不可用时自绘关闭按钮退化为普通关闭');

const secondAt = main.indexOf("app.on('second-instance'");
const secondBlock = main.slice(secondAt, secondAt + 400);
ok(secondAt > 0 && secondBlock.indexOf('showMainWindow()') > 0, 'second-instance 唤起已有窗口');
const showAt = main.indexOf('function showMainWindow()');
const showBlock = main.slice(showAt, main.indexOf('// ---------- iframe', showAt));
ok(/mainWindow\.isDestroyed\(\)/.test(showBlock), 'showMainWindow 先判窗口是否已销毁');
ok(/createWindow\(appBaseUrl\)/.test(showBlock), '窗口已销毁时用 appBaseUrl 重建（双击图标不再「没反应」）');
ok(/app\.dock\.show/.test(showBlock), 'macOS 唤起时把 dock 图标找回来');

const wacAt = main.indexOf("app.on('window-all-closed'");
const wacBlock = main.slice(wacAt, main.indexOf('});', main.indexOf('app.quit();', wacAt)) + 3);
ok(wacAt > 0 && /if \(process\.platform === 'darwin'\) return;/.test(wacBlock), 'macOS 关窗后不退出');
ok(/if \(tray\) \{/.test(wacBlock), '非 macOS 只要托盘在就保持进程');
ok(/app\.quit\(\);/.test(wacBlock), '托盘不可用时才退出');

console.log('');
console.log('桌面托盘回归：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
fails.forEach((label) => console.log('  ✗ ' + label));
if (fails.length) process.exitCode = 1;
