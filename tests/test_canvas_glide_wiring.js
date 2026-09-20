/* 经典画布（static/canvas.html + static/js/canvas.js）接入 NovaGlide 滑块高亮的静态断言。

   钉死四件事：
   1. 6 个弹层容器（斜杠菜单 / 子菜单 / 创建菜单 / 连线创建菜单 / 端口菜单 ×2 / 图片节点菜单）
      都有真的 attach 调用点；
   2. 每次 innerHTML 重写之后都要重新 attach —— 顺序错了滑块就量到旧 DOM；
   3. 同一个容器不会叠出第二个滑块（靠 glide.js 的 destroy + 这里的单一入口）；
   4. 菜单是 display:none → block 切换的，attach 后必须强制布局再 refresh，
      否则第一次量到的 rect 全是 0。

   跑法：node tests/test_canvas_glide_wiring.js */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const js = read('static/js/canvas.js');
const html = read('static/canvas.html');
const glide = read('static/js/shared/glide.js');
const glideCss = read('static/css/glide.css');
const canvasCss = read('static/css/canvas.css');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };
const count = (src, re) => (src.match(re) || []).length;

/* 取一个顶层函数的函数体：非贪婪到行首的 }，内部块都缩进，所以不会提前截断 */
const fnBody = (src, name) => {
    const re = new RegExp('function ' + name + '\\([^)]*\\)\\{([\\s\\S]*?)\\n\\}');
    const m = src.match(re);
    return m ? m[1] : '';
};

