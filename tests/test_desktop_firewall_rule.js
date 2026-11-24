#!/usr/bin/env node
/*
 * Windows 安装包的局域网防火墙放行（静态验收，零依赖）。
 *
 * 背景（2026-11-24 用户反馈）：有些同事「能加别人，别人加不了他、发不了消息、打不开他的分享」。
 * 桌面版安装包按用户安装、不提权，以前不加任何防火墙规则；Windows 首次弹窗点了取消 / 网络是「公用」
 * 时，别的电脑连不进他的后端（TCP）也收不到他的广播应答（UDP 47823）。
 *
 * 断言：
 *   - customInstall 调用了防火墙放行宏；
 *   - 只在非静默安装时执行（在线更新 /S 不弹任何窗口）；
 *   - 先查规则是否已存在，没有才弹一次 UAC；
 *   - 先删该后端程序名下旧规则（含系统生成的阻止规则），再按程序放行 + UDP 47823 放行，所有网络类型生效。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nsh = fs.readFileSync(path.join(root, 'desktop', 'scripts', 'nsis-data-preserve.nsh'), 'utf8');

let pass = 0;
const fails = [];
const ok = (condition, label) => {
    if (condition) pass += 1;
    else fails.push(label);
};

const macroStart = nsh.indexOf('!macro NOVAI_FIREWALL_ALLOW');
const macroEnd = macroStart >= 0 ? nsh.indexOf('!macroend', macroStart) : -1;
const macro = macroStart >= 0 && macroEnd > macroStart ? nsh.slice(macroStart, macroEnd) : '';
const installStart = nsh.indexOf('!macro customInstall');
const installBody = installStart >= 0 ? nsh.slice(installStart, nsh.indexOf('!macroend', installStart)) : '';

ok(Boolean(macro), '定义了 NOVAI_FIREWALL_ALLOW 宏');
ok(/!insertmacro NOVAI_FIREWALL_ALLOW/.test(installBody), 'customInstall 调用防火墙放行');
ok(/!insertmacro NOVAI_KEEP_RESTORE/.test(installBody), 'customInstall 仍先放回用户数据');
ok(/\$\{IfNot\} \$\{Silent\}/.test(macro), '静默安装 / 在线更新不弹 UAC');
ok(/netsh advfirewall firewall show rule name="\$\{NOVAI_FW_RULE\}"/.test(macro), '先检查规则是否已存在');
ok(/ExecShellWait "runas"/.test(macro), '缺规则时提权一次');
ok(/delete rule name=all program="\$INSTDIR\\resources\\backend\\NOVAI\.exe"/.test(macro), '先删后端程序名下旧规则（含阻止规则）');
ok(/add rule name="\$\{NOVAI_FW_RULE\}" dir=in action=allow program="\$INSTDIR\\resources\\backend\\NOVAI\.exe"[^&]*profile=any/.test(macro),
    '按后端程序放行入站，所有网络类型');
ok(/protocol=UDP localport=47823 profile=any/.test(macro), '放行 UDP 47823 广播发现');

if (fails.length) {
    console.error('防火墙放行静态验收失败 ' + fails.length + ' 项：\n  - ' + fails.join('\n  - '));
    process.exit(1);
}
console.log('防火墙放行静态验收通过（' + pass + ' 项）');
