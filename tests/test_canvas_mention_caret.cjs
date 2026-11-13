#!/usr/bin/env node
'use strict';
/*
 * @ 引用胶囊插入后的光标位置（两个编辑器）：
 *   1) 节点生成面板 PromptEditor（#gpPrompt，@ 弹层 MentionMenu）
 *   2) 画布助手输入区 MentionInput（#aiInput，MentionPalette）
 *
 * 断言：在「画一张 @然后参考图中的人物」这种 @ 后面还有文字的场景里，点选一个 @ 项后光标必须停在
 *      「胶囊 + 胶囊后的分隔空格」之后、后面的文字之前；再打一个字要落在那里，不能跑到全文末尾。
 * 同时覆盖不回归的旧行为：@ 在末尾时光标仍在末尾、Esc 关弹层后 @ 与光标都还在、退格能整体删掉胶囊。
 *
 * 跑法（不碰 3000 端口、不需要 main.py；自己起 vite dev + 无头 Chromium，用完自己收）：
 *   node tests/test_canvas_mention_caret.cjs
 *   node tests/test_canvas_mention_caret.cjs --shots _verification-caret-fix
 * 退出码 0 = 全绿，1 = 有断言失败。
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ROOT, 'novai-canvas-ui');
const PAGE_FILE = path.join(UI_DIR, '__caret-e2e.html');
const PAGE_HTML = '<!doctype html>\n<html lang="zh-CN"><head><meta charset="UTF-8" /><style>html,body,#root{height:100%;width:100%;margin:0;overflow:hidden}</style></head>\n<body><div id="root"></div><script type="module" src="/src/canvas/canvas-next/dev/main.tsx"></script></body></html>\n';
const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg > 0 ? path.resolve(ROOT, process.argv[shotsArg + 1]) : '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failed = [];
function check(name, ok, detail) {
    if (ok) {
        passed += 1;
        console.log('PASS  ' + name);
    } else {
        failed.push(name);
        console.log('FAIL  ' + name + (detail === undefined ? '' : '  ::  ' + JSON.stringify(detail)));
    }
}
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}
function chromiumExecutable() {
    const candidates = [
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
        (() => { try { return chromium.executablePath(); } catch (error) { return ''; } })(),
        path.join(process.env.HOME || '', 'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ].filter(Boolean);
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) throw new Error('找不到可用的 Chromium：设 PLAYWRIGHT_CHROMIUM_EXECUTABLE');
    return found;
}
async function startVite(port) {
    const bin = path.join(UI_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
    if (!fs.existsSync(bin)) throw new Error('novai-canvas-ui 还没装依赖：先 cd novai-canvas-ui && npm install');
    fs.writeFileSync(PAGE_FILE, PAGE_HTML);
    const child = spawn(process.execPath, [bin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: UI_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += String(d); });
    child.stderr.on('data', (d) => { log += String(d); });
    const url = 'http://127.0.0.1:' + port + '/static/novai-canvas/__caret-e2e.html';
    for (let i = 0; i < 160; i += 1) {
        await sleep(250);
        if (child.exitCode !== null) throw new Error('vite 起不来（exit ' + child.exitCode + '）：\n' + log);
        try {
            const res = await fetch(url);
            if (res.ok && (await res.text()).includes('id="root"')) return { child, url };
        } catch (error) { /* 还在启动 */ }
    }
    child.kill('SIGTERM');
    throw new Error('vite 等待超时：\n' + log);
}
function stopVite(child) {
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch (error) { /* 已退出 */ } resolve(); }, 3000);
    });
}

