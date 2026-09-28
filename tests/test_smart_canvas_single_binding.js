/* 「点一次『下载』弹出多个 macOS 保存框」的回归测试。
   根因：render() 会原样复用 HTML 未变的节点 DOM（keepEl），但每轮 render 末尾都会再跑
   bindNodeEvents()；没有幂等保护的 addEventListener 会一组组叠加 —— 点一次「下载」就跑
   N 次 runSmartNodeToolbarAction → N 次 downloadPreviewFile → N 个原生保存框。
   本测试断言三件事：
     A. 结构：四个绑定函数里每个 addEventListener 都落在「同一元素只绑一次」的 dataset 保护之内；
     B. 行为：把 downloadBlob 抽出来在假 pywebview / 假浏览器里跑，验证 in-flight 保护与各分支复位；
     C. launcher.py 的 save_file 有忙碌保护（原生保存框是模态的，绝不允许叠第二个）。
   跑法：node tests/test_smart_canvas_single_binding.js */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const js = read('static/js/smart-canvas.js');
const utils = read('static/js/shared/utils.js');
const zimage = read('static/zimage.html');
const launcher = read('launcher.py');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };
const eq = (actual, expected, label) => ok(JSON.stringify(actual) === JSON.stringify(expected),
    label + ' 期望' + JSON.stringify(expected) + ' 实际' + JSON.stringify(actual));

/* ── 源码扫描小工具 ── */

