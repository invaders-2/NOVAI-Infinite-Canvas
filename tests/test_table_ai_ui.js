#!/usr/bin/env node
// 多维表格「智能」界面层：选区矩形 / 工具条显隐与禁用 / 预览不改数据 / 应用与撤销 /
// AI 列分批与停止 / 批量生成期间隔离 / host 缺 callLLM 时禁用。
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0; const fails = [];
const ok = (c, m) => { c ? pass++ : fails.push(m); };
const show = v => { try { return JSON.stringify(v); } catch(e){ return String(v); } };
const eq = (a, b, m) => { show(a) === show(b) ? pass++ : fails.push(m + ' 期望' + show(b) + ' 实际' + show(a)); };

// ── 极简 DOM 垫片（结构照 test_table_node_dom.js）──
function makeEl(tag){
    const el = {
        tagName: String(tag).toUpperCase(), children: [], className: '', _text: '', innerHTML: '',
        style: {}, dataset: {}, parentElement: null, _listeners: {},
        appendChild(child){ child.parentElement = el; child.parentNode = el; el.children.push(child); return child; },
        addEventListener(type, fn){ (el._listeners[type] = el._listeners[type] || []).push(fn); },
        querySelector(){ return null; },
        getBoundingClientRect(){ return el._rect || {left:0, top:0, right:0, bottom:0, width:0, height:0}; },
        contains(){ return false; },
        closest(){ return null; },
        focus(){ el._focused = true; },
        select(){},
        get textContent(){ return el.children.length ? el.children.map(c => c.textContent).join('') : el._text; },
        set textContent(v){ el.children.length = 0; el._text = String(v === null || v === undefined ? '' : v); },
    };
    el.classList = {
        add(...cs){ const s = new Set(el.className.split(/\s+/).filter(Boolean)); cs.forEach(c => s.add(c)); el.className = [...s].join(' '); },
        remove(...cs){ const s = new Set(el.className.split(/\s+/).filter(Boolean)); cs.forEach(c => s.delete(c)); el.className = [...s].join(' '); },
        contains(c){ return el.className.split(/\s+/).includes(c); },
        toggle(c, force){
            const on = force === undefined ? !el.classList.contains(c) : Boolean(force);
            on ? el.classList.add(c) : el.classList.remove(c);
            return on;
        },
    };
    return el;
}
const all = el => { const out = []; const rec = e => { if(!e) return; out.push(e); (e.children || []).forEach(rec); }; rec(el); return out; };
const byClass = (el, c) => all(el).filter(e => e.classList.contains(c));
const byTag = (el, t) => all(el).filter(e => e.tagName === t.toUpperCase());
const one = (el, c) => byClass(el, c)[0];

const docBody = makeEl('body');
global.document = {
    body: docBody,
    documentElement: docBody,
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: makeEl,
    querySelector: () => null,
    createTextNode: text => ({
        nodeType: 3, textContent: String(text), children: [], parentNode: null,
        classList: {contains: () => false, add(){}, remove(){}, toggle(){ return false; }},
    }),
};
global.window = {innerWidth: 1600, innerHeight: 1000};
global.requestAnimationFrame = fn => fn();
const model = require('../static/js/shared/table-model.js');
global.NovaTableModel = model;
global.NovaNodeRegistry = require('../static/js/shared/node-registry.js');

// ── 从 table-node.js 抽出表格节点代码求值 ──
const tableSrc = fs.readFileSync(path.join(__dirname, '../static/js/shared/table-node.js'), 'utf8');
const start = tableSrc.indexOf('function novaTableModel(){');
const end = tableSrc.lastIndexOf(String.fromCharCode(10) + '        return {');
ok(start > 0 && end > start, '能定位表格节点代码段');
const block = tableSrc.slice(start, end);

const ARG_NAMES = ['document', 'requestAnimationFrame', 'defaultPoint', 'addNode', 'scheduleSave', 'uid',
    'connections', 'nodes', 'pushUndo', 'mediaKindForNode', 'isMissingAssetUrl', 'canvasPreviewImgHtml',
    'canvasVideoPreviewHtml', 'nowMs', 'tr', 'nodesEl', 'runVideoNode', 'runGenerator', 'window',
    'saveCanvas', 'refreshIcons', 'outputUrlValue', 'mediaKindForRef', 'generationStopRequested',
    'callLLM', 'showErrorModal'];