/** 页面里的量具：胶囊按 1 个字符算，和编辑器内部的纯文本偏移一致 */
function installProbe(page) {
    return page.evaluate(() => {
        const isChip = (n) => n && n.nodeType === 1 && n.dataset && (n.dataset.ref || n.dataset.mk);
        window.__nv = {
            flat(root) {
                let out = '';
                const walk = (el) => {
                    el.childNodes.forEach((c) => {
                        if (c.nodeType === 3) out += c.nodeValue;
                        else if (c.nodeType === 1) {
                            if (isChip(c)) out += '◉';
                            else if (c.tagName === 'BR') out += '\n';
                            else walk(c);
                        }
                    });
                };
                walk(root);
                return out.replace(/\u00a0/g, ' ');
            },
            caret(root) {
                const s = getSelection();
                if (!s || !s.rangeCount) return { offset: -1, anchor: 'none', inRoot: false, active: false };
                const r = s.getRangeAt(0);
                if (!root.contains(r.startContainer)) return { offset: -1, anchor: 'outside', inRoot: false, active: document.activeElement === root };
                let off = 0;
                const count = (n) => {
                    if (!n) return;
                    if (n.nodeType === 3) off += n.nodeValue.length;
                    else if (isChip(n)) off += 1;
                    else n.childNodes.forEach(count);
                };
                const walk = (n) => {
                    if (n === r.startContainer) {
                        if (n.nodeType === 3) off += r.startOffset;
                        else for (let i = 0; i < r.startOffset; i += 1) count(n.childNodes[i]);
                        return true;
                    }
                    if (n.nodeType === 3) { off += n.nodeValue.length; return false; }
                    if (isChip(n)) { off += 1; return false; }
                    for (const c of n.childNodes) if (walk(c)) return true;
                    return false;
                };
                walk(root);
                return {
                    offset: off,
                    anchor: r.startContainer.nodeType === 3 ? '#text' : r.startContainer.nodeName + (r.startContainer.id ? '#' + r.startContainer.id : ''),
                    inRoot: true,
                    active: document.activeElement === root,
                };
            },
            setCaret(root, off) {
                const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
                let left = off;
                while (walker.nextNode()) {
                    const n = walker.currentNode;
                    if (n.nodeType === 3) {
                        if (left <= n.nodeValue.length) {
                            const r = document.createRange(); r.setStart(n, left); r.collapse(true);
                            const s = getSelection(); s.removeAllRanges(); s.addRange(r);
                            return true;
                        }
                        left -= n.nodeValue.length;
                    } else if (isChip(n)) {
                        if (left === 0) {
                            const r = document.createRange(); r.setStartBefore(n); r.collapse(true);
                            const s = getSelection(); s.removeAllRanges(); s.addRange(r);
                            return true;
                        }
                        left -= 1;
                    }
                }
                const r = document.createRange(); r.selectNodeContents(root); r.collapse(false);
                const s = getSelection(); s.removeAllRanges(); s.addRange(r);
                return false;
            },
            chips(root) { return root.querySelectorAll('.pm-chip').length; },
        };
        window.__nvChipCount = (sel) => document.querySelectorAll(sel).length;
    });
}

async function openHarness(browser, url, options = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 940 } });
    if (options.elements) await ctx.addInitScript((list) => { try { localStorage.setItem('canvas-next:elements', JSON.stringify(list)); } catch (error) { /* 存不下就测不了素材 */ } }, options.elements);
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
    await page.goto(url + '?empty=1&speed=8');
    await page.waitForFunction(() => window.__cn && window.__cn.state && window.__cn.state.models && window.__cn.state.models.length, null, { timeout: 60000 });
    await sleep(400);
    await installProbe(page);
    return { page, ctx, pageErrors };
}

async function setupPrompt(page) {
    const ids = await page.evaluate(() => {
        const s = window.__cn;
        const src = s.newNode('text', 120, 120, { title: '参考文案', manual: true, hist: [{ text: '人物：白衬衫，背景纯白' }] });
        const dst = s.newNode('image', 620, 120, { title: '目标图', prompt: '' });
        s.addNodes([src, dst], [{ id: 'e-caret-prompt', from: src.id, to: dst.id }]);
        s.setView({ x: 0, y: 0, k: 1 });
        s.setUI({ sel: new Set([dst.id]) });
        return { src: src.id, dst: dst.id };
    });
    await page.waitForSelector('#gpPrompt', { timeout: 10000 });
    await sleep(300);
    return ids;
}

async function openPromptMenu(page, prefix) {
    const ed = page.locator('#gpPrompt');
    await ed.click();
    await page.keyboard.type(prefix);
    await page.evaluate(() => window.__nv.setCaret(document.getElementById('gpPrompt'), 4));
    await page.keyboard.type('@');
    await page.waitForSelector('[data-mention-menu] button.pm-it[data-mi]', { timeout: 8000 });
}

