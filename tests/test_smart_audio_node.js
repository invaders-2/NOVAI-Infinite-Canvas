#!/usr/bin/env node
/* 画布「Audio 音频生成节点」回归：
   1) 添加菜单有「音频」入口，节点类型是独立的 smart-audio（不混进图片/视频分支）；
   2) 空节点是一行 Audio 标签 + 大圆角卡片 + 淡淡的音符占位；有素材时复用现有音频卡片（<audio> 播放器）；
   3) 生成走 POST /api/canvas-audio，参数按 suno / flowmusic 门控，停止复用现有停止机制（abort）；
   4) 结果按 canvas_meta 落位，图片结果的 size_notice 要 toast 出来。
   跑法：node tests/test_smart_audio_node.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
const fails = [];
const ok = (cond, msg) => { if(cond) { pass += 1; } else { fails.push(msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), (msg || '') + '（实际 ' + JSON.stringify(a) + '）');

function read(rel){ return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }
function extractFn(src, name){
    const start = src.indexOf('function ' + name + '(');
    if(start < 0) throw new Error('未找到函数 ' + name);
    const end = src.indexOf('\n}', start);
    if(end < 0) throw new Error('未找到函数结尾 ' + name);
    return src.slice(start, end + 2);
}
function extractConst(src, name){
    const start = src.indexOf('const ' + name + ' = ');
    if(start < 0) throw new Error('未找到常量 ' + name);
    const end = src.indexOf('\n', start);
    return src.slice(start, end);
}

const js = read('static/js/smart-canvas.js');
const html = read('static/smart-canvas.html');
const css = read('static/css/smart-canvas.css');
const i18n = read('static/js/i18n/smart-canvas.js');

console.log('[1] 添加菜单：音频入口（线性音符图标 + 副标题）');
const addPanel = html.slice(html.indexOf('id="canvasAddPanel"'), html.indexOf('id="canvasRailTip"'));
ok(/data-add-kind="audio"/.test(addPanel), '添加面板有 data-add-kind="audio"');
ok(/<strong>音频<\/strong>/.test(addPanel) && /<em>生成音乐或音效<\/em>/.test(addPanel), '音频入口文案：音频 / 生成音乐或音效');
const audioAddBtn = addPanel.slice(addPanel.indexOf('data-add-kind="audio"'), addPanel.indexOf('data-add-kind="audio"') + 700);
ok(/<svg[^>]*stroke="currentColor"/.test(audioAddBtn) && /<circle/.test(audioAddBtn), '音频入口用内联线性 SVG 音符（lucide 子集里没有 music）');
ok(/data-lucide="chevron-right"/.test(audioAddBtn), '音频入口保留线性人字箭头');

console.log('[2] 节点类型是独立的 smart-audio');
ok(/function isSmartAudioNode\(node\)\{\s*return Boolean\(node && node\.type === 'smart-audio'\);/.test(js), 'isSmartAudioNode 认 smart-audio');
ok(/function isSmartMediaNode\(node\)\{\s*return Boolean\(isSmartImageNode\(node\) \|\| isSmartVideoNode\(node\) \|\| isSmartAudioNode\(node\)\);/.test(js),
    'smart-audio 与图片/视频同属媒体节点（共用分组/落点/编辑栏那套逻辑）');
const createMenuFn = extractFn(js, 'createNodeFromMenu');
ok(/type === 'audio'\) created = createImageNodeAt\(p, \[\], \{type:'smart-audio', title:tr\('smart\.kindAudio'\)\}\)/.test(createMenuFn),
    'createNodeFromMenu 的 audio 分支建 smart-audio 空节点（标题用中文种类名）');
ok(/type === 'video'\) created = createImageNodeAt\(p, \[\], \{type:'smart-video'\}\)/.test(createMenuFn), 'video 分支保持原样');

console.log('[3] 空节点与图片/视频完全同款（共用空卡） + 结果态是播放器');
const bodyFn = extractFn(js, 'nodeBodyHtml');
ok(!/smartAudioBodyHtml/.test(js), '音频空态不再有自己的渲染函数（不另起一套）');
ok(!/smart-audio-label|smart-audio-card|smart-audio-placeholder/.test(js) && !/smart-audio-label|smart-audio-card|smart-audio-placeholder/.test(css),
    '节点里的「Audio」胶囊 / 内层圆角空盒 / 淡音符占位已彻底删除');
/* 空态走文件末尾那张共用空卡：同样的 class、同样的提示文案，只有图标按类型换 */
const emptyBlock = bodyFn.slice(bodyFn.lastIndexOf('空媒体节点'));
ok(/const emptyIcon = isSmartVideoNode\(node\) \? 'video' : 'image';/.test(emptyBlock), '图片/视频的图标选择保持原样');
ok(/isSmartAudioNode\(node\) \? SMART_AUDIO_EMPTY_ICON_SVG/.test(emptyBlock), '音频空态只是把图标换成音符，其余共用');
ok(/<div class="node-drop" data-upload-action="files">/.test(emptyBlock), '空卡 class 与图片/视频同一个 .node-drop（圆角/底色/间距天然一致）');
ok(/class="smart-empty-icon"/.test(emptyBlock), '图标容器同一个 .smart-empty-icon（22px 尺寸由 CSS 给）');
ok(/<span class="upload-node-sub">拖拽 \/ 粘贴 \/ 点击上传<\/span>/.test(emptyBlock), '提示文案与图片/视频逐字一致（不造新 key）');
ok((js.match(/拖拽 \/ 粘贴 \/ 点击上传/g) || []).length === 1, '这段提示文案全仓只有一份（复用，不复制）');
const iconSvg = (js.match(/const SMART_AUDIO_EMPTY_ICON_SVG = '([^']+)'/) || [])[1] || '';
ok(/viewBox="0 0 24 24"/.test(iconSvg) && /stroke-width="2"/.test(iconSvg) && /stroke="currentColor"/.test(iconSvg),
    '音符图标与 lucide 同规格：viewBox 24 / stroke-width 2 / currentColor');
ok(!/fill="currentColor"/.test(iconSvg) && iconSvg.length > 100, '音符是线性图标（不填充）');
ok(/\.smart-empty-icon i,\.smart-empty-icon svg \{ width:22px; height:22px; \}/.test(css.replace(/\s+/g, ' ')),
    '尺寸由共用 .smart-empty-icon 统一给 22px（和视频摄像机图标同一份 CSS）');
ok(/isSmartAudioNode\(node\) && imgs\.length && imgs\.every\(isAudioMediaItem\)\) return smartAudioPlayerHtml\(node, imgs\)/.test(bodyFn),
    'nodeBodyHtml：有音频素材才走播放器卡片');
