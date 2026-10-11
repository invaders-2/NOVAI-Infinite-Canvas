/* 设置 · 记忆分组（新外壳）静态断言。
   钉死：SettingsModal 有「记忆」tab（brain 图标 / i18n common.memory）；MemoryPanel 用 /api/memories
   做列表（文本 + 启用开关 + 删除）、新增输入框 + 「添加」、作用域「全局 / 本对话」；
   批量操作是两个「全部启用 / 全部停用」按钮逐条 PATCH enabled —— 后端没有总开关字段，禁止假总开关；
   开关 PATCH 要带上各自的 scope / conversation_id（否则后端 scope 默认 global 会把「本对话」打回全局）；
   i18n 中英齐全；不碰 /api/agent/memory（那是画布项目记忆）。
   跑法：node tests/test_settings_memory_panel.js */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const modal = read('web/src/shell/SettingsModal.vue');
const panel = read('web/src/shell/settings/MemoryPanel.vue');
const api = read('web/src/shell/settings/memoryApi.js');
const common = read('static/js/i18n/common.js');
const en = JSON.parse(read('web/src/lib/i18n-en.json'));

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };
const count = (src, re) => (src.match(re) || []).length;

console.log('[1] 设置弹窗里的「记忆」分组');
ok(/import MemoryPanel from '\.\/settings\/MemoryPanel\.vue'/.test(modal), 'SettingsModal 引入 MemoryPanel');
ok(/\{ id: 'memory', icon: 'brain', i18n: 'common\.memory'/.test(modal), 'tab id=memory / brain 图标 / i18n common.memory');
ok(/<MemoryPanel v-else-if="tab\.id === 'memory'" \/>/.test(modal), '记忆 tab 渲染 MemoryPanel');
ok(!/title="记忆"/.test(panel), '记忆卡片不再自带「记忆」标题（页面级标题已由 tab 提供，避免顶部重复）');
ok(!panel.includes('与 GPT 对话页记忆库共用同一份数据'), '卡片不再重复介绍文案');

console.log('[2] 列表：文本 + 启用开关 + 删除');
ok(/onMounted\(loadMemories\)/.test(panel), '挂载时加载 /api/memories');
ok(/<NvSwitch[\s\S]{0,220}toggleMemory\(m\)/.test(panel), '每条记忆挂启用开关，切换走 toggleMemory');
ok(/<NvIcon name="trash" \/>/.test(panel), '每条记忆有删除按钮（trash）');
ok(/deleteMemory\(item\)/.test(panel), '删除调用 deleteMemory');
ok(/class="tx"[^>]*>\{\{ m\.content \}\}<\/span>/.test(panel), '列表渲染记忆正文');

console.log('[3] 新增：输入框 + 添加 + 作用域');
ok(/placeholder="例如：回答用中文、少用术语"/.test(panel), '新增输入框');
ok(/@keydown\.enter="submit"/.test(panel), '回车提交');
ok(/>添加<\/button>/.test(panel), '「添加」按钮');
ok(/value: 'global', label: '全局' \}, \{ value: 'conversation', label: '本对话'/.test(panel), '作用域选项 全局 / 本对话');
ok(/<NvPills[\s\S]{0,200}@update:model-value="setScope"/.test(panel), '作用域切换走 setScope');

console.log('[4] 批量操作：逐条 PATCH，禁止总开关');
ok(panel.includes('全部启用') && panel.includes('全部停用'), '顶部两个批量按钮文案');
ok(/@click="setAll\(true\)"/.test(panel) && /@click="setAll\(false\)"/.test(panel), '两个按钮分别 setAll(true) / setAll(false)');
ok(/export async function setAllEnabled\(enabled\)[\s\S]*for \(const item of snapshot\)/.test(api), 'setAllEnabled 遍历快照逐条处理');
ok(count(api, /PATCH', body, '更新失败'/g) === 2, '单条开关与批量启停都用带作用域的请求体 PATCH');
ok(!/masterOn|onMaster/.test(panel), '没有总开关状态 / 处理器');
ok(!/label="启用记忆"/.test(panel), '页面没有「启用记忆」总开关行');

console.log('[5] 接口与作用域口径');
ok(/call\('\/api\/memories', 'GET'/.test(api), 'GET /api/memories');
ok(/call\('\/api\/memories', 'POST'/.test(api), 'POST /api/memories');
ok(/const enabled = item\.enabled === false;/.test(api), '单条开关：取反目标 enabled');
ok(/const body = item\.scope === 'conversation'[\s\S]{0,140}\{ enabled, scope: 'conversation', conversation_id: item\.conversation_id \|\| '' \}/.test(api), '开关 PATCH 带上自身 scope / conversation_id（不被后端默认值打回全局）');
ok(/PATCH', \{ scope: next, conversation_id: conversationId \}/.test(api), '切作用域 PATCH scope + conversation_id');
ok(/DELETE', null/.test(api), 'DELETE /api/memories/{id} 删除');
ok(!/\/api\/agent\/memory/.test(panel + api), '不碰 /api/agent/memory（画布项目记忆）');
ok(/gpt_chat_last_conversation_v1/.test(api), '「本对话」沿用 GPT 对话页同一个当前会话 key');
ok(/if \(!conversationId\) \{ scope = 'global'; fellBack = true/.test(api), '没有当前对话时如实回落全局（不造假 scope）');

console.log('[6] i18n 中英');
ok(/"common\.memory": \{ zh: "记忆", en: "Memory" \}/.test(common), 'common.memory zh / en');
ok(/"common\.memoryDesc": \{ zh: "[^"]+", en: "[^"]+" \}/.test(common), 'common.memoryDesc zh / en');
ok(!Object.prototype.hasOwnProperty.call(en, '长期记忆由服务端自动注入到 GPT 对话与生成请求里，与 GPT 对话页记忆库共用同一份数据。'), 'i18n 词典清理不再使用的卡片介绍词条');
[['记忆', 'Memory'], ['记忆列表', 'Memory list'], ['全部启用', 'Enable all'], ['全部停用', 'Disable all'],
 ['新增记忆', 'Add memory'], ['记忆作用域', 'Memory scope'], ['本对话', 'This chat'], ['全局', 'Global'],
 ['添加', 'Add'], ['删除', 'Delete'], ['暂无记忆', 'No memories'], ['记忆加载中…', 'Loading memories…'],
 ['已启用全部记忆', 'All memories enabled'], ['已停用全部记忆', 'All memories disabled']].forEach(function(pair){
    ok(en[pair[0]] === pair[1], 'i18n-en.json ' + JSON.stringify(pair[0]) + ' => ' + JSON.stringify(pair[1]));
});

console.log('[7] 构建产物（Boss 服务器吃 static/v2）也带上记忆分组');
const indexHtml = read('static/v2/index.html');
const jsSrc = (indexHtml.match(/src="(\/static\/v2\/assets\/[^"]+\.js)"/) || [])[1];
const cssHref = (indexHtml.match(/href="(\/static\/v2\/assets\/[^"]+\.css)"/) || [])[1];
ok(!!jsSrc && fs.existsSync(path.join(root, jsSrc.replace(/^\//, ''))), 'static/v2/index.html 引用的构建 JS 存在');
if (jsSrc) {
    const js = read(jsSrc.replace(/^\//, ''));
    ok(js.includes('全部启用') && js.includes('全部停用'), '构建 JS 含「全部启用 / 全部停用」');
    ok(js.includes('记忆作用域') && js.includes('Memory scope'), '构建 JS 含记忆作用域文案（中英）');
    ok(js.includes('gpt_chat_last_conversation_v1'), '构建 JS 含记忆作用域用的当前会话 key');
}
if (cssHref) {
    const css = read(cssHref.replace(/^\//, ''));
    ok(/\.bulk\[[^\]]+\]\{/.test(css), '构建 CSS 含记忆批量按钮样式 .bulk');
}

console.log('');
if(fails.length){
    console.error('失败 ' + fails.length + ' 项：');
    fails.forEach(f => console.error('  ✗ ' + f));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项）');