async function openAgent(page) {
    await page.evaluate(() => window.__cn.setUI({ agentOpen: true }));
    await page.waitForSelector('#aiInput', { timeout: 10000 });
    await sleep(300);
}

async function openAgentMenu(page, prefix) {
    const ed = page.locator('#aiInput');
    await ed.click();
    await page.keyboard.type(prefix);
    await page.evaluate(() => window.__nv.setCaret(document.getElementById('aiInput'), 6));
    await page.keyboard.type('@');
    await page.waitForSelector('#pop button.ap2-mp-item', { timeout: 8000 });
}

async function readState(page, id) {
    return page.evaluate((rootId) => {
        const root = document.getElementById(rootId);
        return { flat: window.__nv.flat(root), caret: window.__nv.caret(root), chips: window.__nv.chips(root) };
    }, id);
}

async function shot(page, name) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}

async function promptCase(browser, url) {
    const { page, ctx, pageErrors } = await openHarness(browser, url);
    const ids = await setupPrompt(page);
    await openPromptMenu(page, '画一张 然后参考图中的人物');
    const beforePick = await page.evaluate(() => window.__nv.flat(document.getElementById('gpPrompt')));
    await page.locator('[data-mention-menu] button.pm-it[data-mi]').first().click();
    await sleep(350);
    const afterPick = await readState(page, 'gpPrompt');
    const stored = await page.evaluate((dst) => {
        const d = window.__cn.node(dst);
        return d && d.data && d.data.gen ? d.data.gen.prompt : null;
    }, ids.dst);
    await shot(page, '1-prompt-after-pick');
    await page.keyboard.type('X');
    await sleep(200);
    const afterType = await readState(page, 'gpPrompt');
    await shot(page, '2-prompt-after-type');
    console.log('   [prompt] before=' + JSON.stringify(beforePick));
    console.log('   [prompt] afterPick=' + JSON.stringify({ ...afterPick, stored }));
    console.log('   [prompt] afterType=' + JSON.stringify(afterType));
    check('PromptEditor：插入前文本是「画一张 @然后参考图中的人物」', beforePick === '画一张 @然后参考图中的人物', beforePick);
    check('PromptEditor：胶囊 + 空格插在 @ 的位置', afterPick.flat === '画一张 ◉ 然后参考图中的人物', afterPick.flat);
    check('PromptEditor：选完光标停在胶囊后、后面文字之前', afterPick.caret.offset === 6 && afterPick.caret.inRoot, afterPick.caret);
    check('PromptEditor：选完光标不在全文末尾', afterPick.caret.offset < afterPick.flat.length, { offset: afterPick.caret.offset, len: afterPick.flat.length });
    check('PromptEditor：接着打字落在胶囊后（不是全文末尾）', afterType.flat === '画一张 ◉ X然后参考图中的人物' && afterType.caret.offset === 7, afterType);
    check('PromptEditor：父状态里的提示词同步成记号、顺序正确', stored === '画一张 @{' + ids.src + '}\u00a0然后参考图中的人物', stored);
    check('PromptEditor：无页面异常', pageErrors.length === 0, pageErrors);
    await ctx.close();
    return { case: 'prompt', ids, beforePick, afterPick, afterType, stored };
}

async function promptAtEndCase(browser, url) {
    const { page, ctx, pageErrors } = await openHarness(browser, url);
    const ids = await setupPrompt(page);
    const ed = page.locator('#gpPrompt');
    await ed.click();
    await page.keyboard.type('画一张 ');
    await page.evaluate(() => window.__nv.setCaret(document.getElementById('gpPrompt'), 4));
    await page.keyboard.type('@');
    await page.waitForSelector('[data-mention-menu] button.pm-it[data-mi]', { timeout: 8000 });
    await page.locator('[data-mention-menu] button.pm-it[data-mi]').first().click();
    await sleep(350);
    const afterPick = await readState(page, 'gpPrompt');
    await page.keyboard.type('X');
    await sleep(200);
    const afterType = await readState(page, 'gpPrompt');
    console.log('   [prompt@end] afterPick=' + JSON.stringify(afterPick) + ' afterType=' + JSON.stringify(afterType));
    check('PromptEditor（@ 在末尾）：胶囊 + 空格后光标仍在末尾', afterPick.flat === '画一张 ◉ ' && afterPick.caret.offset === 6, afterPick);
    check('PromptEditor（@ 在末尾）：继续打字接在空格后', afterType.flat === '画一张 ◉ X' && afterType.caret.offset === 7, afterType);
    check('PromptEditor（@ 在末尾）：无页面异常', pageErrors.length === 0, pageErrors);
    await ctx.close();
    return { case: 'prompt-at-end', ids, afterPick, afterType };
}

