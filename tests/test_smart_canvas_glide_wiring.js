/* 智能画布 NovaGlide（滑块高亮）接线的静态断言。
   钉死五组目标各自的 attach 落点、每个落点都走「只接一次」的 attachGlideHost、
   以及「深底 + 反色文字」的选中项在滑块 host 内被拉回可读色。
   跑法：node tests/test_smart_canvas_glide_wiring.js */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const html = read('static/smart-canvas.html');
const js = read('static/js/smart-canvas.js');
const glide = read('static/js/shared/glide.js');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };
const count = (src, re) => (src.match(re) || []).length;
/* 取一个零参函数体的源码（到顶格的 } 为止） */
const fnBody = (src, name) => (src.match(new RegExp('function ' + name + '\\(\\)\\{([\\s\\S]*?)\\n\\}')) || [])[1] || '';

console.log('[1] A 斜杠指令菜单（#slashMenu / #slashSub）');
ok(js.includes("attachGlideHost(target, {item: '.slash-item'});"), "renderSlashItems 里 attach '.slash-item'");
const renderSlash = (js.match(/function renderSlashItems\(items, target, isRoot\)\{([\s\S]*?)\n\}/) || [])[1] || '';
const slashHtmlAt = renderSlash.indexOf('target.innerHTML = items.map(buildItemHtml).join');
const slashAttachAt = renderSlash.indexOf("attachGlideHost(target, {item: '.slash-item'})");
ok(slashHtmlAt > -1 && slashAttachAt > slashHtmlAt, 'attach 在 innerHTML 重写之后（选项那时才存在）');
ok(js.includes('refreshGlideHost(slashSub);'), '#slashSub 每次悬停分类重写后补一次 refresh');
const subRenderAt = js.indexOf('renderSlashItems(item.children, slashSub, false);');
const subOpenAt = js.indexOf('slashSub.classList.add', subRenderAt);
const subRefreshAt = js.indexOf('refreshGlideHost(slashSub);', subRenderAt);
ok(subRenderAt > -1 && subOpenAt > subRenderAt && subRefreshAt > subOpenAt, 'refresh 排在「重写子菜单 + 展开」之后');
const openSlashFn = (js.match(/function openSlashMenu\(\)\{([\s\S]*?)\n\}/) || [])[1] || '';
ok(/slashMenu\.classList\.add\('open'\);\n\s*refreshGlideHost\(slashMenu\);/.test(openSlashFn), '#slashMenu 在 open 之后 refresh（display:none 里量不到尺寸）');

console.log('[2] B @ 提及选择器（三种列表）');
ok(js.includes("attachGlideHost(mentionPicker.querySelector('.mention-option-grid'), {item: '.mention-option', orientation: 'grid'});"), 'mention-option-grid 用 grid 语义（二维位移）');
ok(js.includes("attachGlideHost(mentionPicker.querySelector('.mention-folder-chips'), {item: '.mention-folder-chip', orientation: 'horizontal'});"), 'mention-folder-chips 横向');
ok(js.includes("attachGlideHost(mentionPicker.querySelector('.mention-source-tabs'), {item: '.mention-source-tab', orientation: 'horizontal'});"), 'mention-source-tabs 横向');
const renderMention = (js.match(/function renderMentionPicker\(source\)\{([\s\S]*?)\n\}/) || [])[1] || '';
const mentionHtmlAt = renderMention.indexOf('mentionPicker.innerHTML =');
const mentionOpenAt = renderMention.indexOf("mentionPicker.classList.add('open')");
const mentionAttachAt = renderMention.indexOf("attachGlideHost(mentionPicker.querySelector('.mention-option-grid')");
ok(mentionHtmlAt > -1 && mentionOpenAt > mentionHtmlAt && mentionAttachAt > mentionOpenAt, '三处 attach 都在「写完 innerHTML + open」之后（那时才量得到尺寸）');

