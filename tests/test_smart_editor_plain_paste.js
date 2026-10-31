#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../static/js/smart-canvas.js'), 'utf8');
const start = source.indexOf('function pastePlainTextIntoSmartEditor(');
const end = source.indexOf('\n}', start);
if(start < 0 || end < 0) throw new Error('找不到 pastePlainTextIntoSmartEditor');
const fn = source.slice(start, end + 2);
let pass = 0;
const failures = [];
function ok(condition, label){ if(condition) pass += 1; else failures.push(label); }

function run(target, text){
    const calls = [];
    const editor = target.editor || {
        focus(){},
        dispatchEvent(event){ calls.push(['input', event.type, event.bubbles]); }
    };
    if(target.editor) target.editor.dispatchEvent = event => calls.push(['input', event.type, event.bubbles]);
    const event = {
        target,
        clipboardData:{getData(){ return text; }},
        preventDefault(){ calls.push(['preventDefault']); }
    };
    const documentMock = {
        execCommand(command, showUi, value){ calls.push([command, value]); return true; }
    };
    const windowMock = {};
    class EventMock { constructor(type, options){ this.type = type; this.bubbles = options.bubbles; } }
    const paste = new Function('document', 'window', 'Event', fn + '\nreturn pastePlainTextIntoSmartEditor;')(documentMock, windowMock, EventMock);
    const handled = paste(event);
    return {handled, calls, editor};
}

const richText = '普通文字，保持默认样式';
const editorTarget = {closest(selector){ return selector === '[contenteditable="true"]' ? this.editor : null; }, editor:null};
editorTarget.editor = {focus(){}, dispatchEvent(){}, closest(){ return null; }};
const result = run(editorTarget, richText);
ok(result.handled, '可编辑区域拦截粘贴');
ok(result.calls.some(call => call[0] === 'insertText' && call[1] === richText), '只插入 text/plain，不插入 HTML');
ok(result.calls.some(call => call[0] === 'input' && call[2] === true), '粘贴后触发 input 保存事件');
ok(result.calls.some(call => call[0] === 'preventDefault'), '阻止浏览器默认富文本粘贴');

const nonEditor = run({closest(){ return null; }}, richText);
ok(!nonEditor.handled, '非编辑区域不影响素材和文件粘贴');
const empty = run(editorTarget, '');
ok(!empty.handled, '空文本不拦截其他粘贴分支');

console.log('编辑器纯文本粘贴：' + pass + ' 项通过');
if(failures.length){
    failures.forEach(label => console.error('  x ' + label));
    process.exit(1);
}
