/* 设置弹窗右上角关闭按钮「×」：不要底框（背景 / 边框 / 阴影），只留图标。
   钉死：静止态 + hover 态背景都透明；hover 反馈只能靠图标颜色（.nv-icon-btn:hover 的 color）；
   收敛要用关闭按钮自己的 .close 选择器，不能动共用的 .nv-icon-btn:hover（其它图标按钮仍要软底）；
   位置 / 尺寸 / 图标 / aria-label / title / 点击关闭行为不变；static/v2 构建产物里带上这条规则。
   跑法：node tests/test_settings_close_button.js */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const modal = read('web/src/shell/SettingsModal.vue');
const ds = read('web/src/styles/ds.css');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };

console.log('[1] 关闭按钮不再铺底框（只改它自己的 .close 规则）');
const closeRule = (modal.match(/[^{}]*\.nv-icon-btn\.close[^{}]*\{[^}]*\}/) || [''])[0];
ok(closeRule.length > 0, 'SettingsModal 里有针对关闭按钮的 .nv-icon-btn.close 规则');
ok(/\.nv-icon-btn\.close(?![\w-])/.test(closeRule), '选择器带上关闭按钮自己的 .close 类（不牵连别的图标按钮）');
ok(/\.nv-icon-btn\.close:hover/.test(closeRule), 'hover 态一并收敛，不靠共用 :hover 兜底');
ok(/background:\s*transparent/.test(closeRule), '背景置为 transparent（静止态与 hover 态都透明）');
ok(!/!important/.test(closeRule), '不用 !important 硬盖');
ok(!(/\.close\s*\{[^}]*background:\s*var\(--fill-1\)/).test(modal), '旧的 .close { background: var(--fill-1) } 底框已删掉');

console.log('[2] 共用的图标按钮样式没被动过');
ok(/\.nv-icon-btn:hover\s*\{\s*background:\s*var\(--fill-1\)/.test(ds), 'ds.css 里 .nv-icon-btn:hover 仍保留 --fill-1 软底');
ok(/\.nv-icon-btn\s*\{[^}]*color:\s*var\(--ink-2\)/.test(ds) && /\.nv-icon-btn:hover\s*\{[^}]*color:\s*var\(--ink\)/.test(ds), 'hover 反馈的图标颜色（--ink-2 → --ink）还在');

console.log('[3] 位置 / 尺寸 / 图标 / 无障碍 / 点击行为不变');
ok(/class="nv-icon-btn sm round close"/.test(modal), '仍用 nv-icon-btn sm round close（28px 点击区域、圆形命中区不变）');
ok(/title="关闭" aria-label="关闭" @click="close"/.test(modal), 'title / aria-label / 点击关闭行为不变');
ok(/<NvIcon name="x" \/>/.test(modal), '图标仍是 x（线性 ×）');

console.log('[4] 构建产物（Boss 服务器吃 static/v2）也带上这条规则');
const indexHtml = read('static/v2/index.html');
const cssHref = (indexHtml.match(/href="(\/static\/v2\/assets\/[^"]+\.css)"/) || [])[1];
ok(!!cssHref && fs.existsSync(path.join(root, cssHref.replace(/^\//, ''))), 'static/v2/index.html 引用的构建 CSS 存在');
if (cssHref) {
    const css = read(cssHref.replace(/^\//, ''));
    ok(/\.nv-icon-btn\.close[^{}]*\{[^}]*background:transparent/.test(css), '构建 CSS 里关闭按钮背景 transparent');
    ok(/\.nv-icon-btn\.close[^{}]*:hover/.test(css), '构建 CSS 里 hover 态也收敛');
}

console.log('');
if (fails.length) {
    console.error('失败 ' + fails.length + ' 项：');
    fails.forEach(f => console.error('  ✗ ' + f));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项）');
