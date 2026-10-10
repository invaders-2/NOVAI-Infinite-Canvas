/* GPT 对话页 · 记忆库开关作用域回归断言。
   钉死：系统提示词弹层的记忆开关 PATCH enabled 时必须带上该条自身的 scope / conversation_id，
   否则后端 MemoryRequest.scope 默认 "global" 会把「本对话」条目打回全局
   （实测：对话页建 conversation 条目 → 点开关 → 后端变 global、conversation_id 清空）。
   跑法：node tests/test_chat_memory_toggle_scope.js */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const lib = read('web/src/pages/chat/library.js');
const pop = read('web/src/pages/chat/SystemPromptPop.vue');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };
const count = (src, re) => (src.match(re) || []).length;

console.log('[1] 对话页记忆开关不再裸 PATCH enabled');
ok(/const enabled = item\.enabled === false;/.test(lib), 'toggleMemory 先算出目标 enabled');
ok(/const body = item\.scope === 'conversation'[\s\S]{0,140}\{ enabled, scope: 'conversation', conversation_id: item\.conversation_id \|\| '' \}[\s\S]{0,60}: \{ enabled \};/.test(lib), '「本对话」条目带上自身 scope / conversation_id');
ok(/PATCH', body, '更新失败'/.test(lib), 'PATCH 使用组装后的 body');
ok(!/PATCH', \{ enabled: item\.enabled === false \}/.test(lib), '不存在裸 PATCH { enabled } 的旧写法');
ok(count(lib, /PATCH', \{ enabled:[^}]*\}/g) === 0, '源码里没有「只带 enabled」的 PATCH 请求体');

console.log('[2] 其它记忆接口口径不变');
ok(/PATCH', \{ scope: next, conversation_id: conversationId \}/.test(lib), '切作用域仍 PATCH scope + conversation_id');
ok(/POST', \{ content, scope, conversation_id: conversationId \}/.test(lib), '新增仍 POST scope + conversation_id');

console.log('[3] 弹层开关接到 toggleMemory');
ok(/@click="toggleMemory\(m\)"/.test(pop), '每条记忆的开关调用 toggleMemory');

console.log('[4] 构建产物（Boss 服务器吃 static/v2）也带上修复');
const indexHtml = read('static/v2/index.html');
const jsSrc = (indexHtml.match(/src="(\/static\/v2\/assets\/[^"]+\.js)"/) || [])[1];
ok(!!jsSrc && fs.existsSync(path.join(root, jsSrc.replace(/^\//, ''))), 'static/v2/index.html 引用的构建 JS 存在');
if (jsSrc) {
    const js = read(jsSrc.replace(/^\//, ''));
    ok(count(js, /scope:"conversation",conversation_id:/g) >= 3, '构建 JS 里单条开关 / 批量启停 / 切作用域都带 scope');
    ok(count(js, /PATCH",\{enabled:/g) === 0, '构建 JS 里没有裸 PATCH { enabled }');
    ok(/scope:"conversation",conversation_id:[a-z]+\.conversation_id\|\|""/.test(js), '构建 JS 含「本对话」取自身 conversation_id 的形态');
}

console.log('[5] 旧页 gpt-chat.html 记忆开关同样带上自身 scope');
const old = read('static/gpt-chat.html');
ok(/async function toggleMemory\(id, enabled\)[\s\S]{0,260}item && item\.scope === 'conversation'[\s\S]{0,140}\{ enabled, scope: 'conversation', conversation_id: item\.conversation_id \|\| '' \}[\s\S]{0,80}: \{ enabled \};/.test(old), '旧页「本对话」条目带上自身 scope / conversation_id');
ok(/body: JSON\.stringify\(body\)/.test(old), '旧页 toggleMemory 使用组装后的 body');
ok(!/body: JSON\.stringify\(\{ enabled \}\)/.test(old), '旧页不存在裸 PATCH { enabled } 的旧写法');

console.log('');
if (fails.length) {
    console.error('失败 ' + fails.length + ' 项：');
    fails.forEach(f => console.error('  ✗ ' + f));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项）');
