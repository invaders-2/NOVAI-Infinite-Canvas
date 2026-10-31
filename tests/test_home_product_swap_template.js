#!/usr/bin/env node
'use strict';
/*
 * 首页新模板「产品换图 · 换鞋」回归。
 *
 * 覆盖真实行为点：
 *   1. static/home.html 的 TEMPLATES 里有 id='product-swap'，封面 media 指向 /static/images/templates/product-swap.jpg；
 *   2. 节点顺序与形态：标题胶囊 → 鞋子分组 → 模特图 → 文本说明 → 换鞋生成（gen, portrait43）；
 *   3. 换鞋生成节点的 inputs 同时包含 shoes / model / prompt（少一个都启动不了这条工作流）；
 *   4. 文本节点带完整约束（只替换鞋子、其它不变、多角度参考顺序、不悬空/穿模、摄影质感），且不带 brief:true
 *      —— 带 brief 会被首页输入框的文字覆盖掉；
 *   5. 素材节点不带 ref/brief：首页上传的参考图不该顶掉用户自己拖进来的鞋图/模特图；
 *   6. 封面 jpg 存在、非空、是 JPEG、尺寸 640x440；
 *   7. 旧的 14 个模板一个都没丢，SKILLS 八个入口不变；
 *   8. smart-canvas.js 的 buildHomeSeedNode 认识 type:'group'（分组节点靠它落成真正的 smart-group）。
 *
 * 模板对象直接从 home.html 里切出来 eval，测的是文件里真正跑的那段定义，不是另抄一份。
 *
 * 跑法：node tests/test_home_product_swap_template.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const homePath = path.join(root, 'static/home.html');
const canvasPath = path.join(root, 'static/js/smart-canvas.js');
const home = fs.readFileSync(homePath, 'utf8');
const canvas = fs.readFileSync(canvasPath, 'utf8');
const cssPath = path.join(root, 'static/css/smart-canvas.css');
const css = fs.readFileSync(cssPath, 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };

console.log('[1] home.html 里能定位模板定义与封面');
ok(/id: 'product-swap'/.test(home), "static/home.html 有 id: 'product-swap'");
ok(/media: '\/static\/images\/templates\/product-swap\.jpg'/.test(home), '封面 media 指向 /static/images/templates/product-swap.jpg');
ok(/title: '产品换图 · 换鞋'/.test(home), '标题为「产品换图 · 换鞋」');
ok(/cat: '电商'/.test(home.slice(home.indexOf("id: 'product-swap'"), home.indexOf("id: 'product-swap'") + 400)), 'cat 归到「电商」');
ok(/icon: 'camera', color: '#0f766e'/.test(home), "icon: camera / color: #0f766e");

console.log('[2] 首页展示模板为空，技能工作流对象可从 home.html 切片 eval');
const sliceStart = home.indexOf('var KEEP = ');
const sliceEnd = home.indexOf('var TEMPLATE_MAP = {};');
ok(sliceStart >= 0 && sliceEnd > sliceStart, '模板定义区块（var KEEP … TEMPLATE_MAP）可定位');
let TEMPLATES = null;
let HOME_TEMPLATES = null;
if (sliceStart >= 0 && sliceEnd > sliceStart) {
    try {
        const lists = new Function(home.slice(sliceStart, sliceEnd) + '\nreturn {home:TEMPLATES, skills:SKILL_TEMPLATES};')();
        HOME_TEMPLATES = lists.home;
        TEMPLATES = lists.skills;
    } catch (e) {
        ok(false, '模板定义区块 eval 失败：' + e.message);
    }
}
ok(Array.isArray(HOME_TEMPLATES) && HOME_TEMPLATES.length === 0, '首页展示模板列表已清空');
ok(/id="hpTemplateSection" hidden/.test(home) && /\$\('hpTemplateSection'\)\.hidden = !list\.length/.test(home), '没有展示模板时整个模板区隐藏');
ok(Array.isArray(TEMPLATES) && TEMPLATES.length > 0, '技能工作流列表仍然完整');
const tpl = (TEMPLATES || []).find(t => t.id === 'product-swap');
ok(Boolean(tpl), '技能工作流里能找到 product-swap');

console.log('[3] 节点顺序与形态');
const nodes = (tpl && tpl.nodes) || [];
ok(nodes.length === 5, '产品换图模板共 5 个节点（实际 ' + nodes.length + '）');
const [n0, shoes, model, prompt, swap] = nodes;
ok(n0 && n0.type === 'label' && n0.text === '产品换图' && n0.color === '#0f766e', '第 1 个是标题胶囊「产品换图」#0f766e');
ok(shoes && shoes.key === 'shoes' && shoes.type === 'group' && shoes.title === '鞋子多角度白底图' && shoes.col === 0,
    '第 2 个是空分组节点：鞋子多角度白底图（多图拖进去自动收进分组）');
ok(shoes && !shoes.ref && !shoes.brief, '鞋子分组不带 ref / brief 标记（首页上传图不会顶掉它）');
ok(model && model.key === 'model' && model.type === 'image' && model.title === '模特参考图' && model.col === 0,
    '第 3 个是空图片节点：模特参考图');
ok(model && !model.ref && !model.brief, '模特图节点不带 ref / brief 标记');
ok(model && model.titleChip === true, '模特图节点带 titleChip:true（画布上挂可见的名字 chip）');
ok(swap && swap.titleChip === true, '生成节点带 titleChip:true（画布上挂可见的名字 chip）');
ok(prompt && !prompt.titleChip && shoes && !shoes.titleChip, '文本/分组节点不加 titleChip（分组标题本来可见、文本节点自带内容）');
const chipNodes = (TEMPLATES || []).reduce((acc, t) => acc.concat((t.nodes || []).filter(n => n.titleChip)), []);
ok(chipNodes.length === 2 && (TEMPLATES || []).length === 15, '全站模板里只有 product-swap 的两个节点带 titleChip（旧模板不动）', JSON.stringify(chipNodes.map(n => n.title)));
ok(prompt && prompt.key === 'prompt' && prompt.type === 'text' && prompt.col === 0, '第 4 个是文本说明节点');
ok(prompt && !prompt.brief, '文本节点不带 brief:true（否则首页输入框会把这段提示词覆盖掉）');
ok(swap && swap.key === 'swap' && swap.type === 'gen' && swap.title === '换鞋生成' && swap.ratio === 'portrait43' && swap.col === 1,
    '第 5 个是生成节点：换鞋生成 / portrait43 / 第 1 列');

console.log('[4] 换鞋生成节点的输入连线');
const inputs = (swap && swap.inputs) || [];
ok(Array.isArray(inputs) && ['shoes', 'model', 'prompt'].every(k => inputs.includes(k)),
    'inputs 同时包含 shoes / model / prompt（实际 ' + JSON.stringify(inputs) + '）');
ok(inputs.length === 3, '正好 3 条输入（不多连、不漏连）');
const keySet = new Set(nodes.map(n => n.key));
ok(['shoes', 'model', 'prompt'].every(k => keySet.has(k)), 'inputs 里的 key 在节点里都存在（不会连到空气）');

console.log('[5] 文本约束完整');
const text = (prompt && prompt.text) || '';
ok(text.indexOf('只替换模特脚上的鞋子') >= 0, '文本含「只替换模特脚上的鞋子」');
ok(text.indexOf('画面其它一切保持不变') >= 0, '文本含「画面其它一切保持不变」');
ok(text.indexOf('参考图顺序') >= 0 && text.indexOf('最后一张是模特图') >= 0, '文本含参考图顺序（前面鞋图、最后一张模特图）');
ok(text.indexOf('鞋型') >= 0 && text.indexOf('鞋底纹路') >= 0, '文本含鞋款细节约束（鞋型…鞋底纹路）');
ok(text.indexOf('悬空') >= 0 && text.indexOf('穿模') >= 0, '文本含「不能悬空、不能穿模」');
ok(text.indexOf('真实摄影质感') >= 0 && text.indexOf('水印') >= 0, '文本含输出要求（真实摄影质感、不要水印）');
ok((prompt && prompt.text || '').length > 200, '文本不是一句空话（长度 ' + text.length + '）');
ok(swap && /只替换模特脚上的鞋子/.test(swap.prompt || ''), '生成节点 prompt 也写了「只替换模特脚上的鞋子」');
ok(swap && /模特、姿势、服装、场景、光线和构图全部保持原样/.test(swap.prompt || ''), '生成节点 prompt 写明其它全部保持原样');

console.log('[6] 封面文件');
const coverPath = path.join(root, 'static/images/templates/product-swap.jpg');
const exists = fs.existsSync(coverPath);
ok(exists, '封面文件存在：static/images/templates/product-swap.jpg');
if (exists) {
    const st = fs.statSync(coverPath);
    const buf = fs.readFileSync(coverPath);
    ok(st.size > 0, '封面 > 0 字节（' + st.size + '）');
    ok(buf[0] === 0xFF && buf[1] === 0xD8, '封面是 JPEG（SOI FFD8）');
    // 扫 SOF 段读宽高，零依赖
    let w = 0, h = 0, i = 2;
    while (i < buf.length - 9) {
        if (buf[i] !== 0xFF) { i += 1; continue; }
        const marker = buf[i + 1];
        if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
            h = buf.readUInt16BE(i + 5);
            w = buf.readUInt16BE(i + 7);
            break;
        }
        i += 2 + len;
    }
    ok(w === 640 && h === 440, '封面尺寸 640x440（实际 ' + w + 'x' + h + '）');
    ok(st.size < 120 * 1024, '封面 < 120KB（实际 ' + st.size + ' 字节）');
}

console.log('[7] 旧模板与技能入口没被动过');
const ids = (TEMPLATES || []).map(t => t.id);
const legacy = ['ecom-set', 'white-bg', 'multi-angle', 'retouch', 'poster', 'social-cover', 'portrait', 'try-on',
    'storyboard', 'video-relay', 'product-video', 'char-three', 'scene-four', 'batch'];
ok(legacy.every(id => ids.includes(id)), '旧 14 个模板全部保留');
ok(ids.filter(id => id === 'product-swap').length === 1, 'product-swap 只出现一次');
ok((TEMPLATES || []).length === 15, '模板总数 15（实 ' + (TEMPLATES || []).length + '）');
ok(ids[0] === 'product-swap', 'product-swap 排在第一张（新模板先上首页）');
const skillsBlock = home.slice(home.indexOf('var SKILLS = ['), home.indexOf('var MODES = ['));
const skillIds = (skillsBlock.match(/id: '[a-z-]+'/g) || []).map(s => s.slice(5, -1));
ok(skillIds.length === 8, 'SKILLS 仍是 8 个入口（实 ' + skillIds.length + '）');
ok(skillIds.join(',') === 'ecom-set,poster,storyboard,char-three,retouch,multi-angle,video-relay,batch', 'SKILLS 入口顺序未变');
ok(!/(^|[{, ])type: 'group', ref|type: 'group', brief/.test(home) && !/key: 'shoes', type: 'group', ref/.test(home), '鞋子分组没有混进 ref/brief 标记');

console.log('[8] smart-canvas 认识 type:group 的种子节点');
const seedStart = canvas.indexOf('function buildHomeSeedNode(');
const seedEnd = canvas.indexOf('function applyHomeCanvasSeed(');
ok(seedStart >= 0 && seedEnd > seedStart, 'buildHomeSeedNode 可定位');
const seedBody = seedStart >= 0 && seedEnd > seedStart ? canvas.slice(seedStart, seedEnd) : '';
ok(/if\(type === 'group'\)\{/.test(seedBody), "buildHomeSeedNode 里有 type === 'group' 分支");
ok(/type:'smart-group'/.test(seedBody), '该分支产出 smart-group 节点');
ok(/SMART_GROUP_DEFAULT_WIDTH/.test(seedBody) && /SMART_GROUP_DEFAULT_HEIGHT/.test(seedBody), '分组用默认宽高落位');
ok(/items:\[\]/.test(seedBody), '分组初始 items 为空数组（成员靠拖入）');
ok(/ensureSmartImageAssetId/.test(seedBody), '分组可选初始图片同样走 ensureSmartImageAssetId');

console.log('[9] 显示名 chip：种子字段 + 渲染分支 + 样式');
ok(/spec\.titleChip && String\(spec\.title \|\| ''\)\.trim\(\)/.test(seedBody), 'buildHomeSeedNode 只在 spec.titleChip 且 title 非空时写 templateTitle');
ok(/node\.templateTitle = String\(spec\.title\)\.trim\(\)/.test(seedBody), 'templateTitle 取自 spec.title（去掉首尾空白）');
const chipSpanAt = canvas.indexOf('${node.templateTitle ? `<span class="node-template-title">');
ok(chipSpanAt >= 0, 'render() 根节点模板里插入 .node-template-title 的 span');
const chipRender = chipSpanAt >= 0 ? canvas.slice(chipSpanAt, chipSpanAt + 160) : '';
ok(/escapeHtml\(node\.templateTitle\)/.test(chipRender), 'chip 文本走 escapeHtml（节点名不裸拼进 innerHTML）');
ok(canvas.indexOf("node.templateTitle ? 'has-template-title'") >= 0, 'rootClass 带 has-template-title 标记');
const chipCss = (css.match(/\.node-template-title \{[^}]*\}/) || [''])[0];
ok(chipCss.length > 0, 'CSS 里有 .node-template-title 规则');
ok(/position:absolute/.test(chipCss) && /right:0/.test(chipCss) && /top:-19px/.test(chipCss), 'chip 绝对定位在卡片右上（right:0 / top:-19px）');
ok(/background:var\(--soft\)/.test(chipCss), 'chip 底是实色 var(--soft)');
ok(/color:color-mix\(in srgb, var\(--text\) 72%, transparent\)/.test(chipCss), 'chip 文字用 72% 的 --text（提高对比度）');
ok(!/opacity:/.test(chipCss), 'chip 不用整体 opacity（否则 soft 底会被一起带透）');
ok(/\.image-node\.selected > \.node-template-title \{ color:var\(--text\); \}/.test(css), '选中时 chip 文字回到实色 --text');
ok(!/border(?!-radius)/.test(chipCss) && !/box-shadow/.test(chipCss) && !/inset/.test(chipCss), 'chip 不描边、不加投影（设计硬规则）');
ok(/\.image-node\.dragging > \.node-template-title \{ opacity:0; \}/.test(css), '拖动时 chip 淡出（和 .node-alias 一致）');

console.log('产品换图模板回归：' + pass + ' 项通过' + (fails.length ? '，' + fails.length + ' 项失败' : ''));
if (fails.length) { fails.forEach(f => console.error('  \u2717 ' + f)); process.exit(1); }
console.log('全部通过');