const EXPORTS = ['tableAiBatchBusy', 'tableAiChannel', 'tableAiApplySelection', 'tableAiPointerDown',
    'tableAiPointerMove', 'tableAiPointerUp', 'tableAiGlobalKeydown', 'tableAiGlobalMouseDown',
    'tableAiOpenPreview', 'tableAiApplyChanges', 'tableAiUndoLast', 'tableAiUndoNode', 'tableAiHasUndo', 'tableAiRunColumn',
    'tableAiColumnState', 'tableAiColumnIsRunning', 'tableAiSetInstruction', 'tableAiStopColumn',
    'openTableAiColumnPanel', 'tableAiCloseOverlay', 'tableAiSyncToolbar',
    'renderTableBody', 'addTableNode', 'ensureTableState', 'repaintTable', 'tableNodeSignature'];

function makeEnv(options = {}){
    const nodes = [];
    const connections = [];
    const errors = [];
    let saveCount = 0;
    let uidSeq = 0;
    const values = {
        document: global.document,
        requestAnimationFrame: global.requestAnimationFrame,
        defaultPoint: () => ({x:0, y:0}),
        addNode: n => { nodes.push(n); return n; },
        scheduleSave: () => { saveCount += 1; },
        uid: p => String(p) + '_' + (uidSeq += 1),
        connections, nodes,
        pushUndo(){},
        mediaKindForNode: () => 'image',
        isMissingAssetUrl: () => false,
        canvasPreviewImgHtml: url => '<img src="' + url + '">',
        canvasVideoPreviewHtml: url => '<video src="' + url + '"></video>',
        nowMs: () => 1700000000000,
        tr: key => key,
        nodesEl: {querySelector(){ return null; }},
        runVideoNode(){},
        runGenerator(){},
        window: global.window,
        saveCanvas(){},
        refreshIcons(){},
        outputUrlValue: item => (typeof item === 'string' ? item : (item && item.url) || ''),
        mediaKindForRef: () => 'image',
        generationStopRequested: options.generationStopRequested || (() => false),
        callLLM: options.callLLM,
        showErrorModal: (message, title) => errors.push({message, title}),
    };
    const factory = new Function(ARG_NAMES.join(','), block + '\nreturn {' + EXPORTS.join(', ') + '};');
    const api = factory.apply(null, ARG_NAMES.map(name => values[name]));
    return {api, nodes, connections, errors, saves: () => saveCount};
}

function addTable(env, columns, rows){
    const node = env.api.addTableNode();
    node.table = {columns, rows};
    return node;
}
const dataCells = root => all(root).filter(e => e.tagName === 'TD'
    && e.dataset && e.dataset.row !== undefined && e.dataset.col !== undefined);
const cellAt = (root, row, col) => dataCells(root)
    .filter(e => e.dataset.row === String(row) && e.dataset.col === String(col))[0];
const aiHeaderButtons = root => byClass(root, 'table-ai-col-btn');

async function waitIdle(api, node){
    for(let i = 0; i < 300 && api.tableAiColumnIsRunning(node); i += 1){
        await new Promise(resolve => setTimeout(resolve, 1));
    }
}