/* ── 1. 6 个容器：DOM 存在 + 选择器 + attach 调用点 ── */
console.log('[1] 6 个容器的 attach 调用点');
const TARGETS = [
    { id: 'slashMenu',      varName: 'slashMenu',      selector: '.slash-item', owner: 'openSlashMenu',          rewrites: true  },
    { id: 'slashSub',       varName: 'slashSub',       selector: '.slash-item', owner: 'openSlashMenu',          rewrites: true  },
    { id: 'createMenu',     varName: 'createMenu',     selector: '.menu-btn',   owner: 'openCreateMenu',         rewrites: false },
    { id: 'linkCreateMenu', varName: 'linkCreateMenu', selector: '.menu-btn',   owner: 'openLinkCreateMenu',     rewrites: true  },
    { id: 'nodeInputMenu',  varName: 'nodeInputMenu',  selector: '.menu-btn',   owner: 'openGeneratorNodeMenu',  rewrites: true  },
    { id: 'nodeOutputMenu', varName: 'nodeOutputMenu', selector: '.menu-btn',   owner: 'openGeneratorNodeMenu',  rewrites: true  },
    { id: 'imageNodeMenu',  varName: 'imageNodeMenu',  selector: '.menu-btn',   owner: 'openImageNodeMenu',      rewrites: true  },
];
TARGETS.forEach(t => {
    ok(html.includes('id="' + t.id + '"'), 'canvas.html 有容器 #' + t.id);
    const call = new RegExp('glideSync\\(' + t.varName + ", '" + t.selector.replace('.', '\\.') + "'\\)");
    ok(call.test(js), 'canvas.js 里有 glideSync(' + t.varName + ", '" + t.selector + "')");
});
/* 6 个目标容器 = 7 个容器变量（端口菜单一对） */
const glideCalls = js.match(/glideSync\(/g) || [];
ok(glideCalls.length === 8, 'glideSync 共 8 处调用（7 个容器 + 1 处定义之外的都没有），实际 ' + glideCalls.length);

/* ── 2. 顺序：内容写完（innerHTML / 打开）之后才 attach ── */
console.log('[2] attach 跟在每次内容写入之后');
TARGETS.filter(t => t.rewrites).forEach(t => {
    const body = fnBody(js, t.owner);
    ok(body.length > 0, '找得到 ' + t.owner + ' 的函数体');
    const writeAt = body.indexOf(t.varName + '.innerHTML');
    const callAt = body.indexOf('glideSync(' + t.varName + ',');
    const openAt = body.indexOf(t.varName + ".classList.add('open')");
    ok(writeAt >= 0, t.owner + ' 里有 ' + t.varName + '.innerHTML = …');
    ok(callAt > writeAt, t.varName + ' 的 attach 排在 innerHTML 之后（先有 DOM 才量几何）');
    ok(openAt < 0 || callAt > openAt, t.varName + ' 的 attach 排在 .open 之后（display:block 才有 rect）');
});
/* #createMenu 是静态标记：要在打开流程里重新量一次 */
{
    const body = fnBody(js, 'openCreateMenu');
    ok(body.includes("createMenu.classList.add('open')"), 'openCreateMenu 里加了 .open');
    ok(body.indexOf('glideSync(createMenu,') > body.indexOf("createMenu.classList.add('open')"),
        '#createMenu 的 attach 排在 .open 之后');
}
/* #imageNodeMenu 被图片菜单和输出节点菜单共用：两处渲染都要过 attach */
{
    const imgBody = fnBody(js, 'openImageNodeMenu');
    ok(imgBody.includes("imageNodeMenu.innerHTML"), 'openImageNodeMenu 重写 innerHTML');
    ok(imgBody.indexOf('glideSync(imageNodeMenu,') > imgBody.indexOf('imageNodeMenu.innerHTML'),
        '#imageNodeMenu 的 attach 排在 innerHTML 之后');
    const outBody = fnBody(js, 'openOutputNodeMenu');
    ok(outBody.includes('imageNodeMenu.innerHTML'), 'openOutputNodeMenu 也重写同一个容器');
    ok(outBody.includes('closeImageNodeMenu()'), '输出节点菜单走的是共用容器的关闭逻辑');
}
/* 子菜单：悬停分类项（每次重写）+ 主菜单唤起，两条路径都要 attach */
{
    const subRewrites = count(js.slice(js.indexOf('function openSlashMenu'), js.indexOf('function selectSlashItem')), /slashSub\.innerHTML/g);
    ok(subRewrites >= 1, 'openSlashMenu 里有一次 slashSub.innerHTML 重写（悬停分类项）');
    const slashBody = fnBody(js, 'openSlashMenu');
    ok(slashBody.indexOf('glideSync(slashSub,') > slashBody.indexOf('slashSub.innerHTML'),
        '#slashSub 的 attach 排在 innerHTML 之后');
    ok(slashBody.indexOf('glideSync(slashMenu,') > slashBody.indexOf('slashMenu.innerHTML'),
        '#slashMenu 的 attach 排在 innerHTML 之后');
}

/* ── 3. 不重复 attach ── */
console.log('[3] 同一容器不会叠出第二个滑块');
ok(count(js, /NovaGlide\.attach\(/g) === 1, 'NovaGlide.attach 只有一处调用（都走 glideSync 单一入口）');
const helper = fnBody(js, 'glideSync');
ok(helper.length > 0, '有 glideSync 帮助函数');
ok(/if\(!container \|\| !item\) return null;/.test(helper), 'glideSync 先挡空容器 / 空选择器');
ok(helper.includes("typeof window.NovaGlide.attach !== 'function'"), 'glideSync 用「存在才调」守卫（没引 glide.js 的页面不抛）');
ok(/void container\.offsetHeight;/.test(helper), 'glideSync 强制一次布局（菜单 display:none → block，rect 才不是 0）');
ok(helper.indexOf('glide.refresh()') > helper.indexOf('void container.offsetHeight'), 'glideSync 在强制布局之后 refresh');
ok(!/setActive\(/.test(helper), 'glideSync 不用 setActive 钉死项（pin 会压过类，键盘/类变化路径就死了）');
/* 重复 attach 的安全性来自 glide.js 自己：它认 __nvGlide 并先 destroy */
ok(/if\(container\.__nvGlide && typeof container\.__nvGlide\.destroy === 'function'\) container\.__nvGlide\.destroy\(\)/.test(glide),
    'glide.js 的 attach 会先 destroy 旧实例（重复 attach 不叠滑块的根本保证）');
ok(/delete container\.__nvGlide;/.test(glide), 'destroy 里清掉 __nvGlide');
/* 菜单关闭时会清空 innerHTML：滑块要跟着 observer 自动隐藏，不留残影 */
['closeSlashMenu', 'closeLinkCreateMenu', 'closeImageNodeMenu'].forEach(name => {
    const body = fnBody(js, name);
    ok(body.includes(".innerHTML = ''") || body.includes("innerHTML=''") || body.includes('innerHTML = \'\''),
        name + ' 会清空内容（滑块由 observer 自动隐藏）');
});

/* ── 4. 样式与依赖：走 glide.css，不碰 canvas.css ── */
console.log('[4] 依赖与样式边界');
ok(glideCss.includes('.nv-glide-host [data-nv-glide-item]'), 'glide.css 负责选项底色压制');
{
    const links = html.match(/<link[^>]+rel="stylesheet"[^>]*>/g) || [];
    const at = links.findIndex(tag => /\/static\/css\/glide\.css\?v=[0-9.]+/.test(tag));
    ok(at >= 0, 'canvas.html 引入 glide.css');
    ok(at === links.length - 1, 'glide.css 排在其它样式表之后（同权重时靠顺序取胜）');
    ok(/shared\/glide\.js\?v=[0-9.]+/.test(html), 'canvas.html 引入 shared/glide.js');
    ok(html.indexOf('shared/glide.js') > html.indexOf('shared/utils.js'), 'glide.js 排在 shared/utils.js 之后');
}
/* 红线：本次接线不许改 canvas.css（那边有别人在加 .nd-menu 的滑块样式）。
   做法：去掉注释、按规则块切开，剩下的 nv-glide 只允许出现在 .nd-menu（自绘下拉弹层）的规则里；
   经典画布这 6 个弹层的容器 / 选项选择器一律不许出现在 canvas.css 的滑块规则中。 */
{
    const stripped = canvasCss.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const blocks = [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), decls: m[2] }));
    const withVars = blocks.filter(b => /nv-glide/.test(b.decls));
    ok(withVars.length >= 1, 'canvas.css 里那几条 .nd-menu 的滑块变量仍在（不是被本次改动删了）');
    const foreign = withVars.filter(b => !/\.nd-menu/.test(b.sel));
    ok(foreign.length === 0, 'canvas.css 里没有本次新增的经典画布滑块规则（只允许 .nd-menu 那几条）：' +
        foreign.map(b => b.sel).join(' | '));
}