ok(!/smartAudioListHtml/.test(js), '旧的「一行一首 + 原生播放器」列表已删除');
/* 生成中：与图片/视频同一条 pending 扫光，不再自己画 */
const runState = extractFn(js, 'runSmartAudioGeneration');
ok(/node\.pending = 1;/.test(runState), '生成中走共用 pending 态（卡片换成同一条扫光玻璃 + 顶部「音频生成 + 计时」）');
ok(!/genStageHtml\(\)/.test(runState), '不在音频自己的渲染里另铺扫光');
/* 标题：中文种类名，不再是英文 Audio */
const menuFn2 = extractFn(js, 'createNodeFromMenu');
ok(/type === 'audio'\) created = createImageNodeAt\(p, \[\], \{type:'smart-audio', title:tr\('smart\.kindAudio'\)\}\)/.test(menuFn2),
    '创建时标题用项目 i18n 的中文种类名（smart.kindAudio = 音频），不再写 "Audio"');
ok(!/title:'Audio'/.test(js), '全仓不再有 title:' + "'Audio'");
ok(/"smart\.kindAudio": \{ zh: "音频", en: "Audio" \}/.test(i18n), '复用现成的 smart.kindAudio 词条（没造新 key）');
const placeFn3 = extractFn(js, 'placeAudioResult');
ok(/untitled\|audio/i.test(placeFn3) && /tr\('smart\.kindAudio'\)/.test(placeFn3),
    '生成结果的标题：上游只给 Untitled/Audio 这类占位时回落到「音频」');
ok(/上传|node-drop/.test(js) && /data-upload-action="files"/.test(js), '空节点点击/拖拽/粘贴上传入口仍在');
ok(/\(图\|视频\|音频\|提示词\|文本\|组\)\\d\{1,4\}/.test(js), '节点编号兼容「音频N」（服务器一旦分配就能显示）');
ok(/node-run-status|gen-stage/.test(js) && /node\.pending = 0;/.test(extractFn(js, 'runSmartAudioGeneration')),
    '失败/停止仍会把 pending 收掉（回到空卡）');
