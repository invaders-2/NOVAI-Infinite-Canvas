/* 空媒体节点「上传」按钮（选中才显示）+ 点本体不再弹上传窗：回归测试（零依赖）。

   覆盖：
   [1] 节点本体：.node-drop 只拦 mousedown，click 不再 pickMediaForSmartNode（选中交给节点 onclick）
   [2] 上方「上传」按钮：只在「单选当前空媒体节点」时渲染；深色胶囊 + 线性 upload 图标
   [3] 点击：world 上一次性委托 → pickMediaFromUploadCta（选中 + 清图选 + 落点 + 弹选择器）
   [4] 选中态同步：syncSelectionUi 里补/摘按钮（这条路径不整棵重建节点）
   [5] 显示条件：有图 / 生成中 / 多选 / 分组内成员 / 只读画布都不出现
   [6] 空卡提示改成「拖拽 / 粘贴上传」；拖拽与粘贴上传路径没被动
   [7] 样式：浮在节点框正上方 8px、无 border 线框

   跑法：node tests/test_smart_empty_upload_cta.js */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const js = read('static/js/smart-canvas.js');
const css = read('static/css/smart-canvas.css');
const i18n = read('static/js/i18n/smart-canvas.js');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };

function fn(name){
    const lines = js.split('\n');
    const start = lines.findIndex(line => line.startsWith('function ' + name + '(') || line.startsWith('async function ' + name + '('));
    if(start < 0) return '';
    for(let i = start + 1; i < lines.length; i += 1) if(lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    return '';
}
function sliceBetween(source, from, to){
    const start = source.indexOf(from);
    if(start < 0) return '';
    const end = source.indexOf(to, start + from.length);
    return end < 0 ? source.slice(start) : source.slice(start, end);
}

console.log('[1] 点节点本体不再弹系统上传窗');
{
    const dropBlock = sliceBetween(js, "const nodeDrop = el.querySelector('.node-drop');", "el.querySelectorAll('.node-delete')");
    ok(Boolean(dropBlock), '.node-drop 绑定块还在');
    ok(!/pickMediaForSmartNode/.test(dropBlock), 'node-drop 里不再调用 pickMediaForSmartNode（点本体不弹窗）');
    ok(/addEventListener\('mousedown', e => \{[\s\S]{0,160}stopPropagation\(\);/.test(dropBlock), '仍然只拦 mousedown（不启动拖拽）');
    ok(dropBlock.indexOf("addEventListener('click'") < 0, 'node-drop 上没有 click 监听');
}

console.log('[2] 选中才显示「上传」按钮');
{
    const visibleFn = fn('nodeUploadCtaVisible');
    ok(Boolean(visibleFn), '有 nodeUploadCtaVisible 统一判定');
    ok(/if\(!node \|\| !isEmptyMediaNode\(node\)\) return false;/.test(visibleFn), '只对空媒体节点成立');
    ok(/if\(collabReadOnly\) return false;/.test(visibleFn), '只读画布不显示');
    ok(/isSmartGroupCompactMember\(node\) \|\| smartGroupContainingNode\(node\.id\)/.test(visibleFn), '分组内成员不显示');
    ok(/return selectedIds\.length === 0 && isNodeSelected\(node\.id\);/.test(visibleFn), '只有单选当前这个节点时才显示（多选不弹一排）');

    const htmlFn = fn('nodeUploadCtaHtml');
    ok(/class="node-upload-cta"/.test(htmlFn), '按钮 class = .node-upload-cta');
    ok(/data-upload-node="\$\{escapeAttr\(node\.id\)\}"/.test(htmlFn), '按钮带 data-upload-node');
    ok(/data-lucide="upload"/.test(htmlFn), '图标是线性 upload（lucide）');
    ok(/tr\('smart\.uploadCta'\)/.test(htmlFn) && /<span>/.test(htmlFn), '文案走 i18n 并带文字「上传」');

    ok(/const showUploadCta = nodeUploadCtaVisible\(node\);/.test(js), 'render 用统一判定');
    ok(/const uploadCtaHtml = showUploadCta \? nodeUploadCtaHtml\(node\) : '';/.test(js), '按钮 HTML 由同一处生成');
    ok(/\$\{uploadCtaHtml\}\s*\n\s*\$\{node\.templateTitle/.test(js), '按钮在节点内容顶部（alias 之后、body 之前）');
}

console.log('[3] 点按钮 → 原上传流程');
{
    const actionFn = fn('pickMediaFromUploadCta');
    ok(Boolean(actionFn), '有 pickMediaFromUploadCta');
    ['hideRunTimerForNode',
        'selectedId = nodeId;',
        'selectedIds = [];',
        "selectedImage = {nodeId:'', index:-1};",
        'pendingGroupUploadPoint = null;',
        'uploadTargetId = nodeId;',
        'syncSelectionUi()',
        'updateComposer()',
        'pickMediaForSmartNode(nodeId)'
    ].forEach(snippet => ok(actionFn.indexOf(snippet) >= 0, '上传流程包含 ' + snippet));
    ok(/if\(collabReadOnly\)\{ collabNotifyReadOnly\(\); return; \}/.test(actionFn), '只读兜底：只提示、不上传');

    const initFn = fn('initSmartNodeUploadCta');
    ok(Boolean(initFn) && /closest\?\.\('\[data-upload-node\]'\)/.test(initFn), 'world 上委托认 [data-upload-node]');
    ok(/root\.__smartNodeUploadCta/.test(initFn), '只挂一次');
    ok(/pickMediaFromUploadCta\(button\.dataset\.uploadNode/.test(initFn), '点击 → pickMediaFromUploadCta');
    ok(/event\.preventDefault\(\);\s*\n\s*event\.stopPropagation\(\);/.test(initFn), '吃掉 click（不选节点、不弹画布菜单）');
    ok(/initSmartNodeToolbarActions\(document\);\s*\ninitSmartNodeUploadCta\(document\);/.test(js), '启动时和工具条委托一起初始化');
    ok(js.indexOf("[data-upload-node]').forEach") < 0, '没有残留的逐元素绑定');
}

console.log('[4] 选中态变化同步按钮');
{
    const syncFn = fn('syncNodeUploadCtas');
    ok(Boolean(syncFn), '有 syncNodeUploadCtas');
    ok(/world\.querySelectorAll\('\.image-node > \.node-upload-cta'\)/.test(syncFn), '先扫一遍现存的按钮');
    ok(/btn\.remove\(\)/.test(syncFn), '不该有的直接摘掉');
    ok(/el\.insertAdjacentHTML\('afterbegin', nodeUploadCtaHtml\(target\)\)/.test(syncFn), '该有的补进来（用的是同一份 HTML）');
    ok(/syncNodeUploadCtas\(\);/.test(fn('syncSelectionUi')), 'syncSelectionUi 里同步（这条路径不整棵重建节点）');
}

console.log('[5] 有图 / 生成中 / 多选都不显示');
{
    const emptyFn = fn('isEmptyMediaNode');
    ok(/\(node\.images \|\| \[\]\)\.length/.test(emptyFn), '有图 → 不算空');
    ok(/node\.pending \|\| node\.queued/.test(emptyFn), '生成中 / 排队 → 不算空');
    ok(/node\.jimengPending && node\.jimengPending\.submitId/.test(emptyFn), '即梦提交中 → 不算空');
    ok(/imgs\.length === 0 && !node\.pending && !isQueued && !isJimengPending/.test(js),
        'render 那边的 isEmpty 口径与它一致');
    ok(/const showUploadCta = nodeUploadCtaVisible\(node\);/.test(js), '按钮跟着 isEmpty（有图后自动消失）');
}

console.log('[6] 空卡文案 + 拖拽/粘贴路径');
{
    const dropHtml = (js.match(/return `<div class="node-drop"[\s\S]*?\n    `;/) || [''])[0];
    ok(/tr\('smart\.uploadEmptyHint'\)/.test(dropHtml), '空卡提示走 i18n 新文案');
    ok(dropHtml.indexOf('点击上传') < 0, '空卡里不再写「点击上传」');
    ok(/data-upload-action="files"/.test(dropHtml), '数据属性保留（拖拽落点仍认它）');
    ok(/window\.addEventListener\('paste'/.test(js) && /handleFiles\(files, selectedId\)/.test(js), '粘贴上传仍落到选中节点');
    ok(/handleFiles\(fileInput\.files, targetId, opts\)/.test(js), '文件选择框仍按 uploadTargetId / selectedId 落节点');
    ok(/el\.ondrop = async e => \{/.test(js) && /handleSmartImageDropPayload\(payload, id\)/.test(js), '节点上的拖拽落文件入口还在');
}

console.log('[7] i18n 与样式');
{
    ok(i18n.indexOf('"smart.uploadCta": { zh: "上传"') >= 0, 'i18n：smart.uploadCta = 上传');
    ok(i18n.indexOf('"smart.uploadEmptyHint": { zh: "拖拽 / 粘贴上传"') >= 0, 'i18n：拖拽 / 粘贴上传');
    const ctaCss = sliceBetween(css, '.node-upload-cta {', '}');
    ok(/position:absolute/.test(ctaCss) && /bottom:calc\(100% \+ 8px\)/.test(ctaCss), '浮在节点框正上方 8px');
    ok(/left:50%;/.test(ctaCss) && /transform:translateX\(-50%\)/.test(ctaCss), '水平居中');
    ok(/border:0;/.test(ctaCss) && /border-radius:var\(--radius-full\)/.test(ctaCss), '无边框 + 圆角胶囊');
    ok(/background:var\(--strong\)/.test(ctaCss) && /box-shadow:var\(--shadow-md\)/.test(ctaCss), '深色实底 + 柔和投影');
    ok(!/border\s*:\s*(1px )?solid/.test(ctaCss), '没有画 border 线框');
    ok(!/box-shadow\s*:\s*inset/.test(ctaCss), '没有 inset 描边');
    const iconCss = sliceBetween(css, '.node-upload-cta i, .node-upload-cta svg {', '}');
    ok(/width:14px/.test(iconCss) && /stroke-width:2\.2/.test(iconCss), '图标是 14px 线性（保留笔画）');
}

console.log('');
if(fails.length){
    console.error('空节点上传按钮：失败 ' + fails.length + ' 项');
    fails.forEach(item => console.error('  x ' + item));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
}
console.log('空节点上传按钮：' + pass + ' 项通过');