console.log('[3] C 尺寸选择弹窗（world 收尾钩子）');
const wirePicker = (js.match(/function wireSizePickerGlide\(root\)\{([\s\S]*?)\n\}/) || [])[1] || '';
ok(wirePicker.length > 200, '有 wireSizePickerGlide(root)');
ok(wirePicker.includes("root.querySelectorAll('.size-picker-popover, .loop-number-grid')"), '一次扫描拿到尺寸弹窗与 Loop 数字面板');
ok(wirePicker.includes("host.querySelector('.size-picker-scope')") && wirePicker.includes("{item: 'button', orientation: 'horizontal'}"), 'size-picker-scope 的「自动/系统参数/自定义」接上');
ok(wirePicker.includes("host.querySelectorAll('.size-picker-list')") && wirePicker.includes("{item: '.size-picker-option'}"), '两个 size-picker-list（比例 / 分辨率）各接一条');
ok(wirePicker.includes('if(!hosts.length) return;'), 'root 里没有目标时直接早退（render 很频繁）');
const renderFn = (js.match(/function render\(\)\{([\s\S]*?)\n    return;/ ) || [])[1] || '';
const iconsAt = renderFn.indexOf('lucide.createIcons()');
const wireAt = renderFn.indexOf('wireSizePickerGlide(world);');
ok(iconsAt > -1 && wireAt > iconsAt, '钩子排在 render() 的 lucide.createIcons() 之后（图标替换完几何才定）');
ok(/wireSizePickerGlide\(world\);\n\s*sbSyncStarBorderFrames\(\);/.test(renderFn.slice(wireAt)), '钩子落在 flushContentMeasurements / refreshRunTimerPills 那串收尾调用里');
/* 真实落点：尺寸弹窗在 composer 的 dynamicParams 里（屏幕空间），HTML 由 renderDynamicParams 重建 */
const paramsFn = (js.match(/function renderDynamicParams\([^)]*\)\{([\s\S]*?)\n\}/) || [])[1] || '';
const paramsIconsAt = paramsFn.indexOf('lucide.createIcons()');
const paramsWireAt = paramsFn.indexOf('wireSizePickerGlide(dynamicParams);');
ok(paramsIconsAt > -1 && paramsWireAt > paramsIconsAt, 'renderDynamicParams() 收尾也补一次（切引擎/点分段控件会绕过 render() 重建参数面板）');

console.log('[3b] C2 参数行同族弹层（质量 / 数量 / 画幅 / 时长 / 平台 / 模型 / 视频分辨率）');
const paramGroups = (js.match(/const GLIDE_OPTION_GROUPS = \[([\s\S]*?)\];/) || [])[1] || '';
[["'.seg-row'", "'button'", '质量 / 图片分辨率'],
 ["'.count-grid'", "'.count-cell'", '数量'],
 ["'.ratio-grid'", "'.ratio-option'", '图片比例 / 视频画幅'],
 ["'.duration-grid'", "'.duration-option'", '视频时长'],
 ["'.model-list'", "'.direct-option'", '平台 / 模型 / 视频分辨率']].forEach(([host, item, label]) => {
    ok(paramGroups.includes(host) && paramGroups.includes(item), '参数组接线：' + label + '（' + host + ' → ' + item + '）');
});
const paramFn = (js.match(/function wireSmartParamsGlide\(root\)\{([\s\S]*?)\n\}/) || [])[1] || '';
ok(paramFn.length > 100, '有 wireSmartParamsGlide(root)');
ok(paramFn.includes('attachGlideHost(host, {item: itemSel'), '每个参数组都走 attachGlideHost 守卫（不裸调 NovaGlide.attach）');
ok(paramFn.includes('root.querySelectorAll(hostSel)'), '按 root 扫，只扫 composer 参数行（节点 DOM 里没有这些弹层）');
ok(/wireSizePickerGlide\(dynamicParams\);\n\s*wireSmartParamsGlide\(dynamicParams\);/.test(js), 'renderDynamicParams 收尾：尺寸弹窗与同族弹层一起接（顺序固定）');
ok(!/wireSmartParamsGlide\(world\)/.test(js), '不为参数行去扫 world（这些弹层不在 world 里，白扫一遍全树）');

