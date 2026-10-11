/* 智能画布工具栏「无损改图」入口的回归测试。
   用户需求：图片节点悬浮工具条加一颗「无损改图」（lucide 线性 eraser）；
   第 45 轮缩短工具条后它从常驻条挪进末端「…」溢出菜单 —— 入口还在、图标 / 文案 / 提示 / 禁用逻辑一字未改，
   只是换了个地方点（见 tests/artifacts/verify-scripts/verify_toolbar_overflow.py）。
   点它打开已有的图片编辑弹窗并切到 lossless 模式；弹窗底部「应用」在新模式下生成一张
   新图片节点（标题「无损改图」），并把当前节点的图带进本地内置工具
   （static/tools/lossless-edit/index.html，CC BY-NC-SA 4.0，作者 陶醉）。
   跑法：node tests/test_smart_canvas_lossless_edit_entry.js */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

/* 版本号不写死：能读到项目版本（desktop/package.json，退回 VERSION）就比对当前版本，
   读不到只守形状，保证「已按 main.py 规则重写过」这个意图不丢。 */
const projectVersion = (() => {
    try {
        const version = JSON.parse(fs.readFileSync(path.join(root, 'desktop/package.json'), 'utf8')).version;
        if(version) return String(version);
    } catch(e) {}
    try {
        return fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim().split('\n')[0].trim();
    } catch(e) {}
    return '';
})();

/* 只守形状与项目版本：git 检出不保留 mtime，强求 ?v= 里的 mtime 等于当前文件 mtime 在 CI 上必然失败
   （与 test_glide / test_gpt_chat_reasoning 的缓存串断言同一口径）。 */
const versionTagOk = value => {
    const text = String(value || '');
    if(!/^\d+(\.\d+)+$/.test(text)) return false;
    return projectVersion ? text.slice(0, text.lastIndexOf('.')) === projectVersion : true;
};

const js = read('static/js/smart-canvas.js');
const html = read('static/smart-canvas.html');
const css = read('static/css/smart-canvas.css');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };

function topLevelFunction(src, name){
    const lines = src.split('\n');
    const start = lines.findIndex(line => line.startsWith('function ' + name + '('));
    if(start < 0) return '';
    for(let i = start + 1; i < lines.length; i += 1){
        if(lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const versionOf = (page, file) => {
    const m = page.match(new RegExp(escapeRe(file) + '\\?v=([^"\'<>\\s]+)'));
    return m ? m[1] : '';
};
const mtimeOf = value => Number(String(value || '').split('.').pop());

console.log('[1] 工具条：无损改图入口在「…」溢出菜单里（第 45 轮缩短工具条后挪的位置）');
const toolbarFn = topLevelFunction(js, 'smartNodeToolbarHtml');
ok(toolbarFn.length > 0, '有 smartNodeToolbarHtml');
ok(toolbarFn.indexOf("iconButton('lossless-edit'") < 0, '常驻条上不再直接放它（已收纳进「…」）');
const overflowRow = topLevelFunction(js, 'smartToolOverflowRow');
const overflowHtml = topLevelFunction(js, 'smartToolOverflowRowHtml');
ok(/rows:\s*\["lossless-edit"\]/.test(js), '「…」菜单的收纳清单里有 lossless-edit');
ok(/'lossless-edit':\s*\['eraser',\s*'无损改图'/.test(overflowRow), '入口：key=lossless-edit、图标 eraser、文案「无损改图」');
ok(/只把改动那块合进来，其余像素与原图一致/.test(overflowRow), '提示文案说清「只合改动那块，其余像素与原图一致」');
ok(/smartToolOverflowRowHtml\(key, rows\[0\], rows\[1\], rows\[2\], canEditImage, nodeId\)/.test(overflowRow), '按钮跟着 canEditImage 一起灰（只有图片能点）');
ok(/data-smart-node-action/.test(overflowHtml) && /enabled \? '' : ' disabled'/.test(overflowHtml), '渲染成菜单项：带 data-smart-node-action，禁用态照旧生效');
ok((js.match(/'lossless-edit':/g) || []).length === 1, '只列了一次，没有重复');

console.log('[2] 动作分发：跟调色一模一样');
const actionFn = topLevelFunction(js, 'runSmartNodeToolbarAction');
ok(/if\(action === 'lossless-edit'\)\{\s*openImageEditor\(nodeId, index\);\s*setImageEditMode\('lossless', true\);\s*return;\s*\}/.test(actionFn),
    'lossless-edit 分支 = openImageEditor + setImageEditMode(lossless, true) + return');

console.log('[3] setImageEditMode：模式/class/面板/文案/钩子');
const modeFn = topLevelFunction(js, 'setImageEditMode');
ok(modeFn.length > 0, '有 setImageEditMode');
ok(/imageEditMode = \[[^\]]*'adjust','lossless'\]/.test(modeFn), '模式白名单包含 lossless');
ok(/classList\.toggle\('lossless-mode', imageEditMode === 'lossless'\)/.test(modeFn), 'lossless 时 cropCanvas 加 .lossless-mode');
ok(/getElementById\('imageLosslessTools'\)\?\.classList\.toggle\('active', imageEditMode === 'lossless'\)/.test(modeFn), '切换 #imageLosslessTools 的 active');
ok(/prev === 'lossless'[\s\S]{0,140}window\.losslessEditLeaveMode/.test(modeFn), '离开 lossless 调 window.losslessEditLeaveMode');
ok(/imageEditMode === 'lossless'[\s\S]{0,180}window\.losslessEditEnterMode/.test(modeFn), '进入 lossless 调 window.losslessEditEnterMode');
ok(/'无损改图'/.test(modeFn) && /应用无损改图/.test(modeFn), '标题「无损改图」+ 应用按钮「应用无损改图」');
ok(/'上传原图 \+ AI 改后的图/.test(modeFn), '副标题说明「原图 + AI 改后的图」用法');
ok(/data-lucide="eraser"/.test(modeFn), '应用按钮用 eraser 图标');

console.log('[4] 应用分发：applyImageEdit → applyLosslessEdit');
const applyFn = topLevelFunction(js, 'applyImageEdit');
ok(/if\(imageEditMode === 'lossless'\) return applyLosslessEdit\(\);/.test(applyFn), 'applyImageEdit 里 lossless 分支走 applyLosslessEdit');
const applyStart = js.indexOf('async function applyLosslessEdit(');
ok(applyStart >= 0, '有 applyLosslessEdit');
const applyLossless = applyStart < 0 ? '' : js.slice(applyStart, js.indexOf('\n}\n', applyStart) + 3);
ok(/losslessEditRequestResult\(\)/.test(applyLossless), '向 iframe 要结果走 losslessEditRequestResult');
ok(/_lossless\.png/.test(applyLossless), '文件名参考调色：<原图名>_lossless.png');
ok(/window\.losslessEdit\.upload\(/.test(applyLossless) && /window\.losslessEdit\.addResult\(/.test(applyLossless) && /window\.losslessEdit\.finish\(\)/.test(applyLossless),
    '拿到结果：upload → addResult → finish');
ok(/toast\('无损改图失败/.test(applyLossless), '出错/超时用 toast 提示，不静默');
ok(/losslessEditRequestResult\(timeoutMs=15000\)/.test(js), '请求结果默认 15s 超时');

console.log('[5] iframe 协议：标记 / 校验来源 / 懒创建 / 不反复重载');
ok(js.indexOf("const LOSSLESS_EDIT_SOURCE = 'novai-lossless-edit';") >= 0, '工具侧回发标记 novai-lossless-edit 齐全');
ok(js.indexOf("const LOSSLESS_EDIT_HOST_SOURCE = 'novai-lossless-edit-host';") >= 0, '宿主请求标记 novai-lossless-edit-host 齐全');
ok(/losslessEditPost\('prefill'/.test(js) && /losslessEditPost\('request-result'\)/.test(js), '宿主 → 工具：prefill 与 request-result 都发');
ok(/event\.source !== target\) return;/.test(js), '收消息校验 event.source（只认本 iframe）');
ok(/target\.postMessage\([\s\S]{0,200}location\.origin\)/.test(js), '发消息 targetOrigin 用 location.origin');
ok(js.indexOf("'/static/tools/lossless-edit/index.html?'") >= 0, 'iframe 地址指向本地内置工具');
ok(/params\.set\('embed', '1'\)/.test(js) && /params\.set\('orig', src\.orig\.url\)/.test(js) && /params\.set\('ai', src\.ai\.url\)/.test(js), 'URL 带 embed=1/orig/ai（ai 可省）');
ok(/document\.createElement\('iframe'\)/.test(js) && /frame\.title = '无损改图'/.test(js) && /frame\.setAttribute\('allow'/.test(js), 'iframe 懒创建（进入模式才插）+ title + allow');
ok(/frame\.dataset\.losslessSource === key\) return;/.test(js), '同一节点的同一组图重复进入不重载 iframe（保住工具内进度）');
ok(/dataset\.losslessSource = key;[\s\S]{0,200}losslessEditPost\('prefill'/.test(js), '换图/换节点才走 prefill 消息，不换 src');

console.log('[6] window.losslessEdit 桥：取图 / 上传 / 建节点 / 连线 / 收尾');
ok(js.indexOf('window.losslessEdit = {') >= 0, 'window.losslessEdit 桥存在');
const bridgeAt = js.indexOf('window.losslessEdit = {');
const bridge = bridgeAt < 0 ? '' : js.slice(bridgeAt, js.indexOf('\n};', bridgeAt) + 3);
ok(/sourcesFor: function\(node, index\)/.test(bridge), '桥里有 sourcesFor 取图 helper');
ok(/upload: function\(blob, name\)\{ return uploadCroppedBlob\(blob, name\); \}/.test(bridge), 'upload 复用 uploadCroppedBlob');
ok(/addResult: async function/.test(bridge), '有 addResult');
ok(/outNode\.title = '无损改图'/.test(bridge), 'addResult 生成的新节点标题「无损改图」');
ok(/addConnection\(node\.id, outNode\.id\)/.test(bridge), 'addResult 把源图连到新节点');
ok(/\(layout\.width \|\| 260\) \+ 40/.test(bridge) && /\(node\.y \|\| 0\) \+ 12/.test(bridge), '新节点在源图右边 40px、y+12（跟调色同一套布局）');
ok(/finish: function\(\)\{ closeImageEditor\(\); render\(\); scheduleSave\(\); \}/.test(bridge), 'finish = closeImageEditor + render + scheduleSave');

console.log('[7] 行为：sourcesFor 的预填规则（新口径：只填右侧 ai，左侧留空）');
{
    const bridgeObj = bridge.slice(bridge.indexOf('{'), bridge.lastIndexOf('}') + 1);
    const sourcesForOf = new Function('imageForDisplay', 'return (' + bridgeObj + ').sourcesFor;')(item => item);
    const two = sourcesForOf({id:'n1', images:[{url:'a.png'}, {url:'b.png'}]}, 1);
    ok(two.orig === null && two.ai && two.ai.url === 'b.png', 'index=1 → 修改图取第 2 张带 url 的图、原图留空（orig === null）');
    const first = sourcesForOf({id:'n1', images:[{url:'a.png'}, {url:'b.png'}]}, 0);
    ok(first.orig === null && first.ai && first.ai.url === 'a.png', 'index=0 → 修改图取第 1 张带 url 的图、原图留空');
    const one = sourcesForOf({id:'n2', images:[{url:'a.png'}]}, 0);
    ok(one.orig === null && one.ai && one.ai.url === 'a.png', '只有一张 → 修改图就是它、原图留空');
    const gap = sourcesForOf({id:'n3', images:[{url:'a.png'}, {name:'占位没有 url'}, {url:'b.png'}]}, 2);
    ok(gap.orig === null && gap.ai && gap.ai.url === 'b.png', '按 node.images 原下标取：index=2 → 第 3 槽的 b.png（点击的就是它）');
    const gapMiss = sourcesForOf({id:'n3', images:[{url:'a.png'}, {name:'占位没有 url'}, {url:'b.png'}]}, 1);
    ok(gapMiss.orig === null && gapMiss.ai && gapMiss.ai.url === 'a.png', 'index 指到没有 url 的槽位 → 退回第一张带 url 的图');
    const bad = sourcesForOf({id:'n4', images:[{url:'a.png'}, {url:'b.png'}]}, 9);
    ok(bad.orig === null && bad.ai && bad.ai.url === 'a.png', 'index 非法（越界）→ 退回第一张带 url 的图');
    const neg = sourcesForOf({id:'n5', images:[{url:'a.png'}, {url:'b.png'}]}, -1);
    ok(neg.orig === null && neg.ai && neg.ai.url === 'a.png', 'index 非法（负数）→ 退回第一张');
    const none = sourcesForOf({id:'n6', images:[{name:'占位没有 url'}]}, 0);
    ok(none.orig === null && none.ai === null, '没有带 url 的图 → 两侧都空');
}

console.log('[8] 面板容器与 CSS（不画边框/发丝线，用留白与圆角）');
ok(html.indexOf('id="imageLosslessTools"') >= 0, 'HTML 里有 #imageLosslessTools 容器');
ok(/<div id="imageLosslessTools" class="image-edit-tools image-lossless-tools"><\/div>/.test(html), '容器沿用 .image-edit-tools 约定，空壳（iframe 由 JS 懒创建）');
ok(html.indexOf('id="imageLosslessTools"') > html.indexOf('id="imageGridTools"'), '#imageLosslessTools 参照 #imageGridTools 的位置');
ok(html.indexOf('id="imageLosslessTools"') < html.indexOf('id="imageEditStage"'), '容器在图片区之前');
ok(/\.image-lossless-tools\{[^}]*flex:1 1 auto/.test(css), 'CSS：进入模式的面板吃掉剩余高度');
ok(/\.image-lossless-tools\.active\{display:flex;\}/.test(css), 'CSS：.active 时显示');
ok(/\.lossless-edit-frame\{[^}]*width:100%;height:100%/.test(css), 'CSS：iframe 填满面板');
ok(/\.lossless-edit-frame\{[^}]*border:0[^}]*border-radius:var\(--radius-xl\)/.test(css), 'CSS：去掉 iframe 默认边框，用圆角容器（不画发丝线）');

console.log('[9] 打包件存在（另一执行岗产出的上游件）');
['static/tools/lossless-edit/index.html',
 'static/tools/lossless-edit/vendor/ag-psd.js',
 'static/tools/lossless-edit/LICENSE.md',
 'static/tools/lossless-edit/NOTICE.md'].forEach(file => {
    ok(fs.existsSync(path.join(root, file)), '打包件存在：' + file);
});

console.log('[10] 缓存戳：?v= 是「项目版本.mtime」形式');
['static/js/smart-canvas.js', 'static/css/smart-canvas.css'].forEach(file => {
    const tag = versionOf(html, file);
    ok(versionTagOk(tag), file + ' 的 ?v= 是「项目版本.mtime」形式（' + tag + '）');
});

console.log('[11] 顶部模式栏：预览 / 调色之后多一颗「无损改图」');
{
    const modeBarMatch = html.match(/<div class="image-edit-mode">([\s\S]*?)<\/div>/);
    const modeBar = modeBarMatch ? modeBarMatch[1] : '';
    ok(/data-image-edit-mode="lossless"/.test(modeBar), '顶部模式栏有 data-image-edit-mode="lossless"');
    ok(/<button type="button" data-image-edit-mode="lossless" title="无损改图"><i data-lucide="eraser" class="w-3\.5 h-3\.5"><\/i><span>无损改图<\/span><\/button>/.test(modeBar),
        '顶部按钮：eraser 图标 + 文案「无损改图」');
    ok(modeBar.indexOf('data-image-edit-mode="adjust"') < modeBar.indexOf('data-image-edit-mode="lossless"'), '「无损改图」排在「调色」之后');
    ok((modeBar.match(/data-image-edit-mode="lossless"/g) || []).length === 1, '顶部只加了一颗，没有重复');
}

console.log('[12] 顶部点击分派：走同一条 setImageEditMode(..., true)');
ok(/document\.querySelectorAll\('\[data-image-edit-mode\]'\)\.forEach\(btn => \{[\s\S]{0,220}setImageEditMode\(btn\.dataset\.imageEditMode \|\| 'crop', true\)/.test(js),
    '点击把 data-image-edit-mode 原样交给 setImageEditMode（lossless 自然生效，不特判）');
ok(/imageEditMode = \[[^\]]*'adjust','lossless'\]/.test(modeFn), 'lossless 在模式白名单里（顶部点击不会被吞成 preview）');

console.log('[13] pick 协议：request / result / cancel + 来源校验');
ok(/data\.type === 'pick-request'/.test(js) && /losslessEditOpenPicker\(data\.slot\)/.test(js), '收到 pick-request 打开选择器（带 slot）');
ok(/losslessEditPost\('pick-result', \{slot, url, name:name \|\| ''\}\)/.test(js), '选中回 pick-result（slot + url + name）');
ok(/losslessEditPost\('pick-cancel', \{slot\}\)/.test(js), '取消回 pick-cancel（slot）');
ok(/if\(!frame \|\| event\.source !== frame\.contentWindow\) return;/.test(js), 'pick-request 只认本 iframe 的 event.source');
ok(/if\(data\.source !== LOSSLESS_EDIT_SOURCE\) return;/.test(js), 'pick-request 认工具方 source 标记');
ok(js.indexOf("const LOSSLESS_EDIT_HOST_SOURCE = 'novai-lossless-edit-host';") >= 0, '回发用宿主标记 novai-lossless-edit-host');

console.log('[14] 选择器：扁平数据 / DOM 结构 / 上传 / Esc / 点外面');
ok(/function losslessEditOpenPicker\(slot\)/.test(js) && /function losslessEditClosePicker\(sendCancel\)/.test(js), '有 open / close 函数');
ok(/function losslessEditPickEntries\(\)/.test(js) && /function losslessEditPickListHtml\(\)/.test(js), '有扁平条目函数 + 列表构建函数');
ok(/imageForDisplay\(raw\)/.test(js) && /smartMediaPreviewUrl\(entry\.item, 256\)/.test(js), '展示 URL 用 imageForDisplay、缩略图用 smartMediaPreviewUrl');
ok(/nodeAliasText\(node\)/.test(js) && /seq:'第' \+ \(i \+ 1\) \+ '张'/.test(js), '条目词元 = 节点别名 + 第N张');
ok(/window\.losslessEdit\.upload\(file/.test(js), '本地上传复用宿主上传通路（window.losslessEdit.upload → uploadCroppedBlob）');
ok(/data-lossless-pick-upload/.test(js) && /data-lossless-pick-cancel/.test(js) && /data-lossless-pick-url/.test(js), '选择器有本地上传 / 取消 / 图片项三个锚点');
ok(/event\.key !== 'Escape'\) return;[\s\S]{0,220}losslessEditClosePicker\(true\)/.test(js), 'Esc 取消选择器');
ok(/document\.addEventListener\('pointerdown', losslessEditPickOutside, true\)/.test(js), '点外面（pointerdown 捕获）取消');
ok(/overlay\.classList\.add\('open'\)/.test(js) && /overlay\.classList\.remove\('open'\)/.test(js), '开启 / 关闭切换 .open');
ok(/id = 'losslessPickOverlay'/.test(js) && /className = 'lossless-pick-overlay'/.test(js) && /class="smart-popover lossless-pick-panel"/.test(js), '选择器 DOM：overlay + .smart-popover 面板');
console.log('[15] 主题：iframe URL 参数 + 主题变化消息 + observer 挂摘');
ok(/function losslessEditTheme\(\)/.test(js), '有主题判定函数');
ok(/root\.classList\.contains\('theme-dark'\)/.test(js) && /document\.body && document\.body\.classList\.contains\('theme-dark'\)/.test(js), '从 documentElement / body 的 theme-dark 判定');
ok(/params\.set\('theme', losslessEditTheme\(\)\)/.test(js), 'iframe URL 拼 theme 参数');
ok(/losslessEditPost\('theme', \{theme:losslessEditTheme\(\)\}\)/.test(js), '主题变化发 {type:theme} 消息');
ok(/new MutationObserver\(losslessEditSyncTheme\)/.test(js) && /attributeFilter:\['class'\]/.test(js), 'MutationObserver 盯 documentElement 的 class');
ok(/function losslessEditUnwatchTheme\(\)/.test(js) && /losslessEditThemeObserver\.disconnect\(\)/.test(js), '离开模式摘掉 observer（不重复添加）');
ok(/if\(losslessEditThemeObserver \|\| typeof MutationObserver === 'undefined'\) return;/.test(js), '重复进入不会挂第二个 observer');
ok(/losslessEditWatchTheme\(\);[\s\S]{0,700}losslessEditSyncTheme\(\);/.test(js), '进入模式先挂 observer，iframe 已存在时再同步一次主题');
{
    const urlFnSrc = topLevelFunction(js, 'losslessEditIframeUrl');
    const buildUrl = new Function('losslessEditTheme', 'URLSearchParams', 'return (' + urlFnSrc + ');')(() => 'dark', URLSearchParams);
    const url = buildUrl({orig:{url:'/assets/a.png'}, ai:{url:'/assets/b.png'}});
    ok(url.indexOf('?') > 0 && url.indexOf('embed=1') >= 0 && /[?&]theme=dark/.test(url), '行为：URL 里带上 &theme=dark（' + url + '）');
    const aiOnly = new URLSearchParams(buildUrl({orig:null, ai:{url:'/assets/b.png'}}).split('?')[1] || '');
    ok(aiOnly.get('ai') === '/assets/b.png', '行为：新口径只把被点击的那张拼进 ai=');
    ok(aiOnly.get('orig') === null, '行为：新口径 URL 不含 orig=');
    const empty = new URLSearchParams(buildUrl({orig:null, ai:null}).split('?')[1] || '');
    ok(empty.get('ai') === null && empty.get('orig') === null, '行为：无图时 URL 既不带 ai= 也不带 orig=');
}

console.log('[16] 缓存戳：?v= 是「项目版本.mtime」形式（二次确认）');
['static/js/smart-canvas.js', 'static/css/smart-canvas.css'].forEach(file => {
    const tag = versionOf(html, file);
    ok(versionTagOk(tag), file + ' 的 ?v= 是「项目版本.mtime」形式（' + tag + '）');
});

console.log('[17] 选择器图片区：整体宫格（不再按节点分组成行）');
ok(/function losslessEditPickEntries\(\)/.test(js), '有一个扁平的条目构建函数');
ok(js.indexOf('lossless-pick-group') < 0, 'JS 里不再有按节点分组的容器/标题');
ok(css.indexOf('lossless-pick-group') < 0, 'CSS 里不再有按节点分组样式');
ok(/return '<div class="lossless-pick-grid" style="--lossless-pick-min:' \+ density\.min \+ 'px">' \+ cells \+ '<\/div>'/.test(js), '列表只输出一个整体 .lossless-pick-grid');
ok((js.match(/class="lossless-pick-grid"/g) || []).length === 1, '整体宫格只出现一次（不是每个节点各自成格）');
ok(/const label = entry\.alias \+ ' · ' \+ entry\.seq;/.test(js), '每格标签固定为「节点别名 · 第N张」');
ok(/data-lossless-pick-url="' \+ escapeAttr\(url\) \+ '" data-lossless-pick-name="' \+ escapeAttr\(name\)/.test(js), '每格仍带 pick-result 需要的 url / name');

console.log('[18] 搜索：两个词元 + 四种命中形式（严格，不模糊）');
{
    const matchFn = topLevelFunction(js, 'losslessEditPickMatch');
    ok(matchFn.length > 0, '有 losslessEditPickMatch 纯函数');
    const match = new Function('return (' + matchFn + ');')();
    ok(match('图68', '图68', '第1张') === true, 'q = 别名（图68）命中');
    ok(match('第1张', '图68', '第1张') === true, 'q = 第N张（第1张）命中');
    ok(match('图68 第1张', '图68', '第1张') === true, 'q = 别名 + 空格 + 第N张 命中');
    ok(match('图68 · 第1张', '图68', '第1张') === true, 'q = 别名 + · + 第N张 命中');
    ok(match('', '图68', '第1张') === true, '空查询 = 全部显示');
    ok(match('  图68  ', '图68', '第1张') === true, '查询 trim 后命中');
    ok(match('68', '图68', '第1张') === false, '纯数字 68 不命中（不做兜底）');
    ok(match('图6', '图68', '第1张') === false, '前缀 图6 不命中（不做模糊）');
    ok(match('第1', '图68', '第1张') === false, '纯序号 第1 不命中（不做兜底）');
    ok(match('图68 图', '图68', '第1张') === false, '含额外修饰词的写法不命中');
    ok(match('图69', '图68', '第1张') === false, '别的别名不命中');
    ok(match('第1张', '图68', '第2张') === false, '别的第N张不命中');
}

console.log('[19] 缩略图密度：小 / 中 / 大 三档 + 切换 + localStorage');
ok(/const LOSSLESS_PICK_DENSITIES = \[[\s\S]*?key:'small'[\s\S]*?min:72[\s\S]*?key:'medium'[\s\S]*?min:120[\s\S]*?key:'large'[\s\S]*?min:180/.test(js), '三档常量：小 72 / 中 120 / 大 180');
ok(/const LOSSLESS_PICK_DENSITY_KEY = 'novai_lossless_pick_density';/.test(js), 'localStorage 键固定');
ok(/function losslessEditPickDensityCurrent\(\)/.test(js) && /function losslessEditPickDensityStep\(step\)/.test(js), '有当前档位读取 + 切换函数');
ok(/localStorage\.setItem\(LOSSLESS_PICK_DENSITY_KEY, next\.key\)/.test(js), '切换后写入 localStorage');
ok(/localStorage\.getItem\(LOSSLESS_PICK_DENSITY_KEY\)/.test(js), '打开时读取上次选择（记住档位）');
ok(/grid\.style\.setProperty\('--lossless-pick-min', density\.min \+ 'px'\)/.test(js), '档位落到网格 --lossless-pick-min');
ok(/data-lossless-pick-density/.test(js) && /losslessEditPickDensityStep\(1\)/.test(js), '布局按钮点击切一档（即时生效）');
ok(/label\.textContent = density\.label/.test(js), '按钮上显示当前档位名（可见标识）');
ok(/\.lossless-pick-grid\{[^}]*minmax\(var\(--lossless-pick-min,120px\)/.test(css), 'CSS 用 --lossless-pick-min 控列宽');

console.log('[20] 选择器顶部：搜索框 + 布局按钮（不在滚动容器内）');
ok(/<div class="lossless-pick-toolbar">/.test(js), '有固定顶部工具条容器');
ok(/class="lossless-pick-search"/.test(js) && /data-lossless-pick-density/.test(js), '工具条里有搜索框 + 布局按钮');
{
    const searchIdx = js.indexOf('class="lossless-pick-search"');
    const densityIdx = js.indexOf('data-lossless-pick-density');
    const listIdx = js.indexOf('class="lossless-pick-list"');
    ok(searchIdx >= 0 && densityIdx >= 0 && listIdx >= 0, '三处锚点都在面板 innerHTML 里');
    ok(searchIdx < listIdx && densityIdx < listIdx, '搜索框/布局按钮在列表容器之前（不随列表滚动）');
}
{
    const listFn = topLevelFunction(js, 'losslessEditPickListHtml');
    ok(listFn.length > 0 && listFn.indexOf('lossless-pick-search') < 0 && listFn.indexOf('lossless-pick-toolbar') < 0,
        '列表构建函数不含顶部工具条');
}
ok(/\.lossless-pick-toolbar\{[^}]*flex:0 0 auto/.test(css), 'CSS：工具条固定、不吃滚动高度');
ok(/\.lossless-pick-list\{[^}]*flex:1 1 auto[^}]*overflow-y:auto/.test(css), 'CSS：只有 .lossless-pick-list 滚动');

console.log('[21] 弹窗底色一致：无损改图 iframe / 预览 / 调色都无自身背景');
ok(/\.lossless-edit-frame\{[^}]*background:transparent/.test(css), 'iframe .lossless-edit-frame 透明（弹窗底色透上来）');
ok(!/\.lossless-edit-frame\{[^}]*background:var\(--card\)/.test(css), 'iframe 不再自带 --card 背景');
{
    const previewRule = (css.match(/\.preview-stage\s*\{[^}]*\}/) || [''])[0];
    ok(previewRule.length > 0 && !/background\s*:/.test(previewRule), '预览区 .preview-stage 无自身背景');
}
{
    const stageRule = (css.match(/\.image-edit-stage\s*\{[^}]*\}/) || [''])[0];
    ok(/background:transparent/.test(stageRule), '图片区 .image-edit-stage 透明');
}
{
    const adjustCss = read('static/css/image-adjust.css');
    ok(/\.image-adjust-tools\.iaj\{[^}]*background:transparent\s*!important/.test(adjustCss), '调色右栏 #imageAdjustTools 透明');
}

console.log('[22] 署名：界面不再自带，#credit/#ver 改由仓库 NOTICE/LICENSE 承担');
{
    const toolHtml = read('static/tools/lossless-edit/index.html');
    ok(toolHtml.indexOf('id="credit"') < 0 && toolHtml.indexOf('id="ver"') < 0, '内置工具界面已无 #credit / #ver');
    const notice = read('static/tools/lossless-edit/NOTICE.md');
    const license = read('static/tools/lossless-edit/LICENSE.md');
    ok(/陶醉/.test(notice) && /陶醉/.test(license), '仓库 NOTICE.md / LICENSE.md 仍保留「陶醉」署名');
}

console.log('[23] 署名移除（强版）：界面无 #credit / #ver / © 陶醉 / v260923b，许可头与仓库文档保留');
{
    const toolHtmlRaw = read('static/tools/lossless-edit/index.html');
    const uiHtml = toolHtmlRaw.replace(/<!--[\s\S]*?-->/g, '');
    ok(toolHtmlRaw.indexOf('id="credit"') < 0, 'index.html 不含 id="credit"');
    ok(toolHtmlRaw.indexOf('id="ver"') < 0, 'index.html 不含 id="ver"');
    ok(uiHtml.indexOf('id="credit"') < 0 && uiHtml.indexOf('id="ver"') < 0, '去掉注释后的界面标记里也没有 credit / ver 容器');
    ok(uiHtml.indexOf('© 陶醉') < 0, '去掉许可头注释后的界面不出现「© 陶醉」');
    ok(uiHtml.indexOf('v260923b') < 0, '去掉许可头注释后的界面不出现版本号 v260923b');
    const header = (toolHtmlRaw.match(/^[\s\S]*?-->/) || [''])[0];
    ok(/陶醉/.test(header), '顶部许可头注释仍保留作者「陶醉」');
    ok(/https:\/\/github\.com\/[^\s"']+/.test(header), '顶部许可头注释仍保留来源仓库链接');
    ok(/creativecommons\.org\/licenses\/by-nc-sa\/4\.0/.test(header), '顶部许可头注释仍保留 CC BY-NC-SA 4.0 许可链接');
    const license = read('static/tools/lossless-edit/LICENSE.md');
    const notice = read('static/tools/lossless-edit/NOTICE.md');
    ok(/陶醉/.test(license) && /https?:\/\//.test(license), 'LICENSE.md 仍含「陶醉」+ 许可/来源链接');
    ok(/陶醉/.test(notice) && /github\.com\/[^\s>]+/.test(notice), 'NOTICE.md 仍含「陶醉」+ 来源仓库链接');
}

console.log('[24] 扁平宫格：losslessEditPickListHtml 只产出一个整体 .lossless-pick-grid');
{
    ok((js.match(/lossless-pick-group/g) || []).length === 0, 'smart-canvas.js 里 lossless-pick-group 出现 0 次');
    ok(css.indexOf('lossless-pick-group') < 0, 'CSS 里也没有 lossless-pick-group');
    const listFn = topLevelFunction(js, 'losslessEditPickListHtml');
    ok(listFn.length > 0, '能抠出 losslessEditPickListHtml 源码');
    ok((listFn.match(/class="lossless-pick-grid"/g) || []).length === 1, '列表函数只产出一个 .lossless-pick-grid');
    ok((listFn.match(/lossless-pick-group/g) || []).length === 0, '列表函数里没有按节点分组容器');
    ok(/entries\.map\(/.test(listFn) && /\.join\(''\)/.test(listFn), '所有图片摊进同一个 grid（不按节点分行）');
}

console.log('[25] 搜索：严格整串命中 + 明确不命中（含 第1张图）');
{
    const matchFn = topLevelFunction(js, 'losslessEditPickMatch');
    ok(matchFn.length > 0, '能抠出 losslessEditPickMatch 源码');
    const match = new Function('return (' + matchFn + ');')();
    const hit = q => match(q, '图68', '第1张');
    ok(hit('图68') === true, '命中：q = 别名「图68」');
    ok(hit('第1张') === true, '命中：q = 序号「第1张」');
    ok(hit('图68 第1张') === true, '命中：q = 别名 + 空格 + 序号');
    ok(hit('图68 · 第1张') === true, '命中：q = 别名 + · + 序号');
    ok(hit('') === true, '命中：空串 = 全部显示');
    ok(match('', '任意别名', '第9张') === true, '空串对任何条目都返回全部');
    ok(hit('68') === false, '不命中：纯数字 68');
    ok(hit('图6') === false, '不命中：前缀 图6');
    ok(hit('第1') === false, '不命中：纯序号 第1');
    ok(hit('图68 图') === false, '不命中：含额外修饰词 图68 图');
    ok(hit('第1张图') === false, '不命中：序号带后缀 第1张图');
    ok(hit('图69') === false, '不命中：别名不同 图69');
}

console.log('[26] 三档缩略图密度：标签递增 + localStorage + 环绕切换 + 写入 grid 变量');
{
    const densitiesSrc = (js.match(/const LOSSLESS_PICK_DENSITIES = \[[\s\S]*?\];/) || [''])[0];
    ok(densitiesSrc.length > 0, '抠出 LOSSLESS_PICK_DENSITIES');
    const densities = new Function(densitiesSrc + '\nreturn LOSSLESS_PICK_DENSITIES;')();
    ok(densities.length === 3 && densities.map(d => d.key).join(',') === 'small,medium,large', '三档键名依次 small / medium / large');
    ok(densities.map(d => d.label).join('/') === '小缩略图/中缩略图/大缩略图', '标签依次为 小缩略图 / 中缩略图 / 大缩略图');
    ok(densities.every((d, i) => typeof d.min === 'number' && (i === 0 || d.min > densities[i - 1].min)), 'min 依次递增（' + densities.map(d => d.min).join(' < ') + '）');
    ok(/const LOSSLESS_PICK_DENSITY_KEY = 'novai_lossless_pick_density';/.test(js), 'localStorage 键名 = novai_lossless_pick_density');
    const indexFn = topLevelFunction(js, 'losslessEditPickDensityIndex');
    const currentFn = topLevelFunction(js, 'losslessEditPickDensityCurrent');
    const stepFn = topLevelFunction(js, 'losslessEditPickDensityStep');
    const sandbox = new Function('LOSSLESS_PICK_DENSITIES', 'LOSSLESS_PICK_DENSITY_KEY',
        'let losslessEditPickDensity = "medium";'
        + 'const __store = {};'
        + 'const localStorage = { getItem: k => (k in __store ? __store[k] : null), setItem: (k, v) => { __store[k] = String(v); } };'
        + 'let __sync = 0; function losslessEditPickSyncDensity(){ __sync += 1; }'
        + indexFn + '\n' + currentFn + '\n' + stepFn + '\n'
        + 'return { step: losslessEditPickDensityStep, current: losslessEditPickDensityCurrent, store: __store, syncCalls: () => __sync };'
    )(densities, 'novai_lossless_pick_density');
    ok(sandbox.step(1) === 'large', 'medium 点一下 → large');
    ok(sandbox.step(1) === 'small', 'large 再点 → 环绕回 small');
    ok(sandbox.step(1) === 'medium', 'small 再点 → medium');
    ok(sandbox.step(-1) === 'small', 'medium 反向 → small');
    ok(sandbox.step(-1) === 'large', 'small 反向 → 环绕回 large');
    ok(sandbox.store['novai_lossless_pick_density'] === 'large' && sandbox.current().key === 'large', '每次切换写入 localStorage，当前档位同步为 large');
    ok(sandbox.syncCalls() === 5, '每次切换都调用一次 losslessEditPickSyncDensity（5 次）');
    ok(/grid\.style\.setProperty\('--lossless-pick-min', density\.min \+ 'px'\)/.test(js), 'losslessEditPickSyncDensity 把当前档位 min 写进 --lossless-pick-min');
    const listFn = topLevelFunction(js, 'losslessEditPickListHtml');
    ok(/--lossless-pick-min:' \+ density\.min \+ 'px/.test(listFn), '列表初始化时也用当前档位 min');
    ok(/\.lossless-pick-grid\{[^}]*minmax\(var\(--lossless-pick-min,120px\)/.test(css), 'CSS：网格列宽吃 --lossless-pick-min');
}

console.log('[27] 顶部工具条固定：搜索 / 密度按钮在列表之外，列表自己滚');
{
    const searchTag = (js.match(/<input class="lossless-pick-search"[^>]*>/) || [''])[0];
    ok(searchTag.length > 0, '能找到 input.lossless-pick-search');
    ok(/type="search"/.test(searchTag), '搜索框 type=search');
    ok(/placeholder="搜索：图68 或 第1张"/.test(searchTag), '搜索框占位提示「搜索：图68 或 第1张」');
    ok(/data-lossless-pick-density="medium"/.test(js), '密度按钮默认档位 medium');
    ok(/data-lossless-pick-density="medium"[\s\S]{0,160}<span>中缩略图<\/span>/.test(js), '按钮上显示当前档位 label（中缩略图）');
    const toolbarIdx = js.indexOf('class="lossless-pick-toolbar"');
    const searchIdx = js.indexOf('class="lossless-pick-search"');
    const densityIdx = js.indexOf('data-lossless-pick-density="');
    const listIdx = js.indexOf('class="lossless-pick-list"');
    ok(toolbarIdx >= 0 && densityIdx >= 0 && listIdx >= 0, '工具条 / 密度按钮 / 列表三处锚点齐全');
    ok(toolbarIdx < searchIdx && searchIdx < listIdx, '搜索框在工具条内、列表之前');
    ok(toolbarIdx < densityIdx && densityIdx < listIdx, '密度按钮也在列表之前');
    const listFn = topLevelFunction(js, 'losslessEditPickListHtml');
    ok(listFn.indexOf('lossless-pick-search') < 0 && listFn.indexOf('lossless-pick-toolbar') < 0, '列表内容里不含工具条（工具条不随列表滚动）');
    ok(/\.lossless-pick-list\{[^}]*overflow-y:auto/.test(css), 'CSS：.lossless-pick-list 自身 overflow-y:auto');
    ok(/\.lossless-pick-toolbar\{[^}]*flex:0 0 auto/.test(css), 'CSS：工具条 flex:0 0 auto（不参与滚动）');
}

console.log('[28] 弹窗底色一致：frame / 调色 / 预览 / 图片区都无自身背景');
{
    const opaqueBackgrounds = rule => (rule.match(/background(?:-color|-image)?\s*:\s*[^;}]+/g) || [])
        .map(decl => decl.split(':').slice(1).join(':').replace(/!important/gi, '').trim().toLowerCase())
        .filter(value => value !== 'transparent' && value !== 'none' && value !== '');
    const frameRule = (css.match(/\.lossless-edit-frame\s*\{[^}]*\}/) || [''])[0];
    ok(/background:transparent/.test(frameRule), '.lossless-edit-frame 声明 background:transparent');
    ok(opaqueBackgrounds(frameRule).length === 0 && !/background:var\(--card\)/.test(frameRule), '.lossless-edit-frame 没有任何非透明自背景');
    const adjustBase = (css.match(/\.image-adjust-tools\s*\{[^}]*\}/) || [''])[0];
    const adjustCss = read('static/css/image-adjust.css');
    const adjustSkin = (adjustCss.match(/\.image-adjust-tools\.iaj\s*\{[^}]*\}/) || [''])[0];
    ok(adjustBase.length > 0 && opaqueBackgrounds(adjustBase).length === 0, '调色右栏 .image-adjust-tools 无自带非透明背景');
    ok(adjustSkin.length > 0 && opaqueBackgrounds(adjustSkin).length === 0, '调色右栏 .image-adjust-tools.iaj 无自带非透明背景');
    ok(!/#imageAdjustTools[^{]*\{[^}]*background\s*:(?!\s*transparent)/.test(css + adjustCss), '#imageAdjustTools 相关 CSS 没有非透明背景声明');
    const previewRule = (css.match(/\.preview-stage\s*\{[^}]*\}/) || [''])[0];
    ok(previewRule.length > 0 && opaqueBackgrounds(previewRule).length === 0, '预览区 .preview-stage 无自身背景');
    const editStageRule = (css.match(/\.image-edit-stage\s*\{[^}]*\}/) || [''])[0];
    ok(editStageRule.length > 0 && opaqueBackgrounds(editStageRule).length === 0, '图片区 .image-edit-stage 无自身非透明背景');
    ok(/background:transparent/.test(editStageRule), '图片区 .image-edit-stage 透明');
    const previewTag = (html.match(/<div[^>]*id="previewStage"[^>]*>/) || [''])[0];
    const editStageTag = (html.match(/<div[^>]*id="imageEditStage"[^>]*>/) || [''])[0];
    ok(previewTag.length > 0 && !/background\s*:/.test(previewTag), '#previewStage 标签无内联 background');
    ok(editStageTag.length > 0 && !/background\s*:/.test(editStageTag), '#imageEditStage 标签无内联 background');
}

console.log('[29] 带图进入：只填右侧；换图/空图重进发 prefill reset（不残留上一张）');
{
    const urlFn = topLevelFunction(js, 'losslessEditIframeUrl');
    const keyFn = topLevelFunction(js, 'losslessEditSourceKey');
    const enterFn = topLevelFunction(js, 'losslessEditEnterMode');
    ok(urlFn.length > 0 && keyFn.length > 0 && enterFn.length > 0, '能抠出 URL / key / 进入模式三函数');

    const state = {frame:null, cur:null, src:null, posts:[]};
    const host = {appendChild(){}};
    const doc = {
        createElement(){
            const f = {
                id:'', className:'', title:'', dataset:{}, attrs:{}, src:'', contentWindow:{},
                setAttribute(k, v){ this.attrs[k] = v; }
            };
            state.frame = f;
            return f;
        },
        getElementById(){ return host; }
    };
    const win = {losslessEdit:{sourcesFor(){ return state.src; }}};
    const box = new Function(
        'window', 'document', 'LOSSLESS_EDIT_FRAME_ID',
        'currentEditImage', 'losslessEditWatchTheme', 'losslessEditToolsEl', 'losslessEditFrame',
        'losslessEditSyncTheme', 'losslessEditPost', 'losslessEditTheme', 'URLSearchParams',
        urlFn + '\n' + keyFn + '\n' + enterFn + '\nreturn { enter: losslessEditEnterMode };'
    )(
        win, doc, 'losslessEditFrame',
        () => state.cur, () => {}, () => host, () => state.frame,
        () => {}, (type, payload) => { state.posts.push({type, payload}); return true; }, () => 'dark', URLSearchParams
    );

    state.cur = {node:{id:'n1'}, index:0};
    state.src = {orig:null, ai:{url:'/assets/a.png'}, name:'a'};
    box.enter();
    ok(!!state.frame, '首次进入懒创建 iframe');
    const first = new URLSearchParams(String(state.frame.src).split('?')[1] || '');
    ok(first.get('ai') === '/assets/a.png' && first.get('orig') === null, '首次进入 URL 只带被点击的那张（ai），不带 orig');
    ok(state.posts.length === 0, '首次进入靠 URL 预填，不发 prefill');

    state.src = {orig:null, ai:{url:'/assets/b.png'}, name:'b'};
    box.enter();
    ok(state.posts.length === 1 && state.posts[0].type === 'prefill', '换一张图重进走 prefill 分支（key 变了不跳过）');
    ok(state.posts[0].payload.reset === true, 'prefill 带 reset:true');
    ok(state.posts[0].payload.ai === '/assets/b.png' && !('orig' in state.posts[0].payload), 'prefill 只带新的 ai，不带 orig');

    state.src = {orig:null, ai:null, name:''};
    box.enter();
    ok(state.posts.length === 2 && state.posts[1].type === 'prefill', '无图重进仍发 prefill');
    ok(state.posts[1].payload.reset === true && !('ai' in state.posts[1].payload) && !('orig' in state.posts[1].payload), '无图 prefill = {reset:true}，两槽都清空');

    state.frame = null; state.posts = [];
    state.src = {orig:null, ai:null, name:''};
    box.enter();
    const blank = new URLSearchParams(String(state.frame.src).split('?')[1] || '');
    ok(blank.get('ai') === null && blank.get('orig') === null, '无图首次进入建成空状态（URL 不带 ai/orig）');
    ok(state.posts.length === 0, '无图首次进入直接建成空状态，不发 prefill');
}

console.log('[30] 尺寸口径：档位保比例 + 适配输入按档位 + 批量勾选数量');
{
    const vm = require('vm');
    const blockOf = re => { const m = js.match(re); if(!m) throw new Error('缺少源码块 ' + re); return m[0]; };
    const consts = [
        blockOf(/const SIZE_MAP = \{[\s\S]*?\n\};/),
        blockOf(/const API_RES_LEVELS = \[[^\]]*\];/),
        blockOf(/const RES_LONG_SIDE = \{[^}]*\};/),
        blockOf(/const RES_PIXEL_LIMIT_FALLBACK = \{[^}]*\};/)
    ];
    const sandbox = { window:{}, console };
    vm.createContext(sandbox);
    vm.runInContext(read('static/js/shared/size-policy.js'), sandbox);
    vm.runInContext('globalThis.NovaSizePolicy = window.NovaSizePolicy;', sandbox);
    const fnNames = ['parseSizeValue','parseRatioValue','gcdInt','apiImageSize','fitSourceSize'];
    const fnSources = fnNames.map(name => topLevelFunction(js, name));
    ok(fnSources.every(src => src.length > 0), '能抠出尺寸计算相关的全部函数源码');
    vm.runInContext(consts.concat(fnSources).join('\n'), sandbox);
    const apiImageSize = sandbox.apiImageSize;
    const fitSourceSize = sandbox.fitSourceSize;
    ok(typeof apiImageSize === 'function' && typeof fitSourceSize === 'function', 'vm 里拿到真实的 apiImageSize / fitSourceSize');
    ok(apiImageSize('source','1k','56:75','','') === '1136x1536', '56:75@1K = 1136x1536（等比 + 16 对齐）');
    ok(apiImageSize('source','2k','56:75','','') === '1520x2048', '56:75@2K = 1520x2048');
    ok(apiImageSize('source','4k','56:75','','') === '2864x3840', '56:75@4K = 2864x3840（修前 2480x3840）');
    ok(apiImageSize('custom','4k','2:3','','') === '2560x3840', '2:3@4K = 2560x3840（修前 2336x3840）');
    ok(apiImageSize('square','4k','','','') === '4096x4096', '预设 1:1（square）@4K 仍 4096x4096，没有被改动波及');
    ok(apiImageSize('source','4k','75:56','','') === '3840x2864', '横版 75:56@4K = 3840x2864（长边 3840、短边等比）');
    {
        const diff = Math.abs((56 / 75) - (2864 / 3840));
        ok(diff > 0 && diff <= 16 / 3840 + 1e-9, '56:75@4K 比例误差只来自 16 对齐（实测 ' + (2864 / 3840).toFixed(5) + '）');
    }
    ok(fitSourceSize({ratio:'source',resolution:'4k',sourceWidth:896,sourceHeight:1200}) === '2864x3840',
        '适配输入 896x1200 @4K = 2864x3840（不再返回参考图原始像素 896x1200）');
    ok(fitSourceSize({ratio:'source',resolution:'2k',sourceWidth:896,sourceHeight:1200}) === '1520x2048', '适配输入 896x1200 @2K = 1520x2048');
    ok(fitSourceSize({ratio:'source',resolution:'1k',sourceWidth:896,sourceHeight:1200}) === '1136x1536', '适配输入 896x1200 @1K = 1136x1536');
    ok(fitSourceSize({ratio:'source',resolution:'auto',sourceWidth:896,sourceHeight:1200}) === '', '适配输入 + 自动档位仍让位（留空，交给 sizeForRun 原逻辑）');
    ok(fitSourceSize({ratio:'source',resolution:'custom',sourceWidth:896,sourceHeight:1200}) === '', '适配输入 + 自定义尺寸仍让位');
    ok(js.indexOf('NovaSizePolicy.fitSource(') < 0, '不再拿参考图原始像素当输出尺寸（smart-canvas.js 已无 NovaSizePolicy.fitSource 调用）');

    const totalRowsLine = (js.match(/const totalRows = [^\n]*/) || [''])[0];
    ok(/_batchRunRows/.test(totalRowsLine), 'batchResultNodeForRun 的 totalRows 先取本轮真正要跑的 _batchRunRows');
    ok(/output\.batchRunExpected = Math\.max\(1, Number\(sourceNode && sourceNode\._batchRunRows\) \|\| totalRows\);/.test(js), 'pending 与 batchRunExpected 同源（totalRows 已先取 _batchRunRows）');
    const keysLine = (js.match(/const SMART_RUN_SIZE_KEYS = \[[^\]]*\];/) || [''])[0];
    ['resolution','customRatio','customRatioWidth','customRatioHeight','customSize','customWidth','customHeight','sourceWidth','sourceHeight','videoResolution']
        .forEach(key => ok(keysLine.indexOf("'" + key + "'") >= 0, 'SMART_RUN_SIZE_KEYS 含 ' + key));
    ok(/SMART_RUN_SIZE_KEYS\.forEach\(key => \{ if\(settings\[key\] !== undefined\) runSettings\[key\] = settings\[key\]; \}\);/.test(js),
        '分辨率/自定义像素以界面为权威（比例已改为节点优先）');
    {
        const mergeIdx = js.indexOf('let runSettings = Object.assign({}, settings, smartSettingsForNode(node) || {});');
        const overrideIdx = js.indexOf('SMART_RUN_SIZE_KEYS.forEach');
        const rowRatioIdx = js.indexOf('applyRowSourceRatioToSettings(runSettings, srcRatio)');
        ok(keysLine.indexOf("'ratio'") < 0 && keysLine.indexOf("'videoAspect'") < 0, '比例键不再被界面值强制覆盖（节点/每行比例才是权威）');
        ok(mergeIdx >= 0 && overrideIdx > mergeIdx && rowRatioIdx > overrideIdx,
            '顺序：节点快照合并 → 实时尺寸键覆盖 → 按行参考图比例覆盖（每行比例仍能盖回来）');
    }
}

console.log('');
if(fails.length){
    console.error('失败 ' + fails.length + ' 项：');
    fails.forEach(item => console.error('  ✗ ' + item));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项）');