/* ── 5. 无「深底 + 反色文字」风险（全文核对，不是只查几个文件） ── */
console.log('[5] 选中态文字可读性：经典画布这 6 个弹层没有深底反白');
{
    /* .menu-btn / .slash-item 的 hover / active 规则：底色变了但文字色必须还是正文色 */
    const rules = [];
    [['static/css/canvas.css', canvasCss], ['static/css/theme.css', read('static/css/theme.css')],
     ['static/css/marvis-shared.css', read('static/css/marvis-shared.css')]].forEach(([name, src]) => {
        const clean = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
        [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].forEach(m => {
            const sel = m[1].trim();
            if(!/(^|[,\s])(\.menu-btn|\.slash-item)(:hover|\.active|\.is-active|\.hovered)?(\s|,|$|:)/.test(sel)) return;
            rules.push({file: name, sel: sel.replace(/\s+/g, ' '), decls: m[2]});
        });
    });
    ok(rules.length >= 3, '扫到 .menu-btn / .slash-item 的样式规则 ' + rules.length + ' 条');
    const inverted = rules.filter(r => /(^|[;{\s])color\s*:/.test(r.decls))
        .filter(r => /background(-color)?\s*:\s*var\(--(strong|accent|nav-|text)/.test(r.decls));
    ok(inverted.length === 0, '没有「深底 + 反色文字」的 hover/选中规则（' +
        inverted.map(r => r.file + ' ' + r.sel).join(' | ') + '）');
    /* 深色主题下文字色也必须还在正文色系 */
    const darkBtn = rules.filter(r => /theme-dark/.test(r.sel) && /\.menu-btn:hover/.test(r.sel));
    ok(darkBtn.every(r => /color\s*:\s*var\(--text\)/.test(r.decls)), '深色下 .menu-btn:hover 的文字回到 var(--text)');
}

/* ── 6. 滑块底色：深色下必须走 --nav-hover-bg（不能用默认 --soft） ── */
console.log('[6] 深色下滑块的可见性覆写（写在 canvas.html 的 <style> 块里）');
{
    const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]);
    const pageCss = styleBlocks.join('\n');
    ok(/\.create-menu\.nv-glide-host[\s\S]{0,160}\.slash-menu\.nv-glide-host[\s\S]{0,160}\.slash-sub\.nv-glide-host/.test(pageCss),
        'canvas.html 的 <style> 里有 .create-menu / .slash-menu / .slash-sub + .nv-glide-host 这组选择器');
    ok(/--nv-glide-bg:\s*var\(--nav-hover-bg\)/.test(pageCss),
        '这组选择器把 --nv-glide-bg 覆写成 var(--nav-hover-bg)');
    /* 为什么不能用默认 --soft：theme.css 在深色下把 .shell 作用域里的 --soft 重定义成 var(--bg)
       （#0a0a0a），比菜单面板还深 —— 滑块方向反了，等于看不出高亮。注释要留住这个坑。 */
    ok(/--soft[\s\S]{0,240}var\(--bg\)/.test(pageCss), '注释写明了「深色下 --soft = var(--bg)」这个坑');
    const ruleAt = pageCss.indexOf('.create-menu.nv-glide-host');
    ok(ruleAt >= 0 && pageCss.slice(Math.max(0, ruleAt - 900), ruleAt).indexOf('/*') >= 0,
        '规则前面有注释说明（不是一条裸规则）');
    ok(!/\.create-menu\.nv-glide-host/.test(canvasCss), '这条覆写只在 canvas.html，没写进 canvas.css');
    ok(!/#createMenu\.nv-glide-host|#imageNodeMenu\.nv-glide-host/.test(pageCss),
        '用类选择器而不是 id（#imageNodeMenu 这类容器是复用的）');
    ok(!/(^|\n)\s*\.create-menu\s*\{[^}]*--nv-glide-bg/m.test(pageCss),
        '选择器带 .nv-glide-host 限定：没接线时这条规则不参与，观感不变');
    /* 默认值仍在 glide.css 里（这条覆写只是覆写，不是把模块默认删了） */
    ok(/var\(--nv-glide-bg, var\(--soft/.test(glideCss), 'glide.css 仍保留 --nv-glide-bg → --soft 的默认回退');
}

console.log('');
if(fails.length){
    console.error('失败 ' + fails.length + ' 项：');
    fails.forEach(f => console.error('  ✗ ' + f));
    console.error('通过 ' + pass + ' 项');
    process.exit(1);
}
console.log('全部通过（' + pass + ' 项）');
