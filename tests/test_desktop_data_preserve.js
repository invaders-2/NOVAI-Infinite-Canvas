#!/usr/bin/env node
/*
 * 安装 / 更新 / 卸载不碰用户数据的静态验收（零依赖）。
 *
 * 背景：「默认数据根 = 安装目录」之后，data/ assets/ output/ history.json API/ 都在安装目录里。
 * electron-builder 默认卸载会 RMDir /r $INSTDIR（templates/nsis/uninstaller.nsh），
 * 覆盖安装又会先跑上一个版本的卸载器把安装目录清空 —— 不兜底的话用户数据会跟着程序一起没。
 *
 * 这里不做真正打包（成本高），只断言配置与脚本里的保护逻辑仍在：
 *   - desktop/package.json 的 nsis 配置引用了保护脚本，「仅当前用户、可改目录、不升权」没被改坏；
 *   - include 脚本定义了删前暂存 / 删后恢复的钩子，且没有替换 electron-builder 自己的删除逻辑；
 *   - installer.py（传统安装版）覆盖安装跳过用户数据，卸载脚本把数据挪出去再挪回来；
 *   - README 写清数据在哪、卸载是否保留、怎么彻底删除、Linux 只读安装回落 ~/NOVAI。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const desktop = path.join(root, 'desktop');
const readText = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const readJson = (rel) => JSON.parse(readText(rel));

let pass = 0;
const fails = [];
const ok = (condition, label) => {
    if (condition) pass += 1;
    else fails.push(label);
};

console.log('[1] desktop/package.json：NSIS 引用保护脚本，安装方式没被改坏');
const pkg = readJson('desktop/package.json');
const build = pkg.build || {};
const nsis = build.nsis || {};
const NSH_REL = 'scripts/nsis-data-preserve.nsh';
const nshPath = path.join(desktop, NSH_REL);
ok(nsis.include === NSH_REL, 'nsis.include = ' + NSH_REL + '（实际 ' + nsis.include + '）');
ok(fs.existsSync(nshPath), '保护脚本存在：desktop/' + NSH_REL);
ok(nsis.oneClick === false, '仍是向导式安装（能选目录）');
ok(nsis.allowToChangeInstallationDirectory === true, '向导里允许改安装目录');
ok(nsis.perMachine === false, '仍是仅当前用户安装（不要求管理员）');
ok(nsis.allowElevation === false, '安装程序不申请 UAC 提权');
const winTargets = ((build.win || {}).target || []).map((item) => (typeof item === 'string' ? item : item.target));
ok(winTargets.includes('nsis'), 'Windows 目标仍是 nsis（include 才会生效）');
const linux = build.linux || {};
ok(JSON.stringify((linux.target || []).slice().sort()) === JSON.stringify(['AppImage', 'deb']),
   'Linux 仍然只出 AppImage / deb');
ok(typeof linux.description === 'string' && linux.description.includes('~/NOVAI')
   && linux.description.includes('只读安装回落'),
   'deb / AppImage 包说明写清可写安装存安装目录、只读安装回落到 ~/NOVAI');

console.log('[2] NSIS include：删前挪走、删后放回，卸载与覆盖安装两条路都覆盖');
const nsh = fs.existsSync(nshPath) ? fs.readFileSync(nshPath, 'utf8') : '';
const nshCode = nsh.split('\n').filter((line) => !line.trim().startsWith(';')).join('\n');
ok(/!macro customUnInit/.test(nsh), '定义了卸载前钩子 customUnInit');
ok(/!macro customUnInstall/.test(nsh), '定义了卸载后钩子 customUnInstall');
ok(/!macro customInit/.test(nsh), '定义了安装前钩子 customInit');
ok(/!macro customInstall/.test(nsh), '定义了安装后钩子 customInstall');
ok(/Function \.onGUIEnd/.test(nsh) && /NOVAI_KEEP_RESTORE/.test(nsh),
   '安装取消 / 失败时 .onGUIEnd 兜底放回');
['data', 'assets', 'output', 'API', 'history.json'].forEach((name) => {
    ok(nsh.includes(name), '保护名单含 ' + name);
});
ok(nsh.includes('.novai-data-keep') && nsh.includes('$novaiKeepDir'), '用安装目录同级暂存目录（同盘 rename）');
ok(!nshCode.includes('customRemoveFiles'), '不定义 customRemoveFiles（保留 electron-builder 原子删除逻辑）');
ok(!nshCode.includes('RMDir /r $INSTDIR'), '脚本自己不清空安装目录');
ok(nsh.includes('RMDir "$novaiKeepDir"'), '暂存目录只删空的（不 RMDir /r）');
ok(nsh.includes('!include "LogicLib.nsh"'), '显式引入 LogicLib（include 在模板头部，不能依赖后文）');
ok(nsh.includes('!ifndef BUILD_UNINSTALLER') && nsh.includes('!ifdef BUILD_UNINSTALLER'),
   '安装 / 卸载两套钩子按 BUILD_UNINSTALLER 分开');

console.log('[2b] 卸载三选一：保留 / 一并删除 / 取消');
const macroBlock = (text, start) => {
    const i = text.indexOf(start);
    if (i < 0) return '';
    const j = text.indexOf('!macroend', i);
    return j < 0 ? text.slice(i) : text.slice(i, j);
};
const unInitBlock = macroBlock(nsh, '!macro customUnInit');
const unInstallBlock = macroBlock(nsh, '!macro customUnInstall');
const silentGuard = /\$\{IfNot\} \$\{Silent\}/;
ok(unInitBlock.includes('MB_YESNOCANCEL') && unInitBlock.includes('user32::MessageBox'), '卸载前弹「保留 / 一并删除 / 取消」三选一');
ok(/\$0 == 6/.test(unInitBlock) && /\$0 == 7/.test(unInitBlock), '是（6）= 一并删除、否（7）= 保留数据');
ok(unInitBlock.includes('0x133') && unInitBlock.includes('MB_DEFBUTTON2'), '默认按钮是「否 = 保留数据」（原生 MessageBox 不支持，改用 user32::MessageBox）');
ok(unInitBlock.includes('Abort'), '选取消会 Abort 中止卸载');
ok(silentGuard.test(unInitBlock) && unInitBlock.search(silentGuard) < unInitBlock.indexOf('MB_YESNOCANCEL'),
   '弹窗在 ${IfNot} ${Silent} 里（静默卸载 / 升级不弹）');
ok(!unInitBlock.slice(0, unInitBlock.search(silentGuard)).includes('MessageBox'), '静默分支没有弹窗');
ok(/StrCpy \$novaiDeleteData "0"/.test(unInitBlock), '默认按「保留」处理');
ok(unInitBlock.includes('NOVAI_KEEP_BEGIN') && /novaiDeleteData == "0"/.test(unInitBlock),
   '选保留仍走「删前挪走 → 删程序 → 挪回」');
ok(nsh.includes('Var novaiDeleteData') && /novaiDeleteData == "1"/.test(unInstallBlock), '选一并删除有独立分支');
ok(unInstallBlock.includes('RMDir /r "$APPDATA\\NOVAI"'), '一并删除才清 %APPDATA%\\NOVAI');
ok(unInstallBlock.indexOf('RMDir /r "$APPDATA\\NOVAI"') > unInstallBlock.indexOf('novaiDeleteData == "1"'),
   '删 %APPDATA%\\NOVAI 只在 IDYES 分支');
ok(/\$\{Else\}/.test(unInstallBlock) && unInstallBlock.indexOf('NOVAI_KEEP_RESTORE') > unInstallBlock.search(/\$\{Else\}/),
   '保留分支仍挪回数据并提示路径');

console.log('[3] installer.py：传统安装版覆盖安装与卸载同样保留数据');
const installer = readText('installer.py');
ok(installer.includes("PRESERVE_DIRS = ('data', 'output', 'assets', 'API')"), '有保护目录清单');
ok(installer.includes("PRESERVE_FILES = ('history.json',)"), '有保护文件清单');
ok(installer.includes('item not in PRESERVE_DIRS'), '覆盖安装不再 rmtree 用户目录');
ok(installer.includes('item in PRESERVE_FILES'), '覆盖安装不覆盖已有的 history.json');
ok(installer.includes('NOVAI-data-keep') && installer.includes('set "KEEP='), '卸载脚本有暂存目录');
ok(installer.includes('move /y') && installer.includes('rmdir /s /q "{INSTALL_DIR}"'),
   '卸载脚本先挪出数据再删程序文件');
ok((installer.match(/move \/y/g) || []).length >= 4, '卸载脚本把数据挪回安装目录');
ok(installer.includes('用户数据保留在'), '卸载完成提示数据保留位置');
ok(installer.includes('YesNoCancel') && installer.includes('System.Windows.Forms.MessageBox'),
   '卸载脚本用 PowerShell MessageBox 弹 YesNoCancel');
ok(installer.includes('MessageBoxDefaultButton]::Button2'), '传统卸载默认按钮也是「否 = 保留数据」');
ok(/if "%ANSWER%"=="2"/.test(installer) && installer.includes('exit /b'), '选取消 exit /b，不卸载');
ok(/if "%ANSWER%"=="6" set "DELDATA=1"/.test(installer), '选是才置 DELDATA=1');
ok(/:novai_delete_all/.test(installer) && /goto novai_delete_all/.test(installer),
   'DELDATA=1 走整体删除分支');
ok(installer.includes('rmdir /s /q "%APPDATA%\\\\NOVAI"'), '选一并删除才清 %APPDATA%\\NOVAI');

console.log('[4] README：数据在哪 / 卸载是否保留 / 怎么彻底删除 / Linux 只读安装');
const readme = readText('README.md');
ok(readme.includes('### 数据目录与卸载'), '有「数据目录与卸载」小节');
ok(readme.includes('默认把用户数据放在安装目录'), '说明 Windows 默认数据在安装目录');
ok(readme.includes('卸载只删程序文件'), '说明卸载保留数据');
ok(readme.includes('彻底删除'), '说明怎么彻底删除');
ok(readme.includes('AppImage') && readme.includes('deb'), '提到 Linux AppImage 与 deb');
ok(readme.includes('~/NOVAI') && readme.includes('数据回落') && readme.includes('数据默认跟安装目录走'),
   '说明 Linux 只读安装回落 ~/NOVAI、可写安装跟安装目录走');
ok(readme.includes('一并删除') && readme.includes('保留数据（默认）'), '说明卸载会问「保留（默认）/ 一并删除」');
ok(readme.includes('静默卸载 / 安装包升级'), '说明静默卸载 / 升级按保留处理');

console.log('');
if (fails.length) {
    console.log('安装/卸载数据保护静态断言失败 ' + fails.length + ' 项：');
    fails.forEach((label) => console.log('  - ' + label));
    process.exit(1);
}
console.log('安装/卸载数据保护静态断言全部通过（' + pass + ' 项）');