console.log('[4] D 创建菜单 / E 导出菜单（静态弹层，初始化接线）');
ok(js.includes("attachGlideHost(createMenu, {item: '.menu-btn'});"), '.create-menu 接 .menu-btn');
ok(js.includes("attachGlideHost(smartExportMenu, {item: '.smart-export-item'});"), '.smart-export-menu 接 .smart-export-item');
const staticFn = fnBody(js, 'wireStaticMenuGlide');
ok(staticFn.includes("createMenu") && staticFn.includes("smartExportMenu"), '两个静态弹层同一个初始化函数');
ok(js.includes('wireStaticMenuGlide();') && /window\.onload = async \(\) => \{\n\s*initSmartNodeMenuMotion\(world\);\n\s*wireStaticMenuGlide\(\);/.test(js), 'onload 里接一次线（DOM 不重建，不需要每次 render 重扫）');
ok(html.includes('id="createMenu" class="create-menu"') && count(html, /class="menu-btn"/g) >= 2, 'HTML 里 .create-menu > .menu-btn 结构不变');
ok(html.includes('id="smartExportMenu" class="smart-export-menu"') && count(html, /class="smart-export-item"/g) >= 2, 'HTML 里 .smart-export-menu > .smart-export-item 结构不变');

console.log('[5] 只 attach 一次：WeakSet + 滑块存活判断 + 模块自身的 destroy');
ok(js.includes('const glideHosts = new WeakSet();'), 'WeakSet 记账已接线的 host（元素被换掉后条目自动消失，不泄漏）');
ok(js.includes('if(glideHosts.has(host) && host.querySelector(') && js.includes("api.PILL_CLASS)"), '已接线且滑块还在 → 直接返回旧 controller');
ok(/function attachGlideHost\(host, options\)\{[\s\S]*?glideHosts\.add\(host\);\n\s*return api\.attach\(host, options\);/.test(js), 'attach 只发生在记账之后');
ok(js.includes("if(!host || !api || typeof api.attach !== 'function') return null;"), 'NovaGlide 没加载时不抛错、不影响渲染');
ok(count(js, /NovaGlide\.attach\(/g) === 0, 'smart-canvas.js 里没有绕过守卫的裸 NovaGlide.attach 调用');
ok(/if\(container\.__nvGlide && typeof container\.__nvGlide\.destroy === 'function'\) container\.__nvGlide\.destroy\(\);/.test(glide), 'glide.js 自己也会先 destroy 旧实例（第二层保险）');
ok(/destroy\(\)\{\n\s*observer\.disconnect\(\);/.test(glide) && glide.includes('delete container.__nvGlide;'), 'destroy 会断开 observer 并摘掉引用（旧 DOM 被整体替换时不泄漏）');
/* 真的跑一遍守卫：同一个 host 连调两次只能 attach 一次；innerHTML 把滑块抹掉后要能重新接上 */
const guardSrc = (js.match(/const glideHosts = new WeakSet\(\);[\s\S]*?\n\}\n/) || [])[0];
const attachCalls = [];
const makeHost = () => { const children = []; return { children, __nvGlide: null, querySelector(sel){ const pill = children[0]; return (String(sel).includes('nv-glide-pill') && pill && pill.classList.contains('nv-glide-pill')) ? pill : null; } }; };
const fakeWindow = { NovaGlide: { PILL_CLASS: 'nv-glide-pill', attach(host, options){ attachCalls.push(options); host.__nvGlide = {refresh(){}, destroy(){}}; host.children.unshift({classList:{contains: c => c === 'nv-glide-pill'}}); return host.__nvGlide; } } };
let attachGlideHost = null;
try { attachGlideHost = new Function('window', guardSrc + '\nreturn attachGlideHost;')(fakeWindow); } catch(error) { /* 语法变了就下面断言失败 */ }
ok(typeof attachGlideHost === 'function', '守卫函数能独立求值（源码抽取成功）');
if(typeof attachGlideHost === 'function'){
    const host = makeHost();
    attachGlideHost(host, {item: '.x'});
    attachGlideHost(host, {item: '.x'});
    attachGlideHost(host, {item: '.x'});
    ok(attachCalls.length === 1, '同一个 host 连调三次只 attach 一次（实际 ' + attachCalls.length + ' 次）');
    attachGlideHost(makeHost(), {item: '.x'});
    ok(attachCalls.length === 2, '不同 host 各接各的');
    host.children.length = 0;   // innerHTML 重写把滑块抹掉
    attachGlideHost(host, {item: '.x'});
    ok(attachCalls.length === 3, 'innerHTML 抹掉滑块后再渲染会重新接（#slashSub 每次悬停都走这条路）');
}
ok(!/function wireSmartWorldGlide\(\)\{[\s\S]*?NovaGlide\.attach/.test(js), 'world 钩子不绕过守卫');

console.log('[6] 样式：底色 token + 反色文字拉回 + 不用深底 --strong');
ok(html.includes('.size-picker-list.nv-glide-host { --nv-glide-bg: var(--soft); }'), '尺寸列表用弹层 hover 底 --soft');
ok(/\.mention-option-grid\.nv-glide-host,[\s\S]{0,240}--nv-glide-bg: var\(--soft\);/.test(html), '@ 提及的缩略图/文件夹 chip 用 --soft');
ok(/\.mention-source-tabs\.nv-glide-host,[\s\S]{0,200}\.loop-number-grid\.nv-glide-host \{ --nv-glide-bg: var\(--card\); \}/.test(html), '容器自己就是 --soft 底的分段控件改用选中底色 --card');
ok(!/--nv-glide-bg: var\(--strong/.test(html), '滑块底色不用深底 --strong（否则文字必隐形）');
const activeTextRule = (html.match(/\.mention-folder-chips\.nv-glide-host \.mention-folder-chip\.active,[\s\S]*?\{ color: var\(--text\); \}/) || [])[0] || '';
ok(activeTextRule.length > 0, '「深底 + 反色文字」的选中项有一条合并规则把文字拉回 var(--text)');
['.mention-folder-chip.active', '.mention-source-tab.active', '.loop-number-cell.active'].forEach(sel => {
    ok(activeTextRule.includes(sel), '这条规则覆盖：' + sel);
});
ok(html.includes('.mention-folder-chips.nv-glide-host .nv-glide-pill { border-radius: var(--radius-full); }'), '圆形 chip 上的滑块跟着圆');
ok(html.includes('.mention-option-grid.nv-glide-host .mention-option:hover { transform: none; }'), '缩略图悬停上浮会与滑块差 1px，滑块 host 内关掉');
/* 参数行同族弹层：容器自己是 --soft 底的用 --card；容器透明的用 --soft（它们的 hover 底色 --card 浅色下是白色，看不见） */
ok(/\.seg-row\.nv-glide-host,\n\.count-grid\.nv-glide-host \{ --nv-glide-bg: var\(--card\); \}/.test(html), '质量/数量（容器自身 --soft 底）滑块改用 --card 才看得见');
ok(/\.ratio-grid\.nv-glide-host,\n\.duration-grid\.nv-glide-host,\n\.model-list\.nv-glide-host \{ --nv-glide-bg: var\(--soft\); \}/.test(html), '画幅/时长/平台模型（容器透明）滑块用 --soft，不用它的 --card 白底');
ok(/\.seg-row\.nv-glide-host button\.active,\n\.count-grid\.nv-glide-host \.count-cell\.active \{ color: var\(--text\); \}/.test(html), '质量/数量的「深底 + 反色文字」选中项文字拉回可读色');
ok(html.includes('.model-list.nv-glide-host .direct-option:hover { transform: none; }'), '.direct-option 悬停上浮同样会让滑块差 1px，滑块 host 内关掉');

console.log('[7] 资源顺序：滑块样式/脚本都得排在页面样式与 smart-canvas.js 之前');
const glideCssAt = html.indexOf('css/glide.css');
const glideJsAt = html.indexOf('js/shared/glide.js');
const smartCssAt = html.indexOf('css/smart-canvas.css');
const smartJsAt = html.indexOf('js/smart-canvas.js?v=');
const pageStyleAt = html.indexOf('--nv-glide-bg');
ok(glideCssAt > -1 && smartCssAt > -1 && glideCssAt > smartCssAt, 'glide.css 排在 smart-canvas.css 之后（压制规则才压得住）');
ok(pageStyleAt > glideCssAt, '页面 <style> 排在 glide.css 之后（--nv-glide-bg / 文字色覆盖才生效）');
ok(glideJsAt > -1 && smartJsAt > glideJsAt, 'glide.js 先于 smart-canvas.js 执行（window.NovaGlide 已就绪）');
ok(html.includes('shared/glide.js?v=') && html.includes('css/glide.css?v='), '页面确实引入了模块的 js + css');

console.log('');
if(fails.length){
    console.error('失败 ' + fails.length + ' 项：');
    fails.forEach(f => console.error('  ✗ ' + f));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项）');
