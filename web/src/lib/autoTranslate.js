// 新前端的英文界面（第 24 轮）。
// 新写的 Vue 页面里文案大多直接写中文（部分走 t()）。英文模式下由这里统一翻译：
//   · 词典 lib/i18n-en.json：key 是源码里的中文文案（模板文本、属性、脚本字符串；含变量的写成 {0}{1}），
//     由 web/i18n-extract.cjs 从源码抽取，新增文案后重新抽取 → 补译 → 合并即可；
//   · 运行时扫描 DOM 文本节点和 placeholder / title / aria-label 属性：整句精确匹配，或按「{0}」模板匹配（变量本身若是词典里的词也会翻译）；
//   · MutationObserver 接住 Vue 后续更新和 Teleport 出来的弹层；切回中文时逐个还原。
// 用户内容不翻译：聊天正文（.md / .bu）、输入框、contenteditable，以及任何带 data-no-i18n 的容器。
import EN from './i18n-en.json';
import { watch } from 'vue';
import { state } from './store.js';

const ZH = /[一-龥]/;
const norm = s => String(s).replace(/\s+/g, ' ').trim();
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
const exact = new Map();
const tpls = [];
for (const [zh, en] of Object.entries(EN)) {
    if (/\{\d+\}/.test(zh)) {
        const order = [];
        const src = zh.split(/(\{\d+\})/).map(p => { const m = p.match(/^\{(\d+)\}$/); if (m) { order.push(+m[1]); return '([\\s\\S]+?)'; } return esc(norm(p) === '' && p ? ' ' : p); }).join('');
        try { tpls.push({ re: new RegExp('^' + src.trim() + '$'), order, en, len: zh.replace(/\{\d+\}/g, '').length }); } catch (e) {}
    } else exact.set(norm(zh), en);
}
tpls.sort((a, b) => b.len - a.len);

export function translate(text) {
    const k = norm(text);
    if (!k || !ZH.test(k)) return null;
    if (exact.has(k)) return exact.get(k);
    for (const t of tpls) {
        const m = k.match(t.re);
        if (!m) continue;
        return t.en.replace(/\{(\d+)\}/g, (_, i) => { const v = m[t.order.indexOf(+i) + 1] || ''; return (v.length < k.length && translate(v)) || v; });
    }
    return null;
}

const SKIP = 'textarea, input, select, script, style, [contenteditable=""], [contenteditable="true"], [data-no-i18n], .md, .bu, .nv-glide-pill';
const ATTRS = ['placeholder', 'title', 'aria-label', 'data-tip'];

// 每个文档（外壳本身、以及同源的旧页面 iframe，如首页 home.html）各有一个翻译器
function createTranslator(doc, roots) {
    let on = false;
    let observer = null;
    const skipped = el => !el || (el.closest && el.closest(SKIP));
    function doText(node) {
        if (!on || skipped(node.parentElement)) return;
        const v = node.nodeValue;
        if (node.__nvEn !== undefined && v === node.__nvEn) return;
        const en = translate(v);
        if (en == null) { node.__nvZh = undefined; node.__nvEn = undefined; return; }
        const lead = v.match(/^\s*/)[0], tail = v.match(/\s*$/)[0];
        node.__nvZh = v; node.__nvEn = lead + en + tail;
        node.nodeValue = node.__nvEn;
    }
    function doAttrs(el) {
        if (!on || skipped(el) && !(el.matches && el.matches('input, textarea'))) return;
        if (el.closest && el.closest('[data-no-i18n]')) return;
        el.__nvAttr = el.__nvAttr || {};
        for (const a of ATTRS) {
            const v = el.getAttribute && el.getAttribute(a);
            if (!v) continue;
            const rec = el.__nvAttr[a];
            if (rec && v === rec.en) continue;
            const en = translate(v);
            if (en == null) { delete el.__nvAttr[a]; continue; }
            el.__nvAttr[a] = { zh: v, en };
            el.setAttribute(a, en);
        }
    }
    function walk(root) {
        if (!root) return;
        if (root.nodeType === 3) { doText(root); return; }
        if (root.nodeType !== 1) return;
        doAttrs(root);
        const tw = doc.createTreeWalker(root, 5 /* SHOW_ELEMENT | SHOW_TEXT */);
        let n;
        while ((n = tw.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
    }
    function restore() {
        const tw = doc.createTreeWalker(doc.documentElement, 5);
        let n;
        while ((n = tw.nextNode())) {
            if (n.nodeType === 3) { if (n.__nvZh !== undefined && n.nodeValue === n.__nvEn) n.nodeValue = n.__nvZh; n.__nvZh = n.__nvEn = undefined; }
            else if (n.__nvAttr) { for (const a in n.__nvAttr) { const r = n.__nvAttr[a]; if (n.getAttribute(a) === r.en) n.setAttribute(a, r.zh); } n.__nvAttr = undefined; }
        }
    }
    function start() {
        if (on) return;
        on = true;
        roots().forEach(walk);
        const W = doc.defaultView || window;
        if (!observer) observer = new W.MutationObserver(records => {
            if (!on) return;
            for (const r of records) {
                if (r.type === 'characterData') doText(r.target);
                else if (r.type === 'attributes') doAttrs(r.target);
                else r.addedNodes.forEach(walk);
            }
        });
        observer.observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    }
    function stop() { if (!on) return; on = false; if (observer) observer.disconnect(); restore(); }
    return { start, stop };
}

const main = createTranslator(document, () => [document.body, document.getElementById('nv-layer')]);

// 同源旧页面（目前只有首页 home.html，它自己没有接 i18n）：iframe 每次 load 都重新挂一个翻译器
export function translateFrame(iframe) {
    if (!iframe || iframe.__nvTr) return;
    iframe.__nvTr = true;
    let tr = null;
    const sync = () => { if (!tr) return; if (state.lang === 'en') tr.start(); else tr.stop(); };
    const hook = () => {
        let doc = null;
        try { doc = iframe.contentDocument; } catch (e) { doc = null; }
        if (tr) tr.stop();
        tr = doc && doc.body ? createTranslator(doc, () => [doc.body]) : null;
        if (doc) { doc.documentElement.setAttribute('lang', state.lang === 'en' ? 'en' : 'zh-CN'); }
        sync();
    };
    iframe.addEventListener('load', hook);
    hook();
    watch(() => state.lang, sync);
}

export function initAutoTranslate() {
    const apply = lang => (lang === 'en' ? main.start() : main.stop());
    watch(() => state.lang, apply);
    if (state.lang === 'en') setTimeout(() => apply('en'), 0);
}
