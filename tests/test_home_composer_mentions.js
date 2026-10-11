#!/usr/bin/env node
'use strict';
/*
 * 首页提示词框「上传图片/视频/文档 + @ 引用已上传素材」回归。
 *
 * 覆盖真实行为点：
 *   1. #hpFile accept 放开到 图片/视频/音频/文档，addFiles 不再只收 image/*；
 *   2. token 生成遵循项目约定 @图片N/@视频M/@文件K（全局序号，按上传顺序）；
 *   3. 素材增删后的重编号是「映射表 + 单次正则替换」，删除项连同其后一个空格删掉；
 *   4. @ 面板打开时 Enter/Tab 只插入引用，绝不 submit；↑/↓/Esc/点外部行为齐全；
 *   5. readyRefs 带 kind，供 smart-canvas buildHomeSeedNode 消费；
 *   6. 输入框是 contenteditable，插入的是行内 chip（data-token/data-ref，图片 chip 内是 img）；
 *   7. inputPlainText() 口径被 syncSend / submit / seedFromTemplate 共用，token 原样进下游；
 *   8. 新增 CSS 不画线框（无 border 描边 / inset 1px）。
 *
 * 纯函数区块直接从 static/home.html 里切出来 eval，测的是文件里真正跑的那段代码，
 * 不是另抄一份，因此不存在「测试过了但线上另一份实现」的偏差。
 *
 * 跑法：node tests/test_home_composer_mentions.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const home = fs.readFileSync(path.join(root, 'static/home.html'), 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };

console.log('[1] 上传类型放开：accept / addFiles / 文案');
ok(/id="hpFile"[^>]*accept="image\/\*,video\/\*,audio\/\*,\.pdf,\.txt,\.md,\.doc,\.docx,\.xls,\.xlsx,\.csv,\.json,\.zip,\.yaml,\.yml,\.log"[^>]*\bmultiple\b/.test(home),
    '#hpFile accept 含图片/视频/音频/文档完整清单且保留 multiple');
ok(/data-tip="添加图片 \/ 视频 \/ 文档（也可以直接拖进来或粘贴）"/.test(home), '#hpRefBtn tooltip 更新为 图片/视频/文档');
ok(/\(state\.refs\.length \? '素材 ' \+ state\.refs\.length : '素材'\)/.test(home), '#hpRefBtn 文案为「素材 N」/「素材」');
const addBody = home.slice(home.indexOf('function addFiles(files)'), home.indexOf('function readyRefs()'));
ok(addBody.length > 0, 'addFiles() 存在且可定位');
ok(!/\^image\\\//.test(addBody), 'addFiles 不再只收 image/*（去掉了 /^image\\// 过滤）');
ok(/guessKind\(f\)/.test(addBody), 'addFiles 上传中按 guessKind(mime/扩展名) 先占位 kind');
ok(/最多 6 个素材/.test(addBody), '数量上限文案改为「最多 6 个素材」');
ok(/entry\.kind = f\.kind \|\| entry\.kind/.test(addBody), '上传成功后以后端返回的 kind 为准');

console.log('[2] token 规则：@图片N / @视频M / @文件K 全局序号');
const pureStart = home.indexOf('var MENTION_LABELS');
const pureEnd = home.indexOf('/* ───────── @ 引用纯函数结束');
ok(pureStart >= 0 && pureEnd > pureStart, 'token/重编号纯函数区块可从 home.html 切入');
const pure = home.slice(pureStart, pureEnd);
let api = null;
try {
    api = new Function(pure + '\nreturn {mentionLabel:mentionLabel, mentionToken:mentionToken, buildMentionMap:buildMentionMap, renumberMentions:renumberMentions, guessKind:guessKind};')();
} catch (e) {
    ok(false, '纯函数区块 eval 失败：' + e.message);
}
if (api) {
    ok(api.mentionToken(0, 'image') === '@图片1', '第 1 个素材（图片）→ @图片1');
    ok(api.mentionToken(1, 'video') === '@视频2', '第 2 个素材（视频）→ @视频2（序号是全局位次，不是同类内序号）');
    ok(api.mentionToken(2, 'file') === '@文件3', '第 3 个素材（文档）→ @文件3');
    ok(api.mentionToken(3, 'audio') === '@音频4', '音频沿用项目约定的「音频」标签 + 全局序号');
    ok(api.mentionToken(0, 'unknown') === '@文件1', '未知 kind 回落「文件」标签');
    ok(api.guessKind({ name: 'a.MP4', type: '' }) === 'video', 'guessKind：无 mime 时按扩展名 .MP4 判视频');
    ok(api.guessKind({ name: 'x', type: 'image/png' }) === 'image', 'guessKind：image/* mime 判图片');
    ok(api.guessKind({ name: 'v.wav', type: 'audio/wav' }) === 'audio', 'guessKind：audio mime 判音频');
    ok(api.guessKind({ name: 'note.md', type: '' }) === 'file', 'guessKind：文档扩展名判文件');
}

console.log('[3] 移除重编号：映射表 + 单次正则替换（不是链式 String.replace）');
ok((pure.match(/\.replace\(/g) || []).length === 1, '重编号只调一次 .replace()（多次顺序 replace 会连锁覆盖）');
ok(/function renumberMentions\(text, tokenMap\)/.test(pure), 'renumberMentions(text, tokenMap) 存在');
ok(/function buildMentionMap\(prevRefs, nextRefs\)/.test(pure), 'buildMentionMap(prevRefs, nextRefs) 存在');
if (api) {
    const prev = [{ id: 'a', kind: 'image' }, { id: 'b', kind: 'image' }, { id: 'c', kind: 'image' }];
    const next = [prev[1], prev[2]];
    const map = api.buildMentionMap(prev, next);
    ok(api.renumberMentions('@图片1 @图片2 @图片3', map) === '@图片1 @图片2',
        '删掉第 1 个素材：@图片2→@图片1、@图片3→@图片2，且不会二次改写（链式 replace 会得到 @图片1 @图片1 @图片1）');
    ok(api.renumberMentions('看 @图片1 和 @图片2', map) === '看 和 @图片1',
        '被移除素材的 token 连同其后的一个空格一起删掉');
    ok(api.buildMentionMap(prev, next)['@图片1'] === null, '移除项的映射值为 null，明确表示删除');
    const kp = [{ id: 'a', kind: 'file' }];
    const kn = [{ id: 'a', kind: 'image' }];
    ok(api.renumberMentions('@文件1', api.buildMentionMap(kp, kn)) === '@图片1',
        '上传后后端改判 kind：@文件1 同步改写为 @图片1');
    ok(api.renumberMentions('@图片9', api.buildMentionMap(prev, next)) === '@图片9', '映射表里没有的 token 原样保留，不误伤');
}

console.log('[4] @ 面板：DOM 契约 / 触发条件 / Enter 不提交');
ok(/<div class="hp-mention" id="hpMention" hidden><\/div>/.test(home), '容器 <div class="hp-mention" id="hpMention" hidden> 初始挂在 .hp-compose 内（打开时 JS 移入 body）');
const placeStart = home.indexOf('function placeMention() {');
const placeEnd = home.indexOf('function renderMention()', placeStart);
const placeBody = home.slice(placeStart, placeEnd);
const posStart = home.indexOf('function positionMention() {');
const posBody = home.slice(posStart, placeStart);
ok(placeStart >= 0 && posStart >= 0 && posStart < placeStart, 'placeMention() / positionMention() 可从 home.html 定位（positionMention 在前）');
ok(/el\.parentElement !== document\.body/.test(placeBody) && /document\.body\.appendChild\(el\)/.test(placeBody),
    '面板打开时 appendChild 到 body —— 脱离 .hp-compose 这个 backdrop root，blur 才能采到后面的页面内容');
ok(/window\.addEventListener\('scroll', positionMention, true\)/.test(placeBody) && /window\.addEventListener\('resize', positionMention\)/.test(placeBody) && /mentionPlaced/.test(placeBody),
    '面板打开期间监听 window scroll(capture)/resize 重定位，mentionPlaced 只绑一次（重复打开不重复绑）');
const caretStart = home.indexOf('function mentionCaretRect() {');
const caretBody = home.slice(caretStart, posStart);
ok(caretStart >= 0 && caretStart < posStart, 'mentionCaretRect() 在 positionMention() 之前（光标行盒锚点可定位）');
ok(/window\.getSelection\(\)/.test(caretBody) && /range\.collapsed/.test(caretBody) && /input\.contains\(range\.startContainer\)/.test(caretBody),
    '锚点取 window.getSelection() 的折叠 Range，且 startContainer 在 #hpInput 内');
ok(/range\.getClientRects\(\)/.test(caretBody) && /range\.getBoundingClientRect\(\)/.test(caretBody),
    '光标行盒优先 range.getClientRects()[0]，取不到退 range.getBoundingClientRect()');
ok(/\$\('hpCompose'\)\.getBoundingClientRect\(\)/.test(caretBody), '拿不到光标时退回 #hpCompose 的 rect（不报错、面板不乱飞）');
ok(/var box = el\.getBoundingClientRect\(\)/.test(posBody), 'positionMention() 现量面板自身 rect（hidden=false 之后量）');
ok(/var left = Math\.max\(8, Math\.min\(caret\.left, window\.innerWidth - box\.width - 8\)\)/.test(posBody),
    'left = 光标行盒 left，并夹到 [8, window.innerWidth - 面板宽 - 8]（靠右不溢出）');
ok(/var top = caret\.bottom \+ 6;/.test(posBody), 'top = 光标行盒 bottom + 6 —— 弹在光标行正下方，留 6px');
ok(/if \(top \+ box\.height > window\.innerHeight - 8\) top = caret\.top - box\.height - 6;/.test(posBody),
    '兜底翻转：下方放不下时改到光标行上方（caret.top - 面板高 - 6）');
ok(/el\.style\.top = top \+ 'px'/.test(posBody) && /el\.style\.left = left \+ 'px'/.test(posBody) && !/el\.style\.bottom/.test(posBody) && !/rect\.left \+ 14/.test(posBody),
    '只写 left/top，不再写 bottom / 输入框上方 10px 的旧坐标');
ok(/input\.addEventListener\('click', function \(\) \{ updateMention\(\); \}\)/.test(home) && /'ArrowLeft' \|\| e\.key === 'ArrowRight' \|\| e\.key === 'Home' \|\| e\.key === 'End'\) updateMention\(\);/.test(home),
    '重算时机：input / click / keyup(←/→/Home/End) 都经 updateMention → positionMention');
ok(/el\.hidden = false;[\s\S]{0,120}placeMention\(\);/.test(home), 'renderMention() 打开面板时就地挂 body 并定位');
ok(/class="hp-mention-item/.test(home) && /data-mention-index="/.test(home), '每项 button.hp-mention-item[data-mention-index]');
ok(/data-token="' \+ esc\(item\.token\)/.test(home) && /title="' \+ esc\(label\)/.test(home) && /aria-label="' \+ esc\(label\)/.test(home),
    '每格 button 带 data-token / title / aria-label（E2E 读 data-token 与 title）');
ok(/item\.token \+ ' · ' \+ item\.ref\.name/.test(home), 'title/aria-label = token · 文件名，不再占位显示文件名与 token');
ok(!/hp-mention-name|hp-mention-token/.test(home), '旧的 .hp-mention-name / .hp-mention-token 文案格已移除');
ok(/没有可引用的素材/.test(home), '空态文案「没有可引用的素材」');
ok(/is-active/.test(home), '高亮项加 class is-active');
ok(/function mentionQueryAt\(\)/.test(home) && /lastIndexOf\('@'\)/.test(home) && /\/\\s\/\.test\(query\)/.test(home) && !/prevChar/.test(home),
    '@ 触发条件：@ 到光标之间没有空白即可（不再要求 @ 前是行首/空白）');
const probeStart = home.indexOf('function plainTextUpTo(');
const probeEnd = home.indexOf('function mentionItemsFor(', probeStart);
ok(probeStart >= 0 && probeEnd > probeStart, 'mentionQueryAt/plainTextUpTo 可从 home.html 定位（行为探针）');
let mentionAt = null;
if (probeStart >= 0 && probeEnd > probeStart) {
    try {
        mentionAt = new Function('input', 'window', home.slice(probeStart, probeEnd) + '\nreturn mentionQueryAt();');
    } catch (e) {
        ok(false, 'mentionQueryAt 行为探针构造失败：' + e.message);
    }
}
function mentionCtx(text, caret) {
    if (!mentionAt) return null;
    const textNode = { nodeType: 3, nodeValue: text };
    const box = { nodeType: 1, tagName: 'DIV', classList: { contains: function () { return false; } }, childNodes: [textNode], contains: function (n) { return n === textNode; } };
    const range = { collapsed: true, startContainer: textNode, startOffset: caret == null ? text.length : caret };
    const win = { getSelection: function () { return { rangeCount: 1, getRangeAt: function () { return range; } }; } };
    return mentionAt(box, win);
}
ok(mentionCtx('用@') && mentionCtx('用@').query === '', '汉字后面紧跟 @ 也能弹（不再要求前置空白）：用@ → 进入过滤模式');
ok(mentionCtx('abc @') && mentionCtx('abc @').query === '', '@ 前有空格仍正常弹：abc @ → 进入过滤模式');
ok(mentionCtx('abc@def') && mentionCtx('abc@def').query === 'def', '@ 到光标之间无空白进入过滤模式：abc@def → query=def');
ok(mentionCtx('abc@def ghi') === null, '@ 到光标之间出现空白则关闭：abc@def ghi → null');
const thumbStart = home.indexOf('function mentionThumb(r) {');
const thumbEnd = home.indexOf('function renderMention()', thumbStart);
const thumb = home.slice(thumbStart, thumbEnd);
ok(thumbStart >= 0 && thumbEnd > thumbStart, 'mentionThumb() 缩略图分支可定位');
ok(/r\.kind === 'video'/.test(thumb) && /<video src=/.test(thumb) && /muted playsinline preload="metadata"/.test(thumb) && /hp-ref-play/.test(thumb),
    '视频格子 <video muted playsinline preload="metadata"> 填满 + 线性播放角标');
ok(/icon\('play'\)/.test(thumb) && /play: '<polygon points="6 3 20 12 6 21 6 3"\/>'/.test(home) && /stroke-width="1\.8"/.test(home),
    '播放角标复用 lucide 线性 play 图标（stroke-width 1.8）');
ok(/r\.kind === 'image'/.test(thumb) && /<img src=/.test(thumb), '图片格子 <img> 填满');
ok(/icon\(r\.kind === 'audio' \? 'music' : 'fileText'\)/.test(thumb), '音频/文档格子用线性 music / fileText 图标');
const kdStart = home.lastIndexOf("input.addEventListener('keydown', function (e) {");
const kdEnd = home.indexOf("input.addEventListener('paste'", kdStart);
const kd = home.slice(kdStart, kdEnd);
ok(kd.length > 0, 'input keydown 监听可定位');
ok(/if \(mention\.open\) \{/.test(kd), 'keydown 有「面板打开」守卫');
ok(/e\.key === 'ArrowRight'[\s\S]{0,60}moveMention\(1\)/.test(kd) && /e\.key === 'ArrowLeft'[\s\S]{0,60}moveMention\(-1\)/.test(kd), '←/→ 前后移动 1 格');
ok(/e\.key === 'ArrowDown'[\s\S]{0,80}moveMentionRow\(Math\.min\(mention\.items\.length, 5\)\)/.test(kd) && /e\.key === 'ArrowUp'[\s\S]{0,80}moveMentionRow\(-Math\.min\(mention\.items\.length, 5\)\)/.test(kd),
    '↑/↓ 行距 = 实际列数 Math.min(素材数, 5)，单行时不多跳');
ok(!/moveMentionRow\(-?5\)/.test(home), '不再写死 ±5 行距');
const mvStart = home.indexOf('function moveMention(step) {');
const mvEnd = home.indexOf('function insertMention(item)', mvStart);
const mvBody = home.slice(mvStart, mvEnd);
ok(mvStart >= 0 && /% mention\.items\.length/.test(mvBody), '←/→ 循环移动（mod n）');
const rowStart = home.indexOf('function moveMentionRow(step) {');
const rowBody = home.slice(rowStart, mvEnd);
ok(rowStart > mvStart && /next < 0 \? 0 :/.test(rowBody) && /mention\.items\.length - 1/.test(rowBody), '↑/↓ 越界夹到 [0, n-1]，不循环');
ok(/insertMention\(mention\.items\[mention\.active\]\)/.test(kd), 'Enter/Tab 插入当前高亮项');
ok(/e\.key === 'Escape'/.test(kd) && /closeMention\(\)/.test(kd), 'Esc 关闭面板');
const guardIdx = kd.indexOf('if (mention.open) {');
const submitIdx = kd.indexOf('submit();');
ok(guardIdx >= 0 && submitIdx > guardIdx, '面板守卫在 submit() 之前 —— 面板打开时 Enter 绝不触发送出/提交');
ok(/panel\.addEventListener\('mousedown'/.test(home) && /e\.preventDefault\(\)/.test(home), '选项 mousedown preventDefault，避免编辑器失焦');
ok(/document\.addEventListener\('mousedown', function \(e\) \{[\s\S]{0,180}closeMention\(\)/.test(home), '点面板外关闭');
ok(/data-ref-insert=/.test(home) && /insertRefMention\(ref\)/.test(home), '点素材缩略格子把该素材 token 插到光标处');
ok(/function insertMention\(item\)/.test(home) && /createTokenChip\(item\.ref, item\.token\)/.test(home) && /range\.deleteContents\(\)/.test(home), '插入 = 删掉光标前 @query，插入行内 chip + 一个空格，再触发 autoGrow/syncSend');
ok(/input\.addEventListener\('input', function \(\) \{ syncEmpty\(\); autoGrow\(\); syncSend\(\); updateMention\(\); \}\)/.test(home), '输入后同步刷新占位符/高度/发送态/面板');

console.log('[5] 下游：readyRefs 带 kind / token 原样进 prompt');
ok(/function readyRefs\(\)[\s\S]{0,260}kind: r\.kind \|\| 'image'/.test(home), 'readyRefs() 返回 {url, name, kind}');
ok(/if \(refs\.length\) nodes\.push\(\{ key: 'ref', type: 'image', title: '参考图', images: refs, col: 0 \}\)/.test(home), 'image/video 模式仍把 refs 作为素材节点 seed');
ok(/prompt: text/.test(home) && /agent: text \|\| '看看画布上的参考图，帮我规划可以做什么'/.test(home), '输入框文本（含 @token）原样带进 gen prompt / agent 文本');
ok(/function seedFromTemplate/.test(home) && /function renderSkills/.test(home) && /id="hpMode"/.test(home) && /id="hpSend"/.test(home) && /id="recentProjects"/.test(home) && /id="lanNotice"/.test(home), '模式切换/模板/技能/最近项目/局域网条路径保留');
ok(/input\.addEventListener\('paste'/.test(home) && /box\.addEventListener\('drop'/.test(home) && /hasFiles\(e\)/.test(home), '粘贴 / 拖拽路径保留');

console.log('[6] contenteditable 输入框 + 行内引用 chip');
ok(/<div class="hp-input" id="hpInput" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="/.test(home),
    '#hpInput 是 contenteditable 的 div（role/aria-multiline/data-placeholder 齐全）');
ok(!/<textarea[^>]*id="hpInput"/.test(home), '不再用 <textarea id="hpInput">');
ok(/#hpInput:empty::before[\s\S]{0,160}content: attr\(data-placeholder\)[\s\S]{0,80}color: var\(--v4-faint\)/.test(home),
    '占位文案走 #hpInput:empty::before { content: attr(data-placeholder) } + var(--v4-faint)');
ok(/input\.setAttribute\('data-placeholder', mode\.ph\)/.test(home), 'renderMode() 改设 data-placeholder');
ok(!/input\.placeholder\s*=/.test(home) && !/input\.value/.test(home) && !/setSelectionRange/.test(home),
    'textarea 时代的 input.value / input.placeholder= / setSelectionRange 全部移除');
ok(/function inputPlainText\(\)/.test(home), '新增 inputPlainText()');
const plainStart = home.indexOf('function inputPlainText() {');
const plainEnd = home.indexOf('function syncEmpty() {', plainStart);
const plain = home.slice(plainStart, plainEnd);
ok(plainStart >= 0 && plainEnd > plainStart, 'inputPlainText() 可从 home.html 定位');
ok(/nodeType === 3/.test(plain) && /classList\.contains\('hp-token'\)/.test(plain) && /getAttribute\('data-token'\)/.test(plain) && /tagName === 'BR'/.test(plain),
    'inputPlainText()：文本节点取文本、chip 取 data-token、<br> 当换行（同 llmEditorPlainText 思路）');
ok(/var hasText = inputPlainText\(\)\.trim\(\)\.length > 0;/.test(home), 'syncSend 的有无文字判断走 inputPlainText()');
const submitBody = home.slice(home.indexOf('function submit() {'), home.indexOf('function initCompose() {'));
ok(/var text = inputPlainText\(\)\.trim\(\);/.test(submitBody), 'submit() 走 inputPlainText()（提交文本口径不变）');
const seedBody = home.slice(home.indexOf('function seedFromTemplate'), home.indexOf('function useTemplate('));
ok(/var text = inputPlainText\(\)\.trim\(\);/.test(seedBody), 'seedFromTemplate() 走 inputPlainText()');
ok(/Math\.min\(200, Math\.max\(56, input\.scrollHeight\)\)/.test(home), 'autoGrow 仍用 scrollHeight 夹在 56~200px');

const chipStart = home.indexOf('function createTokenChip(r, token) {');
const chipEnd = home.indexOf('function insideToken(node) {', chipStart);
const chipFn = home.slice(chipStart, chipEnd);
ok(chipStart >= 0 && chipEnd > chipStart, 'createTokenChip() 可定位');
ok(/chip\.className = 'hp-token'/.test(chipFn) && /setAttribute\('contenteditable', 'false'\)/.test(chipFn),
    'chip 是 .hp-token 且 contenteditable="false"（整块删除）');
ok(/setAttribute\('data-token', token\)/.test(chipFn) && /setAttribute\('data-ref', r\.id\)/.test(chipFn) && /setAttribute\('title', tokenTitle\(token, r\)\)/.test(chipFn),
    'chip 带 data-token / data-ref / title');
const innerStart = home.indexOf('function tokenInnerHtml(r) {');
const innerEnd = home.indexOf('function tokenTitle(', innerStart);
const inner = home.slice(innerStart, innerEnd);
ok(/r\.kind === 'image'/.test(inner) && /<img class="hp-token-thumb"/.test(inner), '图片 chip 里是 <img> 缩略图，不是纯文字');
ok(/r\.kind === 'video'/.test(inner) && /<video src=/.test(inner) && /muted playsinline preload="metadata"/.test(inner) && /hp-token-play/.test(inner) && /icon\('video'\)/.test(inner),
    '视频 chip：<video muted playsinline preload="metadata"> 首帧 + 线性 video 图标兜底 + 右下角小播放角标');
ok(/icon\(r\.kind === 'audio' \? 'music' : 'fileText'\)/.test(inner) && /hp-token-name/.test(inner), '音频/文档 chip：线性 music/fileText 图标 + 小字文件名');

const renumStart = home.indexOf('function applyRefRenumber(prevRefs) {');
const renumEnd = home.indexOf('function refTile(r) {', renumStart);
const renum = home.slice(renumStart, renumEnd);
ok(/querySelectorAll\('\.hp-token'\)/.test(renum) && /getAttribute\('data-ref'\)/.test(renum), 'applyRefRenumber 按 chip 的 data-ref 找它在 state.refs 里的新位置');
ok(/hasOwnProperty\.call\(index, rid\)/.test(renum) && /parent\.removeChild\(chip\)/.test(renum) && /dropFollowingSpace\(chip\)/.test(renum),
    '素材被移除时删掉整个 chip，并收掉它后面多余的一个空格');
ok(/renumberTextTokens\(tokenMap\)/.test(renum), '手打的裸文本 token 继续走单次正则映射 renumberMentions');
ok(!/item\.token \+ ' '/.test(home), '插入的引用不再是「裸文本 token + 空格」');
ok(/input\.addEventListener\('paste'[\s\S]{0,500}getData\('text\/plain'\)/.test(home) && /createTextNode\(text\)/.test(home),
    '粘贴只进纯文本（text/plain → 单个文本节点，不带来源 HTML 样式）');

console.log('[7] 设计硬规则：新增 CSS 不描边');
const borderDecls = [];
home.replace(/(?:^|[\s;{])(border(?:-(?:top|right|bottom|left))?(?:-width)?)\s*:\s*([^;}\n]+)/g, (m, prop, val) => { borderDecls.push(val.trim()); return m; });
const badBorders = borderDecls.filter(v => !/^(0|none)(px)?$/.test(v));
ok(badBorders.length === 0, 'CSS 没有 border 描边（只允许 border:0 / none），违规值：' + badBorders.join(', '));
ok(!/(inset 0 0 0 1px|box-shadow:[^;]*inset)/.test(home), '没有 inset 1px 发丝线');
var mentionBox = (home.match(/\.hp-mention \{[\s\S]*?\}/) || [''])[0];
ok(/background:\s*rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*0?\.90\s*\)/.test(mentionBox),
    '引用面板先留一层浅色 fallback 实底 rgba(255,255,255,.90)，backdrop-filter / color-mix 不支持时仍可读');
ok(/background:\s*color-mix\(in srgb, var\(--v4-card-solid\) 78%, transparent\)/.test(mentionBox),
    '磨砂底 color-mix(in srgb, var(--v4-card-solid) 78%, transparent)（项目标准 78%，不再用实底）');
ok(/backdrop-filter:\s*blur\(44px\) saturate\(190%\)/.test(mentionBox) && /-webkit-backdrop-filter:\s*blur\(44px\) saturate\(190%\)/.test(mentionBox),
    'blur(44px) saturate(190%) 同时写了 backdrop-filter 与 -webkit-backdrop-filter');
ok(/box-shadow:\s*0 4px 14px rgba\(0,0,0,\.10\),\s*0 22px 48px -16px rgba\(0,0,0,\.30\)/.test(mentionBox),
    '两层柔和投影（首层加重）');
ok(/border:\s*0/.test(mentionBox), '面板 border:0，不画描边');
var mentionDark = (home.match(/\.theme-dark \.hp-mention \{[\s\S]*?\}/) || [''])[0];
ok(/background:\s*rgba\(24,24,24,\.90\)/.test(mentionDark),
    '深色 fallback 实底 rgba(24,24,24,.90)，透明失效时仍可读');
ok(/background:\s*color-mix\(in srgb, rgba\(24,24,24,\.96\) 78%, transparent\)/.test(mentionDark),
    '深色磨砂底 color-mix(in srgb, rgba(24,24,24,.96) 78%, transparent)');
ok(/backdrop-filter:\s*blur\(44px\) saturate\(190%\)/.test(mentionDark) && /-webkit-backdrop-filter:\s*blur\(44px\) saturate\(190%\)/.test(mentionDark),
    '深色同样写两条 backdrop-filter');
ok(/box-shadow:\s*0 4px 14px rgba\(0,0,0,\.5\),\s*0 22px 48px -16px rgba\(0,0,0,\.7\)/.test(mentionDark),
    '深色投影保持');
ok(/\.hp-mention \{[^}]*position:\s*fixed;[^}]*z-index:\s*9999;/.test(home), '面板 position: fixed（body 级按视口定位）+ z-index 提到 9999 压过页面');
ok(!/\.hp-mention \{[^}]*left:\s*14px/.test(home) && !/\.hp-mention \{[^}]*bottom:\s*calc/.test(home), 'CSS 里不再写死 left/bottom，坐标由 JS 现算');
ok(!/\.hp-mention \{[^}]*right:\s*14px/.test(home), '面板不再左右铺满（无 right:14px）');
ok(/\.hp-mention \{[^}]*width: fit-content[^}]*max-width: 260px[^}]*max-height: 132px[^}]*overflow-y: auto[^}]*padding: 8px[^}]*border-radius: 14px/.test(home),
    '面板 fit-content 小卡片（max-width 260px / max-height 132px / padding 8px / 圆角 14px），内部可滚');
ok(/\.hp-mention-grid \{[^}]*display: flex[^}]*flex-wrap: wrap[^}]*gap: 6px/.test(home), '面板内 flex + wrap 排布、gap 6px（宽度跟素材个数走）');
ok(!/repeat\(5, 44px\)/.test(home), '不再用 repeat(5, 44px) 固定 5 列（否则 3 个素材右侧会留两格空列）');
ok(/\.hp-mention-item \{[^}]*flex: 0 0 44px[^}]*width: 44px[^}]*height: 44px[^}]*border: 0[^}]*border-radius: 10px[^}]*overflow: hidden/.test(home),
    '每格 flex: 0 0 44px 定尺（不被拉伸/压缩）+ 44×44、圆角 10px、溢出裁切、无描边');
ok(!/\.hp-mention-empty \{[^}]*width:/.test(home), '空态不给固定宽度，面板 fit-content 自然收紧');
ok(/\.hp-mention-item\.is-active \{[^}]*background: var\(--v4-soft-2\)[^}]*transform:\s*translateY\(-1px\)\s*scale\(1\.06\)[^}]*box-shadow:\s*0 6px 14px -6px rgba\(0,0,0,\.35\)[^}]*\}/.test(home) && !/\.hp-mention-item\.is-active \{[^}]*(border|ring|inset)/.test(home),
    '高亮用 --v4-soft-2 软底 + transform 抬升 + 柔和投影，不描边不加 ring');
ok(/\.hp-mention-item:hover \{[^}]*background: var\(--v4-soft-2\)[^}]*transform:\s*translateY\(-1px\)/.test(home), 'hover 与高亮同款软底 + 更轻一档抬升');

console.log('[8] ES5 风格不变');
ok(!/\bconst\b/.test(home) && !/\blet\b/.test(home) && !/=>/.test(home), 'home.html 保持 ES5（无 const/let/=>）');

console.log('首页提示词框素材/@引用：' + pass + ' 项通过' + (fails.length ? '，' + fails.length + ' 项失败' : ''));
if (fails.length) { fails.forEach(f => console.error('  \u2717 ' + f)); process.exit(1); }
console.log('全部通过');
