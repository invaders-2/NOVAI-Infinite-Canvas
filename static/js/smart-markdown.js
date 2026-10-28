/* 智能画布的 Markdown 渲染器：离线、零依赖、必须安全。

   「先转义、再转换」是这份实现唯一的顺序：
   1. 进来第一步把**整段输入**按 HTML 实体转义（& < > " '），此后字符串里不再存在任何标签；
   2. 再在转义后的文本上识别 Markdown 语法，换成**本文件自己写死**的一小撮标签
      （h1~h6 / p / ul / ol / li / strong / em / del / code / pre / blockquote / table / hr / br）。
   输出里的标签全部来自这里，用户文本一律以转义后的实体形式留在标签之间 ——
   没有「把未转义内容塞进 innerHTML」的路径，所以 <script> / onerror / javascript: 只能变成文字。

   注意：转义之后引用符号 > 变成 &gt;、小于号变成 &lt;，所以块级规则认的是转义后的写法。

   暴露：window.SmartMarkdown.render(text) -> string（node 下同时走 module.exports）。 */
(function(root){
    'use strict';

    const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const CODE_SLOT = '\u0000C';
    const PIPE_SLOT = '\u0000P';

    const FENCE = /^\s{0,3}(```+|~~~+)[ \t]*([A-Za-z0-9_+#.-]*)[ \t]*$/;
    const HEADING = /^\s{0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
    const HR = /^\s{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
    /* 转义后引用符号是 &gt; */
    const QUOTE = /^\s{0,3}&gt;[ \t]?/;
    const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;

    function escapeHtml(text){
        return String(text == null ? '' : text).replace(/[&<>"']/g, ch => ESCAPE_MAP[ch]);
    }

    /* ── 行内 ───────────────────────────────────────────────
       只在**同一行**内做：行内代码先摘出来占位，避免它的内容被后面的粗体/斜体规则二次改写。 */
    function renderInline(text){
        const codes = [];
        let out = String(text == null ? '' : text);
        out = out.replace(/(`+)([^`]+?)\1/g, (match, ticks, code) => {
            codes.push(code);
            return CODE_SLOT + (codes.length - 1) + '\u0000';
        });
        out = out.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
        out = out.replace(/(^|[^\w])__(?=\S)([^_]+?\S)__(?=$|[^\w])/g, '$1<strong>$2</strong>');
        out = out.replace(/(^|[^\w*])\*(?!\s)([^*]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>');
        out = out.replace(/(^|[^\w])_(?!\s)([^_]*?[^\s_])_(?=$|[^\w])/g, '$1<em>$2</em>');
        out = out.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
        out = out.replace(new RegExp(CODE_SLOT + '(\\d+)\u0000', 'g'), (match, index) => (
            '<code class="md-code-inline">' + codes[Number(index)] + '</code>'
        ));
        return out;
    }
    function renderInlineLines(text){
        return String(text == null ? '' : text).split('\n').map(renderInline).join('<br>');
    }

    /* ── 表格 ─────────────────────────────────────────────── */
    function splitTableRow(line){
        const masked = String(line).replace(/\\\|/g, PIPE_SLOT);
        const body = masked.trim().replace(/^\|/, '').replace(/\|$/, '');
        return body.split('|').map(cell => cell.trim().split(PIPE_SLOT).join('|'));
    }
    function tableAlign(cell){
        const value = String(cell || '').trim();
        const left = value.startsWith(':');
        const right = value.endsWith(':');
        if(left && right) return 'center';
        if(right) return 'right';
        if(left) return 'left';
        return '';
    }
    function tableDelimiterAt(lines, index){
        if(index + 1 >= lines.length) return null;
        if(lines[index].indexOf('|') < 0) return null;
        const cells = splitTableRow(lines[index + 1]);
        if(!cells.length) return null;
        if(!cells.every(cell => /^:?-{1,}:?$/.test(String(cell).trim()))) return null;
        return cells.map(tableAlign);
    }
    function renderTable(headCells, aligns, bodyRows){
        const cellHtml = (tag, text, index) => {
            const align = aligns[index] || '';
            return '<' + tag + (align ? ' class="md-align-' + align + '"' : '') + '>' + renderInline(text) + '</' + tag + '>';
        };
        let html = '<table class="md-table"><thead><tr>';
        html += headCells.map((cell, index) => cellHtml('th', cell, index)).join('');
        html += '</tr></thead>';
        if(bodyRows.length){
            html += '<tbody>';
            bodyRows.forEach(row => {
                html += '<tr>' + headCells.map((cell, index) => cellHtml('td', row[index] == null ? '' : row[index], index)).join('') + '</tr>';
            });
            html += '</tbody>';
        }
        return html + '</table>';
    }

    /* ── 列表 ─────────────────────────────────────────────── */
    function buildListTree(items){
        const root = { indent: -1, children: [] };
        const stack = [root];
        items.forEach(item => {
            while(stack.length > 1 && stack[stack.length - 1].indent >= item.indent) stack.pop();
            const node = { indent: item.indent, ordered: item.ordered, text: item.text, children: [] };
            stack[stack.length - 1].children.push(node);
            stack.push(node);
        });
        return root.children;
    }
    function renderListNodes(nodes){
        let html = '';
        let index = 0;
        while(index < nodes.length){
            const tag = nodes[index].ordered ? 'ol' : 'ul';
            html += '<' + tag + ' class="md-list">';
            while(index < nodes.length && (nodes[index].ordered ? 'ol' : 'ul') === tag){
                const node = nodes[index];
                html += '<li>' + renderInlineLines(node.text);
                if(node.children.length) html += renderListNodes(node.children);
                html += '</li>';
                index += 1;
            }
            html += '</' + tag + '>';
        }
        return html;
    }

    /* ── 块级 ─────────────────────────────────────────────── */
    function isFenceClose(line, tick){
        const trimmed = String(line == null ? '' : line).trim();
        if(trimmed.length < tick.length) return false;
        for(let i = 0; i < trimmed.length; i += 1){
            if(trimmed.charAt(i) !== tick.charAt(0)) return false;
        }
        return true;
    }
    function isBlockStart(line, lines, index){
        return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line)
            || LIST_ITEM.test(line) || Boolean(tableDelimiterAt(lines, index));
    }

    function parseList(lines, start){
        const items = [];
        let index = start;
        let current = null;
        while(index < lines.length){
            const line = lines[index];
            if(!line.trim()){
                let next = index + 1;
                while(next < lines.length && !lines[next].trim()) next += 1;
                if(next < lines.length && LIST_ITEM.test(lines[next])){ index = next; continue; }
                break;
            }
            const match = LIST_ITEM.exec(line);
            if(match){
                current = {
                    indent: match[1].replace(/\t/g, '    ').length,
                    ordered: /\d/.test(match[2]),
                    text: match[3]
                };
                items.push(current);
                index += 1;
                continue;
            }
            /* 同一条目的续行：并进上一条，用 <br> 换行 */
            if(current && !isBlockStart(line, lines, index)){
                current.text += '\n' + line.trim();
                index += 1;
                continue;
            }
            break;
        }
        return { html: renderListNodes(buildListTree(items)), next: index };
    }

    /* 入参必须是**已转义**的文本：公开的 render 负责转义，递归（引用内部）不再转一次。 */
    function renderBlocks(escaped){
        const lines = String(escaped == null ? '' : escaped).split('\n');
        const out = [];
        let index = 0;
        while(index < lines.length){
            const line = lines[index];
            if(!line.trim()){ index += 1; continue; }

            const fence = FENCE.exec(line);
            if(fence){
                const tick = fence[1].slice(0, 3);
                const lang = String(fence[2] || '').toLowerCase().replace(/[^a-z0-9_+#.-]/g, '');
                const body = [];
                index += 1;
                while(index < lines.length && !isFenceClose(lines[index], tick)){
                    body.push(lines[index]);
                    index += 1;
                }
                if(index < lines.length) index += 1;
                out.push('<pre class="md-pre"><code class="md-code' + (lang ? ' md-lang-' + lang : '') + '">'
                    + body.join('\n') + '</code></pre>');
                continue;
            }

            const heading = HEADING.exec(line);
            if(heading){
                const level = heading[1].length;
                const text = String(heading[2] || '').replace(/[ \t]+#+[ \t]*$/, '');
                out.push('<h' + level + '>' + renderInline(text) + '</h' + level + '>');
                index += 1;
                continue;
            }

            if(HR.test(line)){
                out.push('<hr class="md-hr">');
                index += 1;
                continue;
            }

            if(QUOTE.test(line)){
                const inner = [];
                while(index < lines.length && QUOTE.test(lines[index])){
                    inner.push(lines[index].replace(QUOTE, ''));
                    index += 1;
                }
                out.push('<blockquote class="md-quote">' + renderBlocks(inner.join('\n')) + '</blockquote>');
                continue;
            }

            const aligns = tableDelimiterAt(lines, index);
            if(aligns){
                const headCells = splitTableRow(line);
                const rows = [];
                index += 2;
                while(index < lines.length && lines[index].trim() && lines[index].indexOf('|') >= 0){
                    rows.push(splitTableRow(lines[index]));
                    index += 1;
                }
                out.push(renderTable(headCells, aligns, rows));
                continue;
            }

            if(LIST_ITEM.test(line)){
                const list = parseList(lines, index);
                out.push(list.html);
                index = list.next;
                continue;
            }

            const paragraph = [];
            while(index < lines.length && lines[index].trim() && !isBlockStart(lines[index], lines, index)){
                paragraph.push(lines[index]);
                index += 1;
            }
            out.push('<p class="md-p">' + paragraph.map(renderInline).join('<br>') + '</p>');
        }
        return out.join('');
    }

    function render(markdown){
        const escaped = escapeHtml(String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n'));
        if(!escaped.trim()) return '';
        return renderBlocks(escaped);
    }

    const api = { render: render, escapeHtml: escapeHtml, renderInline: renderInline };
    root.SmartMarkdown = api;
    if(typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
