/* 「提示词节点：长文模式 + Markdown 渲染」的回归测试（零依赖，跟 tests/run-all.js 同一套风格）。

   覆盖：
   [1] 安全：先转义再转换 —— <script> / onerror / javascript: 只能变成文字；
   [2] 块级：标题 / 分割线 / 无序·有序列表（含一层缩进）/ 引用 / 围栏代码块 / GFM 表格；
   [3] 行内：粗体 / 斜体 / 行内 code / 删除线；
   [4] 边界：空输入、null、纯空白、未闭合围栏都不抛错；
   [5] 性能：3000+ 字一次渲染 < 200ms；
   [6] 接入：页面引入顺序、分段控件、长文 System / max_tokens、预览渲染、复制原始 Markdown、i18n、样式（不画线）。

   跑法：node tests/test_markdown_lite.js */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const md = require(path.join(root, 'static/js/smart-markdown.js'));
const js = read('static/js/smart-canvas.js');
const html = read('static/smart-canvas.html');
const css = read('static/css/smart-canvas.css');
const i18n = read('static/js/i18n/smart-canvas.js');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };
const render = text => md.render(text);

function topLevelFunction(src, name){
    const lines = src.split('\n');
    const start = lines.findIndex(line => line.startsWith('function ' + name + '('));
    if(start < 0) return '';
    for(let i = start + 1; i < lines.length; i += 1){
        if(lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}
/* 源码里的一段（用于断言「只在这一块里」的样式约束） */
function sectionFrom(src, marker){
    const at = src.indexOf(marker);
    return at < 0 ? '' : src.slice(at);
}

console.log('[1] 安全：必须先转义再转换，任何输入都产不出可执行标签');
{
    const out = render('<script>alert(1)</script>');
    ok(out.indexOf('<script') < 0, '<script> 没有被原样输出');
    ok(out.indexOf('&lt;script&gt;alert(1)&lt;/script&gt;') >= 0, '<script> 被转义成文本（&lt;script&gt;）');

    const attr = render('"><img src=x onerror=alert(1)>');
    ok(attr.indexOf('<img') < 0 && attr.indexOf('&lt;img') >= 0, '属性突破形式（"><img onerror>）只留下文字，不产生元素');
    ok(attr.indexOf('&quot;&gt;&lt;img') >= 0, '引号与尖括号都被转义');

    const closing = render('正文</p><script>alert(1)</script>');
    ok(closing.indexOf('</p><script>') < 0 && (closing.match(/<script/g) || []).length === 0, '闭合标签注入不成立');

    const link = render('[点我](javascript:alert(1))');
    ok(link.indexOf('<a') < 0, '不渲染链接（[x](javascript:...) 保持文本，没有 <a href>）');
    ok(link.indexOf('javascript:alert(1)') >= 0, '链接语法原样当文字显示');

    const code = render('\u0060\u0060\u0060html\n<script>alert(1)</script>\n\u0060\u0060\u0060');
    ok(code.indexOf('<script') < 0 && code.indexOf('&lt;script&gt;') >= 0, '代码块里的标签同样只当文字');
    ok(code.indexOf('<pre class="md-pre">') >= 0, '代码块本身是受控的 <pre>');

    const inline = render('看 \u0060<b>not bold</b>\u0060 就好');
    ok(inline.indexOf('<b>') < 0 && inline.indexOf('&lt;b&gt;') >= 0, '行内 code 里的标签只当文字');

    const table = render('| a | b |\n| --- | --- |\n| <img src=x onerror=alert(1)> | 2 |');
    ok(table.indexOf('<img') < 0 && table.indexOf('&lt;img') >= 0, '表格单元格同样转义');

    const amp = render('A & B < C');
    ok(amp.indexOf('A &amp; B &lt; C') >= 0, '裸露的 & 与 < 也按实体输出');
}

console.log('[2] 块级语法：标题 / 分割线 / 列表 / 引用 / 代码块 / 表格');
{
    const h = render('# 一级\n## 二级\n### 三级\n#### 四级\n##### 五级\n###### 六级');
    ok(/<h1>一级<\/h1><h2>二级<\/h2><h3>三级<\/h3>/.test(h), 'ATX 标题 #~###### 都产出对应标签');
    ok(h.indexOf('<h6>六级</h6>') >= 0, '六级标题也在');
    ok(render('## 带 *斜体* 的标题').indexOf('<h2>带 <em>斜体</em> 的标题</h2>') >= 0, '标题里的行内语法照样生效');
    ok(render('#标签不是标题').indexOf('<h1>') < 0, '# 后面没有空格不当标题（避免误伤 #话题）');

    const hr = render('上\n\n---\n\n下');
    ok(hr.indexOf('<hr class="md-hr">') >= 0, '--- 产出分割线');
    ok(hr.indexOf('<p class="md-p">上</p>') >= 0 && hr.indexOf('<p class="md-p">下</p>') >= 0, '分割线两侧各自成段');

    const ul = render('- 项一\n- 项二\n  - 子项 A\n  - 子项 B\n- 项三');
    ok(ul.indexOf('<ul class="md-list"><li>项一</li><li>项二<ul class="md-list"><li>子项 A</li><li>子项 B</li></ul></li><li>项三</li></ul>') >= 0,
        '无序列表 + 一层缩进（子列表嵌在上一项里）');
    const ol = render('1. 第一步\n2. 第二步\n3. 第三步');
    ok(ol.indexOf('<ol class="md-list"><li>第一步</li><li>第二步</li><li>第三步</li></ol>') >= 0, '有序列表 1. 2. 3.');
    ok(render('- 项\n\n  - 隔一个空行还是子项').indexOf('<ul class="md-list"><li>项<ul class="md-list">') >= 0, '空行不打断同一个列表');
    ok(render('- 项一\n续行内容\n- 项二').indexOf('<li>项一<br>续行内容</li>') >= 0, '同一条目的续行并进这一项');

    const quote = render('> 第一行\n> 第二行');
    ok(quote.indexOf('<blockquote class="md-quote"><p class="md-p">第一行<br>第二行</p></blockquote>') >= 0, '> 引用成块，内部照样分段');

    const code = render('\u0060\u0060\u0060js\nconst a = 1 < 2;\nif (a) { b(); }\n\u0060\u0060\u0060');
    ok(code.indexOf('<code class="md-code md-lang-js">') >= 0, '围栏代码块带语言标记');
    ok(code.indexOf('const a = 1 &lt; 2;') >= 0, '代码块内容转义但不做 Markdown 转换');
    ok(code.indexOf('<br>') < 0, '代码块里不插 <br>（换行靠 white-space:pre）');
    ok(render('\u0060\u0060\u0060\nplain\n\u0060\u0060\u0060').indexOf('<code class="md-code">') >= 0, '不带语言标记的代码块');

    const table = render('| 字段 | 说明 |\n| --- | :---: |\n| 主体 | 一只鞋 |\n| 光线 | 侧逆光 |');
    ok(table.indexOf('<table class="md-table">') >= 0 && table.indexOf('<thead>') >= 0, 'GFM 表格产出 table/thead');
    ok(table.indexOf('<th>字段</th>') >= 0 && table.indexOf('<th class="md-align-center">说明</th>') >= 0, '表头 + 居中列对齐');
    ok(table.indexOf('<td>主体</td>') >= 0 && table.indexOf('<td class="md-align-center">一只鞋</td>') >= 0, '表体单元格 + 对齐沿用');
    ok(table.indexOf('<tbody>') >= 0 && (table.match(/<tr>/g) || []).length === 3, '两行表体 + 一行表头');
    ok(render('| a | b |\n| --- | --- |').indexOf('<tbody>') < 0, '没有表体时不渲染空的 tbody');
}

console.log('[3] 行内语法：粗体 / 斜体 / 行内 code / 删除线');
{
    ok(render('这是**粗体**').indexOf('<strong>粗体</strong>') >= 0, '**粗体**');
    ok(render('这是__粗体__').indexOf('<strong>粗体</strong>') >= 0, '__粗体__ 也认');
    ok(render('这是*斜体*').indexOf('<em>斜体</em>') >= 0, '*斜体*');
    ok(render('这是_斜体_').indexOf('<em>斜体</em>') >= 0, '_斜体_');
    ok(render('看 \u0060code\u0060 这段').indexOf('<code class="md-code-inline">code</code>') >= 0, '行内 code');
    ok(render('~~删掉~~').indexOf('<del>删掉</del>') >= 0, '~~删除线~~');
    ok(render('snake_case 不能被吃掉').indexOf('snake_case') >= 0, '词里的下划线不触发斜体（snake_case 原样）');
    ok(render('**粗体里有 \u0060code\u0060**').indexOf('<strong>粗体里有 <code class="md-code-inline">code</code></strong>') >= 0, '代码里的内容不会被粗体规则二次改写');
    ok(render('3 * 4 = 12').indexOf('<em>') < 0, '单独一个星号（3 * 4）不会被当成斜体');
}

console.log('[4] 边界：空输入 / 非字符串 / 未闭合围栏都不抛错');
{
    let threw = false;
    ['', '   \n\n  ', null, undefined].forEach(value => {
        try {
            if(render(value) !== '') threw = true;   // 空内容必须是空串（调用方才好判断要不要走占位）
        } catch(error) { threw = true; }
    });
    ok(!threw, '空串 / 纯空白 / null / undefined 都返回空串且不抛错');
    let survived = true;
    [0, '0', false, NaN].forEach(value => {
        try { render(value); } catch(error) { survived = false; }
    });
    ok(survived, '数字 / false / NaN 这类非字符串输入也不抛错');
    ok(render('\u0060\u0060\u0060js\nlet a = 1;') === '<pre class="md-pre"><code class="md-code md-lang-js">let a = 1;</code></pre>',
        '未闭合的围栏：读到文末自动收口，不抛错');
    ok(render('---') === '<hr class="md-hr">', '只有三个减号时是分割线（不进段落）');
    ok(render('0') === '<p class="md-p">0</p>', '数字 0 也按文本输出');
    ok(render('a\r\nb').indexOf('<br>') >= 0, 'CRLF 也被当成换行');
}

console.log('[5] 性能：3000+ 字长文一次渲染 < 200ms');
{
    let big = '';
    for(let i = 0; i < 24; i += 1){
        big += '## 第 ' + (i + 1) + ' 节：结构与字段\n\n';
        big += '这一节描述主体、材质、构图与光线，**重点**是保持比例，*次要*是背景；风格统一。\n\n';
        big += '- 字段一：取值 ' + i + '\n- 字段二：取值 ' + i + '\n  - 子项说明\n';
        big += '\n| 字段 | 说明 |\n| --- | --- |\n| 主体 | 一只鞋 |\n| 光线 | 侧逆光 |\n\n';
        big += '\u0060\u0060\u0060json\n{ "section": ' + i + ' }\n\u0060\u0060\u0060\n\n';
    }
    ok(big.length >= 3000, '用例文本 ' + big.length + ' 字（>= 3000）');
    const startedAt = process.hrtime.bigint();
    const out = render(big);
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    ok(out.indexOf('<h2>第 1 节：结构与字段</h2>') >= 0, '长文里第一个标题渲染出来了');
    ok((out.match(/<h2>/g) || []).length === 24, '24 个小标题一个不少');
    ok((out.match(/<table class="md-table">/g) || []).length === 24, '24 张表格一个不少');
    ok(ms < 200, '渲染耗时 ' + ms.toFixed(1) + 'ms < 200ms');
}

console.log('[6] 接入：页面引入顺序 / 分段控件 / 长文 System 与 max_tokens / 预览渲染 / 复制原文');
{
    /* 页面：渲染器必须排在 smart-canvas.js 之前（两者都是 defer，顺序即执行顺序） */
    const mdAt = html.indexOf('/static/js/smart-markdown.js');
    const canvasAt = html.indexOf('/static/js/smart-canvas.js');
    ok(mdAt >= 0, 'smart-canvas.html 引入了 smart-markdown.js');
    ok(mdAt > 0 && canvasAt > mdAt, 'smart-markdown.js 排在 smart-canvas.js 之前');
    ok(/\.SmartMarkdown = api/.test(read('static/js/smart-markdown.js')), '暴露 window.SmartMarkdown');
    ok(/module\.exports = api/.test(read('static/js/smart-markdown.js')), '同时支持 module.exports（node 测试可用）');
    ok(!/require\(/.test(read('static/js/smart-markdown.js')) && !/<script src="http/.test(read('static/js/smart-markdown.js')), '不引任何外部库 / 不依赖构建');

    /* 输出类型：全自动（前端不再有控件，判据见 tests/test_llm_output_kind.js） */
    const resolveFn = topLevelFunction(js, 'smartLlmResolvedOutputKind');
    ok(/return smartLlmAutoOutputKind\(smartLlmOutputKindSourceText\(node, ctx\)\)/.test(resolveFn), '生效的输出类型 = 自动判定结果（不再读手动覆盖）');
    ok(!/llmOutputKindUserSet/.test(resolveFn) && !/smartLlmOutputKindMode/.test(js), '手动覆盖链（mode / UserSet）已删除');
    const bodyFn = topLevelFunction(js, 'promptNodeBodyHtml');
    const nodeBottom = bodyFn.slice(bodyFn.lastIndexOf('prompt-node-bottom-row'));
    ok(nodeBottom.indexOf('llmOutputModeHtml(node)') >= 0
        && nodeBottom.indexOf('llmOutputKindHtml(node)') < 0
        && nodeBottom.indexOf('prompt-node-run') > 0,
        '节点模式底部行：只剩输出形式 + 运行键（输出类型控件已下线）');
    ok(!/data-llm-output-kind/.test(js), 'DOM 里不会再出现 [data-llm-output-kind]');
    ok(/const outputKind = smartLlmResolvedOutputKind\(node\);/.test(bodyFn), '渲染时仍按自动判定结果决定要不要渲染 Markdown');

    /* 长文 System：默认 prompt 那条一个字都不动 */
    const defFn = topLevelFunction(js, 'smartLlmDefaultSystemPrompt');
    ok(/100到160个汉字/.test(defFn) || /smart\.promptLlmDefaultSystem/.test(defFn), '生图提示词默认 System 仍在原处');
    ok(/options\.promptOnlySystem \? smartLlmDefaultSystemPrompt\(\) : ''/.test(js), 'prompt 模式仍走原来的默认 System（行为不变）');
    const docSysFn = topLevelFunction(js, 'smartLlmDocSystemPrompt');
    ok(Boolean(docSysFn) && /smart\.llmDocSystem/.test(docSysFn), '长文默认 System 走 i18n（smart.llmDocSystem）');
    ok(/const docMode = !options\.chat && Boolean\(options\.promptOnlySystem\) && options\.outputKind === 'doc';/.test(js),
        '长文只对提示词节点的节点模式生效（不碰聊天 / 出表 / 优化提示词）');
    ok(/const outputKind = smartLlmResolvedOutputKind\(node\);/.test(js), '运行前按自动判定/手动覆盖算出 outputKind 再发请求');
    ok(/if\(docMode\) body\.system_prompt = String\(node\.llmSystemPrompt \|\| ''\)\.trim\(\) \|\| smartLlmDocSystemPrompt\(\);/.test(js),
        'doc 模式：用户自己填的 System 优先，空的时候才用长文默认 System');
    ok(js.indexOf("if(docMode) body.system_prompt") > js.indexOf("system_prompt: options.chat")
        && js.indexOf("if(docMode) body.system_prompt") < js.indexOf('if(options.systemPrompt) body.system_prompt'),
        '长文 System 是请求体外面的覆写（原来那条三元一字不动），且显式 systemPrompt 仍然最优先');
    ok(/const SMART_LLM_DOC_MAX_TOKENS = 8000;/.test(js), '长文 max_tokens 常量 = 8000');
    ok(/if\(docMode\) body\.max_tokens = SMART_LLM_DOC_MAX_TOKENS;/.test(js), 'doc 模式下发 max_tokens');
    ok(js.indexOf('if(docMode) body.max_tokens = SMART_LLM_DOC_MAX_TOKENS;') < js.indexOf('if(options.maxTokens) body.max_tokens'),
        '调用方显式传的 maxTokens 仍然优先（排在其后覆盖）');
    const callAt = js.indexOf('async function callSmartCanvasLLM(');
    const callBody = callAt < 0 ? '' : js.slice(callAt, js.indexOf('async function callSmartLLMText('));
    const streamAt = js.indexOf('async function streamCanvasLLMResponse(');
    const streamFn = streamAt < 0 ? '' : js.slice(streamAt, streamAt + 3000);
    ok(callBody.indexOf('JSON.stringify(body)') >= 0 && streamFn.indexOf('JSON.stringify(body)') >= 0,
        '流式与非流式共用同一份 body（body 只在 callSmartCanvasLLM 里构建一次）');
    ok((callBody.match(/system_prompt:/g) || []).length === 1, 'system_prompt 在这份请求体里只赋值一次（没有第二套拼装）');

    /* 预览：只有长文模式才走 Markdown，其它模式仍是 escapeHtml + pre-wrap */
    const previewFn = topLevelFunction(js, 'promptNodePreviewHtml');
    ok(previewFn.indexOf("outputKind === 'doc'") >= 0 && previewFn.indexOf("node.llmTab !== 'chat'") >= 0, '预览按输出类型决定要不要渲染 Markdown（聊天页签不渲染）');
    ok(/\$\{markdown \? smartMarkdownHtml\(text\) : escapeHtml\(text \|\| placeholder\)\}/.test(previewFn), '非长文仍走 escapeHtml（老节点零变化）');
    ok(/is-markdown/.test(previewFn), '长文预览块带 is-markdown 标记（样式只认这一层）');
    const mdHtmlFn = topLevelFunction(js, 'smartMarkdownHtml');
    ok(Boolean(mdHtmlFn) && /window\.SmartMarkdown/.test(mdHtmlFn) && /return escapeHtml\(text\)/.test(mdHtmlFn), '拿不到渲染器 / 渲染抛错时退回纯文本');
    const paintFn = topLevelFunction(js, 'paintPromptStreamSnapshot');
    ok(/classList\.remove\('is-markdown'\)/.test(paintFn), '流式过程按纯文本刷（不每个 token 重排 Markdown）');

    /* 复制：复制的是原始 Markdown */
    /* 注意要定位到「复制按钮的绑定」那一段：同一个属性名在双击编辑器里也有一处守卫判断 */
    const copyAt = js.indexOf("el.querySelectorAll('[data-prompt-copy-markdown]')");
    const copyBlock = copyAt < 0 ? '' : js.slice(copyAt, copyAt + 700);
    ok(copyAt >= 0 && copyBlock.indexOf('copyTextToClipboard(raw)') >= 0
        && copyBlock.indexOf('String(node.outputText || node.llmInstruction || node.text || \'\')') >= 0,
        '复制按钮复制原文（与预览同一取值顺序：outputText → llmInstruction → text，全是原始 Markdown）');
    ok(copyBlock.indexOf('innerHTML') < 0 && copyBlock.indexOf('textContent') < 0, '复制路径不碰渲染后的 HTML');

    /* i18n：三条必需文案中英各一份 */
    ['smart.llmDocSystem', 'smart.promptOutputDiscard'].forEach(key => {
        ok(new RegExp('"' + key.replace(/\./g, '\\.') + '": \\{').test(i18n), 'i18n 已登记 ' + key);
    });
    ok(!/smart\.llmOutputKind/.test(i18n), '输出类型控件的 i18n key 已清理');
    const docSys = (i18n.match(/"smart\.llmDocSystem": \{\s*\n\s*zh: "([^"]+)"/) || [])[1] || '';
    ok(docSys.length > 40, 'smart.llmDocSystem 的 zh 文案存在（' + docSys.length + ' 字）');
    ok(/完整输出/.test(docSys) && /Markdown/.test(docSys), '长文 System 明确要求「完整输出」+「用 Markdown」');
    ok(/省略/.test(docSys), '长文 System 明确说不要省略');
    ok(/en: "You write structured long-form documents/.test(i18n), 'smart.llmDocSystem 也有英文版');

    /* 样式：层级只用间距 / 字重 / 半透明底，不画线框与发丝线 */
    const styleSection = sectionFrom(css, '提示词节点「长文（Markdown）预览」');
    ok(styleSection.length > 500, '样式已追加到 smart-canvas.css');
    ok(!/border\s*:\s*[^;]*(solid|dashed|1px)/.test(styleSection), '长文/分段控件样式里没有 border 线框');
    ok(!/border-(top|right|bottom|left)\s*:/.test(styleSection), '没有 border-top/left 这类发丝线');
    ok(!/box-shadow\s*:\s*inset/.test(styleSection), '没有 inset 1px 描边');
    ok(styleSection.indexOf('.prompt-node-display-text.is-markdown h1') >= 0, '标题层级样式在');
    ok(styleSection.indexOf('.md-table') >= 0 && styleSection.indexOf('.md-pre') >= 0, '表格与代码块样式在');
    ok(styleSection.indexOf('.prompt-node-display-copy') >= 0, '复制按钮样式在');
    ok(styleSection.indexOf('.smart-text-modal-input.is-raw') >= 0, '生成结果编辑框的纯文本排版样式在');
}

console.log('');
console.log('markdown-lite：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
fails.forEach(f => console.log('  ✗ ' + f));
if(fails.length) process.exit(1);