async function promptEscapeCase(browser, url) {
    const { page, ctx, pageErrors } = await openHarness(browser, url);
    await setupPrompt(page);
    await openPromptMenu(page, '画一张 然后参考图中的人物');
    await page.keyboard.press('Escape');
    await sleep(300);
    const state = await readState(page, 'gpPrompt');
    const menuGone = await page.evaluate(() => !document.querySelector('[data-mention-menu]'));
    check('PromptEditor（Esc）：弹层关掉、@ 留在原文里', menuGone && state.flat === '画一张 @然后参考图中的人物', state);
    check('PromptEditor（Esc）：光标回到 @ 后面', state.caret.offset === 5 && state.caret.offset === state.flat.length - '然后参考图中的人物'.length, state.caret);
    check('PromptEditor（Esc）：无页面异常', pageErrors.length === 0, pageErrors);
    await ctx.close();
    return { case: 'prompt-escape', state, menuGone };
}

async function promptBackspaceCase(browser, url) {
    const { page, ctx, pageErrors } = await openHarness(browser, url);
    await setupPrompt(page);
    await openPromptMenu(page, '画一张 然后参考图中的人物');
    await page.locator('[data-mention-menu] button.pm-it[data-mi]').first().click();
    await sleep(350);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await sleep(250);
    const state = await readState(page, 'gpPrompt');
    check('PromptEditor（退格）：胶囊整体删掉、文字复原', state.chips === 0 && state.flat === '画一张 然后参考图中的人物', state);
    check('PromptEditor（退格）：无页面异常', pageErrors.length === 0, pageErrors);
    await ctx.close();
    return { case: 'prompt-backspace', state };
}

async function promptElementCase(browser, url) {
    const elements = [{ id: 'el_caret', name: '主角A', kind: 'character', desc: '白衬衫人物', refs: [], at: Date.now() }];
    const { page, ctx, pageErrors } = await openHarness(browser, url, { elements });
    await setupPrompt(page);
    await openPromptMenu(page, '画一张 然后参考图中的人物');
    await page.locator('[data-mention-menu] button.pm-fd[data-folder="character"]').click();
    await page.waitForSelector('[data-mention-menu] button.pm-it[data-mi^="el:"]', { timeout: 8000 });
    await page.locator('[data-mention-menu] button.pm-it[data-mi^="el:"]').first().click();
    await sleep(350);
    const afterPick = await readState(page, 'gpPrompt');
    await page.keyboard.type('X');
    await sleep(200);
    const afterType = await readState(page, 'gpPrompt');
    console.log('   [prompt/素材] afterPick=' + JSON.stringify(afterPick));
    console.log('   [prompt/素材] afterType=' + JSON.stringify(afterType));
    check('PromptEditor（素材）：@名字 + 空格插在 @ 的位置', afterPick.flat === '画一张 @主角A 然后参考图中的人物', afterPick.flat);
    check('PromptEditor（素材）：选完光标停在刚插入的名字后面', afterPick.caret.offset === 9, afterPick.caret);
    check('PromptEditor（素材）：接着打字落在名字后（不是全文末尾）', afterType.flat === '画一张 @主角A X然后参考图中的人物' && afterType.caret.offset === 10, afterType);
    check('PromptEditor（素材）：无页面异常', pageErrors.length === 0, pageErrors);
    await ctx.close();
    return { case: 'prompt-element', elements, afterPick, afterType };
}

