// 轻量 Markdown → HTML（替换旧 V11 装饰层的 md()）。
// 旧版是一串正则：不支持表格、有序列表不包 <ol>、引用逐行拆开。这里改成逐行的块级解析：
//   围栏代码块（带语言名 + 复制按钮）、标题 h1–h6、分隔线、引用（多行合并、可嵌套）、
//   无序 / 有序列表（按缩进嵌套）、GFM 表格（对齐 :--- / :---: / ---:）、段落（单换行保留为 <br>）；
//   行内：`code`、**粗体**、*斜体*、~~删除线~~、[链接](http…)。
// 所有文本先转义再加标签，模型输出里的 HTML 不会被执行。流式输出时未闭合的代码块按已收到的部分渲染。
import { ICONS } from '../../lib/icons.js';

export function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const COPY_SVG = `<svg class="nv-i" viewBox="0 0 24 24" aria-hidden="true">${ICONS.copy}</svg>`;

/* ───────── 行内 ───────── */
function inline(text) {
    const codes = [];
    let h = esc(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    h = h.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
    h = h.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return h.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + codes[Number(i)] + '</code>');
}

/* ───────── 表格 ───────── */
const SEP_CELL = /^\s*:?-{1,}:?\s*$/;
function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let cur = '', inCode = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
        if (ch === '`') inCode = !inCode;
        if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    cells.push(cur.trim());
    return cells;
}
function isSepRow(line) {
    if (!line || !line.includes('-')) return false;
    const cells = splitRow(line);
    return cells.length > 0 && cells.every(c => SEP_CELL.test(c)) && (line.includes('|') || cells.length > 1);
}
function isTableStart(lines, i) {
    return lines[i].includes('|') && i + 1 < lines.length && isSepRow(lines[i + 1]) && splitRow(lines[i]).length >= 1;
}
function renderTable(lines) {
    const head = splitRow(lines[0]);
    const aligns = splitRow(lines[1]).map(c => {
        const t = c.trim();
        if (t.startsWith(':') && t.endsWith(':')) return 'center';
        if (t.endsWith(':')) return 'right';
        if (t.startsWith(':')) return 'left';
        return '';
    });
    const cell = (tag, txt, i) => `<${tag}${aligns[i] ? ` style="text-align:${aligns[i]}"` : ''}>${inline(txt || '')}</${tag}>`;
    const rows = lines.slice(2).map(l => {
        const cells = splitRow(l);
        return '<tr>' + head.map((_, i) => cell('td', cells[i], i)).join('') + '</tr>';
    });
    return '<div class="md-table"><table><thead><tr>' + head.map((h, i) => cell('th', h, i)).join('') + '</tr></thead>'
        + (rows.length ? '<tbody>' + rows.join('') + '</tbody>' : '') + '</table></div>';
}

/* ───────── 列表 ───────── */
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
function indentOf(line) { const m = line.match(/^\s*/)[0]; return m.replace(/\t/g, '    ').length; }
function renderList(lines) {
    const first = lines[0].match(LIST_RE);
    const base = indentOf(lines[0]);
    const ordered = /\d/.test(first[2]);
    const start = ordered ? parseInt(first[2], 10) : 1;
    const items = [];
    for (const line of lines) {
        const m = line.match(LIST_RE);
        if (m && indentOf(line) <= base) items.push([m[3]]);
        else if (items.length) items[items.length - 1].push(line);
    }
    const body = items.map(([head, ...rest]) => {
        const sub = rest.filter(l => l.trim());
        if (!sub.length) return '<li>' + inline(head) + '</li>';
        const pad = Math.min(...sub.map(indentOf));
        return '<li>' + inline(head) + blocks(rest.map(l => l.replace(/\t/g, '    ').slice(Math.min(pad, indentOf(l))))) + '</li>';
    }).join('');
    return ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${body}</ol>` : `<ul>${body}</ul>`;
}

/* ───────── 块级 ───────── */
function codeBlock(lang, code) {
    return `<div class="md-pre"><div class="md-pre-h"><span>${esc(lang || 'code')}</span>`
        + `<button type="button" class="md-copy" data-md-copy title="复制代码" aria-label="复制代码">${COPY_SVG}</button></div>`
        + `<pre><code>${esc(code)}</code></pre></div>`;
}

function blocks(lines) {
    const out = [];
    let para = [];
    const flush = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fence = line.match(/^\s*(```+|~~~+)\s*([^\s`]*)/);
        if (fence) {
            flush();
            const mark = fence[1];
            const buf = [];
            i++;
            while (i < lines.length && !lines[i].trim().startsWith(mark)) buf.push(lines[i++]);
            out.push(codeBlock(fence[2], buf.join('\n')));
            continue;
        }
        if (!line.trim()) { flush(); continue; }
        const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
        if (h) { flush(); const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }
        if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
        if (isTableStart(lines, i)) {
            flush();
            const buf = [lines[i], lines[i + 1]];
            i += 2;
            while (i < lines.length && lines[i].trim() && lines[i].includes('|')) buf.push(lines[i++]);
            i--;
            out.push(renderTable(buf));
            continue;
        }
        if (/^\s{0,3}>/.test(line)) {
            flush();
            const buf = [];
            while (i < lines.length && /^\s{0,3}>/.test(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
            i--;
            out.push('<blockquote>' + blocks(buf) + '</blockquote>');
            continue;
        }
        if (LIST_RE.test(line) && (!para.length || indentOf(line) < 4)) {
            flush();
            const base = indentOf(line);
            const ordered = /\d/.test(line.match(LIST_RE)[2]);
            const buf = [line];
            i++;
            while (i < lines.length) {
                const l = lines[i];
                if (!l.trim()) {
                    // 空行后仍是列表项 / 缩进内容就继续，否则结束
                    const next = lines[i + 1];
                    if (next && (LIST_RE.test(next) && indentOf(next) >= base || indentOf(next) > base)) { buf.push(l); i++; continue; }
                    break;
                }
                const lm = l.match(LIST_RE);
                if (lm && indentOf(l) <= base && /\d/.test(lm[2]) !== ordered) break;   // 有序 / 无序切换 = 新列表
                if (lm && indentOf(l) >= base) { buf.push(l); i++; continue; }
                if (indentOf(l) > base) { buf.push(l); i++; continue; }
                break;
            }
            i--;
            out.push(renderList(buf));
            continue;
        }
        para.push(line.trim());
    }
    flush();
    return out.join('');
}

export function md(src) {
    if (!src) return '';
    return blocks(String(src).replace(/\r\n?/g, '\n').split('\n'));
}