(async function main(){
    // ═══ [1] 选区：拖选矩形 / Shift 扩选 / 点外面清空 / Esc 清空 ═══
    {
        const env = makeEnv({callLLM: async () => JSON.stringify({values: []})});
        const api = env.api;
        const node = addTable(env, ['场景', '卖点'], [['海边', '轻'], ['城市', '重'], ['山野', '硬']]);
        const root = api.renderTableBody(node);
        const toolbar = one(root, 'table-ai-toolbar');
        ok(Boolean(toolbar), '表格里建好了选区工具条');
        ok(!toolbar.classList.contains('is-open'), '没有选区 → 工具条不浮出');
        ok((root._listeners.mousedown || []).length >= 2, 'root 上挂了选区的 mousedown（与原有的 stopPropagation 并存）');
        eq(dataCells(root).length, 6, '数据格都带 data-row / data-col（3 行 × 2 列）');
        eq(byClass(one(root, 'table-input-head'), 'table-ai-col-btn').length, 0, '输入通道列不参与选区，也没有 AI 列按钮');
        eq(byClass(root, 'table-ai-toolbar-input').length, 1, '工具条里有一个输入框');

        const c00 = cellAt(root, 0, 0);
        const c21 = cellAt(root, 2, 1);
        const press = target => (root._listeners.mousedown || []).slice(-1)[0]({
            button: 0, target, preventDefault(){}, stopPropagation(){}, shiftKey: false,
        });
        press(c00);
        eq(node.table.selection, {r0:0, c0:0, r1:0, c1:0}, '按下第一格 → 单格选区');
        ok(toolbar.classList.contains('is-open'), '有选区 → 工具条浮出');
        eq(one(root, 'table-ai-toolbar-title').textContent, '1 格 · AI 批量改', '工具条显示选区格数');

        api.tableAiPointerMove(node, {target: c21});
        eq(node.table.selection, {r0:0, c0:0, r1:2, c1:1}, '拖动扩成矩形（左下 / 右上都归一）');
        eq(one(root, 'table-ai-toolbar-title').textContent, '6 格 · AI 批量改', '矩形格数 = 3 行 × 2 列');
        ok(c00.classList.contains('is-selected') && c21.classList.contains('is-selected'), '选中格加 .is-selected');
        ok(cellAt(root, 1, 1).classList.contains('is-selected'), '矩形内的格子都标记');
        eq(all(root).filter(e => e.tagName === 'TD' && e.classList.contains('is-selected')).length, 6,
            '选中标记只在选区内的 6 个数据格上');
        const dataHeads = byClass(root, 'table-head-cell').filter(th => th.classList.contains('has-ai'));
        eq(dataHeads.length, 2, '两个数据列表头都有 AI 按钮');
        ok(dataHeads[0].classList.contains('is-selected-column')
            && dataHeads[1].classList.contains('is-selected-column'), '表头对应列有轻底呼应');
        api.tableAiPointerUp(node, {target: c21});
        eq(node._tableAiDrag, null, '松手落定，拖拽状态清空');
        eq(node.table.selection, {r0:0, c0:0, r1:2, c1:1}, '松手后选区保留');

        api.tableAiPointerDown(node, {button: 0, target: c00, preventDefault(){}, shiftKey: false});
        api.tableAiPointerUp(node, {target: c00});
        api.tableAiPointerDown(node, {button: 0, target: cellAt(root, 1, 1), preventDefault(){}, shiftKey: true});
        eq(node.table.selection, {r0:0, c0:0, r1:1, c1:1}, 'Shift+点击从锚点扩选');
        ok(cellAt(root, 1, 1).classList.contains('is-selected'), '扩选到的格子有标记');

        api.tableAiGlobalMouseDown({target: docBody});
        eq(node.table.selection, undefined, '点表格外 → 选区清空');
        ok(!toolbar.classList.contains('is-open'), '清空后工具条收起');

        press(c00);
        ok(Boolean(node.table.selection), '重新选中');
        api.tableAiGlobalKeydown({key: 'Escape', target: docBody, preventDefault(){}, stopPropagation(){}});
        eq(node.table.selection, undefined, 'Esc 清空选区');
        ok(!c00.classList.contains('is-selected'), 'Esc 后 .is-selected 一起清掉');
        api.tableAiCloseOverlay(node);
    }

    // ═══ [2] 工具条：输入为空 / 只有空格时禁用 ═══
    {
        const env = makeEnv({callLLM: async () => '{}'});
        const api = env.api;
        const node = addTable(env, ['场景'], [['海边'], ['城市']]);
        const root = api.renderTableBody(node);
        const toolbar = one(root, 'table-ai-toolbar');
        const runBtn = one(toolbar, 'table-ai-primary');
        const input = one(toolbar, 'table-ai-toolbar-input');
        ok(runBtn.disabled, '没有输入 → 生成预览禁用');
        api.tableAiPointerDown(node, {button: 0, target: cellAt(root, 0, 0), preventDefault(){}});
        api.tableAiPointerUp(node, {target: cellAt(root, 0, 0)});
        ok(runBtn.disabled, '有选区但输入为空 → 仍然禁用');
        input.value = '   ';
        input.oninput();
        ok(runBtn.disabled, '只有空格 → 禁用');
        input.value = '改写成英文';
        input.oninput();
        ok(!runBtn.disabled, '输入有效 → 生成预览可用');
        input.value = ' ';
        input.oninput();
        ok(runBtn.disabled, '清回空 → 重新禁用');
        api.tableAiCloseOverlay(node);
    }

    // ═══ [3] 预览不改数据 → 应用一次 set_cells → 撤销还原 ═══
    {
        const prompts = [];
        const env = makeEnv({callLLM: async (nodeArg, message, options) => {
            prompts.push({nodeArg, message, options});
            return JSON.stringify({values: [
                {row: 1, col: 1, value: '海边｜AI'},
                {row: 2, col: 1, value: '城市｜AI'},
            ]});
        }});
        const api = env.api;
        const node = addTable(env, ['场景', '卖点'], [['海边', '轻'], ['城市', '重'], ['山野', '硬']]);
        api.renderTableBody(node);
        const root = node._tableEl;
        api.tableAiPointerDown(node, {button: 0, target: cellAt(root, 0, 0), preventDefault(){}});
        api.tableAiPointerMove(node, {target: cellAt(root, 1, 0)});
        api.tableAiPointerUp(node, {target: cellAt(root, 1, 0)});
        eq(node.table.selection, {r0:0, c0:0, r1:1, c1:0}, '拖选 2 行 × 1 列');

        const input = one(one(root, 'table-ai-toolbar'), 'table-ai-toolbar-input');
        input.value = '改写成 20 字电商口语';
        input.oninput();
        node.llmProvider = 'demo-provider';
        node.model = 'demo-model';
        node.systemPrompt = 'DEMO-SYS';
        const before = JSON.stringify(node.table);
        ok(await api.tableAiOpenPreview(node), '生成预览成功');
        eq(JSON.stringify(node.table), before, '预览期间表格数据一字未改');
        eq(prompts.length, 1, '一次 LLM 调用即够');
        eq(prompts[0].nodeArg, node, 'host 收到的第一个参数是表格节点本身（不是空对象）');
        eq([prompts[0].nodeArg.llmProvider, prompts[0].nodeArg.model, prompts[0].nodeArg.systemPrompt],
            ['demo-provider', 'demo-model', 'DEMO-SYS'], '节点上的 provider / model / systemPrompt 都能被 host 读到');
        ok(String(prompts[0].message).indexOf('第 1 行') > 0
            && String(prompts[0].message).indexOf('第 2 行') > 0, '提示词带上选区行号');
        eq(prompts[0].options.maxTokens, model.AI_COLUMN_MAX_TOKENS, 'LLM 调用带 AI_COLUMN_MAX_TOKENS');

        const overlay = one(docBody, 'table-ai-overlay');
        ok(Boolean(overlay), '预览弹层挂在 body 上');
        eq(byClass(overlay, 'table-ai-diff-row').length, 2, '逐格差异 2 行');
        const diffBefore = byClass(overlay, 'table-ai-diff-before').filter(e => e.tagName === 'DIV');
        const diffAfter = byClass(overlay, 'table-ai-diff-after').filter(e => e.tagName === 'DIV');
        eq(diffBefore.map(e => e.textContent), ['海边', '城市'], '左列是原文');
        eq(diffAfter.map(e => e.textContent), ['海边｜AI', '城市｜AI'], '右列是改动后');
        eq(one(overlay, 'table-ai-diff-count').textContent.indexOf('共 2 处变更'), 0, '底部显示「共 2 处变更」');
        ok(byClass(overlay, 'table-ai-diff-check').every(check => check.checked !== false), '每行默认勾选（默认全选）');
        ok(!one(overlay, 'table-ai-ghost').disabled, '取消按钮可用');

        const applyCalls = [];
        const realApply = model.applyOperation;
        model.applyOperation = function(table, op, args){ applyCalls.push({op, args}); return realApply.apply(model, [table, op, args]); };
        try { one(overlay, 'table-ai-primary').onclick(); } finally { model.applyOperation = realApply; }
        eq(applyCalls.filter(item => item.op === 'set_cells').length, 1, '应用只调用一次 applyOperation(set_cells)');
        eq(applyCalls[0].args.cells.length, 2, '一次写入两格');
        eq(node.table.rows[0][0], '海边｜AI', '应用后第 1 行生效');
        eq(node.table.rows[1][0], '城市｜AI', '应用后第 2 行生效');
        eq(node.table.rows[2][0], '山野', '选区外的行没动');
        ok(!one(docBody, 'table-ai-overlay'), '应用后弹层关闭');

        const notice = one(root, 'table-ai-notice');
        ok(notice.classList.contains('is-open'), '应用成功后提示条浮出');
        ok(Boolean(one(notice, 'table-ai-notice-undo')), '提示条上有【撤销】按钮');
        ok(String(one(notice, 'table-ai-notice-text').textContent).indexOf('已应用 2 处改动') === 0, '提示条写明应用了几处');

        ok(api.tableAiUndoLast(), '撤销成功');
        eq(node.table.rows[0][0], '海边', '撤销还原第 1 行');
        eq(node.table.rows[1][0], '城市', '撤销还原第 2 行');
        ok(!api.tableAiUndoLast(), '撤销只用一次（快照已消费，不抢画布原有撤销）');
        eq(one(root, 'table-ai-notice-text').textContent, '已撤销 AI 改动', '撤销后提示条文案');
        api.tableAiCloseOverlay(node);
    }

    // ═══ [4] 每行可单独取消：取消的格子不写入 ═══
    {
        const env = makeEnv({callLLM: async () => JSON.stringify({values: [
            {row: 1, col: 1, value: 'A1'},
            {row: 1, col: 2, value: 'B1'},
        ]})});
        const api = env.api;
        const node = addTable(env, ['甲', '乙'], [['a', 'b'], ['c', 'd']]);
        api.renderTableBody(node);
        const root = node._tableEl;
        api.tableAiPointerDown(node, {button: 0, target: cellAt(root, 0, 0), preventDefault(){}});
        api.tableAiPointerMove(node, {target: cellAt(root, 0, 1)});
        api.tableAiPointerUp(node, {target: cellAt(root, 0, 1)});
        const input = one(one(root, 'table-ai-toolbar'), 'table-ai-toolbar-input');
        input.value = '改一遍';
        input.oninput();
        ok(await api.tableAiOpenPreview(node), '预览打开');
        const overlay = one(docBody, 'table-ai-overlay');
        const rows = byClass(overlay, 'table-ai-diff-row');
        eq(rows.length, 2, '两处差异');
        const check2 = one(rows[1], 'table-ai-diff-check');
        check2.checked = false;
        check2.onchange();
        ok(rows[1].classList.contains('is-off'), '取消的行淡出');
        ok(one(overlay, 'table-ai-diff-count').textContent.indexOf('已选 1 处') > 0, '底部显示已选数量');
        one(overlay, 'table-ai-primary').onclick();
        eq(node.table.rows[0][0], 'A1', '勾选的格子写入');
        eq(node.table.rows[0][1], 'b', '取消勾选的格子不动');
        api.tableAiCloseOverlay(node);
    }

    // ═══ [5] AI 列：按 planAiColumn 分批 + 进度 + 停止 ═══
    {
        const calls = [];
        let stopTarget = null;
        let stopOnFirst = false;
        const env = makeEnv({callLLM: async (nodeArg, message, options) => {
            calls.push({nodeArg, message, options});
            if(stopOnFirst && calls.length === 1 && stopTarget) env.api.tableAiStopColumn(stopTarget);
            const rows = (message.match(/^第 \d+ 行$/gm) || []).map(line => Number(line.replace(/[^\d]/g, '')));
            return JSON.stringify({values: rows.map(row => ({row, value: 'v' + row + '｜AI'}))});
        }});
        const api = env.api;
        const makeRows = count => Array.from({length: count}, (_, index) => ['原文' + (index + 1)]);
        const node = addTable(env, ['场景'], makeRows(25));
        api.renderTableBody(node);
        const root = node._tableEl;
        api.openTableAiColumnPanel(node, 0);
        const panel = one(docBody, 'table-ai-overlay');
        ok(Boolean(panel), 'AI 列弹层打开');
        eq(one(panel, 'table-ai-panel-title').textContent, '智能列 · 场景', '弹层标题带列名');
        const textarea = one(panel, 'table-ai-instruction');
        ok(Boolean(textarea), '弹层里有指令输入框');
        textarea.value = '按原文写一句英文提示词';
        one(panel, 'table-ai-primary').onclick();
        await waitIdle(api, node);
        eq(calls.length, 2, '25 行按默认每批 20 行 → 2 次 LLM 调用');
        eq(calls[0].nodeArg, node, 'AI 列每批都把表格节点传给 host');
        eq(calls[1].nodeArg, node, '第二批也一样');
        eq((calls[0].message.match(/^第 \d+ 行$/gm) || []).length, 20, '第一批 20 行');
        eq((calls[1].message.match(/^第 \d+ 行$/gm) || []).length, 5, '第二批 5 行');
        eq(node.table.aiColumns[0].instruction, '按原文写一句英文提示词', '指令写进 aiColumns');
        eq(api.tableAiColumnState(node).done, 25, '进度：已生成 25/25 行');
        eq(node.table.rows[0][0], 'v1｜AI', '第 1 行已写入');
        eq(node.table.rows[24][0], 'v25｜AI', '第 25 行已写入');
        ok(String(one(panel, 'table-ai-col-status').textContent).indexOf('已生成 25/25 行') >= 0,
            '弹层显示「已生成 25/25 行」');
        ok(aiHeaderButtons(root)[0].classList.contains('is-configured'), '有指令的列 → AI 按钮高亮');
        eq(one(one(root, 'table-ai-col-btn'), 'table-ai-col-btn') && aiHeaderButtons(root)[0].textContent, 'AI', 'AI 列按钮文案');
        api.tableAiCloseOverlay(node);

        // 停止：第一批跑完就停，后面的批次不再发请求
        stopOnFirst = true;
        calls.length = 0;
        const stopNode = addTable(env, ['场景'], makeRows(25));
        stopTarget = stopNode;
        api.renderTableBody(stopNode);
        api.openTableAiColumnPanel(stopNode, 0);
        api.tableAiSetInstruction(stopNode, 0, '写一列');
        await api.tableAiRunColumn(stopNode, 0);
        eq(calls.length, 1, '停止后不再发下一批');
        eq(api.tableAiColumnState(stopNode).done, 20, '停止前已完成第一批 20 行');
        eq(api.tableAiColumnState(stopNode).stopped, true, '状态标记已停止');
        eq(api.tableAiColumnState(stopNode).running, false, '停止后不再显示运行中');
        eq(stopNode.table.rows[19][0], 'v20｜AI', '已完成的行保留');
        eq(stopNode.table.rows[20][0], '原文21', '第 21 行没被改写（停在批次边界）');
        api.tableAiCloseOverlay(stopNode);
        stopOnFirst = false;

        // 同一时刻只允许一列在跑
        const holdEnv = makeEnv({callLLM: () => new Promise(() => {})});
        const holdNode = addTable(holdEnv, ['甲', '乙'], [['a', 'b'], ['c', 'd']]);
        holdEnv.api.renderTableBody(holdNode);
        holdEnv.api.tableAiSetInstruction(holdNode, 0, '写第一列');
        holdEnv.api.tableAiSetInstruction(holdNode, 1, '写第二列');
        holdEnv.api.tableAiRunColumn(holdNode, 0);
        const second = await holdEnv.api.tableAiRunColumn(holdNode, 1);
        eq(second, false, '一列在跑时另一列被拒绝');
        ok(holdEnv.api.tableAiColumnIsRunning(holdNode), '第一列仍在跑');
        const otherNode = addTable(holdEnv, ['丙'], [['x']]);
        holdEnv.api.renderTableBody(otherNode);
        holdEnv.api.tableAiSetInstruction(otherNode, 0, '写第三列');
        eq(await holdEnv.api.tableAiRunColumn(otherNode, 0), false, '另一张表的 AI 列也要等这一列跑完');
        holdEnv.api.tableAiStopColumn(holdNode);
        api.tableAiCloseOverlay(holdNode);
        holdEnv.api.tableAiCloseOverlay(holdNode);
        holdEnv.api.tableAiCloseOverlay(otherNode);
    }

    // ═══ [6] AI 列失败行：标红 + 重试该行 ═══
    {
        const calls = [];
        const env = makeEnv({callLLM: async (nodeArg, message) => {
            calls.push({nodeArg, message});
            const rows = (message.match(/^第 \d+ 行$/gm) || []).map(line => Number(line.replace(/[^\d]/g, '')));
            return JSON.stringify({values: rows
                .filter(row => !(calls.length === 1 && row === 3))
                .map(row => ({row, value: 'x' + row}))});
        }});
        const api = env.api;
        const node = addTable(env, ['场景'], [['a'], ['b'], ['c'], ['d'], ['e']]);
        api.renderTableBody(node);
        const root = node._tableEl;
        api.openTableAiColumnPanel(node, 0);
        api.tableAiSetInstruction(node, 0, '写一列');
        await api.tableAiRunColumn(node, 0);
        eq(api.tableAiColumnState(node).failed.map(item => item.row), [3], '失败行被记下来');
        eq(node.table.rows[2][0], 'c', '失败行保持原文');
        ok(cellAt(root, 2, 0).classList.contains('table-ai-failed'), '失败行格子标红');
        ok(!cellAt(root, 0, 0).classList.contains('table-ai-failed'), '成功行不标红');
        const panel = one(docBody, 'table-ai-overlay');
        eq(byClass(panel, 'table-ai-col-fail').length, 1, '面板里列出失败行');
        const retry = one(panel, 'table-ai-retry');
        eq(retry.textContent, '重试该行', '失败行给出「重试该行」');
        retry.onclick();
        await waitIdle(api, node);
        eq(node.table.rows[2][0], 'x3', '重试成功后补上第 3 行');
        eq(api.tableAiColumnState(node).failed.length, 0, '重试成功后失败列表清空');
        ok(!cellAt(root, 2, 0).classList.contains('table-ai-failed'), '重试成功后红色标记去掉');
        eq(byClass(one(docBody, 'table-ai-overlay'), 'table-ai-col-fail').length, 0, '面板里的失败行一并消失');
        api.tableAiCloseOverlay(node);
    }

    // ═══ [7] 隔离：批量生成运行中禁用；llmTable 不显示 AI 列入口 ═══
    {
        const env = makeEnv({callLLM: async () => JSON.stringify({values: []})});
        const api = env.api;
        const node = addTable(env, ['场景'], [['a'], ['b']]);
        const root = api.renderTableBody(node);
        ok(!aiHeaderButtons(root)[0].disabled, '没有批量在跑 → AI 列按钮可用');

        node.tableBatchRunning = true;
        api.repaintTable(node);
        ok(aiHeaderButtons(root)[0].disabled, '批量生成中 → AI 列按钮禁用');
        eq(aiHeaderButtons(root)[0].title, '批量生成中，完成后再改', 'AI 列按钮给出原因');
        api.tableAiApplySelection(node, {r0:0, c0:0, r1:0, c1:0});
        const toolbar = one(root, 'table-ai-toolbar');
        ok(one(toolbar, 'table-ai-primary').disabled, '批量生成中 → 选区工具条禁用');
        eq(one(toolbar, 'table-ai-hint').textContent, '批量生成中，完成后再改', '工具条显示「批量生成中，完成后再改」');
        eq(toolbar.title, '批量生成中，完成后再改', '工具条 title 同样提示');
        one(toolbar, 'table-ai-toolbar-input').value = '改';
        const previewBlocked = await api.tableAiOpenPreview(node);
        eq(previewBlocked, false, '批量生成中不能生成预览');
        ok(env.errors.some(item => String(item.message).indexOf('批量生成中') === 0), '给出可见错误（不是静默吞）');
        eq(await api.tableAiRunColumn(node, 0), false, '批量生成中不能跑 AI 列');
        node.tableBatchRunning = false;
        api.repaintTable(node);
        ok(!aiHeaderButtons(root)[0].disabled, '批量结束后 AI 列按钮恢复可用');

        env.nodes.push({id: 'gen1', type: 'generator', _batchRunning: true});
        env.connections.push({id: 'c_gen1', from: node.id, to: 'gen1'});
        ok(api.tableAiBatchBusy(node), '下游批量节点在跑 → 同样视为批量中');
        env.nodes[env.nodes.length - 1]._batchRunning = false;
        ok(!api.tableAiBatchBusy(node), '下游停了 → 恢复');

        const stopEnv = makeEnv({callLLM: async () => '{}', generationStopRequested: id => id === 'gen1'});
        const stopNode = addTable(stopEnv, ['场景'], [['a']]);
        stopEnv.nodes.push({id: 'gen1', type: 'generator'});
        stopEnv.connections.push({id: 'c_gen1', from: stopNode.id, to: 'gen1'});
        stopEnv.api.renderTableBody(stopNode);
        ok(stopEnv.api.tableAiBatchBusy(stopNode), 'host 的 generationStopRequested 也拦住 AI 入口');

        const llmEnv = makeEnv({callLLM: async () => '{}'});
        const llmNode = addTable(llmEnv, ['场景'], [['a']]);
        llmNode.llmGeneratedOutput = true;
        const llmRoot = llmEnv.api.renderTableBody(llmNode);
        eq(aiHeaderButtons(llmRoot).length, 0, 'LLM 出表生成的表格不显示 AI 列入口');
        ok(Boolean(one(llmRoot, 'table-head-label')), 'LLM 表照常显示列名');
        api.tableAiCloseOverlay(node);
    }

    // ═══ [8] host 没有 callLLM：按钮禁用 + 明确提示 ═══
    {
        const env = makeEnv({});
        const api = env.api;
        eq(api.tableAiChannel(), null, 'host 没有 callLLM → 取不到 AI 通道');
        const node = addTable(env, ['场景'], [['a'], ['b']]);
        const root = api.renderTableBody(node);
        const aiBtn = aiHeaderButtons(root)[0];
        ok(aiBtn.disabled, '缺 AI 通道 → AI 列按钮禁用');
        eq(aiBtn.title, '当前画布未提供 AI 通道', 'AI 列按钮写明缺通道');
        api.tableAiApplySelection(node, {r0:0, c0:0, r1:0, c1:0});
        const toolbar = one(root, 'table-ai-toolbar');
        ok(one(toolbar, 'table-ai-primary').disabled, '缺通道 → 生成预览禁用');
        eq(one(toolbar, 'table-ai-hint').textContent, '当前画布未提供 AI 通道', '工具条上写明缺通道');
        eq(await api.tableAiOpenPreview(node), false, '缺通道不能生成预览');
        ok(env.errors.some(item => item.message === '当前画布未提供 AI 通道'), '给出可见错误');
        eq(await api.tableAiRunColumn(node, 0), false, '缺通道不能跑 AI 列');
        api.tableAiCloseOverlay(node);
    }

    // ═══ [9] 工具条定位：贴选区上方，空间不够翻到下方，左右上下都夹在节点内 ═══
    {
        const env = makeEnv({callLLM: async () => '{}'});
        const api = env.api;
        const node = addTable(env, ['场景'], [['a'], ['b'], ['c']]);
        const root = api.renderTableBody(node);
        const toolbar = one(root, 'table-ai-toolbar');
        toolbar.offsetWidth = 320;
        toolbar.offsetHeight = 60;
        const grid = one(root, 'table-grid') || all(root).filter(e => e.classList.contains('table-node-grid'))[0];
        root._rect = {left: 100, top: 100, right: 900, bottom: 800, width: 800, height: 700};
        grid._rect = {left: 112, top: 140, right: 888, bottom: 780, width: 776, height: 640};
        const cell0 = cellAt(root, 0, 0);
        cell0._rect = {left: 224, top: 190, right: 356, bottom: 234, width: 132, height: 44};
        api.tableAiApplySelection(node, {r0:0, c0:0, r1:0, c1:0});
        api.tableAiSyncToolbar(node);
        eq(toolbar.style.top, '140px', '贴上方放不下（会盖住表头）→ 翻到选区下方');
        eq(toolbar.style.left, '124px', '左边界夹在节点内（贴合选区左边）');

        const cell5 = cellAt(root, 2, 0);
        cell5._rect = {left: 600, top: 500, right: 732, bottom: 544, width: 132, height: 44};
        api.tableAiApplySelection(node, {r0:2, c0:0, r1:2, c1:0});
        api.tableAiSyncToolbar(node);
        eq(toolbar.style.top, '334px', '上方放得下 → 贴在选区上方');
        eq(toolbar.style.left, '464px', '右边界夹在节点内（不溢出）');
        const topPx = Number(String(toolbar.style.top).replace('px', ''));
        const leftPx = Number(String(toolbar.style.left).replace('px', ''));
        ok(topPx >= 82 && topPx + 60 <= 680, '纵向始终落在表格可视区内');
        ok(leftPx >= 16 && leftPx + 320 <= 784, '横向始终落在表格可视区内');
        api.tableAiCloseOverlay(node);
    }

    // ═══ [10] Ctrl/Cmd+Z：有 AI 快照时接管，焦点在编辑器里不抢 ═══
    {
        const env = makeEnv({callLLM: async () => '{}'});
        const api = env.api;
        const node = addTable(env, ['场景'], [['a'], ['b']]);
        api.renderTableBody(node);
        ok(api.tableAiApplyChanges(node, [{row: 1, col: 1, before: 'a', after: 'A'}]), '应用一处改动（构造撤销快照）');
        eq(node.table.rows[0][0], 'A', '改动已落盘');
        let prevented = false;
        let stopped = false;
        api.tableAiGlobalKeydown({key: 'z', ctrlKey: true, target: docBody,
            preventDefault(){ prevented = true; }, stopPropagation(){ stopped = true; }});
        ok(prevented && stopped, 'Ctrl+Z 在有 AI 快照时被接管（不落到画布的撤销）');
        eq(node.table.rows[0][0], 'a', 'Ctrl+Z 一步还原');
        prevented = false;
        stopped = false;
        ok(api.tableAiApplyChanges(node, [{row: 2, col: 1, before: 'b', after: 'B'}]), '再应用一处');
        api.tableAiGlobalKeydown({key: 'z', ctrlKey: true, target: {tagName: 'TEXTAREA', className: 'table-cell-editor'},
            preventDefault(){ prevented = true; }, stopPropagation(){ stopped = true; }});
        ok(!prevented && !stopped, '焦点在编辑器里时不抢 Ctrl+Z');
        eq(node.table.rows[1][0], 'B', '编辑器里的撤销不受影响（表格数据没被回滚）');
        api.tableAiGlobalKeydown({key: 'z', ctrlKey: true, target: docBody, preventDefault(){}, stopPropagation(){}});
        eq(node.table.rows[1][0], 'b', '回到普通位置再按一次才消费快照');
        api.tableAiCloseOverlay(node);
    }

    // ═══ [11] 点表格外后 AI 撤销快照作废，Cmd+Z 交回画布 ═══
    {
        const env = makeEnv({callLLM: async () => '{}'});
        const api = env.api;
        const node = addTable(env, ['场景'], [['a']]);
        api.renderTableBody(node);
        ok(api.tableAiApplyChanges(node, [{row: 1, col: 1, before: 'a', after: 'A'}]), '应用一处（有撤销快照）');
        ok(api.tableAiHasUndo(), '快照在');
        api.tableAiGlobalMouseDown({target: docBody});
        ok(!api.tableAiHasUndo(), '点表格外 → AI 撤销快照作废');
        let prevented = false;
        let stopped = false;
        api.tableAiGlobalKeydown({key: 'z', ctrlKey: true, target: docBody,
            preventDefault(){ prevented = true; }, stopPropagation(){ stopped = true; }});
        ok(!prevented && !stopped, 'Cmd+Z 不再被 AI 接管（交回画布撤销）');
        eq(node.table.rows[0][0], 'A', '点别处之后的 Cmd+Z 不会回滚这张表');
        api.tableAiCloseOverlay(node);
    }

    console.log('通过 ' + pass + '/' + (pass + fails.length));
    if(fails.length){ console.log('失败:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
    console.log('全部通过');
})();