async function agentCase(browser, url) {
    const { page, ctx, pageErrors } = await openHarness(browser, url);
    const ids = await page.evaluate(() => {
        const s = window.__cn;
        const src = s.newNode('text', 120, 120, { title: '参考文案', manual: true, hist: [{ text: '人物：白衬衫，背景纯白' }] });
        const dst = s.newNode('image', 620, 120, { title: '目标图', prompt: '' });
        s.addNodes([src, dst], [{ id: 'e-caret-agent', from: src.id, to: dst.id }]);
        return { src: src.id, dst: dst.id };
    });
    await openAgent(page);
    await openAgentMenu(page, '帮我画一张 然后参考图中的人物');
    await page.locator('#pop button.ap2-mp-item').first().click();
    await sleep(350);
    const afterPick = await readState(page, 'aiInput');
    await shot(page, '3-agent-after-pick');
    await page.keyboard.type('X');
    await sleep(200);
    const afterType = await readState(page, 'aiInput');
    await shot(page, '4-agent-after-type');
    console.log('   [agent] afterPick=' + JSON.stringify(afterPick));
    console.log('   [agent] afterType=' + JSON.stringify(afterType));
    check('MentionInput：胶囊 + 空格插在 @ 的位置', afterPick.flat === '帮我画一张 ◉ 然后参考图中的人物', afterPick.flat);
    check('MentionInput：选完光标停在胶囊后、后面文字之前', afterPick.caret.offset === 8 && afterPick.caret.inRoot, afterPick.caret);
    check('MentionInput：选完光标不在全文末尾', afterPick.caret.offset < afterPick.flat.length, { offset: afterPick.caret.offset, len: afterPick.flat.length });
    check('MentionInput：接着打字落在胶囊后（不是全文末尾）', afterType.flat === '帮我画一张 ◉ X然后参考图中的人物' && afterType.caret.offset === 9, afterType);
    check('MentionInput：无页面异常', pageErrors.length === 0, pageErrors);
    await ctx.close();
    return { case: 'agent', ids, afterPick, afterType };
}

async function agentBackspaceCase(browser, url) {
    const { page, ctx, pageErrors } = await openHarness(browser, url);
    await page.evaluate(() => {
        const s = window.__cn;
        const src = s.newNode('text', 120, 120, { title: '参考文案', manual: true, hist: [{ text: '人物：白衬衫，背景纯白' }] });
        s.addNodes([src]);
    });
    await openAgent(page);
    await openAgentMenu(page, '帮我画一张 然后参考图中的人物');
    await page.locator('#pop button.ap2-mp-item').first().click();
    await sleep(350);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await sleep(250);
    const state = await readState(page, 'aiInput');
    check('MentionInput（退格）：胶囊整体删掉、文字复原', state.chips === 0 && state.flat === '帮我画一张 然后参考图中的人物', state);
    check('MentionInput（退格）：无页面异常', pageErrors.length === 0, pageErrors);
    await ctx.close();
    return { case: 'agent-backspace', state };
}

async function main() {
    const port = await freePort();
    const { child, url } = await startVite(port);
    const evidence = { startedAt: new Date().toISOString(), url, cases: {} };
    let browser = null;
    try {
        browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
        for (const run of [promptCase, promptAtEndCase, promptEscapeCase, promptBackspaceCase, promptElementCase, agentCase, agentBackspaceCase]) {
            const result = await run(browser, url);
            evidence.cases[result.case] = result;
        }
    } finally {
        if (browser) await browser.close().catch(() => undefined);
        await stopVite(child);
        try { fs.unlinkSync(PAGE_FILE); } catch (error) { /* 本来就没有 */ }
    }
    if (SHOTS) {
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'selection.json'), JSON.stringify(evidence, null, 2) + '\n');
        console.log('证据写到 ' + SHOTS);
    }
    console.log('\n' + (failed.length ? 'FAILED ' + failed.length + ' 项 / 共 ' + (passed + failed.length) + ' 项' : 'ALL PASS (' + passed + ' 项)'));
    if (failed.length) { failed.forEach((name) => console.log('  - ' + name)); process.exit(1); }
}
main().catch((error) => { console.error(error); process.exit(1); });