// 顶层函数体：列 0 的 "function x(" 到列 0 的 "}"（本文件顶层函数名唯一）
function topLevelFunction(src, name){
    const lines = src.split('\n');
    const start = lines.findIndex(line => line.startsWith('function ' + name + '('));
    if(start < 0) return '';
    for(let i = start + 1; i < lines.length; i += 1){
        if(lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}
// IIFE 里的 4 空格缩进函数体
function indentedFunction(src, signature){
    const lines = src.split('\n');
    const start = lines.findIndex(line => line.trim().startsWith(signature));
    if(start < 0) return '';
    const indent = lines[start].match(/^\s*/)[0];
    for(let i = start + 1; i < lines.length; i += 1){
        if(lines[i] === indent + '}') return lines.slice(start, i + 1).join('\n');
    }
    return '';
}
const BACKTICK = String.fromCharCode(96);
/* 1 = 真代码，0 = 注释 / 字符串 / 模板字面量 / 正则。
   长度与换行都保持不变，位置可以和原文一一对齐（花括号只认真代码里的）。 */
function codeFlags(src){
    const flags = new Uint8Array(src.length).fill(1);
    const blank = (from, to) => { for(let k = from; k < to && k < src.length; k += 1) flags[k] = 0; };
    let i = 0;
    let prev = '';
    while(i < src.length){
        const c = src[i];
        if(c === '/' && src[i + 1] === '/'){ const start = i; while(i < src.length && src[i] !== '\n') i += 1; blank(start, i); continue; }
        if(c === '/' && src[i + 1] === '*'){ const start = i; i += 2; while(i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1; i = Math.min(src.length, i + 2); blank(start, i); continue; }
        if(c === '"' || c === "'"){
            const quote = c; const start = i; i += 1;
            while(i < src.length && src[i] !== quote){ if(src[i] === '\\') i += 1; i += 1; }
            i += 1; blank(start, i); prev = quote; continue;
        }
        if(c === BACKTICK){
            const start = i; i += 1; let depth = 0;
            while(i < src.length){
                const ch = src[i];
                if(ch === '\\'){ i += 2; continue; }
                if(ch === '$' && src[i + 1] === '{'){ depth += 1; i += 2; continue; }
                if(depth > 0 && ch === '}'){ depth -= 1; i += 1; continue; }
                if(depth === 0 && ch === BACKTICK){ i += 1; break; }
                i += 1;
            }
            blank(start, i); prev = BACKTICK; continue;
        }
        if(c === '/' && /[([{,;:=!&|?+\-*%<>~^]/.test(prev || '(')){
            const start = i; i += 1; let inClass = false;
            while(i < src.length && src[i] !== '\n'){
                if(src[i] === '\\'){ i += 2; continue; }
                if(src[i] === '[') inClass = true;
                else if(src[i] === ']') inClass = false;
                else if(src[i] === '/' && !inClass){ i += 1; break; }
                i += 1;
            }
            blank(start, i); prev = '/'; continue;
        }
        if(!/\s/.test(c)) prev = c;
        i += 1;
    }
    return flags;
}
function braceRanges(src, flags){
    const stack = [];
    const ranges = [];
    for(let i = 0; i < src.length; i += 1){
        if(!flags[i]) continue;
        if(src[i] === '{') stack.push(i);
        else if(src[i] === '}'){
            const start = stack.pop();
            if(start !== undefined) ranges.push({start, end:i});
        }
    }
    return ranges;
}
const inRange = (range, idx) => range.start < idx && idx < range.end;
const escapeRe = text => text.replace(/[.*+?^$[\]{}()|\\]/g, '\\$&');

/* 找出「没有被幂等保护罩住」的 addEventListener 调用点。
   保护写法两种，仓库里已有的风格：
     ① if(x.dataset.yBound === '1') return;   ← forEach 回调开头提前返回
     ② if(x.dataset.yBound !== '1') { ... }   ← 整块只进一次
   要求同一个元素（接收者）的 dataset 标记，而且标记必须真的被赋成 '1'（否则保护是假的）。 */
function unguardedSites(body){
    const flags = codeFlags(body);
    const blocks = braceRanges(body, flags);
    const guards = [];
    for(const m of body.matchAll(/if\s*\(\s*([A-Za-z_$][\w$]*)\.dataset\.(\w+)\s*===\s*'1'\s*\)\s*\{?\s*return;/g)){
        if(!flags[m.index]) continue;
        const block = blocks.filter(b => inRange(b, m.index)).sort((a, b) => b.start - a.start)[0];
        if(block) guards.push({recv:m[1], flag:m[2], pos:m.index, block});
    }
    // ② if(x && x.dataset.yBound !== '1'){ ... }：整块只进一次（条件里允许有别的与项）
    for(const m of body.matchAll(/if\s*\(([^()]*)\)\s*\{/g)){
        if(!flags[m.index]) continue;
        const block = blocks.find(b => b.start === m.index + m[0].length - 1);
        if(!block) continue;
        for(const cond of m[1].matchAll(/([A-Za-z_$][\w$]*)\.dataset\.(\w+)\s*!==\s*'1'/g)){
            guards.push({recv:cond[1], flag:cond[2], pos:m.index, block});
        }
    }
    const lines = body.split('\n');
    const sites = [...body.matchAll(/([A-Za-z_$][\w$]*)\.addEventListener\(/g)]
        .filter(m => m[1] !== 'document')
        .map(m => {
            const lineNo = body.slice(0, m.index).split('\n').length;
            return {idx:m.index, recv:m[1], line:lineNo, text:(lines[lineNo - 1] || '').trim()};
        });
    return sites.filter(site => !guards.some(guard => guard.recv === site.recv
        && guard.pos < site.idx
        && inRange(guard.block, site.idx)
        && new RegExp(escapeRe(guard.recv) + '\\.dataset\\.' + guard.flag + "\\s*=\\s*'1'").test(body)));
}

/* 「每个节点元素整体只跑一次」的写法：函数开头
     if(el.dataset.xxxBound === '1') return; el.dataset.xxxBound = '1';
   只有当这个函数对同一个 el 一轮只会被调用一次时才算数（下面会核对调用点数量）。 */
function functionLevelGuard(body){
    const sig = body.match(/^function\s+\w+\s*\(([^)]*)\)/);
    if(!sig) return null;
    const first = sig[1].split(',')[0].trim();
    if(!/^[A-Za-z_$][\w$]*$/.test(first)) return null;
    // 函数左花括号之后允许先有注释
    const gap = '(?:\\s|\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*\\n)*';
    const re = new RegExp('\\{' + gap + 'if\\s*\\(\\s*' + escapeRe(first) + "\\.dataset\\.(\\w+)\\s*===\\s*'1'\\s*\\)\\s*return;" + gap
        + escapeRe(first) + "\\.dataset\\.\\1\\s*=\\s*'1';");
    const m = body.match(re);
    return m ? first + '.dataset.' + m[1] : null;
}

(async function main(){
    /* ───────────────────────── A. 绑定函数结构 ───────────────────────── */
    console.log('[A] bindNodeEvents 及它调用的绑定函数：每个监听点都在 dataset 幂等保护之内');
    const BIND_FUNCS = ['bindNodeEvents', 'bindPromptNodeControls', 'bindLoopNodeControls', 'bindSmartGroupTitleInput'];
    const bodies = {};
    BIND_FUNCS.forEach(name => {
        bodies[name] = topLevelFunction(js, name);
        ok(bodies[name].length > 400, '抽到 ' + name + ' 源码');
    });

    let checkedSites = 0;
    BIND_FUNCS.forEach(name => {
        const body = bodies[name];
        if(!body) return;
        const all = [...body.matchAll(/\.addEventListener\(/g)].length;
        const identified = [...body.matchAll(/([A-Za-z_$][\w$]*)\.addEventListener\(/g)];
        eq(identified.length, all, name + ' 内 addEventListener 的接收者都是标识符（便于挂 dataset 标记）');
        const docSites = [...body.matchAll(/document\.addEventListener\(/g)];
        const flags = codeFlags(body);
        const blocks = braceRanges(body, flags);
        const unpaired = docSites.filter(m => {
            const block = blocks.filter(b => inRange(b, m.index)).sort((a, b) => b.start - a.start)[0];
            return !block || !/document\.removeEventListener\(/.test(body.slice(block.start, block.end));
        });
        ok(unpaired.length === 0, name + ' 里 document 上的监听都是「用时加、用完删」的成对写法');
        const fnGuard = functionLevelGuard(body);
        if(fnGuard){
            // 整函数级标记成立的前提：同一个 el 一轮只会调一次（定义 + bindNodeEvents 里那次调用）
            eq([...js.matchAll(new RegExp('\\b' + name + '\\(', 'g'))].length, 2,
                name + ' 只有「定义 + bindNodeEvents 里一次调用」，整函数级标记才成立');
        }
        const bad = fnGuard ? [] : unguardedSites(body);
        checkedSites += identified.length - docSites.length;
        ok(bad.length === 0, name + ' 有 ' + bad.length + ' 个监听点没有幂等保护'
            + (fnGuard ? '（整函数由 ' + fnGuard + " === '1' 保护）" : '') + '：'
            + bad.slice(0, 6).map(s => 'L' + s.line + ' ' + s.text).join(' | '));
    });
    ok(checkedSites >= 45, '覆盖到的监听点足够多，不是空跑（实际 ' + checkedSites + ' 个）');

    // 根元素上的四组监听必须共用一个根级标记，一次性绑完
    ok(/if\(el\.dataset\.smartNodeEventsBound !== '1'\)\{/.test(bodies.bindNodeEvents), '根元素用同一个标记 el.dataset.smartNodeEventsBound 绑一次');
    eq((bodies.bindNodeEvents.match(/el\.addEventListener\(/g) || []).length, 4, '根元素上正好四组 addEventListener（拖后吞 click / 视频选中 / 端口 linger 进出）');
    /* 工具条按钮（含懒渲染建出来的菜单项）改成在 world 上一次性委托：
       幂等保护从「每颗按钮的 data-smart-action-bound」换成「根上的 __smartNodeToolbarActions」，
       逐元素绑定必须已经摘掉，否则一次点击会跑两遍动作。 */
    ok(/function initSmartNodeToolbarActions\(root\)\{[\s\S]{0,240}root\.__smartNodeToolbarActions\) return;/.test(js),
        '工具条动作在根上一次性委托（__smartNodeToolbarActions 幂等），懒渲染的菜单项才绑得上');
    ok(!/smartActionBound/.test(js), '已摘掉逐元素的 data-smart-action-bound 绑定（避免和委托重复执行）');

    /* ───────────────────────── B. downloadBlob ───────────────────────── */
    console.log('[B] downloadBlob：同一时刻只允许一个保存流程，且任何分支都会复位');
    const flagSource = utils.slice(0, utils.indexOf('async function downloadBlob('));
    const flagCandidates = [...flagSource.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*false;/g)].map(m => m[1]);
    const fnSrc = indentedFunction(utils, 'async function downloadBlob(');
    ok(fnSrc.length > 400, '抽到 downloadBlob 源码');
    // 只认「函数体里真的用到」的那个模块级 false 标记（文件里还有别的 xxx = false）
    const flagName = flagCandidates.reverse().find(name => new RegExp('\\b' + escapeRe(name) + '\\b').test(fnSrc)) || '';
    ok(Boolean(flagName), 'downloadBlob 有模块级 in-flight 标记（let/var xxx = false）');
    ok(new RegExp('if\\s*\\(\\s*' + escapeRe(flagName || 'NO_FLAG') + '\\s*\\)').test(fnSrc),
        '函数入口检查 in-flight 标记，正在保存就直接返回');
    ok(new RegExp('finally\\s*\\{[\\s\\S]{0,160}' + escapeRe(flagName || 'NO_FLAG') + '\\s*=\\s*false').test(fnSrc),
        'downloadBlob 用 try/finally 复位 in-flight 标记');

    let harness = null;
    if(fnSrc && flagName){
        try {
            harness = new Function('window', 'document', 'URL', 'FileReader', 'showToast', 'tr', 'setTimeout', 'console',
                'let ' + flagName + ' = false;\n' + fnSrc + '\nreturn downloadBlob;');
        } catch(e) {
            harness = null;
            fails.push('downloadBlob 源码无法在沙箱里跑起来：' + e.message);
        }
    }

    function newEnv(opts){
        opts = opts || {};
        const calls = {saveFile:0, names:[], anchors:0, pickers:0, toasts:[], revoked:0, writes:0, closed:0};
        const fakeDoc = {
            createElement: () => ({style:{}, click(){ calls.anchors += 1; }, remove(){}}),
            body: {appendChild(){}}
        };
        const fakeWindow = {};
        if(opts.pywebview !== false){
            fakeWindow.pywebview = {api: {save_file: (data, name) => {
                calls.saveFile += 1;
                calls.names.push(name);
                return opts.saveFile ? opts.saveFile() : Promise.resolve('/Users/x/a.png');
            }}};
        }
        if(opts.picker){
            fakeWindow.showSaveFilePicker = async () => {
                calls.pickers += 1;
                return opts.picker();
            };
        }
        const fakeUrl = {createObjectURL: () => 'blob:fake', revokeObjectURL: () => { calls.revoked += 1; }};
        class FakeFileReader {
            readAsDataURL(){
                if(opts.readFails){ setTimeout(() => this.onerror && this.onerror(new Error('read failed')), 0); return; }
                this.result = 'data:image/png;base64,AAAA';
                setTimeout(() => this.onload && this.onload(), 0);
            }
        }
        const timers = [];
        const fn = harness(fakeWindow, fakeDoc, fakeUrl, FakeFileReader,
            text => calls.toasts.push(String(text)), key => key,
            cb => { timers.push(cb); return timers.length; },
            {log(){}, warn(){}, error(){}});
        return {calls, timers, download: name => fn({size:8, type:'image/png'}, name)};
    }

    if(harness){
        // ① 并发两次只跑一次原生保存
        {
            const env = newEnv({saveFile: () => Promise.resolve('/Users/x/a.png')});
            const first = env.download('a.png');
            const second = env.download('a.png');
            await Promise.all([first, second]);
            eq(env.calls.saveFile, 1, '并发第二次调用被忽略（只弹一个保存框）');
            ok(env.calls.toasts.some(t => /正在保存|保存中/.test(t)), '被忽略的调用有中文提示：' + JSON.stringify(env.calls.toasts));
            await env.download('b.png');
            eq(env.calls.saveFile, 2, '保存结束后能再次保存（没有永久锁死）');
        }
        // ② 用户取消（save_file 返回空串）
        {
            const env = newEnv({saveFile: () => Promise.resolve('')});
            await env.download('a.png');
            await env.download('b.png');
            eq(env.calls.saveFile, 2, '用户取消后标记复位（下一次仍能保存）');
        }
        // ③ 保存抛异常
        {
            const env = newEnv({saveFile: () => Promise.reject(new Error('boom'))});
            await env.download('a.png');
            ok(env.calls.toasts.includes('保存失败'), '抛异常时提示保存失败');
            await env.download('b.png');
            eq(env.calls.saveFile, 2, '抛异常后标记复位');
        }
        // ④ blob 读取失败（两次都走到「保存失败」，说明第二次没被 in-flight 挡住）
        {
            const env = newEnv({readFails: true});
            await env.download('a.png');
            await env.download('b.png');
            eq(env.calls.toasts.filter(t => t === '保存失败').length, 2, '读 blob 失败后标记复位（第二次仍会真的走保存流程）');
        }
        // ⑤ showSaveFilePicker 正常保存
        {
            const env = newEnv({pywebview: false, picker: () => ({
                createWritable: async () => ({
                    write: async () => { env.calls.writes += 1; },
                    close: async () => { env.calls.closed += 1; }
                })
            })});
            await env.download('a.png');
            await env.download('b.png');
            eq(env.calls.pickers, 2, '浏览器 File System Access 路径正常可用（标记复位）');
            eq(env.calls.writes, 2, '写盘各一次');
        }
        // ⑥ 文件选择器出错（非取消）→ 回退到 <a download>；用户主动取消 → 静默
        {
            const env = newEnv({pywebview: false, picker: () => { throw new Error('no user gesture'); }});
            await env.download('a.png');
            eq(env.calls.anchors, 1, '文件选择器不可用时回退到 <a download>');
            await env.download('b.png');
            eq(env.calls.anchors, 2, '回退路径结束后标记复位');
        }
        {
            const env = newEnv({pywebview: false, picker: () => { const e = new Error('abort'); e.name = 'AbortError'; throw e; }});
            await env.download('a.png');
            eq(env.calls.anchors, 0, '用户取消文件选择器：静默，不再触发 <a download>');
            await env.download('b.png');
            eq(env.calls.pickers, 2, '取消后标记复位');
        }
        // ⑦ 纯 <a download> 降级路径
        {
            const env = newEnv({pywebview: false});
            await env.download('a.png');
            await env.download('b.png');
            eq(env.calls.anchors, 2, '普通浏览器下载路径正常可用（标记复位）');
        }
    } else {
        fails.push('downloadBlob 行为测试没法跑：没抽到源码 / 没有 in-flight 标记');
    }

    /* ───────────────────────── C. launcher.py ───────────────────────── */
    console.log('[C] launcher.py 的 save_file：已有保存框打开时第二次调用立刻返回空串');
    const launcherLines = launcher.split('\n');
    const defAt = launcherLines.findIndex(line => /^\s+def save_file\(self/.test(line));
    ok(defAt > 0, '找得到 NovaiApi.save_file');
    let saveBody = '';
    if(defAt > 0){
        const indent = launcherLines[defAt].match(/^\s*/)[0];
        for(let i = defAt + 1; i < launcherLines.length; i += 1){
            if(!launcherLines[i].trim()) continue;
            if(launcherLines[i].match(/^\s*/)[0].length <= indent.length){ saveBody = launcherLines.slice(defAt, i).join('\n'); break; }
        }
    }
    ok(saveBody.length > 200, '抽到 save_file 方法体');
    const busyAt = saveBody.indexOf('if not self._save_file_lock.acquire(blocking=False):');
    const dialogAt = saveBody.indexOf('create_file_dialog');
    ok(busyAt >= 0 && busyAt < dialogAt, '忙碌检查在弹出原生保存框之前');
    ok(/if not self\._save_file_lock\.acquire\(blocking=False\):[\s\S]{0,200}log\("save_file: busy, skipped"\)[\s\S]{0,60}return ""/.test(saveBody),
        '抢不到锁时打日志并立刻返回空串（非阻塞）');
    ok(/finally:\s*\n\s*self\._save_file_lock\.release\(\)/.test(saveBody),
        '锁在 finally 里释放（异常也不会锁死）');
    const initAt = launcherLines.findIndex(line => /^\s+def __init__\(self\):/.test(line));
    let initBody = '';
    if(initAt > 0){
        const indent = launcherLines[initAt].match(/^\s*/)[0];
        for(let i = initAt + 1; i < launcherLines.length; i += 1){
            if(!launcherLines[i].trim()) continue;
            if(launcherLines[i].match(/^\s*/)[0].length <= indent.length){ initBody = launcherLines.slice(initAt, i).join('\n'); break; }
        }
    }
    ok(/self\._save_file_lock = threading\.Lock\(\)/.test(initBody), '__init__ 里初始化 self._save_file_lock = threading.Lock()');
    ok(/^import threading$/m.test(launcher), 'launcher.py 顶部已 import threading');
    ok(/log\(f"save_file: saved to \{path\}"\)/.test(saveBody), '正常保存分支原样保留');
    ok(!zimage.includes('NovaUtils.downloadBlob') && zimage.includes('window.pywebview.api.save_file(canvas.toDataURL'),
        'zimage.html 直连 save_file 的那处保持原样（不是本次问题源）');

    console.log('');
    if(fails.length){
        console.error('失败 ' + fails.length + ' 项：');
        fails.forEach(f => console.error('  ✗ ' + f));
        console.error('通过 ' + pass + ' 项');
        process.exit(1);
    }
    console.log('全部通过（' + pass + ' 项）');
})();