const layoutFn = extractFn(js, 'imageLayout');
ok(/if\(node\?\.type === 'smart-audio'\)\{/.test(layoutFn) && /EMPTY_UPLOAD_NODE_WIDTH/.test(layoutFn) && /EMPTY_UPLOAD_NODE_HEIGHT/.test(layoutFn),
    'imageLayout：空音频节点直接用图片/视频空节点那份尺寸常量（像素级一致）');
ok(!/SMART_AUDIO_NODE_WIDTH|SMART_AUDIO_NODE_HEIGHT/.test(js), '音频不再有自己的一套空节点尺寸');
ok(/SMART_AUDIO_PLAYER_WIDTH/.test(layoutFn) && /SMART_AUDIO_PLAYER_HEIGHT/.test(layoutFn) && /const fallbackW = audioCount \? SMART_AUDIO_PLAYER_WIDTH/.test(layoutFn),
    '有音频后按播放器固定尺寸（多首不改变卡片大小）');

console.log('[4] 生成：POST /api/canvas-audio + suno / flowmusic 参数门控');
const runFn = extractFn(js, 'runSmartAudioGeneration');
ok(/fetch\(tts \? '\/api\/canvas-tts' : '\/api\/canvas-audio'/.test(runFn),
    '请求按家族分流：tts → /api/canvas-tts，其余 → /api/canvas-audio');
ok(/method:'POST'/.test(runFn), 'POST 请求');
ok(/smartResponseErrorMessage\(response/.test(runFn), '失败文案走现有 smartResponseErrorMessage helper');
ok(/AbortController/.test(runFn) && /smartGenerationStopRequestedFor\(node\)/.test(runFn) && /controller\.abort\(\)/.test(runFn),
    '停止复用现有停止标记 + abort 在途请求');
ok(/throwIfSmartGenerationStopped\(node\)/.test(runFn), '拿到响应后仍要认停止请求（不再落节点）');
ok(/audioProviders\(\)\.find\(item => item\.id === runSettings\.audioProvider\)/.test(runFn),
    '发请求前按当前配置再校验平台（平台被删 Key / 停用时不发旧参数）');
const payloadFn = extractFn(js, 'audioGenerationPayload');
ok(/custom:false/.test(payloadFn) && /instrumental:false/.test(payloadFn) && /audio_format:''/.test(payloadFn) && /duration:0/.test(payloadFn) && /bpm:0/.test(payloadFn) && /length:0/.test(payloadFn),
    'payload 默认值与后端契约一致（custom/instrumental/title/style/duration/bpm/length/audio_format）');
const sunoBranch = payloadFn.slice(payloadFn.indexOf("family === 'suno'"), payloadFn.indexOf('} else {'));
ok(/payload\.custom = Boolean\(runSettings\.audioCustom\)/.test(sunoBranch), 'suno：custom 只在 suno 家族发送');
ok(/payload\.instrumental = Boolean\(runSettings\.audioInstrumental\)/.test(sunoBranch), 'suno：instrumental 只在 suno 家族发送');
ok(/payload\.duration = audioDurationValue\(\)/.test(sunoBranch), 'suno：duration 只在 suno 家族发送');
ok(/payload\.audio_format = audioFormatValue\(\)/.test(sunoBranch), 'suno：audio_format 只在 suno 家族发送');
ok(/payload\.title = String\(runSettings\.audioTitle/.test(sunoBranch) && /payload\.style = String\(runSettings\.audioStyle/.test(sunoBranch),
    'suno：title / style 只在 suno 家族发送');
const otherBranch = payloadFn.slice(payloadFn.indexOf('} else {'));
ok(/payload\.length = audioLengthValue\(\)/.test(otherBranch) && /payload\.bpm = audioBpmValue\(\)/.test(otherBranch),
    'flowmusic：length / bpm 只在非 suno 家族发送');
ok(!/payload\.duration = /.test(otherBranch) && !/payload\.instrumental = /.test(otherBranch), 'flowmusic 分支不发送 suno 专属参数');
const familyFn = extractFn(js, 'audioModelFamily');
ok(/includes\('suno'\)/.test(familyFn) && /includes\('flowmusic'\)/.test(familyFn), '按模型名分 suno / flowmusic 两个家族');
const providersFn = extractFn(js, 'audioProviders');
ok(/p\.enabled !== false/.test(providersFn) && /p\.has_key !== false/.test(providersFn) && /p\.audio_models/.test(providersFn),
    '音频平台过滤与视频模型下拉同一口径（enabled / has_key / audio_models 非空）');
const paramsFn = extractFn(js, 'renderAudioParams');
ok(/dynamicParams\.innerHTML/.test(paramsFn), '音频参数渲染进底部编辑栏的参数行');
ok(/smart\.audioNoProvider/.test(paramsFn) && /if\(!providers\.length\)/.test(paramsFn), '一个音频平台都没有时给一句明确的中文提示（不渲染空下拉）');
const dynFn = extractFn(js, 'renderDynamicParams');
ok(/if\(isSmartAudioNode\(selectedNode\(\)\)\)\{\s*renderAudioParams\(\);/.test(dynFn), 'renderDynamicParams 先认音频节点，不碰图片/视频那套 apiKind 归一');
ok(/settings\.apiKind = settings\.apiKind === 'video' \? 'video' : 'image';/.test(dynFn), '图片/视频的 apiKind 归一保持原样');
ok(/audio-settings-control/.test(js) && /audio-settings-popover/.test(css), '音频参数弹层有独立样式');
ok(/描述你想要生成的任何内容/.test(js), 'prompt 占位文案：描述你想要生成的任何内容');

console.log('[5] 落地：canvas_meta 自动落位 + 标题沿用 canvas_meta.title');
const placeFn = extractFn(js, 'placeAudioResult');
ok(/afterVideoAutoPlace\(target, audios, canvasMeta\)/.test(placeFn), '有 canvas_meta 时复用现有自动落位（视口平移 + 提示）');
ok(/canvasMeta\?\.title/.test(placeFn), '节点标题沿用 canvas_meta.title');
ok(/type:'smart-audio'/.test(placeFn) && /addConnection\(live\.id, target\.id, 'history'\)/.test(placeFn),
    '已有素材时新结果落到右侧音频节点，旧的留作历史');
ok(/applySmartMediaTypeForKind\(live, 'audio'\)/.test(placeFn), '空节点出结果后就地长成音频节点');
ok(/canvasMeta\.auto_place !== true/.test(extractFn(js, 'afterVideoAutoPlace')), 'auto_place 判定沿用既有实现（非 true 不平移）');
const applyKindFn = extractFn(js, 'applySmartMediaTypeForKind');
ok(/else if\(kind === 'audio'\) node\.type = 'smart-audio'/.test(applyKindFn), 'applySmartMediaTypeForKind 认识 audio kind');
const dispatchAt = js.indexOf('await runSmartAudioGeneration(node, prompt, refs)');
ok(dispatchAt > 0 && js.slice(Math.max(0, dispatchAt - 120), dispatchAt).includes('isSmartAudioNode(node)'), 'runGeneration 把音频节点分流到 runSmartAudioGeneration');

console.log('[6] 图片结果的 size_notice 要 toast 出来（没有该字段时行为不变）');
const noticeFn = extractFn(js, 'toastImageSizeNotice');
ok(/typeof result\?\.size_notice === 'string'/.test(noticeFn), '只认字符串 size_notice（没有该字段时什么都不做）');
ok(/toast\(notice\.slice\(0, 180\)/.test(noticeFn), 'toast 出来（截断 180，避免长句刷屏）');
ok(/lastImageSizeNotice/.test(noticeFn), '同一句短时间内只提示一次（并发多张不刷屏）');
ok(/if\(\(task\.kind \|\| 'image'\) === 'image'\) toastImageSizeNotice\(result\);/.test(js), '单节点图片任务结果处调用');
ok(/settled\.forEach\(toastImageSizeNotice\);/.test(js), '级联/批量图片结果处调用');
ok(!/size_notice/.test(extractFn(js, 'finalizePendingNode')), '不动 finalizePendingNode 的既有逻辑');

console.log('[7] 不改变图片 / 视频的既有行为');
ok(!/isSmartAudioNode/.test(extractFn(js, 'isVideoMediaItem')), 'isVideoMediaItem 不受影响');
ok(/function isSmartImageNode\(node\)\{\s*return Boolean\(node && \(node\.type === 'smart-image' \|\| !node\.type\)\);/.test(js), 'isSmartImageNode 仍是 smart-image / 无 type');
ok(/const kind = s\.apiKind === 'video' \? 'video' : 'image';/.test(extractFn(js, 'smartRerunInfo')), '重跑仍只认图片/视频');
ok(/if\(isSmartAudioNode\(node\) \|\| node\.runSettings\.apiKind === 'audio'\) return null;/.test(extractFn(js, 'smartRerunInfo')),
    '音频节点不参与「再来一张」（那条链路会把它当图片发出去）');
ok(/const nodeType = options\.type \|\| \(nodeImages\.length && nodeImages\.every\(isVideoMediaItem\) \? 'smart-video' : 'smart-image'\);/.test(js),
    'createNode 的自动类型推断没变（拖入素材仍按原口径，不擅自改老画布行为）');

console.log('[8] 行为：在沙箱里跑真实的参数门控函数');
const sandbox = [
    extractConst(js, 'AUDIO_SUNO_DURATION_MIN'),
    extractConst(js, 'AUDIO_SUNO_DURATION_MAX'),
    extractConst(js, 'AUDIO_SUNO_DURATION_DEFAULT'),
    extractConst(js, 'AUDIO_FORMATS'),
    'let apiProviders = [];',
    'let settings = {audioModel:"suno-v5", audioDuration:30, audioLength:0, audioBpm:0, audioFormat:""};',
    'function trd(key, fallback){ return fallback; }',
    extractFn(js, 'audioProviders'),
    extractFn(js, 'audioProviderById'),
    extractFn(js, 'isUnsupportedAudioModel'),
    extractFn(js, 'providerAudioModels'),
    extractFn(js, 'correctedAudioModelForProvider'),
    extractFn(js, 'audioModelFamily'),
    extractFn(js, 'audioDurationValue'),
    extractFn(js, 'audioLengthValue'),
    extractFn(js, 'audioBpmValue'),
    extractFn(js, 'audioFormatValue'),
    'globalThis.__a = {',
    '    setProviders(v){ apiProviders = v; },',
    '    setSettings(v){ settings = Object.assign({}, settings, v); },',
    '    providers(){ return audioProviders(); },',
    '    models(id){ return providerAudioModels(id); },',
    '    corrected(id, model){ return correctedAudioModelForProvider(id, model); },',
    '    family(model){ return audioModelFamily(model); },',
    '    duration(){ return audioDurationValue(); },',
    '    length(){ return audioLengthValue(); },',
    '    bpm(){ return audioBpmValue(); },',
    '    format(){ return audioFormatValue(); }',
    '};'
].join('\n');
const sandboxOut = {};
vm.runInNewContext(sandbox, sandboxOut, {filename:'static/js/smart-canvas.js'});
const a = sandboxOut.__a;

const PROVIDERS = [
    {id:'p1', name:'P1', enabled:true, has_key:true, audio_models:['suno-v5','flowmusic']},
    {id:'p2', name:'P2', enabled:true, has_key:false, audio_models:['suno-v4']},
    {id:'p3', name:'P3', enabled:false, has_key:true, audio_models:['suno-v3']},
    {id:'p4', name:'P4', enabled:true, has_key:true, audio_models:[]},
    {id:'p5', name:'P5', enabled:true, has_key:true}
];
a.setProviders(PROVIDERS);
eq(a.providers().map(p => p.id), ['p1'], '音频平台只留 enabled + 有 Key + 有 audio_models 的（与视频口径一致）');
eq(a.models('p1'), ['suno-v5', 'flowmusic'], '平台音频模型按列表返回');
eq(a.models('p4'), [], '没配音频模型的平台返回空（不兜底）');
eq(a.models('nope'), [], '未知平台返回空（不兜底别的平台）');
eq(a.corrected('p1', 'flowmusic'), 'flowmusic', '模型在新平台合法时保持不动');
eq(a.corrected('p1', 'suno-v4'), 'suno-v5', '换平台后旧模型不存在时回落到新平台第一个');
eq(a.corrected('p1', ''), 'suno-v5', '没选模型时回落到第一个（与视频模型同一口径）');

eq(a.family('suno-v5'), 'suno', 'suno 系认 suno');
eq(a.family('SUNO'), 'suno', '模型名大小写不敏感');
eq(a.family('flowmusic'), 'flowmusic', 'flowmusic 系认 flowmusic');
eq(a.family('other-music'), 'generic', '其它模型走 generic');

a.setSettings({audioDuration:30});
eq(a.duration(), 30, 'suno 时长原样');
a.setSettings({audioDuration:5});
eq(a.duration(), 10, 'suno 时长下限 10 秒');
a.setSettings({audioDuration:9999});
eq(a.duration(), 360, 'suno 时长上限 360 秒');
a.setSettings({audioDuration:0});
eq(a.duration(), 0, '0 = 不传（自适应）');
a.setSettings({audioDuration:''});
eq(a.duration(), 0, '空值 = 自适应');
a.setSettings({audioDuration:45.6});
eq(a.duration(), 46, '时长取整');

a.setSettings({audioLength:-5, audioBpm:-1});
eq([a.length(), a.bpm()], [0, 0], 'flowmusic 负数视为不传');
a.setSettings({audioLength:90, audioBpm:128});
eq([a.length(), a.bpm()], [90, 128], 'flowmusic 目标时长 / BPM 原样');

a.setSettings({audioFormat:'WAV'});
eq(a.format(), '', '大小写不匹配的格式回落到默认');
a.setSettings({audioFormat:'m4a'});
eq(a.format(), 'm4a', 'mp3/m4a/wav 白名单内原样');
a.setSettings({audioFormat:'ogg'});
eq(a.format(), '', '白名单外（ogg）回落默认，不发给后端');

console.log('[9] 结果态播放器：细波形 + 蓝色播放头 + 上一首/播放/下一首');
const playerFn = extractFn(js, 'smartAudioPlayerHtml');
ok(/audio-player-wave/.test(playerFn) && /data-audio-canvas/.test(playerFn) && /data-audio-head/.test(playerFn), '卡片里有波形 canvas + 播放头');
ok(/data-audio-time="1"/.test(playerFn) && /data-audio-time-text="1"/.test(playerFn), '波形下方有跟随播放头的时间胶囊');
ok(/smartAudioClockLabel\(0, 0\)/.test(playerFn), '胶囊初始文本走 mm:ss 格式化（00:00/00:00）');
ok(/data-audio-prev/.test(playerFn) && /data-audio-toggle/.test(playerFn) && /data-audio-next/.test(playerFn), '底部有 上一首 / 播放 / 下一首');
ok(/count < 2 \? 'disabled' : ''/.test(playerFn), '单首时上一首/下一首是 disabled');
ok(!/<audio[\s>]/.test(playerFn) && !/\scontrols[=\s>]/.test(playerFn), '播放器 HTML 里没有 <audio controls>（音源是隐藏元素）');
ok(!/media-card-title|image-name-badge/.test(playerFn), '播放器卡片里没有文件名');
ok(!/时长|duration-text/.test(playerFn), '播放器卡片里没有时长文字');
const drawFn = extractFn(js, 'smartAudioDrawWave');
ok(/AUDIO_WAVE_BAR_WIDTH/.test(drawFn) && /AUDIO_WAVE_BAR_GAP/.test(drawFn), '竖条宽度/间距走常量（3px / 1px，75% 占空比）');
ok(/Math\.max\(AUDIO_WAVE_BARS_MIN, Math\.min\(AUDIO_WAVE_BARS_MAX/.test(drawFn), '条数落在 64–128 根之间');
ok(/ctx\.roundRect/.test(drawFn) && /AUDIO_WAVE_BAR_WIDTH \/ 2/.test(drawFn), '竖条是圆角细条');
ok(/devicePixelRatio/.test(drawFn) && /canvas\.width = Math\.round\(width \* dpr\)/.test(drawFn), '按 DPR 画在 canvas 上');
ok(/AUDIO_WAVE_MAX_BAR_RATIO/.test(drawFn) && /AUDIO_WAVE_CARD_MAX_RATIO/.test(drawFn) && /Math\.round\(\(barAreaHeight - barHeight\) \/ 2\)/.test(drawFn), '波形上下居中、最大高度按卡片比例（38%）');
ok(/height - AUDIO_TIME_CAPSULE_ZONE/.test(drawFn), '波形区底部给时间胶囊留了一条，竖条不会压到胶囊上');
ok(/getPropertyValue\('--audio-bar'\)/.test(drawFn), '竖条颜色走主题变量（暗/亮两套）');
ok(/entry\.waveSignature === signature/.test(drawFn), '签名没变就不重画（render 每轮都挂载）');
const decodeFn = extractFn(js, 'smartAudioEnvelopeFor');
ok(/fetch\(url/.test(decodeFn) && /decodeAudioData/.test(decodeFn), '波形用真实音频：fetch + decodeAudioData');
ok(/smartAudioFallbackEnvelope\(url\)/.test(decodeFn), '取音频/解码失败时回落到占位波形');
ok(/AUDIO_ENVELOPE_CACHE_MAX/.test(decodeFn), '每个 URL 的峰值进缓存（带上限）');
/* 防回退：包络闸门必须跟「音源切换」解耦。曾经 ensureSource 顺手写了 entry.envelopeUrl = url，
   把 ensureEnvelope 的 if(entry.envelopeUrl === url) return 直接命中，于是永远不 fetch + decode，
   波形一直是 smartAudioFallbackEnvelope 的占位波形（实测：8s 带静音的 wav 画不出静音缺口）。 */
const ensureEnvFn = extractFn(js, 'smartAudioEnsureEnvelope');
const ensureSrcFn = extractFn(js, 'smartAudioEnsureSource');
ok(/entry\.envelopeKey === url/.test(ensureEnvFn) && /entry\.envelopeKey = url/.test(ensureEnvFn),
    '包络闸门用独立的 envelopeKey 记「哪个 URL 已认领过包络」');
ok(!/entry\.envelopeKey\s*=/.test(ensureSrcFn), 'ensureSource 不写 envelopeKey（不让音源切换把包络闸门关死）');
ok(!/envelopeUrl/.test(js), '旧的 envelopeUrl 标记已删干净（职责不再被两处抢写）');
ok(/smartAudioEnvelopeCache\.get\(url\)/.test(ensureEnvFn) && !/smartAudioEnvelopeCache/.test(ensureSrcFn),
    '包络缓存读取只在 ensureEnvelope 里（去重，不双解码）');
ok(/if\(cached\)\{ smartAudioDrawWave\(node, entry, true\); return; \}/.test(ensureEnvFn)
    && /entry\.envelope = envelope;\s*smartAudioDrawWave\(node, entry, true\);/.test(ensureEnvFn),
    '包络（缓存命中或异步到达）都会强制重画波形');
const paintFn = extractFn(js, 'smartAudioPaintHead');
ok(/current \/ duration/.test(paintFn), '播放头位置 = 当前时间 / 总时长');
ok(/Math\.min\(1, Math\.max\(0, current \/ duration\)\)/.test(paintFn), '比例夹在 0..1（播完到最右）');
ok(/translateX\(/.test(paintFn), '播放头用 transform 平滑移动');
ok(/smartAudioStartRaf|requestAnimationFrame/.test(js), '播放中靠 rAF 逐帧更新播放头');
ok(/data-audio-played="1"/.test(playerFn) && /data-audio-played-canvas="1"/.test(playerFn), '波形上叠了一层「已播放」高亮 canvas（全曲轮廓原地不动）');
ok(/smartAudioPaintPlayedLayer\(entry, canvas\)/.test(drawFn) && /ctx\.drawImage\(canvas, 0, 0\)/.test(js),
    '高亮层直接复制底层像素（亮色版波形一次画好，不重复描一遍条）');
ok(/ui\.played\.style\.width = smartAudioPlayedWidth\(ratio, width\)\.toFixed\(1\) \+ 'px'/.test(paintFn),
    '每帧只改高亮层的宽度（与播放头同一个 ratio，不重画整条波形）');
ok(/ui\.played\.dataset\.audioPlayedRatio = ratio\.toFixed\(4\)/.test(paintFn), '高亮比例写进 dataset（真机可直接读）');
ok(/\.audio-player-played \{[^}]*overflow:hidden[^}]*pointer-events:none/.test(css), '高亮层靠外层 overflow 裁剪，且不挡波形拖动 seek');
ok(/\.audio-player-wave > \.audio-player-canvas \{ opacity:\.[0-9]+/.test(css), '未播放段用底层 canvas 低透明度压暗一档（颜色仍派生自 --audio-bar）');
const seekFn = extractFn(js, 'smartAudioSeekRatio');
ok(/bounded \* duration/.test(seekFn), 'seek 换算：点击比例 × 总时长');
const bindFn = extractFn(js, 'bindSmartAudioPlayer');
ok(/pointerdown/.test(bindFn) && /pointermove/.test(bindFn) && /pointerup/.test(bindFn), '波形支持点/拖 seek');
ok(/event\.clientX - rect\.left\) \/ rect\.width/.test(bindFn), 'seek 比例按波形区域宽度算');
/* 防回退：seek 一律现取「文档里」的波形元素，不能用 bind 时的闭包 wave。
   点未选中节点会先走选中 + render 重建 DOM，闭包里的 wave 已脱离文档、宽度是 0，
   那条 if(!rect.width) return 会把这一次点击的 seek 整条吞掉。
   真机复现（未选中节点第一次点波形 62.5%）：播放头 ratio 停在 0.0000 / currentTime 0，
   同位置再点第二次才到 0.625 / 5.0s（8s 音频）。 */
const seekSlice = bindFn.slice(bindFn.indexOf('const nodeFor'), bindFn.indexOf('let seeking = false'));
ok(seekSlice.length > 200, 'bindSmartAudioPlayer 里能找到 seek 相关主体');
ok(/closest\?\.\('\[data-audio-wave\]'\)/.test(seekSlice), 'seek 从事件 target 现取波形（closest [data-audio-wave]）');
ok(!/\bwave\.getBoundingClientRect/.test(seekSlice), 'seek 不读闭包 wave 的 rect（脱离文档后宽度是 0）');
ok(/data-audio-wave/.test(seekSlice) && /data-audio-node=/.test(seekSlice) && /querySelector/.test(seekSlice) && /isConnected/.test(seekSlice),
    '事件里拿不到波形时按节点 id 回查文档中的波形，并校验它仍在文档里');
ok(!/\|\| !wave \|\|/.test(bindFn), 'seek 的早退条件不再依赖闭包 wave（否则未选中节点的第一次点击必丢）');
/* 防回退：拖动会话必须是模块级状态。点未选中节点会先选中 + render 重建波形 DOM，
   新元素上重新 bind 的闭包 seeking 恒为 false，后续 pointermove 只认闭包就会「只有第一下 seek 生效」。
   真机复现（未选中节点按住拖 15% → 45% → 80%）：播放头停在 0.15，后两下不动，松手也停在 0.15。 */
ok(/let smartAudioSeekSession = null;/.test(js), '模块级拖动会话 smartAudioSeekSession 存在（{nodeId, pointerId}）');
ok(/smartAudioSeekSession = \{nodeId, pointerId: event\.pointerId\}/.test(bindFn), 'pointerdown 命中波形时写入会话（带 nodeId + pointerId）');
const moveSlice = bindFn.slice(bindFn.indexOf("'pointermove'"), bindFn.indexOf('const endSeek'));
ok(!/if\(!seeking\) return;/.test(moveSlice), 'pointermove 不再只看闭包 seeking（重建 DOM 后它恒为 false）');
ok(/!seeking && !seekingHere\(event\)/.test(moveSlice) && /smartAudioSeekSession\.nodeId === nodeId/.test(bindFn)
    && /smartAudioSeekSession\.pointerId === event\.pointerId/.test(bindFn),
    'pointermove 认「同一个 node + 同一个 pointerId」的会话继续 seek');
const endSlice = bindFn.slice(bindFn.indexOf('const endSeek'), bindFn.indexOf("'pointerup', endSeek"));
ok(/if\(!seeking && !seekingHere\(event\)\) return;/.test(endSlice) && /if\(seekingHere\(event\)\) smartAudioSeekSession = null;/.test(endSlice),
    'pointerup / pointercancel 命中会话时清空（不残留）');
ok(/window\.addEventListener\('pointerup', \(\) => \{ smartAudioSeekSession = null; \}\)/.test(js)
    && /window\.addEventListener\('pointercancel', \(\) => \{ smartAudioSeekSession = null; \}\)/.test(js),
    '拖到节点外松手（波形收不到 pointerup）也清空会话，否则鼠标一划过波形就 seek');
ok(/smartAudioSeekSession = null;/.test(extractFn(js, 'smartAudioStep')), '切歌清空会话');
ok(/if\(smartAudioSeekSession && smartAudioSeekSession\.nodeId === nodeId\) smartAudioSeekSession = null;/.test(extractFn(js, 'smartAudioPrunePool')),
    '音频被删 / 节点清空时清空会话');
const stepFn = extractFn(js, 'smartAudioStep');
ok(/\(smartAudioActiveIndex\(node\) \+ delta \+ count\) % count/.test(stepFn), '上一首/下一首在 node.images 里环形切换');
ok(/node\.audioActiveIndex = /.test(stepFn) && /scheduleSave\(\)/.test(stepFn), '切歌把当前序号写回节点并持久化');
ok(/const wasPlaying = !entry\.el\.paused/.test(stepFn), '正在播时切歌继续播，暂停就保持暂停');
const playFn = extractFn(js, 'smartAudioPlay');
ok(/smartAudioPauseOthers\(node\.id\)/.test(playFn), '同一时间只允许一个音频在播（播新的先暂停旧的）');
const endedFn = extractFn(js, 'smartAudioHandleEnded');
ok(/smartAudioPaintHead/.test(endedFn) && !/currentTime = 0/.test(endedFn), '播完停在末尾（不自动回到开头）');
ok(/mountSmartAudioPlayers\(\);/.test(js), 'render 收尾会挂载播放器（重绘/刷新后重新初始化）');
ok(/studio-theme-change/.test(js), '切换主题重画波形');
ok(/ResizeObserver/.test(js), '节点缩放后重画波形');
ok(/document\.createElement\('audio'\)/.test(js) && /smartAudioPoolHost/.test(js), '音源是挂在 body 上的隐藏 audio（节点重绘不中断播放）');
ok(/AUDIO_WAVE_BAR_WIDTH = 2;/.test(js) && /AUDIO_WAVE_BAR_GAP = 2;/.test(js) && /AUDIO_WAVE_BARS_MIN = 64;/.test(js) && /AUDIO_WAVE_BARS_MAX = 96;/.test(js) && /AUDIO_WAVE_CARD_MAX_RATIO = 0\.38;/.test(js),
    '常量就是外观参数：2px 条宽 / 2px 间距 / 64–96 根 / 最大高度 38% 卡片');
ok(/--audio-bar: rgba\(255, 255, 255, \.58\)/.test(css), '暗色竖条是浅色半透明');
ok(/html:not\(\.studio-theme-dark\) \.audio-player-wave \{ --audio-bar: rgba\(10, 10, 10, \.62\)/.test(css), '亮色竖条换成深色');
ok(/\.audio-player-head \{[^}]*width:2px[^}]*background:var\(--audio-head\)/.test(css), '播放头是 2px 细竖线，颜色走 --audio-head');
ok(/--audio-head: var\(--accent\)/.test(css) && /--audio-head-text: var\(--accent-text\)/.test(css), '播放头/胶囊用主题 token（--accent / --accent-text），没有写死颜色');
ok(!/#4b9bff/i.test(css) && !/#4b9bff/i.test(js), '全仓代码里不再有兜底蓝 #4b9bff');
ok(/\.audio-player-time \{[^}]*background:var\(--audio-head\)[^}]*color:var\(--audio-head-text\)/.test(css), '时间胶囊 = accent 底 + accent-text 字');
ok(/\.audio-player-time \{[^}]*pointer-events:none/.test(css), '胶囊 pointer-events:none，不挡波形拖动 seek');
ok(/\.audio-player-time::before \{[^}]*clip-path:polygon\(50% 0, 0 100%, 100% 100%\)/.test(css), '胶囊顶部有小三角指向播放头（clip-path，不写 border）');
ok(/clip-path:polygon\(0 0, 100% 0, 50% 100%\)/.test(css), '播放头顶部小三角（clip-path 画，不写 border）');
ok(/\.audio-player \{[^}]*border-radius:var\(--radius-xl\)[^}]*background:color-mix\(in srgb, var\(--panel\) 95%, transparent\)/.test(css),
    '卡片是 95% 面板色磨砂底 + 大圆角，无描边');
ok(/\.audio-player-toggle \{[^}]*background:var\(--strong\)[^}]*color:var\(--strong-text\)/.test(css), '大圆播放键用主题对比色（暗色亮圆 / 亮色深圆）');

console.log('[10] 行为：包络 / 占位波形 / 序号 / seek / 互斥');
const playerSandbox = [
    extractConst(js, 'AUDIO_WAVE_BUCKETS'),
    extractConst(js, 'AUDIO_WAVE_PEAK_PERCENTILE'),
    extractConst(js, 'AUDIO_WAVE_PEAK_WEIGHT'),
    extractConst(js, 'AUDIO_WAVE_CONTRAST'),
    extractFn(js, 'smartAudioEnvelopeFromChannel'),
    extractFn(js, 'smartAudioFallbackEnvelope'),
    extractFn(js, 'smartAudioActiveIndex'),
    extractFn(js, 'formatAudioClock'),
    extractFn(js, 'smartAudioClockLabel'),
    extractFn(js, 'smartAudioHeadX'),
    extractFn(js, 'smartAudioPlayedWidth'),
    'const smartAudioPool = new Map();',
    'var paintCalls = 0;',
    'function smartAudioPoolFor(node){ return smartAudioPool.get(node.id); }',
    'function smartAudioPaintHead(){ paintCalls += 1; }',
    'function smartAudioSyncUi(){ }',
    extractFn(js, 'smartAudioSeekRatio'),
    extractFn(js, 'smartAudioPauseOthers'),
    'globalThis.__p = {',
    '    envelope(channel){ return smartAudioEnvelopeFromChannel(channel); },',
    '    fallback(url){ return smartAudioFallbackEnvelope(url); },',
    '    active(node){ return smartAudioActiveIndex(node); },',
    '    clock(value){ return formatAudioClock(value); },',
    '    label(cur, total){ return smartAudioClockLabel(cur, total); },',
    '    headX(ratio, width){ return smartAudioHeadX(ratio, width); },',
    '    capsuleCenter(ratio, width){ return smartAudioHeadX(ratio, width); },',
    '    playedW(ratio, width){ return smartAudioPlayedWidth(ratio, width); },',
    '    entry(id, entry){ smartAudioPool.set(id, entry); },',
    '    seek(node, ratio){ smartAudioSeekRatio(node, ratio); return smartAudioPool.get(node.id).el.currentTime; },',
    '    pauseOthers(exceptId){ smartAudioPauseOthers(exceptId); },',
    '    paused(id){ return smartAudioPool.get(id).el.paused; },',
    '    paints(){ return paintCalls; }',
    '};'
].join('\n');
const pOut = {};
vm.runInNewContext(playerSandbox, pOut, {filename:'static/js/smart-canvas.js'});
const pv = pOut.__p;

const silentThenLoud = new Array(44100).fill(0);
for(let i = silentThenLoud.length / 2; i < silentThenLoud.length; i += 1) silentThenLoud[i] = 1;
const envelope = pv.envelope(silentThenLoud);
eq(envelope.length, 512, '包络固定 512 段（换宽度只重新分箱）');
ok(envelope.slice(0, 200).every(v => v === 0), '静音段的包络是 0');
ok(envelope.slice(-50).every(v => v > 0.9), '响段的包络归一化到 ~1');
ok(envelope.every(v => v >= 0 && v <= 1), '包络值都在 0..1');
const flat = pv.envelope(new Array(44100).fill(0.25));
ok(flat.every(v => v > 0.99), '整体平稳的音量不会被 95 分位压扁');

/* 响度包络（不是频谱）：峰值 + RMS 混合后做动态范围拉伸 —— 小声段落比线性压得更低，起伏更像这首歌 */
const quietLoud = new Array(44100).fill(0);
for(let i = 0; i < quietLoud.length; i += 1){
    const loud = i >= quietLoud.length / 4;
    quietLoud[i] = Math.sin(i * 0.05) * (loud ? 1 : 0.35);
}
const mixEnvelope = pv.envelope(quietLoud);
const quietMean = mixEnvelope.slice(0, 100).reduce((a, b) => a + b, 0) / 100;
const loudMean = mixEnvelope.slice(-100).reduce((a, b) => a + b, 0) / 100;
ok(quietMean > 0.2 && quietMean < 0.31, '小声段落被动态范围拉伸压低（0.35 → 约 0.28，线性不拉伸会是 0.35）：' + quietMean.toFixed(3));
ok(loudMean > 0.95, '大声段落保持满高：' + loudMean.toFixed(3));
ok(/AUDIO_WAVE_PEAK_WEIGHT/.test(extractFn(js, 'smartAudioEnvelopeFromChannel')) && /AUDIO_WAVE_CONTRAST/.test(extractFn(js, 'smartAudioEnvelopeFromChannel')),
    '包络 = 峰值/RMS 混合 + 动态范围拉伸（响度，不是频率分频段）');

const fbA = pv.fallback('/assets/output/a.mp3');
const fbB = pv.fallback('/assets/output/a.mp3');
const fbC = pv.fallback('/assets/output/b.mp3');
eq(JSON.stringify(fbA), JSON.stringify(fbB), '占位波形对同一 URL 是确定的');
ok(JSON.stringify(fbA) !== JSON.stringify(fbC), '不同 URL 的占位波形不一样');
ok(fbA.every(v => v >= 0.12 && v <= 0.39), '占位波形是低振幅（0.12–0.39）');

eq([pv.active({images:[]}), pv.active(null)], [0, 0], '没有素材时序号是 0');
eq(pv.active({images:[1,2,3], audioActiveIndex:-5}), 0, '序号下限 0');
eq(pv.active({images:[1,2,3], audioActiveIndex:99}), 2, '序号上限是最后一首');
eq(pv.active({images:[1,2,3], audioActiveIndex:1.6}), 2, '序号四舍五入');
eq(pv.active({images:[1,2,3], audioActiveIndex:'abc'}), 0, '非法序号回落 0');

pv.entry('n1', {url:'/assets/output/a.mp3', el:{duration:10, currentTime:0, paused:false}});
eq(pv.seek({id:'n1'}, 0.25), 2.5, 'seek 0.25 → 2.5s（10s 音频）');
eq(pv.seek({id:'n1'}, 1.5), 10, 'seek 超过 1 夹到末尾');
eq(pv.seek({id:'n1'}, -2), 0, 'seek 小于 0 夹到开头');
pv.entry('n2', {url:'/assets/output/b.mp3', el:{duration:NaN, currentTime:3, paused:true}});
eq(pv.seek({id:'n2'}, 0.5), 3, '时长未知时不动播放位置（只重画播放头）');
ok(pv.paints() >= 4, '每次 seek 都会重画播放头');

pv.entry('a', {el:{paused:false, pause(){ this.paused = true; }}});
pv.entry('b', {el:{paused:false, pause(){ this.paused = true; }}});
pv.entry('c', {el:{paused:false, pause(){ this.paused = true; }}});
pv.pauseOthers('b');
eq([pv.paused('a'), pv.paused('b'), pv.paused('c')], [true, false, true], '播新的先暂停其它所有音频（互斥）');

console.log('[11] 时间胶囊：mm:ss 格式 / 永远跟随播放头（不夹边） / 每秒才改文本 / token');
const timeFn = extractFn(js, 'smartAudioPaintHead');
ok(/capsule\.dataset\.audioClock !== key/.test(timeFn), '时间文本只在整秒变化时改（不是每帧写 textContent）');
ok(/Math\.max\(0, Math\.floor\(current\)\)/.test(timeFn), '当前时间向下取整（暂停不会跳秒）');
/* 胶囊中心 = 播放头 x：同一个 x 同时写给 head 与 capsule，没有任何按宽度夹边的分支 */
ok(/ui\.head\.style\.transform = 'translateX\(' \+ \(x - 1\)\.toFixed\(1\)/.test(timeFn),
    '2px 竖线以 x 为中心（left:0 再左移半根线宽），所以「播放头 x」就是线的中心');
ok(/capsule\.style\.transform = 'translateX\(' \+ x\.toFixed\(1\) \+ 'px\) translateX\(-50%\)/.test(timeFn),
    '胶囊中心用同一个 x（= 线中心），-50% 让三角落在正中');
ok(!/smartAudioCapsuleX|timeWidth|Math\.max\(half/.test(js), '夹边逻辑和胶囊宽度测量已彻底删除（不再为“不溢出”偏移）');
ok(/target\.metrics\?\.width/.test(timeFn), '播放中不读布局（宽度走缓存的 metrics）');
ok(/data-audio-time/.test(js) && /pointer-events:none/.test(css), '胶囊不挡波形拖动（pointer-events:none）');
ok(/function smartAudioHeadX\(/.test(js) && /function formatAudioClock\(/.test(js) && /function smartAudioClockLabel\(/.test(js),
    '播放头 x / mm:ss 都是可单测的纯函数');
const seekFn2 = extractFn(js, 'smartAudioSeekRatio');
ok(/smartAudioPaintHead\(node\.id, entry\)/.test(seekFn2), 'seek 后立刻重画播放头与时间文本');
const syncFn = extractFn(js, 'smartAudioSyncUi');
ok(/smartAudioPaintHead\(nodeId, entry\)/.test(syncFn), '暂停/播放/切歌后 syncUi 也会对齐时间文本');

console.log('[12] 行为：mm:ss 补零 / 播放头与胶囊几何');
eq(pv.clock(0), '00:00', '0 秒 → 00:00');
eq(pv.clock(5.9), '00:05', '5.9 秒向下取整 → 00:05（不跳秒）');
eq(pv.clock(59), '00:59', '59 秒 → 00:59');
eq(pv.clock(61), '01:01', '超过 1 分钟 → 01:01（两位补零）');
eq(pv.clock(113), '01:53', '参考图里的 01:53');
eq(pv.clock(158), '02:38', '参考图里的 02:38');
eq(pv.clock(3599), '59:59', '差 1 秒到 1 小时 → 59:59');
eq(pv.clock(3600), '60:00', '超过 1 小时分钟继续往上加 → 60:00');
eq([pv.clock(NaN), pv.clock(-3), pv.clock('abc'), pv.clock(undefined)], ['00:00', '00:00', '00:00', '00:00'], '非法/负数一律 00:00');
eq(pv.label(2, 24), '00:02/00:24', '胶囊文案就是「当前/总时长」');
eq(pv.label(0, 158), '00:00/02:38', '总时长 > 1 分钟同样补零');

eq(pv.headX(0, 376), 1, '播放头在 0 时贴左边 1px（不贴死）');
eq(pv.headX(1, 376), 375, '播放头在末尾时贴右边 1px（播完到最右）');
eq(pv.headX(0.5, 376), 188, '播放头位置 = 比例 × 宽度');
eq(pv.headX(-1, 376), 1, '比例小于 0 夹到左边');
eq(pv.headX(2, 376), 375, '比例大于 1 夹到右边');

eq([pv.playedW(0, 376), pv.playedW(0.25, 376), pv.playedW(0.625, 376), pv.playedW(1, 376)], [0, 94, 235, 376],
    '已播放高亮宽度跟随 currentTime/duration（起点 0 / 25% / 62.5% / 播完整条）');
eq([pv.playedW(1.4, 376), pv.playedW(-1, 376), pv.playedW(NaN, 376)], [376, 0, 0], '高亮比例溢出/非法值夹在 0..1');
eq(pv.playedW(0.5, 0), 0, '宽度未知时高亮宽度 0（不会画出一条假高亮）');

/* 胶囊中心恒等于播放头 x —— 三种关键状态逐个验（误差 < 1px，实际是同一个值） */
[[0, 376, 't=0 起点'], [2 / 24, 376, '播放 2 秒'], [0.99, 376, 'seek 99%']].forEach(([ratio, width, label]) => {
    const headX = pv.headX(ratio, width);
    const capsuleCenter = pv.capsuleCenter(ratio, width);
    ok(Math.abs(capsuleCenter - headX) < 1, label + '：胶囊中心 = 播放头 x（误差 < 1px）');
});
eq(pv.capsuleCenter(0, 376), pv.headX(0, 376), '起点：胶囊中心就是播放头 x（不再被推离边缘）');
eq(pv.capsuleCenter(0.99, 376), pv.headX(0.99, 376), '末尾：胶囊中心仍是播放头 x（不再往回夹）');
ok(pv.capsuleCenter(0.99, 376) > 370, '末尾时胶囊中心接近最右侧（允许溢出卡片）');

/* 行为回归：ensureSource + ensureEnvelope 的真实实现（包络取一次 / 换 URL 重取 / 缓存命中不再解码）。
   修复前这段的第一个断言就会挂：ensureSource 写完 envelopeUrl 后 ensureEnvelope 直接 return，decode 次数恒为 0。 */
(async () => {
    console.log('[13] 行为：包络只解码一次 / 换素材或切歌重取 / 缓存命中不重复解码');
    const envSandbox = [
        'const smartAudioEnvelopeCache = new Map();',
        'const smartAudioPool = new Map();',
        'var decodeCalls = 0;',
        'function smartAudioEnvelopeFor(url){',
        '    decodeCalls += 1;',
        '    return Promise.resolve({ url }).then(envelope => { smartAudioEnvelopeCache.set(url, envelope); return envelope; });',
        '}',
        'function smartAudioDrawWave(){ }',
        'function smartAudioPaintHead(){ }',
        'function smartAudioPlay(){ }',
        'function imageForDisplay(item){ return item; }',
        extractFn(js, 'smartAudioActiveIndex'),
        extractFn(js, 'smartAudioActiveItem'),
        extractFn(js, 'smartAudioEnsureEnvelope'),
        extractFn(js, 'smartAudioEnsureSource'),
        'function smartAudioPoolFor(node){',
        '    let entry = smartAudioPool.get(node.id);',
        '    if(!entry){',
        '        entry = {el:{duration:8, currentTime:0, paused:true, src:"", load(){}, removeAttribute(){}},',
        '                 url:"", envelope:null, envelopeKey:"", waveSignature:"", waveBars:0, ui:null};',
        '        smartAudioPool.set(node.id, entry);',
        '    }',
        '    return entry;',
        '}',
        'globalThis.__env = {',
        '    sync(node){ const entry = smartAudioEnsureSource(node); smartAudioEnsureEnvelope(node, entry); return entry; },',
        '    entry(id){ return smartAudioPool.get(id); },',
        '    decodes(){ return decodeCalls; }',
        '};'
    ].join('\n');
    const eOut = {};
    vm.runInNewContext(envSandbox, eOut, {filename:'static/js/smart-canvas.js'});
    const ev = eOut.__env;
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    const node = {id:'a', images:[{url:'/1.wav'}], audioActiveIndex:0};

    ev.sync(node);
    await tick();
    eq(ev.decodes(), 1, '首次挂载真的去 fetch + decode（修复前这里是 0）');
    ok(ev.entry('a').envelope && ev.entry('a').envelope.url === '/1.wav', '解码完成后的包络写进 entry（不再回落占位波形）');

    for(let i = 0; i < 3; i += 1) ev.sync(node);
    await tick();
    eq(ev.decodes(), 1, 'render 多轮/重开面板都不重复解码（envelopeKey 命中同一 URL）');

    node.images.push({url:'/2.wav'});
    node.audioActiveIndex = 1;
    ev.sync(node);
    await tick();
    eq(ev.decodes(), 2, '切歌或换素材（URL 变了）重新取包络');
    ok(ev.entry('a').envelope?.url === '/2.wav', '包络换成新素材的（实际 ' + (ev.entry('a').envelope?.url || 'null') + '）');

    node.audioActiveIndex = 0;
    ev.sync(node);
    await tick();
    eq(ev.decodes(), 2, '切回已经解码过的一首：命中缓存，不再解码');
    ok(ev.entry('a').envelope?.url === '/1.wav', '包络切回旧素材的（实际 ' + (ev.entry('a').envelope?.url || 'null') + '）');

    console.log('');
    console.log('Audio 音频节点：' + pass + '/' + (pass + fails.length) + ' 项通过');
    if(fails.length){
        console.log('失败：');
        fails.forEach(item => console.log('  ✗ ' + item));
        process.exit(1);
    }
    console.log('全部通过');
})();
