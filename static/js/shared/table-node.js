/* 多维表格节点实现（渲染 / 输入通道 / @引用 / 批量执行 / LLM 出表）。
   经典画布与智能画布共用这一份：画布侧把 nodes / connections / render / 上传 / 预览
   等钩子通过工厂传进来（宿主注入）；下面这段是原 canvas.js 的表格段，逐行搬来、逻辑未改。 */
(function(root){
    'use strict';
    root.NovaTableNode = function createTableNode(host){
        const {
            tr, nodes, connections, nodesEl, selected, addNode, render, scheduleSave, saveCanvas, uid,
            pushUndo, defaultPoint, mediaKindForNode, mediaKindForRef, mediaKindForUpload,
            outputUrlValue, isMissingAssetUrl, canvasPreviewImgHtml, canvasVideoPreviewHtml,
            nowMs, responseErrorMessage, refreshIcons, renderNode, runGenerator, runVideoNode,
            showErrorModal, generationStopRequested, onBatchSettled,
        } = host || {};

function novaTableModel(){
    return (typeof NovaTableModel !== 'undefined' && NovaTableModel) ? NovaTableModel : null;
}

function ensureTableState(node){
    const model = novaTableModel();
    if(!model) return null;
    node.table = model.normalizeTable(node.table || {}).table;
    /* 勾选语义＝「默认全选、取消则不跑」。
       老画布里的表格 selectedRows 是空的（那时表示「没选」），现在必须当成全选，
       否则一打开就是一行都不跑。只在第一次补齐 ——
       之后用户自己取消到空也要尊重，不能每次重绘都给他填回来。 */
    if(!node.tableSelectionInitialized){
        node.tableSelectionInitialized = true;
        if(node.table.rows.length && !node.table.selectedRows.length){
            node.table.selectedRows = node.table.rows.map((row, index) => index);
        }
    }
    return node.table;
}

function addTableNode(point){
    const p = point || defaultPoint(0, 0);
    const model = novaTableModel();
    return addNode({
        id: uid('tbl'),
        type: 'table',
        x: p.x,
        y: p.y,
        table: model ? model.emptyTable() : {kind:'table', version:1, columns:[], rows:[], selectedRows:[], mergedGroups:[]}
    });
}

/* 删除列：表格右侧独立的一列「删除行」。
   DX OS 的 Yw 只算 输入列 + 数据列 + 预留(44)，不含这一列，所以自然宽度要单独补上。
   数值必须和 .table-delete-column 的 CSS 宽度一致（wiring 测试会比对）。 */
const TABLE_DELETE_COLUMN_WIDTH = 60;

/* 表格对齐：整列都是短值（时长/运镜/景别/机位…）就居中；
   出现长文本（提示词/画面描述/台词）的那一列保持左对齐 —— 长句居中读不了。
   阈值就是下面这个字符数，调它即可。 */
const TABLE_TEXT_COLUMN_CHARS = 18;

// 表格本体尺寸（DX OS 的 Yw）
function tableNaturalSize(node){
    const model = novaTableModel();
    const state = ensureTableState(node);
    if(!model || !state) return {width:280, height:0};
    const inputColumns = Array.isArray(node.tableInputChannels) ? node.tableInputChannels.length : 0;
    const size = model.nodeSize(state, inputColumns);
    return {width:size.width + TABLE_DELETE_COLUMN_WIDTH, height:size.height};
}

/* 节点宽度 = 表格本体宽 + node-body 左右内边距。
   用户手动拉宽过（tableWidthUserSet）就不再自动覆盖，否则一重绘就跳回原宽。 */
function syncTableNodeWidth(node){
    if(node.tableWidthUserSet) return;
    const size = tableNaturalSize(node);
    node.w = size.width + 24;
    const host = document.querySelector('.node[data-id="' + node.id + '"]');
    if(host) host.style.width = node.w + 'px';
}

/* 表格重绘 —— 顺带刷新**下游**生成 / 视频节点的批量面板。
   面板读的就是这张表，所以改格子 / 加删行列 / 传替换素材都必须即时反映过去。 */
/* 会挂批量面板的节点类型：经典画布是 generator / video，智能画布是 smart-batch。
   只认前两种的话，智能画布那边「表格里改勾选 → 批量面板」永远不重绘（用户报的）。 */
const TABLE_BATCH_NODE_TYPES = ['generator', 'video', 'smart-batch'];
function tableBatchTypeNode(item){ return Boolean(item) && TABLE_BATCH_NODE_TYPES.includes(item.type); }

function repaintTable(node){
    if(typeof node._tablePaint === 'function') node._tablePaint();
    (nodes || []).filter(tableBatchTypeNode).forEach(gen => {
        if(generatorUpstreamTables(gen.id).some(item => item.id === node.id)) repaintBatchPanel(gen);
    });
}

/* 勾选状态是表格和生成面板共用的：
   在表格里取消勾选，生成那边的候选行也要立刻跟着变（反过来也一样），
   所以两个地方都要重绘 —— 只重绘表格会让面板显示过期的勾选。 */
function repaintTableSelectionViews(tableNode){
    repaintTable(tableNode);
    (nodes || []).filter(tableBatchTypeNode).forEach(gen => {
        if(generatorUpstreamTables(gen.id).some(item => item.id === tableNode.id)) repaintBatchPanel(gen);
    });
}

function addTableRow(node){
    const state = ensureTableState(node);
    if(!state || !state.columns.length) return;
    node.table = novaTableModel().applyOperation(state, 'append_row', {values: state.columns.map(() => '')});
    scheduleSave();
    repaintTable(node);
}

function addTableColumn(node){
    const state = ensureTableState(node);
    if(!state) return;
    node.table = novaTableModel().applyOperation(state, 'add_column', {title:''});
    scheduleSave();
    repaintTable(node);
}

function deleteTableRow(node, row){
    const state = ensureTableState(node);
    if(!state) return;
    node.table = novaTableModel().applyOperation(state, 'delete_row', {row: row + 1});
    scheduleSave();
    repaintTable(node);
}

/* 删数据列（DX OS: delete_column）。行原样保留，行选中状态也不动。 */
function deleteTableColumn(node, column){
    const model = novaTableModel();
    const state = ensureTableState(node);
    if(!model || !state || !state.columns.length) return;
    node.table = model.applyOperation(state, 'delete_column', {column: column + 1});
    scheduleSave();
    repaintTable(node);
}

/* 删输入列（DX OS §3 的 QS）：连到这一列的连线一起删，后面的列号整体前移。
   输入列是连线推出来的（ensureTableChannels 每次重绘都重建），不删连线的话删了也会自己长回来。 */
function removeTableInputChannel(node, index){
    const model = novaTableModel();
    if(!model) return;
    const channels = ensureTableChannels(node);
    if(channels.length <= 1) return;   // 至少留一列
    const kept = [];
    (connections || []).forEach(conn => {
        if(!conn || conn.to !== node.id){ kept.push(conn); return; }
        const at = model.channelIndexFromId(conn.toPort);
        const place = at < 0 ? 0 : at;          // 没写 toPort 的连线落在第一列
        if(place === index) return;             // 这一列的连线：跟着列一起删
        if(place > index) kept.push({...conn, toPort: model.channelIdAt(place - 1)});
        else kept.push(conn);
    });
    connections.length = 0;
    kept.forEach(conn => connections.push(conn));
    // 表头手动值 / 手动上传的素材都是按 input-N 存的，列号前移要跟着搬
    const rekey = store => {
        if(!store || typeof store !== 'object') return null;
        const next = {};
        Object.keys(store).forEach(key => {
            const at = model.channelIndexFromId(key);
            if(at < 0 || at === index) return;
            next[model.channelIdAt(at > index ? at - 1 : at)] = store[key];
        });
        return Object.keys(next).length ? next : null;
    };
    const modes = rekey(node.tableInputChannelModes);
    if(modes) node.tableInputChannelModes = modes; else delete node.tableInputChannelModes;
    const manual = rekey(node.tableManualInputItems);
    if(manual) node.tableManualInputItems = manual; else delete node.tableManualInputItems;
    node.tableInputChannelCount = Math.max(1, channels.length - 1);
    scheduleSave();
    repaintTable(node);
}

function toggleTableRow(node, row, on){
    const state = ensureTableState(node);
    if(!state) return;
    const picked = new Set(state.selectedRows);
    if(on) picked.add(row); else picked.delete(row);
    state.selectedRows = Array.from(picked).sort((a, b) => a - b);
    scheduleSave();
    repaintTableSelectionViews(node);
}

function toggleAllTableRows(node, on){
    const state = ensureTableState(node);
    if(!state) return;
    state.selectedRows = on ? state.rows.map((row, index) => index) : [];
    scheduleSave();
    repaintTableSelectionViews(node);
}

// 编辑态挂在 node._tableEdit 上：DOM 原地重绘后自动恢复到编辑中的单元格。
function beginTableEdit(node, editing){
    node._tableEdit = editing;
    repaintTable(node);
}

function endTableEdit(node){
    if(!node._tableEdit) return;
    node._tableEdit = null;
    repaintTable(node);
}

function bindTableCellEditor(node, editor, row, column){
    // 自建表格双击编辑不要那圈线框（格子自己要有个干净的编辑态）
    if(!node.llmGeneratedOutput) editor.classList.add('is-plain');
    let settled = false;
    const finish = commit => {
        if(settled) return;
        settled = true;
        if(commit){
            const state = ensureTableState(node);
            if(state && state.rows[row]) state.rows[row][column] = novaTableModel().cellText(editor.value);
            scheduleSave();
        }
        endTableEdit(node);
    };
    /* 打一个 @ 就列出**同一行**的素材，点一下插入 @图片N。
       没有这个选择器用户只能靠猜序号（实际就有人打成了 @是是是@）。 */
    const picker = document.createElement('div');
    picker.className = 'table-cell-mention-picker';
    const closePicker = () => { picker.classList.remove('is-open'); picker.textContent = ''; };
    const insertMention = item => {
        const model = novaTableModel();
        const caret = typeof editor.selectionStart === 'number' ? editor.selectionStart : editor.value.length;
        const before = editor.value.slice(0, caret);
        const match = /@[^ @]{0,6}$/.exec(before);
        if(!model || !match) return closePicker();
        const start = caret - match[0].length;
        const token = model.mentionTokenAt(item.kind, item.ordinal);
        editor.value = editor.value.slice(0, start) + token + editor.value.slice(caret);
        const at = start + token.length;
        if(typeof editor.setSelectionRange === 'function') editor.setSelectionRange(at, at);
        closePicker();
        if(typeof editor.focus === 'function') editor.focus();
    };
    let activeIndex = 0;
    const pickerItems = () => Array.prototype.slice.call(picker.children || [])
        .filter(child => child.classList && child.classList.contains('table-cell-mention-item'));
    const paintActive = () => pickerItems().forEach((el, i) => el.classList.toggle('is-active', i === activeIndex));
    const openPicker = () => {
        const model = novaTableModel();
        const rows = tableRowInputs(node);
        const media = (rows[row] && rows[row].media ? rows[row].media : []).filter(item => item && item.url);
        if(!model) return closePicker();
        picker.textContent = '';
        if(!media.length){
            // 打 @ 却没反应最容易被当成坏了：这一行没素材时就说清楚
            const tip = document.createElement('span');
            tip.className = 'table-cell-mention-tip';
            tip.textContent = '本行还没有素材，先在上面的输入列上传';
            picker.appendChild(tip);
            picker.classList.add('is-open');
            return;
        }
        activeIndex = 0;
        media.forEach(item => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'table-cell-mention-item';
            button.title = model.mentionTokenAt(item.kind, item.ordinal);
            const thumb = document.createElement('span');
            thumb.className = 'table-media-thumb';
            thumb.innerHTML = item.kind === 'video'
                ? canvasVideoPreviewHtml(item.url)
                : canvasPreviewImgHtml(item.url, 32);
            button.appendChild(thumb);
            const label = document.createElement('span');
            label.textContent = model.mentionTokenAt(item.kind, item.ordinal);
            button.appendChild(label);
            // preventDefault 很关键：不拦的话点按钮会让 textarea 失焦 → onblur 先提交并销毁编辑器，
            // 这次点击就落空了（表现就是「选完图不能用了」）。
            button.onmousedown = event => { event.preventDefault(); event.stopPropagation(); };
            button.onclick = event => { event.preventDefault(); event.stopPropagation(); insertMention(item); };
            picker.appendChild(button);
        });
        activeIndex = 0;
        picker.classList.add('is-open');
        paintActive();
    };
    editor.oninput = () => {
        const caret = typeof editor.selectionStart === 'number' ? editor.selectionStart : editor.value.length;
        // 触发放宽到「最近 6 个字符里有个 @」：打 @ / @图 / @1 都算，打错了也不会闪没
        if(/@[^ @]{0,6}$/.test(editor.value.slice(0, caret))) openPicker();
        else closePicker();
    };
    // 不依赖打 @：编辑器右上角一个「引用」按钮，点它就弹选择条
    const mentionTrigger = stopCellEvent(document.createElement('button'));
    mentionTrigger.type = 'button';
    mentionTrigger.className = 'table-cell-mention-trigger';
    mentionTrigger.textContent = '@';
    mentionTrigger.title = '引用本行素材';
    mentionTrigger.onclick = event => { event.preventDefault(); event.stopPropagation(); openPicker(); };
    if(editor.parentNode){
        editor.parentNode.appendChild(picker);
        editor.parentNode.appendChild(mentionTrigger);
    }
    editor.onblur = () => finish(true);
    editor.onkeydown = event => {
        event.stopPropagation();
        const pickerOpen = picker.classList.contains('is-open');
        // 选择条开着：方向键换一张、Enter 选它、Esc 先收选择条
        if(pickerOpen && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')){
            event.preventDefault();
            const list = pickerItems();
            if(list.length){
                activeIndex = (activeIndex + (event.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
                paintActive();
            }
            return;
        }
        if(pickerOpen && event.key === 'Enter'){
            event.preventDefault();
            const list = pickerItems();
            const picked = list[activeIndex] || list[0];
            if(picked && typeof picked.onclick === 'function'){ picked.onclick({preventDefault(){}, stopPropagation(){}}); return; }
        }
        if(event.key === 'Escape' && pickerOpen){ event.preventDefault(); closePicker(); return; }
        if(event.key === 'Escape'){ event.preventDefault(); finish(false); }
        else if(event.key === 'Enter' && !event.shiftKey){ event.preventDefault(); finish(true); }
    };
    editor.onmousedown = event => event.stopPropagation();
    editor.onclick = event => event.stopPropagation();
    editor.ondblclick = event => event.stopPropagation();
}

function bindTableHeadEditor(node, input, column){
    let settled = false;
    const finish = commit => {
        if(settled) return;
        settled = true;
        if(commit){
            const state = ensureTableState(node);
            if(state){
                const model = novaTableModel();
                const names = state.columns.map((name, index) => index === column ? String(input.value || '') : name);
                state.columns = model.normalizeColumns(names);
            }
            scheduleSave();
        }
        endTableEdit(node);
    };
    input.onblur = () => finish(true);
    input.onkeydown = event => {
        event.stopPropagation();
        if(event.key === 'Escape'){ event.preventDefault(); finish(false); }
        else if(event.key === 'Enter'){ event.preventDefault(); finish(true); }
    };
    input.onmousedown = event => event.stopPropagation();
    input.onclick = event => event.stopPropagation();
    input.ondblclick = event => event.stopPropagation();
}

/* ───────────────────── 表格输入列（DX OS §3/§4）───────────────────── */

function tableIncomingConnections(node){
    return (connections || []).filter(conn => conn && conn.to === node.id);
}

/* 输出节点的媒体 → 表格输入项（DX OS 只有「节点 / 分组」两种来源，这条是 NOVAI 的补充）。
   输出节点自己没有 url，媒体全在 images 里，而且一个节点可能有好几张。
   nodeId 仍然写输出节点自己的 id，下游 nodes.find(n => n.id === ref.nodeId) 才能反查到；
   同一节点的多张图靠 url + outputIndex 区分（别用 nodeId 去重，会把它们并成一张）。 */
function outputSourceItems(source){
    return (source.images || [])
        .map((item, index) => ({url: outputUrlValue(item), index}))
        .filter(entry => entry.url && mediaKindForRef({url:entry.url}) !== 'text')
        .map(entry => ({type:'media', nodeId:source.id, url:entry.url, outputIndex:entry.index}));
}

/* 输入项的唯一键。同一个输出节点会连来好几张图，只比 nodeId 会把它们当成同一项。 */
function tableItemKey(item){
    if(!item) return '';
    const index = Number(item.outputIndex);
    return String(item.nodeId || '') + '#' + String(item.url || '') + '#'
        + (Number.isFinite(index) && index >= 0 ? index : '');
}

/* 条目 → 通道里的输入项（保留 url / outputIndex，输出节点要多带这两个字段） */
function tableChannelItem(entry){
    const item = {type:'media', nodeId:entry.nodeId};
    if(entry.url) item.url = entry.url;
    const index = Number(entry.outputIndex);
    if(Number.isFinite(index) && index >= 0) item.outputIndex = index;
    return item;
}

/* ── 手动塞进参考栏的素材 ────────────────────────────────────────────
   输入列的内容本来是连线推出来的（ensureTableChannels 每次重绘都重建），
   所以手动上传的那一份**不能**写进 tableInputChannels，必须单独存：
     node.tableManualInputItems = { 'input-1': { '0': {url, mediaType, name} } }
   同一个格子以手动为准 —— 参考栏本来就是「一行一张、沿用」，
   手动替换的正是这一行的那一张。删掉手动项就回到连线推出来的那张。 */
function tableManualInputStore(node, create){
    if(!node.tableManualInputItems || typeof node.tableManualInputItems !== 'object'){
        if(!create) return null;
        node.tableManualInputItems = {};
    }
    return node.tableManualInputItems;
}

function tableManualInputItem(node, channelId, row){
    const store = tableManualInputStore(node, false);
    const byRow = store ? store[String(channelId)] : null;
    const item = byRow ? byRow[String(row)] : null;
    return item && item.url ? item : null;
}

function setTableManualInputItem(node, channelId, row, value){
    const store = tableManualInputStore(node, true);
    const key = String(channelId);
    const byRow = store[key] && typeof store[key] === 'object' ? store[key] : (store[key] = {});
    if(value && value.url){
        byRow[String(row)] = {url:value.url, mediaType:value.mediaType || 'image', name:value.name || ''};
    } else {
        delete byRow[String(row)];
    }
    if(!Object.keys(byRow).length) delete store[key];
    if(!Object.keys(store).length) delete node.tableManualInputItems;
    scheduleSave();
}

/* 往格子里上传图片/视频：走画布同一套 /api/ai/upload（落到 assets），不另开后端。 */
async function uploadTableCellFile(file){
    const form = new FormData();
    form.append('files', file, file.name || ('cell_' + Date.now()));
    const response = await fetch('/api/ai/upload', {method:'POST', body:form});
    if(!response.ok) throw new Error(await responseErrorMessage(response, '上传失败'));
    const data = await response.json();
    const first = (data.files || [])[0] || {};
    if(!first.url) throw new Error('上传失败：服务端没有返回地址');
    return {
        url: first.url,
        mediaType: first.kind || mediaKindForUpload(file),
        name: first.name || file.name || ''
    };
}

function pickTableCellFile(onPicked){
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,video/*';
    input.style.display = 'none';
    input.onchange = async () => {
        const file = input.files && input.files[0];
        if(input.parentNode) input.parentNode.removeChild(input);
        if(!file) return;
        try {
            const uploaded = await uploadTableCellFile(file);
            if(uploaded) onPicked(uploaded);
        } catch(error){
            alert(error && error.message ? error.message : '上传失败');
        }
    };
    document.body.appendChild(input);
    input.click();
}

/* 预览格子里的素材：沿用画布的输出大图查看器（视频也能放）。 */
function openTableCellMedia(url, mediaType){
    if(!url) return;
    if(typeof openOutputLightbox === 'function'){
        try { openOutputLightbox(url, {id:'', images:[], type:''}); return; } catch(error){ /* 退回新窗口 */ }
    }
    window.open(url, '_blank');
}

/* ── 格子里的交互 ────────────────────────────────────────────────
   两种表格两套规则：
   - **LLM 生成的多维表格不放任何图标**（表格是模型产出的，每格挂按钮太吵）：
     有图/视频双击看大图，提示词格双击改文字。
   - **用户自己新建的空白表**：空格子正中一个「+」（点击上传）；写了文字「+」就消失；
     有图/视频时右上角一个「···」（点击替换），双击看大图。 */
function stopCellEvent(button){
    button.onmousedown = event => event.stopPropagation();
    button.ondblclick = event => event.stopPropagation();
    return button;
}

function tableCellAddButton(cell, onPick){
    const button = stopCellEvent(document.createElement('button'));
    button.type = 'button';
    button.className = 'table-cell-add';
    button.title = '上传图片/视频';
    const glyph = document.createElement('i');
    glyph.dataset.lucide = 'plus';
    button.appendChild(glyph);
    button.onclick = event => { event.stopPropagation(); onPick(); };
    cell.appendChild(button);
}

/* 右上角「···」：点开一个小菜单（替换 / 新增），不是直接换图。
   用画布上已有的 .menu-btn 语言，位置跟着格子。 */
function tableCellMoreButton(cell, actions){
    const wrap = document.createElement('div');
    wrap.className = 'table-cell-more-wrap';
    const button = stopCellEvent(document.createElement('button'));
    button.type = 'button';
    button.className = 'table-cell-more';
    button.textContent = '···';
    button.title = '替换 / 新增';
    const menu = document.createElement('div');
    menu.className = 'table-cell-menu';
    (actions || []).forEach(action => {
        const item = stopCellEvent(document.createElement('button'));
        item.type = 'button';
        item.className = 'menu-btn';
        // 带缩略图（替换哪一张要看得见）
        if(action.thumb){
            const thumb = document.createElement('span');
            thumb.className = 'table-media-thumb';
            thumb.innerHTML = action.mediaType === 'video'
                ? canvasVideoPreviewHtml(action.thumb)
                : canvasPreviewImgHtml(action.thumb, 24);
            item.appendChild(thumb);
        }
        const label = document.createElement('span');
        label.textContent = action.label;
        item.appendChild(label);
        if(action.token) item.title = action.token;
        item.onclick = event => { event.stopPropagation(); closeMenu(); action.onClick(); };
        if(action.onDelete){
            const del = stopCellEvent(document.createElement('button'));
            del.type = 'button';
            del.className = 'table-cell-menu-del';
            del.textContent = '✕';
            del.title = '删除' + (action.token || '这张');
            del.onclick = event => { event.stopPropagation(); closeMenu(); action.onDelete(); };
            item.appendChild(del);
        }
        menu.appendChild(item);
    });
    /* 菜单挂到 body 上做 fixed 定位：留在格子里会被表格滚动区裁掉 ——
       素材一多，最后那项「新增」就看不见了。 */
    const closeMenu = () => {
        menu.classList.remove('is-open');
        if(menu.parentNode) menu.parentNode.removeChild(menu);
        document.removeEventListener('mousedown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
    };
    const onOutside = event => { if(!menu.contains(event.target) && event.target !== button) closeMenu(); };
    const onKey = event => { if(event.key === 'Escape') closeMenu(); };
    button.onclick = event => {
        event.stopPropagation();
        if(menu.classList.contains('is-open')){ closeMenu(); return; }
        document.body.appendChild(menu);
        menu.classList.add('is-open');
        const box = button.getBoundingClientRect();
        const width = menu.offsetWidth || 124;
        const height = menu.offsetHeight || 0;
        const vw = (window && window.innerWidth) || 0;
        const vh = (window && window.innerHeight) || 0;
        const left = Math.min(Math.max(box.right - width, 8), Math.max(8, vw - width - 8));
        let top = box.bottom + 2;
        if(height && top + height > vh - 8) top = Math.max(8, box.top - height - 2);
        menu.style.left = Math.round(left) + 'px';
        menu.style.top = Math.round(top) + 'px';
        document.addEventListener('mousedown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
    };
    wrap.appendChild(button);
    cell.appendChild(wrap);
}

/* 手动素材：一格可以放多张（点「新增」就往后追加）。
   老画布里存的是单个对象，按 1 张处理。 */
function tableManualInputList(node, channelId, row){
    const store = tableManualInputStore(node, false);
    const byRow = store ? store[String(channelId)] : null;
    const value = byRow ? byRow[String(row)] : null;
    if(!value) return [];
    return (Array.isArray(value) ? value : [value]).filter(item => item && item.url);
}

/* 只换这一格里的第 index 张（「替换」是单张替换，不是整格替换）。
   没有手动列表（素材来自连线）时退回整格替换。 */
function replaceTableManualInputItem(node, channelId, row, index, value){
    if(!value || !value.url) return;
    const list = tableManualInputList(node, channelId, row);
    if(!(index >= 0 && index < list.length)) return setTableManualInputItem(node, channelId, row, value);
    const next = list.slice();
    next[index] = {url:value.url, mediaType:value.mediaType || 'image', name:value.name || ''};
    setTableManualInputItem(node, channelId, row, null);
    const store = tableManualInputStore(node, true);
    const key = String(channelId);
    const byRow = store[key] && typeof store[key] === 'object' ? store[key] : (store[key] = {});
    byRow[String(row)] = next;
    scheduleSave();
}

/* 删掉这一格里的第 index 张（不动别的） */
function removeTableManualInputItem(node, channelId, row, index){
    const list = tableManualInputList(node, channelId, row);
    if(!(index >= 0 && index < list.length)) return;
    const next = list.slice();
    next.splice(index, 1);
    setTableManualInputItem(node, channelId, row, null);
    if(next.length){
        const store = tableManualInputStore(node, true);
        const key = String(channelId);
        const byRow = store[key] && typeof store[key] === 'object' ? store[key] : (store[key] = {});
        byRow[String(row)] = next;
    }
    scheduleSave();
}

function addTableManualInputItem(node, channelId, row, value){
    if(!value || !value.url) return;
    const list = tableManualInputList(node, channelId, row);
    setTableManualInputItem(node, channelId, row, null);
    const store = tableManualInputStore(node, true);
    const key = String(channelId);
    const byRow = store[key] && typeof store[key] === 'object' ? store[key] : (store[key] = {});
    byRow[String(row)] = list.concat([{url:value.url, mediaType:value.mediaType || 'image', name:value.name || ''}]);
    scheduleSave();
}

/* 单元格文本里的 @图片N / @视频N：指向**同一行**的素材时直接渲染成缩略图，
   对不上的引用原样留着（和提示词重写一个原则：绝不静默吞掉）。 */
function renderTableCellText(view, text, mediaList){
    const model = novaTableModel();
    const source = String(text || '');
    const byOrdinal = new Map();
    (mediaList || []).forEach(item => {
        if(item && item.url && Number.isFinite(Number(item.ordinal))) byOrdinal.set(Number(item.ordinal), item);
    });
    if(!model || !byOrdinal.size){ view.textContent = source; return; }
    let cursor = 0;
    source.replace(model.MENTION_RE, (token, label, digits, offset) => {
        const hit = byOrdinal.get(Number(digits));
        if(!hit || model.mentionLabel(hit.kind) !== label) return token;
        if(offset > cursor) view.appendChild(document.createTextNode(source.slice(cursor, offset)));
        const chip = document.createElement('span');
        chip.className = 'table-cell-mention';
        chip.title = token;
        const thumb = document.createElement('span');
        thumb.className = 'table-media-thumb';
        thumb.innerHTML = hit.kind === 'video' ? canvasVideoPreviewHtml(hit.url) : canvasPreviewImgHtml(hit.url, 36);
        chip.appendChild(thumb);
        view.appendChild(chip);
        cursor = offset + token.length;
        return token;
    });
    if(cursor < source.length) view.appendChild(document.createTextNode(source.slice(cursor)));
}

// 双击媒体格看大图
function bindTableCellMediaView(cell, url, mediaType){
    if(!url) return;
    cell.ondblclick = event => { event.stopPropagation(); openTableCellMedia(url, mediaType); };
}

/* 数据列里的媒体格：直接存进 rows（走模型的 set_cell，模型认得媒体对象，不会被 JSON 化）。
   value 传 null 就是删除，格子回到空文字。 */
function setTableCellMedia(node, row, column, value){
    const model = novaTableModel();
    const state = ensureTableState(node);
    if(!model || !state) return;
    const next = value ? model.mediaCell(value.url, value.mediaType, value.name) : '';
    node.table = model.applyOperation(state, 'set_cell', {row: row + 1, column: column + 1, value: next});
    scheduleSave();
    repaintTable(node);
}

/* 把上游来源展开成输入项。
   - group 展开成它的成员素材（一个 group = 一个通道，多张）
   - output 展开成它产出的每一张（一个 output = 一个通道，多张）
   - 单个素材节点就是一列一项
   - 纯文本节点（prompt / llm）返回空 → 走 Ip(t) 参与提示词，两者不重复计入 */
/* 存媒体的节点类型：经典画布的 output、智能画布的 smart-image 都是把素材放在 images 数组里，
   形状一致 → 一起按输出节点展开。 */
const TABLE_OUTPUT_LIKE_TYPES = ['output', 'smart-image'];

function tableSourceItems(source, byId){
    if(!source) return [];
    const lookup = byId ? (id => byId.get(id)) : (id => (nodes || []).find(item => item.id === id));
    /* 分组：经典画布是 group，智能画布是 smart-group（items 字段一样）。
       成员也必须用同一张类型表展开 —— 智能画布「上传的图先归成一个分组、再把分组接到 LLM 节点」
       是常见用法，之前只认 type === 'group'，且成员只认 output / 顶层 url，
       导致整个分组被忽略（用户报的「多维表格读取不到上传的图片/视频」）。 */
    if(source.type === 'group' || source.type === 'smart-group'){
        // 组里也可能放进一个输出/素材节点：同样要展开成它产出的每一张
        const fromMembers = (source.items || [])
            .map(lookup)
            .filter(Boolean)
            .flatMap(item => TABLE_OUTPUT_LIKE_TYPES.includes(item.type)
                ? outputSourceItems(item)
                : (item.url ? [{type:'media', nodeId:item.id}] : []));
        /* 智能画布的分组会把拖进去的图片「吸收」进 group.images（成员节点被删掉），
           所以除了 items 里的成员，还要展开分组自己的 images —— 否则把图片归组后再接 LLM 节点，
           整组素材读不到（用户报的「多维表格读取不到上传的图片/视频」）。 */
        const fromGroupImages = source.type === 'smart-group' ? outputSourceItems(source) : [];
        return [...fromGroupImages, ...fromMembers];
    }
    if(TABLE_OUTPUT_LIKE_TYPES.includes(source.type)) return outputSourceItems(source);
    if(source.url) return [{type:'media', nodeId:source.id}];
    return [];
}

function tableSourceIsMedia(source, byId){ return tableSourceItems(source, byId).length > 0; }

// 上游连来的纯文本（DX OS: Ip(t)）
function tableUpstreamTexts(node, byId){
    const lookup = byId || new Map((nodes || []).map(item => [item.id, item]));
    return tableIncomingConnections(node)
        .map(conn => lookup.get(conn.from))
        .filter(source => source && !tableSourceIsMedia(source, lookup) && typeof source.text === 'string')
        .map(source => source.text.trim())
        .filter(Boolean);
}

// 该通道该行落到哪个素材上（DX OS: wl / Od）
function tableInputEntryAt(node, channel, row, nodeById){
    const model = novaTableModel();
    if(!model) return null;
    const item = model.inputItemAt(channel, row);
    if(!item) return null;
    if(item.type === 'text') return item.text ? {kind:'text', text:item.text, nodeId:''} : null;
    const source = item.nodeId
        ? (nodeById ? nodeById.get(item.nodeId) : (nodes || []).find(entry => entry.id === item.nodeId))
        : null;
    /* 输出节点来的条目自己带 url（一个输出节点可以连来好几张），类型看 url。
       这条必须排在 source.url 前面 —— 输出节点压根没有 url。 */
    const itemUrl = String(item.url || '');
    if(itemUrl){
        const index = Number(item.outputIndex);
        return {
            kind: mediaKindForRef({url:itemUrl}),
            url: itemUrl,
            nodeId: source ? source.id : String(item.nodeId || ''),
            node: source || null,
            outputIndex: Number.isFinite(index) && index >= 0 ? index : -1
        };
    }
    if(!source) return null;
    if(source.url) return {kind: mediaKindForNode(source), url: source.url, nodeId: source.id, node: source};
    if(source.text) return {kind:'text', text: source.text, nodeId: source.id, node: source};
    return null;
}

/* Co(t)：通道从入边推导（连线用 toPort 定位通道，没有 toPort 的落到第一通道）。
   tableInputChannelCount 让用户手动多开几列当放置目标。 */
function ensureTableChannels(node, byId){
    const model = novaTableModel();
    if(!model) return [];
    const lookup = byId || new Map((nodes || []).map(item => [item.id, item]));
    const buckets = new Map();
    tableIncomingConnections(node).forEach(conn => {
        const source = lookup.get(conn.from);
        const entries = tableSourceItems(source, lookup);
        if(!entries.length) return;   // 文本节点不进输入列
        const index = model.channelIndexFromId(conn.toPort);
        const key = index >= 0 ? index : 0;
        if(!buckets.has(key)) buckets.set(key, []);
        entries.forEach(entry => {
            if(!buckets.get(key).some(item => tableItemKey(item) === tableItemKey(entry))) buckets.get(key).push(entry);
        });
    });
    const declared = Math.max(0, Number(node.tableInputChannelCount) || 0);
    const highest = buckets.size ? Math.max.apply(null, Array.from(buckets.keys())) + 1 : 0;
    const count = Math.max(1, declared, highest);
    const manualModes = node.tableInputChannelModes && typeof node.tableInputChannelModes === 'object' ? node.tableInputChannelModes : {};
    const channels = [];
    for(let index = 0; index < count; index += 1){
        const id = model.channelIdAt(index);
        const items = (buckets.get(index) || []).map(entry => tableChannelItem(entry));
        const manual = manualModes[id];
        channels.push({
            id,
            // 手动值优先（表头可切换，物化时也会按规划写入），否则默认「沿用」
            mode: model.CHANNEL_MODES.includes(manual) ? manual : model.channelModeFor(items),
            items
        });
    }
    node.tableInputChannels = channels;
    return channels;
}

/* Pu(t)：逐行汇总。一次算完该行的输入媒体/文本 + 数据列值 + 组装后的提示词。
   「全部」模式的通道整列都上，所以 channelItems[i]（第 i 个通道的这一行）是**数组**。
   提示词里的 @图片N 在这里从「全局输入序号」重写成「该行参考图内的序号」：
   模型是照着全局清单写的序号，不重写的话 @图片4 这类引用在生成时全是悬空的。 */
/* 提示词里没被提到的参考素材，在末尾补一行清单：参考图：@图片1、@图片2、@图片3。
   只在该行有两张以上素材、且确实有没被提到的时候才补 —— 单图行保持原样，不啰嗦。
   提示词里的 @图片N 这时已经重编号成「该行内的序号」，所以清单也用同一套序号。 */
function withRowReferenceList(model, text, media){
    const list = Array.isArray(media) ? media : [];
    if(!model || list.length < 2) return text;
    const mentioned = new Set(model.mentionsIn(text).map(mention => Number(mention.index) + 1));
    // 提示词里一张都没提到：那是用户/模型的写法，不硬塞清单（只补「提到了但漏了几张」的情况）
    if(!mentioned.size) return text;
    const tokens = list.map((entry, index) => ({
        token: model.mentionTokenAt(entry && entry.kind, index + 1),
        mentioned: mentioned.has(index + 1)
    }));
    if(tokens.every(item => item.mentioned)) return text;
    const line = '参考图：' + tokens.map(item => item.token).join('、');
    return String(text || '').trim() ? String(text).trim() + '\n' + line : line;
}

/* tableRowInputs 的按节点缓存：render() 每帧都会重算批量面板/表格的签名，而
   tableRowInputs 要逐行解析素材 + 重写 @图片N + 拼提示词（O(行×通道×素材)）。
   内容没变时这份重活不该再做一遍，所以用一份便宜且完整的签名做 key 命中即返回。
   key 覆盖入边 / 通道条目与模式 / 手动上传 / 单元格文本 / tablePrompt / 上游文本；
   nodeById 入参按引用比对，外部传入的映射不会串味。 */
const rowInputsCache = new WeakMap();
let rowInputsComputeCount = 0;
let rowInputsHitCount = 0;

function rowsFingerprint(rows){
    return (rows || []).map(row => row.rowNumber + ':' + String(row.prompt || '') + ':'
        + (row.media || []).map(item => item.url).join(';')).join('|');
}

function tableRowInputsKey(node, state, channels, upstreamTexts, byId, explicitById){
    const incoming = tableIncomingConnections(node)
        .map(conn => String(conn.from || '') + '>' + String(conn.toPort || ''))
        .sort().join(',');
    const channelKey = (channels || []).map(channel => {
        const items = (channel.items || []).map(item => {
            const source = item.nodeId ? byId.get(item.nodeId) : null;
            return tableItemKey(item) + ':' + String(item.url || (source && source.url) || '')
                + ':' + String((source && source.text) || '');
        }).join('+');
        return channel.id + '=' + channel.mode + '[' + items + ']';
    }).join('|');
    return [
        incoming,
        (channels || []).length,
        channelKey,
        JSON.stringify(node.tableManualInputItems || {}),
        String(node.tablePrompt || ''),
        (upstreamTexts || []).join('\u0001'),
        JSON.stringify(state.columns || []),
        JSON.stringify(state.rows || []),
        explicitById ? 'byId' : ''
    ].join('~');
}

function tableRowInputs(node, options={}){
    const model = novaTableModel();
    const state = ensureTableState(node);
    if(!model || !state) return [];
    const explicitById = options.nodeById || null;
    const byId = explicitById || new Map((nodes || []).map(item => [item.id, item]));
    const channels = ensureTableChannels(node, byId);
    const upstreamTexts = tableUpstreamTexts(node, byId);
    const key = tableRowInputsKey(node, state, channels, upstreamTexts, byId, explicitById);
    const cached = rowInputsCache.get(node);
    if(cached && cached.key === key && cached.byId === explicitById){
        rowInputsHitCount += 1;
        return cached.rows;
    }
    rowInputsComputeCount += 1;
    const rows = computeTableRowInputs(node, state, model, channels, upstreamTexts, byId);
    rowInputsCache.set(node, {key, rows, byId: explicitById, fingerprint: rowsFingerprint(rows)});
    return rows;
}

/* 缓存命中统计：测试用来证明「内容不变时不重算」。 */
function tableRowInputsStats(){ return {computes: rowInputsComputeCount, hits: rowInputsHitCount}; }
function resetTableRowInputsStats(){ rowInputsComputeCount = 0; rowInputsHitCount = 0; }
function tableRowInputsFingerprint(node){
    const cached = rowInputsCache.get(node);
    return cached ? cached.fingerprint : '';
}

/* 一行只带 1 张主参考图：非「全部」通道里多出来的图会被裁掉，指向它们的
   @图片N 如果留在提示词里，就会指向一张不会发出去的图（模型会去找），还会被
   rewriteMentions 判成悬空、批量执行前拦下整行 —— 所以按序号把它们删掉。
   只删 trimmedOrdinals 里「本行确实取到、只是按一行一张裁掉」的序号；本行根本
   取不到的真正悬空引用不在这个集合里，照旧报出来。类型对不上的 mention 也留着
   （那是真正的引用错误，不能顺带吞掉）。 */
function stripTrimmedMentions(model, prompt, trimmedOrdinals){
    if(!model || !trimmedOrdinals || !trimmedOrdinals.size) return String(prompt || '');
    return String(prompt || '').replace(model.MENTION_RE, (token, label, digits) => {
        const kind = trimmedOrdinals.get(Number(digits));
        return kind && model.mentionLabel(kind) === label ? '' : token;
    });
}

function computeTableRowInputs(node, state, model, channels, upstreamTexts, byId){
    // 每个通道的条目在全局输入清单里的起始序号
    const ordinalBase = [];
    let running = 0;
    channels.forEach(channel => {
        ordinalBase.push(running);
        running += (channel.items || []).length;
    });

    return state.rows.map((row, rowIndex) => {
        const channelItems = channels.map((channel, channelIndex) => {
            /* 手动上传的那一格优先：它就是这一行这一列的参考图。 */
            const manual = tableManualInputList(node, channel.id, rowIndex);
            if(manual.length){
                return manual.map((item, offset) => ({
                    // 认上传时记下的类型：素材地址不一定带后缀
                    kind: mediaKindForRef({url:item.url, kind:item.mediaType}),
                    url: item.url,
                    nodeId: '',
                    node: null,
                    outputIndex: -1,
                    ordinal: ordinalBase[channelIndex] + 1 + offset
                }));
            }
            return model
                .inputItemsForRow(channel, rowIndex)
                .map(item => {
                    const entry = tableInputEntryAt(node, {items:[item]}, 0, byId);
                    if(!entry) return null;
                    // 输出节点连来的多张图 nodeId 相同，只能按 nodeId + url + outputIndex 认人
                    const position = (channel.items || []).findIndex(candidate =>
                        candidate === item || tableItemKey(candidate) === tableItemKey(item));
                    return {...entry, ordinal: ordinalBase[channelIndex] + Math.max(0, position) + 1};
                })
                .filter(Boolean);
        });

        const media = [];
        const texts = [];
        const references = [];
        const ordinalMap = new Map();
        /* 一行只要 1 张主参考图：非「全部」的通道（含手动上传的那一格）整行合计
           只保留最先遇到的那一张，其余裁掉；「全部」（多角度）通道的整组照旧全带。
           多个非 all 通道也只合计留一张 —— 用户口径是一行一张主参考图，不是一列一张。 */
        const trimmedOrdinals = new Map();
        let keptMain = false;
        channelItems.forEach((list, channelIndex) => {
            const keepWholeGroup = channels[channelIndex].mode === 'all';
            list.forEach(entry => {
                if(entry.kind === 'text'){
                    if(String(entry.text || '').trim()) texts.push(String(entry.text).trim());
                    return;
                }
                if(!keepWholeGroup && keptMain){
                    trimmedOrdinals.set(entry.ordinal, entry.kind);
                    return;
                }
                if(!keepWholeGroup) keptMain = true;
                // 该行内的 1-based 参考图序号，就是重写后的 @图片N
                ordinalMap.set(entry.ordinal, {position: media.length + 1, kind: entry.kind});
                media.push(entry);
                references.push({kind: entry.kind, nodeId: entry.nodeId, ordinal: entry.ordinal});
            });
        });

        const rowText = model.buildRowPrompt(texts, '', state.columns
            .map((name, columnIndex) => model.cellText(row[columnIndex]))
            .filter(value => value.trim()).join('\n'));
        const rawPrompt = model.buildRowPrompt(upstreamTexts, node.tablePrompt || '', rowText);
        const rewritten = model.rewriteMentions(stripTrimmedMentions(model, rawPrompt, trimmedOrdinals), ordinalMap);
        /* 这一行真正会发出去的素材清单：模型写的提示词常常只 @ 了其中一张
           （「全部」的组一行带整组，提示词里却只出现一张）→ 用户以为「只读取了一张」。
           末尾补一行显式清单，提示词、批量面板、结果节点上都能看到整组。 */
        const prompt = withRowReferenceList(model, rewritten.text, media);
        return {
            rowNumber: rowIndex + 1,
            channelItems,
            entries: channelItems.map(list => list[0] || null),
            media,
            text: rowText,
            references,
            prompt,
            rawPrompt,
            // 该行引用了它拿不到的素材：批量执行前必须拦下来，不能静默发出去
            danglingMentions: rewritten.dangling
        };
    });
}

function tableChannelModeLabel(mode){
    const model = novaTableModel();
    return model ? model.channelModeLabel(mode) : mode;
}

// 表头点一下循环：逐行 → 全部 → 沿用 → 逐行（顺序取模型的 CHANNEL_MODES）
function toggleTableChannelMode(node, channelIndex){
    const model = novaTableModel();
    const channels = ensureTableChannels(node);
    const channel = channels[channelIndex];
    if(!model || !channel) return;
    const cycle = model.CHANNEL_MODES;
    const modes = node.tableInputChannelModes && typeof node.tableInputChannelModes === 'object' ? node.tableInputChannelModes : {};
    modes[channel.id] = cycle[(Math.max(0, cycle.indexOf(channel.mode)) + 1) % cycle.length];
    node.tableInputChannelModes = modes;
    scheduleSave();
    repaintTable(node);
}

function addTableInputChannel(node){
    node.tableInputChannelCount = ensureTableChannels(node).length + 1;
    scheduleSave();
    repaintTable(node);
}

// 落在表格某个输入列上松手 → 把这条连线绑到那一列（DX OS 的 toPort）
function tableDropPortFor(hitEl, targetId){
    const target = (nodes || []).find(item => item.id === targetId);
    if(!target || target.type !== 'table') return '';
    const cell = hitEl && hitEl.closest ? hitEl.closest('.table-media-cell') : null;
    return cell && cell.dataset.channel ? cell.dataset.channel : '';
}

function connectNodes(fromId, toId, toPort){
    const port = toPort || '';
    if((connections || []).some(conn => conn.from === fromId && conn.to === toId && String(conn.toPort || '') === port)) return false;
    pushUndo();
    const conn = {id:uid('c'), from:fromId, to:toId};
    if(port) conn.toPort = port;
    connections.push(conn);
    return true;
}

/* 重绘签名：入边 / 通道数 / 输入列内容与模式 / 行列数。
   输入列的**条目**也要进签名 —— 分组里增删了素材、或者某张图跑完才拿到 url 时，
   入边和行列数都没变；只比连线的话表格永远不会重绘，表现就是「图片数量对不上」：
   表头写着 4 张，单元格里只有 2 张（第一次绘制时它们还没有 url）。
   模式同理：落在签名里，外部改完模式不显式 repaintTable 也不会留下过期画面。 */
function tableNodeSignature(node){
    const state = ensureTableState(node);
    if(!state) return '';
    const incoming = tableIncomingConnections(node)
        .map(conn => conn.from + '>' + String(conn.toPort || ''))
        .sort().join(',');
    const byId = new Map((nodes || []).map(item => [item.id, item]));
    const channels = ensureTableChannels(node);
    const items = channels.map(channel => (channel.items || []).map(item => {
        const source = item.nodeId ? byId.get(item.nodeId) : null;
        // 输出节点的条目自带 url（节点本身没有），优先用条目上的
        return item.nodeId + ':' + String(item.url || (source && source.url) || '');
    }).join('+')).join('|');
    const modes = channels.map(channel => channel.id + '=' + channel.mode).join(',');
    // 手动上传进格子的素材也在签名里：改完不用显式 repaintTable 也不会留旧画面
    const manual = JSON.stringify(node.tableManualInputItems || {});
    return [incoming, channels.length, items, modes, manual, state.columns.length, state.rows.length].join('|');
}

// 输入列单元格（DX OS: .table-media-cell）
function tableMediaThumb(entry){
    if(entry.kind === 'text'){
        const text = document.createElement('span');
        text.className = 'table-media-text';
        text.textContent = entry.text;
        return text;
    }
    if(isMissingAssetUrl(entry.url)){
        const missing = document.createElement('span');
        missing.className = 'table-media-missing';
        missing.textContent = '文件缺失';
        return missing;
    }
    const thumb = document.createElement('div');
    thumb.className = 'table-media-thumb';
    if(entry.kind === 'video') thumb.innerHTML = canvasVideoPreviewHtml(entry.url, 256, 'draggable="false"');
    else if(entry.kind === 'audio') thumb.textContent = '音频';
    else thumb.innerHTML = canvasPreviewImgHtml(entry.url, 256, 'draggable="false"');
    return thumb;
}

/* 「全部」模式的通道一行会有多张，所以这里收数组。
   一张时直接放，多张时套一层 stack 让它换行排开。 */
function fillTableMediaCell(cell, entries){
    const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
    if(!list.length){
        cell.classList.add('is-empty');
        return;
    }
    if(list.length === 1){
        cell.appendChild(tableMediaThumb(list[0]));
        return;
    }
    const stack = document.createElement('div');
    stack.className = 'table-media-stack';
    list.forEach(entry => stack.appendChild(tableMediaThumb(entry)));
    cell.appendChild(stack);
}

/* ────────────────── 表格批量执行（DX OS §4/§5）────────────────── */

// 生成节点的上游表格（DX OS: lb(t)）
function generatorUpstreamTables(genId){
    return (connections || [])
        .filter(conn => conn && conn.to === genId)
        .map(conn => (nodes || []).find(item => item.id === conn.from))
        .filter(source => source && source.type === 'table');
}

// 表格某行的媒体 → 生成器要的 refs
function tableRowRefs(row){
    return (Array.isArray(row && row.media) ? row.media : []).map(entry => {
        const ref = {
            url: entry.url,
            name: (entry.node && (entry.node.name || entry.node.text)) || entry.kind || 'ref',
            kind: entry.kind || 'image',
            nodeId: entry.nodeId || ''
        };
        // 输出节点来的素材带 outputIndex：临时图床上传后要按这个下标回写原图
        const index = Number(entry.outputIndex);
        if(Number.isFinite(index) && index >= 0) ref.outputIndex = index;
        return ref;
    }).filter(ref => ref.url);
}

// 素材校验：本地缺文件的挑出来，别发出去再失败
function tableRowMaterialIssues(row){
    return (Array.isArray(row && row.media) ? row.media : [])
        .filter(entry => entry && entry.url && isMissingAssetUrl(entry.url))
        .map(entry => ({rowNumber: row.rowNumber, nodeId: entry.nodeId || '', reason: 'missing'}));
}

// 批量执行里绝不能用 alert/showErrorModal：阻塞式弹窗会把并发直接退化成串行
function notifyCanvas(text){
    if(window.NovaUtils && typeof NovaUtils.showToast === 'function') NovaUtils.showToast(text);
    else console.log('[table] ' + text);
}

/* 清掉存进画布的历史固定高度（早期物化时按 DX OS 规范设过 max(320, ...+行数*88)），
   表格默认随内容高度，不会留白。
   用户手动拉过高度的（tableHeightUserSet）保留 —— 那是他要的尺寸。
   和 renderNode 里 rh 节点清理旧默认高度是同一个套路。 */
function normalizeTableNodeHeight(node){
    if(!node || node.type !== 'table') return false;
    if(node.h && !node.tableHeightUserSet){
        delete node.h;
        return true;
    }
    return false;
}

/* 生成 / 视频节点同理：默认由内容决定高度，底部不留一大片空白。
   存进画布的老固定高度（早期默认值）直接清掉；
   用户自己拉过的（tableHeightUserSet，拖 resize 手柄时任何节点都会置位）保留 —— 那是他要的尺寸。 */
function normalizeContentHeightNode(node){
    if(!node) return false;
    if(node.type !== 'generator' && node.type !== 'video') return false;
    if(node.h && !node.tableHeightUserSet){
        delete node.h;
        return true;
    }
    return false;
}

/* 生成节点接了多维表格时，主按钮位拆成两个：
   「批量生成」走表格逐行，「单张生成」沿用原来的单次生成逻辑（不看表格）。
   没接表格就一个按钮都不变。 */
function tableBatchRunButtonHtml(node){
    if(!generatorUpstreamTables(node.id).length) return '';
    return '<button class="table-batch-run-btn" type="button" title="按多维表格逐行批量生成">'
        + '<i data-lucide="table" class="w-4 h-4"></i>批量生成</button>';
}

function tableBatchSingleLabel(node){
    if(!generatorUpstreamTables(node.id).length) return node.type === 'video' ? tr('canvas.videoGenerate') : tr('canvas.apiGenerate');
    return node.type === 'video' ? '单段生成' : '单张生成';
}

/* 主运行按钮（单张/单段）。接了多维表格时**整个去掉**：
   表格驱动只有「批量生成」这一条路，这个按钮不读表格，留着只会误点
   （点下去只会撞上「请先连接提示词」）。绑定处也要跟着判空。 */
function tableBatchSingleButtonHtml(node){
    if(generatorUpstreamTables(node.id).length) return '';
    const video = node.type === 'video';
    const label = node.running ? tr('canvas.generating') : tableBatchSingleLabel(node);
    return '<button class="gen-btn' + (node.running ? ' running' : '') + '"' + (node.running ? ' disabled' : '') + '>'
        + '<i data-lucide="' + (video ? 'clapperboard' : 'zap') + '" class="w-4 h-4"></i>' + label + '</button>';
}

/* 表格批量执行的生效并发。
   视频又慢又贵，未显式设置时默认串行（1），图像沿用 3。
   面板显示和真正执行都走这里，避免「显示 3、实际跑 1」。 */
function tableBatchConcurrencyFor(gen, table){
    const model = novaTableModel();
    const fallback = gen && gen.type === 'video' ? 1 : model.DEFAULT_BATCH_CONCURRENCY;
    return model.batchConcurrency(table && table.tableBatchConcurrency, fallback);
}

/* 表格批量执行调哪个运行器：图像走 runGenerator，视频走 runVideoNode。 */
function tableBatchRunner(node){
    return node && node.type === 'video' ? runVideoNode : runGenerator;
}

/* 供应商错误体有时是整段原始 JSON（例如 Agnes 的 {"error":{"message":"..."}}）。
   把原始 JSON 塞进批量摘要没人看得懂，能抽就抽出可读的那一句。 */
function friendlyBatchError(message){
    const text = String(message === undefined || message === null ? '' : message).trim();
    if(!text || (text.charAt(0) !== '{' && text.charAt(0) !== '[')) return text;
    try {
        const parsed = JSON.parse(text);
        const inner = (parsed && parsed.error && (parsed.error.message || parsed.error.msg))
            || (parsed && typeof parsed.error === 'string' ? parsed.error : '')
            || (parsed && (parsed.detail || parsed.message)) || '';
        if(inner) return String(inner);
    } catch(error){ /* 不是 JSON，原样返回 */ }
    return text;
}

/* 接了多维表格、却走了「单张/单段生成」这条路时的提示。
   这条路**不看表格**，直接报「请先连接提示词」会让用户不知道该点哪儿，
   所以表格在的时候要说清该点「批量生成」。 */
function generatorNeedsPromptMessage(node){
    if(generatorUpstreamTables(node.id).length){
        const single = node && node.type === 'video' ? '单段生成' : '单张生成';
        return '已连接多维表格：请点「批量生成」按表格逐行生成；「' + single + '」不看表格，需要单独连一个提示词节点。';
    }
    return node && node.type === 'video' ? tr('canvas.videoNeedsPrompt') : tr('canvas.needPromptOrImage');
}

/* 生成节点由多维表格驱动时，节点自己的 IMAGES 区块没有意义 ——
   表格的素材不走这里，批量生成用的是每一行自己的参考图。
   注意 .input-list 是 display:flex，hidden 属性会被作者样式覆盖，所以用内联样式。 */
function tableDrivenHidden(node){
    return generatorUpstreamTables(node.id).length ? ' style="display:none"' : '';
}

function repaintBatchPanel(gen){
    const host = nodesEl ? nodesEl.querySelector('.node[data-id="' + gen.id + '"]') : null;
    const panel = host ? host.querySelector('[data-table-batch-panel]') : null;
    if(panel) paintTableBatchPanel(panel, gen);
}

/* 手动模式的选中行直接用表格当前的勾选状态。
   不另存 tableBatchSelectedRows 快照——快照会和用户在表格里改的勾选脱节。 */
function tableBatchSelection(table){
    const manual = Boolean(table.tableBatchManualSelection);
    const rows = table.table && Array.isArray(table.table.selectedRows) ? table.table.selectedRows : [];
    return {manual, selectedRows: rows};
}

/* 批量面板（DX OS §10：面板挂在生成节点上，读它的上游表格） */
function renderTableBatchPanel(gen){
    if(!novaTableModel()) return null;
    if(!generatorUpstreamTables(gen.id).length) return null;
    const panel = document.createElement('div');
    panel.className = 'table-batch-panel';
    panel.dataset.tableBatchPanel = '1';
    paintTableBatchPanel(panel, gen);
    return panel;
}

/* 批量面板的重绘签名：内容没变就不重建 DOM。
   面板每行 5–6 个元素（还带缩略图），节点一多每次 render 都重建会明显卡
   （用户报的「画布出现 4 个以上多维表格就开始卡顿」）。 */
function tableBatchPanelSignature(gen, table, rows){
    const resolvedRows = rows || tableRowInputs(table);
    const selection = tableBatchSelection(table);
    return [
        tableNodeSignature(table),
        table.title || '',
        gen._batchRunning ? '1' : '0',
        JSON.stringify(gen._batchProgress || null),
        String(gen._batchLastMessage || ''),
        String(table.tableBatchStartRow || ''),
        String(table.tableBatchConcurrency || ''),
        String(table.tableBatchFailurePolicy || ''),
        table.tableBatchSequential ? '1' : '0',
        selection.manual ? 'm' : '',
        selection.selectedRows.join(','),
        tableRowInputsFingerprint(table) || rowsFingerprint(resolvedRows),
        JSON.stringify((table.generationBatchJournal || {}).rows || [])
    ].join('~');
}

function paintTableBatchPanel(panel, gen){
    const model = novaTableModel();
    const tables = generatorUpstreamTables(gen.id);
    if(!model || !tables.length){ panel.textContent = ''; panel.dataset.batchSignature = ''; return; }
    const table = tables[0];
    const rows = tableRowInputs(table);
    const signature = tableBatchPanelSignature(gen, table, rows);
    if(panel.dataset.batchSignature === signature) return;
    panel.dataset.batchSignature = signature;
    const selection = tableBatchSelection(table);
    const startRow = model.batchStartRow(table.tableBatchStartRow, rows.length);
    const concurrency = tableBatchConcurrencyFor(gen, table);
    const failurePolicy = model.batchFailurePolicy(table.tableBatchFailurePolicy);
    const runnable = model.batchRowsToRun(rows, {manual: selection.manual, startRow, selectedRows: selection.selectedRows});
    const journal = model.normalizeJournal(table.generationBatchJournal);
    const completed = model.journalCompletedRows(journal).length;
    const failed = model.journalFailedRows(journal).length;
    const cancelled = typeof model.journalCancelledRows === 'function' ? model.journalCancelledRows(journal).length : 0;
    const inflight = model.journalInflightRows(journal).length;
    const running = Boolean(table.tableBatchRunning);

    panel.textContent = '';

    // 头：生成输入 + 源表格名（DX OS §10）
    const head = document.createElement('div');
    head.className = 'table-batch-head';
    const title = document.createElement('span');
    title.className = 'table-batch-title';
    title.textContent = '生成输入';
    head.appendChild(title);
    const source = document.createElement('span');
    source.className = 'table-batch-source';
    source.textContent = table.title || '多维表格';
    head.appendChild(source);
    panel.appendChild(head);

    // 状态行：批量 N 行 · 首批 X ｜ 独立运行 · 已选 A/B ｜ 图片 N
    /* 行列表按模式决定显示范围：
       批量模式只看「起始行」之后的（前面的行不会执行，显示出来只会干扰）；
       独立运行要靠列表勾选，所以全部显示 —— 藏掉前面的行就没法选了。 */
    const visibleRows = rows
        .map((row, rowIndex) => ({row, rowIndex}))
        .filter(item => selection.manual || item.row.rowNumber >= startRow);

    const status = document.createElement('div');
    status.className = 'table-batch-status';
    const batchText = document.createElement('span');
    batchText.textContent = '批量 ' + visibleRows.length + ' 行 · 首批 ' + Math.min(runnable.length, concurrency);
    status.appendChild(batchText);
    if(!selection.manual && visibleRows.length < rows.length){
        const startHint = document.createElement('span');
        startHint.textContent = '已从第 ' + startRow + ' 行起';
        status.appendChild(startHint);
    }
    const pickedText = document.createElement('span');
    pickedText.textContent = (selection.manual ? '独立运行 · ' : '')
        + '已勾选 ' + selection.selectedRows.length + '/' + rows.length;
    status.appendChild(pickedText);
    if(table.tableBatchSequential){
        const seqText = document.createElement('span');
        seqText.className = 'table-batch-status-seq';
        seqText.textContent = '依次生成';
        status.appendChild(seqText);
    }
    const mediaTotal = rows.reduce((total, row) => total + (row.media || []).length, 0);
    if(mediaTotal){
        const mediaText = document.createElement('span');
        mediaText.textContent = '图片 ' + mediaTotal;
        status.appendChild(mediaText);
    }
    const progressText = [
        completed ? '已完成 ' + completed : '',
        failed ? '失败 ' + failed : '',
        cancelled ? '已取消 ' + cancelled : '',
        inflight ? '后台 ' + inflight : ''
    ].filter(Boolean).join(' · ');
    if(progressText){
        const progress = document.createElement('span');
        progress.className = 'table-batch-status-progress';
        progress.textContent = progressText;
        status.appendChild(progress);
    }
    panel.appendChild(status);

    /* 行列表：行号 + 该行参考图 + 该行真正会发出去的提示词。
       点整行＝切换这一行在表格里的勾选（与「独立运行」配合）。 */
    const rowList = document.createElement('div');
    rowList.className = 'table-batch-list';
    const selectedSet = new Set(selection.selectedRows.map(Number));
    visibleRows.forEach(item => {
        const row = item.row;
        const rowIndex = item.rowIndex;
        const article = document.createElement('article');
        article.className = 'table-batch-row';
        if(selectedSet.has(rowIndex)) article.classList.add('is-selected');
        article.title = '点击切换这一行的勾选';

        const badge = document.createElement('b');
        badge.className = 'table-batch-row-num';
        badge.textContent = String(row.rowNumber);
        article.appendChild(badge);

        const thumbs = document.createElement('div');
        thumbs.className = 'table-batch-row-media';
        const mediaList = (row.media || []).filter(entry => entry && entry.kind !== 'text');
        if(mediaList.length){
            mediaList.forEach(entry => {
                const box = document.createElement('span');
                box.appendChild(tableMediaThumb(entry));
                thumbs.appendChild(box);
            });
        } else {
            const empty = document.createElement('span');
            empty.className = 'is-empty';
            empty.textContent = '无素材';
            thumbs.appendChild(empty);
        }
        article.appendChild(thumbs);

        const preview = document.createElement('p');
        preview.textContent = String(row.prompt || '').trim() || '仅媒体输入';
        article.appendChild(preview);

        // 勾选＝执行这一行，取消＝跳过（两种模式都适用）。放在最右，和表格里的勾选框一致
        const pick = document.createElement('input');
        pick.type = 'checkbox';
        pick.className = 'table-checkbox';
        pick.checked = selectedSet.has(rowIndex);
        pick.title = '勾选＝执行这一行，取消＝跳过';
        pick.onclick = event => event.stopPropagation();
        pick.onchange = event => {
            event.stopPropagation();
            toggleTableRow(table, rowIndex, pick.checked);
            paintTableBatchPanel(panel, gen);
        };
        article.appendChild(pick);

        article.onclick = event => {
            event.stopPropagation();
            const nowPicked = !selectedSet.has(rowIndex);
            toggleTableRow(table, rowIndex, nowPicked);
            paintTableBatchPanel(panel, gen);
        };
        rowList.appendChild(article);
    });
    panel.appendChild(rowList);

    const controls = document.createElement('div');
    controls.className = 'table-batch-controls';

    const startField = document.createElement('label');
    startField.className = 'table-batch-field';
    const startText = document.createElement('span');
    startText.textContent = '起始行';
    startField.appendChild(startText);
    const startInput = document.createElement('input');
    startInput.type = 'number';
    startInput.min = '1';
    startInput.max = String(Math.max(1, rows.length));
    startInput.value = String(startRow);
    startInput.className = 'table-batch-input';
    startInput.onchange = () => {
        table.tableBatchStartRow = model.batchStartRow(startInput.value, rows.length);
        scheduleSave();
        paintTableBatchPanel(panel, gen);
    };
    startField.appendChild(startInput);
    controls.appendChild(startField);

    const concurrencyField = document.createElement('label');
    concurrencyField.className = 'table-batch-field';
    const concurrencyText = document.createElement('span');
    concurrencyText.textContent = '并发';
    concurrencyField.appendChild(concurrencyText);
    const concurrencySelect = document.createElement('select');
    concurrencySelect.className = 'table-batch-input';
    for(let value = 1; value <= model.MAX_BATCH_CONCURRENCY; value += 1){
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = String(value);
        concurrencySelect.appendChild(option);
    }
    concurrencySelect.value = String(concurrency);
    concurrencySelect.onchange = () => {
        table.tableBatchConcurrency = model.batchConcurrency(concurrencySelect.value);
        scheduleSave();
        paintTableBatchPanel(panel, gen);
    };
    /* 「依次生成」模式下并发固定 1（这一行的设置先留着，取消模式后恢复） */
    if(table.tableBatchSequential){
        concurrencySelect.disabled = true;
        concurrencyField.title = '「依次生成」模式下固定一行一行跑';
    }
    concurrencyField.appendChild(concurrencySelect);
    controls.appendChild(concurrencyField);

    const policyField = document.createElement('label');
    policyField.className = 'table-batch-field';
    const policyText = document.createElement('span');
    policyText.textContent = '出错';
    policyField.appendChild(policyText);
    const policySelect = document.createElement('select');
    policySelect.className = 'table-batch-input';
    [['continue', '继续跑完'], ['stop', '立即停止']].forEach(pair => {
        const option = document.createElement('option');
        option.value = pair[0];
        option.textContent = pair[1];
        policySelect.appendChild(option);
    });
    policySelect.value = failurePolicy;
    policySelect.onchange = () => {
        table.tableBatchFailurePolicy = model.batchFailurePolicy(policySelect.value);
        scheduleSave();
    };
    policyField.appendChild(policySelect);
    controls.appendChild(policyField);
    panel.appendChild(controls);

    const manualRow = document.createElement('label');
    manualRow.className = 'table-batch-manual';
    const manualBox = document.createElement('input');
    manualBox.type = 'checkbox';
    manualBox.className = 'table-checkbox table-batch-manual-box';
    manualBox.checked = selection.manual;
    manualBox.onchange = () => {
        table.tableBatchManualSelection = manualBox.checked;
        scheduleSave();
        paintTableBatchPanel(panel, gen);
    };
    manualRow.appendChild(manualBox);
    const manualText = document.createElement('span');
    manualText.textContent = '独立运行（只跑已勾选的行）';
    manualRow.appendChild(manualText);
    panel.appendChild(manualRow);

    const actions = document.createElement('div');
    actions.className = 'table-batch-actions';
    /* 「依次生成」是个**模式开关**（不是「点一下就开跑」）：
       点它选中这个模式，然后再点底部「运行」才按「一行一行」跑（用户明确要求这样）。
       开关状态存在表格节点上（tableBatchSequential），所以「运行」也能读到。 */
    const sequentialOn = Boolean(table.tableBatchSequential);
    const sequentialButton = document.createElement('button');
    sequentialButton.type = 'button';
    sequentialButton.className = 'table-node-action' + (sequentialOn ? ' is-active' : '');
    sequentialButton.textContent = '依次生成';
    sequentialButton.title = sequentialOn
        ? '已选「依次生成」：点底部「运行」会一行一行跑（再点一下取消）'
        : '点一下选中：之后点底部「运行」会一行一行跑，这一行出图后才开下一行';
    if(typeof sequentialButton.setAttribute === 'function'){
        sequentialButton.setAttribute('aria-pressed', sequentialOn ? 'true' : 'false');
    }
    sequentialButton.onclick = () => {
        table.tableBatchSequential = !Boolean(table.tableBatchSequential);
        scheduleSave();
        paintTableBatchPanel(panel, gen);
    };
    actions.appendChild(sequentialButton);
    // 「批量生成」已上移到生成节点的主按钮位，这里只留恢复
    const resumeButton = document.createElement('button');
    resumeButton.type = 'button';
    resumeButton.className = 'table-node-action';
    resumeButton.textContent = '恢复上次';
    resumeButton.disabled = running || !runnable.length || !journal.runId;
    resumeButton.onclick = () => { runTableBatch(gen.id, {resumeRunId: journal.runId}); };
    actions.appendChild(resumeButton);
    panel.appendChild(actions);

    if(gen._batchLastMessage){
        const note = document.createElement('div');
        note.className = 'table-batch-note';
        note.textContent = gen._batchLastMessage;
        panel.appendChild(note);
    }
}

/* 表格批量执行（DX OS §4 执行器）。
   上游表格逐行驱动这个生成节点：一行 = 一次生成，提示词与参考图按行覆盖。 */
async function runTableBatch(genId, options={}){
    const model = novaTableModel();
    const gen = (nodes || []).find(item => item.id === genId);
    if(!gen || !model) return;
    /* 用户要求：再点一次「运行」就是要**开一批新的生成任务** —— 不管上一批还在跑、
       还是已经出好结果，都不能被挡回来（以前这里直接 `if(gen._batchRunning){ '批量生成正在进行中'; return; }`）。
       用「在跑批次数」而不是布尔：两批叠在一起时，先结束的那一批不能把还在跑的那一批的标志清掉。 */
    const tables = generatorUpstreamTables(genId);
    if(!tables.length){ notifyCanvas('多维表格无法连接到生成节点。'); return; }
    const table = tables[0];

    const say = text => { gen._batchLastMessage = text; notifyCanvas(text); repaintBatchPanel(gen); };

    const rows = tableRowInputs(table);
    const selection = tableBatchSelection(table);
    const startRow = model.batchStartRow(table.tableBatchStartRow, rows.length);
    const failurePolicy = model.batchFailurePolicy(table.tableBatchFailurePolicy);
    /* 「依次生成」：面板上的开关（tableBatchSequential）或调用方显式要求（options.sequential）→ 并发 1。
       上一行跑完才开下一行。 */
    const sequential = Boolean(options.sequential) || Boolean(table.tableBatchSequential);
    const concurrency = sequential ? 1 : tableBatchConcurrencyFor(gen, table);

    const runnable = model.batchRowsToRun(rows, {manual: selection.manual, startRow, selectedRows: selection.selectedRows});
    if(!runnable.length){
        if(selection.manual) say('请先勾选至少一行再独立运行');
        else if(startRow > rows.length) say('起始行超出表格范围，当前共 ' + rows.length + ' 行');
        else {
            const inRange = rows.filter(row => row.rowNumber >= startRow
                && ((Array.isArray(row.media) && row.media.length) || String(row.text || '').trim()));
            say(inRange.length
                ? '起始行之后的执行行都被取消勾选了，请至少勾选一行。'
                : '起始行之后没有可生成的内容');
        }
        return;
    }

    /* 悬空引用必须先拦下来：模型写的是全局输入序号，如果这一行拿不到那张图，
       发出去就是一条引用不存在素材的提示词，结果必然不对，而且是静默的。 */
    const danglingRows = runnable.filter(row => Array.isArray(row.danglingMentions) && row.danglingMentions.length);
    if(danglingRows.length){
        const detail = danglingRows.slice(0, 3).map(row =>
            '第 ' + row.rowNumber + ' 行（' + row.danglingMentions.map(item => item.token).join('、') + '）'
        ).join('；');
        say('有 ' + danglingRows.length + ' 行的提示词引用了本行没有的素材：' + detail
            + (danglingRows.length > 3 ? ' 等' : '') + '。可重新生成这张表格，或检查参考图分组或行数后重试。');
        return;
    }

    // 素材校验：缺文件的别发出去
    const issues = [];
    runnable.forEach(row => { tableRowMaterialIssues(row).forEach(issue => issues.push(issue)); });
    if(issues.length){
        const rowNumbers = Array.from(new Set(issues.map(issue => issue.rowNumber)));
        say('有 ' + issues.length + ' 个素材文件缺失（第 ' + rowNumbers.join('、') + ' 行），请先补齐再运行。');
        return;
    }

    const resumeRunId = String(options.resumeRunId || '');
    const runId = resumeRunId || uid('batch');
    const journal = model.matchBatchJournal(table.generationBatchJournal, runId, rows, failurePolicy);
    table.generationBatchJournal = journal;

    // 已在后台的行不重复派发（DX OS §5 后台恢复检测）
    const inflight = model.journalInflightRows(journal);
    if(inflight.length){
        say('批量生成仍有 ' + inflight.length + ' 行正在后台恢复，请等待完成后再次恢复 Graph。');
        return;
    }

    const runnableNumbers = new Set(runnable.map(row => row.rowNumber));
    const pending = model.journalPendingRows(journal).filter(entry => runnableNumbers.has(entry.rowNumber));
    if(!pending.length){
        say('没有需要执行的行（已完成 ' + model.journalCompletedRows(journal).length + ' 行）。');
        return;
    }

    const workers = Math.min(concurrency, pending.length);
    say(sequential
        ? '依次生成：共 ' + pending.length + ' 行，一行跑完再跑下一行'
        : '已开始批量生成：' + pending.length + ' 行，并发 ' + workers);

    /* 整个执行体包 try/finally：中途任何异常（面板重绘、保存、轮询）都不能把
       _batchRunning / tableBatchRunning 留在 true —— 那会让这个节点**再也跑不动**
       （用户报的「批量生成，无法再次生成」），而且标志还会被存进画布。 */
    gen._batchRunCount = Math.max(0, Number(gen._batchRunCount) || 0) + 1;
    /* 这一批要跑几行：结果节点用它算「还剩几格」，进度框不会因为某一行失败/产出重复就提前收起来。 */
    gen._batchRunRows = pending.length;
    /* 生效并发写到生成节点上：结果节点读它来决定几个占位格在转、几个在排队。 */
    gen._batchRunConcurrency = concurrency;
    /* 新一轮开跑先清上一批的停止标记。停止判定接两处：智能画布的全局停止
       （host.generationStopRequested），以及本节点/调用方显式标记（经典画布等）。 */
    gen._batchStopRequested = false;
    const shouldStopBatch = () => Boolean(gen._batchStopRequested)
        || (typeof generationStopRequested === 'function' ? Boolean(generationStopRequested(gen && gen.id)) : false)
        || (typeof options.shouldStop === 'function' ? Boolean(options.shouldStop()) : false);
    gen._batchRunning = true;
    table.tableBatchRunning = true;
    gen._batchProgress = {total:pending.length, done:0, failed:0, cancelled:0};
    scheduleSave();
    try {
        paintTableBatchPanelFromNode(gen, table);
        repaintTable(table);

        const rowByNumber = new Map(rows.map(row => [row.rowNumber, row]));
        const results = await model.runWithSharedCursor(pending, workers, async entry => {
            const row = rowByNumber.get(entry.rowNumber);
            if(!row) throw new Error('第 ' + entry.rowNumber + ' 行已不存在');
            model.journalMarkRow(journal, entry.rowNumber, 'running', entry.requestId || '');
            scheduleSave();
            // 一行一次生成：提示词与参考图都按这一行覆盖。
            // 视频节点走 runVideoNode，图像节点走 runGenerator，其余设置（模型/时长/比例）沿用节点自身。
            await tableBatchRunner(gen)(genId, {
                batch: true,
                rowOverride: {prompt: row.prompt, refs: tableRowRefs(row)},
                /* batchRowNumbers：本轮真正要跑的行号（顺序固定），结果节点按它建
                   逐行状态，进度框不再拿并发数猜谁在跑。同一批每个 worker 拿到同一份。 */
                runContext: {tableId: table.id, rowNumber: entry.rowNumber, batchRunId: runId,
                    batchRowNumbers: pending.map(item => item.rowNumber)}
            });
            model.journalMarkRow(journal, entry.rowNumber, 'completed');
            gen._batchProgress.done += 1;
            scheduleSave();
            repaintBatchPanel(gen);
            return entry.rowNumber;
        }, {stopOnError: failurePolicy === 'stop', shouldStop: shouldStopBatch});

        const failures = [];
        results.forEach((result, index) => {
            if(result && result.ok) return;
            const entry = pending[index];
            /* 停止：没派发的行（cancelled 标记）和因停止中断的行都记 cancelled，
               不算 failed —— 用户点的是「停止」，不是「失败」。 */
            const stopped = Boolean(result && result.cancelled)
                || Boolean(result && result.error && result.error.smartGenerationStopped);
            if(stopped){
                model.journalMarkRow(journal, entry.rowNumber, 'cancelled');
                gen._batchProgress.cancelled += 1;
                return;
            }
            model.journalMarkRow(journal, entry.rowNumber, 'failed');
            gen._batchProgress.failed += 1;
            failures.push({rowNumber: entry.rowNumber,
                reason: friendlyBatchError(result && result.error && (result.error.message || String(result.error)))});
        });

        scheduleSave();
        await saveCanvas();
        repaintBatchPanel(gen);
        repaintTable(table);

        const completed = model.journalCompletedRows(journal).length;
        const failed = model.journalFailedRows(journal).length;
        const cancelled = typeof model.journalCancelledRows === 'function'
            ? model.journalCancelledRows(journal).length
            : journal.rows.filter(row => row.status === 'cancelled').length;
        let summary = cancelled
            ? '已停止：完成 ' + completed + ' 行，已取消 ' + cancelled + ' 行。'
            : '批量生成结束：完成 ' + completed + ' 行' + (failed ? '，失败 ' + failed + ' 行' : '') + '。';
        /* 批量模式不能弹窗，但只说「失败 N 行」等于没说。
           把首个失败原因带出来，面板上的 note 会一直留着，用户能照着排查。 */
        if(failures.length){
            const reasons = Array.from(new Set(failures.map(item => item.reason).filter(Boolean)));
            summary += '第 ' + failures[0].rowNumber + ' 行失败原因：' + String(reasons[0] || '未知错误').slice(0, 200)
                + (reasons.length > 1 ? '（共 ' + reasons.length + ' 种原因）' : '');
        }
        say(summary);
    } finally {
        /* 无论正常结束还是异常，都要把这一批的计数还回去；计数归零才算「没在跑」。
           （以前是布尔 = false，叠加两批时先结束的那批会把标志提前清掉。） */
        gen._batchRunCount = Math.max(0, (Number(gen._batchRunCount) || 1) - 1);
        gen._batchRunning = gen._batchRunCount > 0;
        if(!gen._batchRunning) gen._batchStopRequested = false;
        table.tableBatchRunning = gen._batchRunning;
        scheduleSave();
        repaintBatchPanel(gen);
        repaintTable(table);
        /* 批量生命周期的任何收尾（正常/异常/停止）都要让主按钮回到「运行」，不能卡在「停止/停止中…」。 */
        if(typeof onBatchSettled === 'function') onBatchSettled();
    }
}

function paintTableBatchPanelFromNode(gen, table){
    repaintBatchPanel(gen);
}

/* ─────────────── LLM 多维表格（DX OS §6：FS/BS/a6/CR/PR）─────────────── */

// LLM 的素材输入按来源切成媒体组；group 展开成成员（一个 group = 一个通道）
function llmMediaGroups(node){
    const groups = [];
    (connections || []).filter(conn => conn.to === node.id).forEach(conn => {
        const source = (nodes || []).find(item => item.id === conn.from);
        const entries = tableSourceItems(source);
        if(!entries.length) return;
        groups.push({
            sourceId: source.id,
            entries: entries.map(entry => {
                const item = (nodes || []).find(n => n.id === entry.nodeId);
                /* 输出节点的条目自带 url，类型要看 url（节点本身没有 url，
                   而且一个输出节点里可能混着图/视频）。 */
                const kind = entry.url ? mediaKindForRef({url:entry.url}) : mediaKindForNode(item || {});
                return {kind, nodeId: entry.nodeId, label: (item && item.name) || '', url: entry.url || ''};
            })
        });
    });
    return groups;
}

function llmListInputs(node){ return llmMediaGroups(node).flatMap(group => group.entries); }

/* 输出形式的药丸按钮（和上面「节点 / 对话」那组药丸同一套 .llm-mode 样式）。
   value 就是存进 node.llmOutputMode 的原始值，文案是可选值 → 中文名的唯一映射。 */
const LLM_OUTPUT_MODE_BUTTONS = [
    {value:'text', label:'文本输出', title:'纯文本输出'},
    {value:'list', label:'多维表格', title:'多维表格：每一行一条生成内容，接图像生成节点'},
    {value:'list-video', label:'视频分镜表', title:'视频分镜表：每一行一个分镜，接视频生成节点逐段生成'}
];

function llmOutputModeButtonsHtml(node){
    const model = novaTableModel();
    const current = model ? model.llmOutputModeChoice(node && node.llmOutputMode) : 'text';
    return LLM_OUTPUT_MODE_BUTTONS.map(item => {
        const active = item.value === current ? ' active' : '';
        return '<button type="button" class="llm-output-mode-btn' + active + '" data-output-mode="' + item.value
            + '" title="' + item.title + '">' + item.label + '</button>';
    }).join('');
}

/* 按钮文案统一走模型的 llmRunStageLabel：文本模式也是「生成 / 生成中」，
   和出表模式同一套说法（原来文本模式写死 "Run LLM"，旁边全是中文，很割裂）。 */
function llmRunButtonLabel(node){
    const model = novaTableModel();
    if(!model) return node.running ? tr('canvas.running') : '生成';
    const stage = model.llmOutputMode(node.llmOutputMode) === 'list' ? node.llmRunStage : '';
    return model.llmRunStageLabel(Boolean(node.running), stage);
}

/* PR()：物化 —— LLM 的 list 输出变成一个真正的表格节点。
   素材 --ref(toPort: input-N)--> 表格；LLM --flow--> 表格。
   落点按 DX OS l6：源右侧 170px，y 取已有下游的最大值 + 42 避让。 */
function materializeLlmTable(llmNode, table, groups, plan){
    const model = novaTableModel();
    if(!model) return null;
    /* 规划里为每一组指定了用法：per-row → 逐行（行驱动），every-row → 全部（每行都带整组）。
       这样「多张参考图 → 多行」和「多张白底图 → 每行都带」是自动落下来的，
       用户不切模式也能对；表头仍可手动覆盖。
       经典画布的规划遍可能为空（规划请求失败/被跳过），生成遍回执的 inputGroups 才是权威。 */
    const modeSource = (table && Array.isArray(table.inputGroups) && table.inputGroups.length) ? table : plan;
    const planModes = model.planGroupModes(modeSource, groups.length);
    const channelModes = {};
    groups.forEach((group, index) => {
        if(model.CHANNEL_MODES.includes(planModes[index])) channelModes[model.channelIdAt(index)] = planModes[index];
    });
    /* 不设固定高度：行少的时候固定高会把表格区撑开、底部留一大片空白。
       改成让内容决定高度，表格区自身有 max-height + 滚动，长表也不会无限长。 */
    let y = llmNode.y || 0;
    (connections || []).filter(conn => conn.from === llmNode.id).forEach(conn => {
        const target = (nodes || []).find(item => item.id === conn.to);
        if(target) y = Math.max(y, (target.y || 0) + (target.h || 320) + 42);
    });

    const created = addNode({
        id: uid('tbl'),
        type: 'table',
        x: (llmNode.x || 0) + (llmNode.w || 420) + 170,
        y,
        w: 520,
        table,
        tableInputColumn: true,
        tableInputColumnsDetached: true,
        tableInputsConnectionDriven: true,
        tableInputChannelCount: Math.max(1, groups.length),
        tableInputChannelModes: channelModes,
        llmGeneratedOutput: true,
        llmSourceId: llmNode.id,
        llmRunAt: nowMs()
    });

    // 每个媒体组连一列；toPort 定位通道，mode 由 ensureTableChannels 按条目数推导
    groups.forEach((group, index) => {
        connectNodes(group.sourceId, created.id, model.channelIdAt(index));
    });
    connectNodes(llmNode.id, created.id);
    return created;
}

function renderTableBody(node){
    const model = novaTableModel();
    if(!model){
        const missing = document.createElement('div');
        missing.className = 'table-node-missing';
        missing.textContent = '多维表格模型未加载';
        return missing;
    }
    // 同一节点的表格 DOM 只构建一次，之后原地重绘。
    // 这样双击编辑期间任何触发 render() 的操作都不会重建 DOM、不会丢焦点。
    if(node._tableEl && node._tablePaint){
        if(tableNodeSignature(node) !== node._tableSignature) node._tablePaint();
        return node._tableEl;
    }

    const root = document.createElement('div');
    root.className = 'table-node';
    // 表格内部不启动节点拖拽（拖拽走标题栏），滚轮滚表格而不是缩放画布。
    root.addEventListener('mousedown', event => event.stopPropagation(), true);
    root.addEventListener('wheel', event => event.stopPropagation(), {passive:true});

    const meta = document.createElement('div');
    meta.className = 'table-node-meta';
    root.appendChild(meta);

    const grid = document.createElement('div');
    grid.className = 'table-node-grid';
    root.appendChild(grid);

    const table = document.createElement('table');
    table.className = 'table-node-table';
    grid.appendChild(table);

    function tableButton(label, title, className){
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = label;
        if(title) button.title = title;
        return button;
    }

    // 表头右侧的删除列按钮（Lucide trash-2，和删行按钮同一套）
    function tableHeadDeleteButton(title, handler){
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'table-head-delete';
        button.title = title;
        const glyph = document.createElement('i');
        glyph.dataset.lucide = 'trash-2';
        button.appendChild(glyph);
        ['mousedown','click','dblclick'].forEach(type => {
            button.addEventListener(type, event => event.stopPropagation());
        });
        button.onclick = event => { event.stopPropagation(); handler(); };
        return button;
    }

    function paint(){
        const state = ensureTableState(node);
        if(!state) return;
        /* 字号一律不缩放，只让图片随列宽变化。
           表格区不再设高度上限：行数全部自然显示，节点多高就显示多少，
           由「填满节点可用高度」来决定，而不是硬顶一个固定行数。 */
        const nodeById = new Map((nodes || []).map(item => [item.id, item]));
        const channels = ensureTableChannels(node);
        const rowData = tableRowInputs(node, {nodeById});
        const picked = new Set(state.selectedRows);
        const editing = node._tableEdit || null;
        /* LLM 产出的表格不放格子图标（见 tableCellAddButton 上面那段说明） */
        const llmTable = Boolean(node.llmGeneratedOutput);
        const textColumns = state.columns.map((_, index) => state.rows.some(row =>
            Array.from(String(row[index] === null || row[index] === undefined ? '' : row[index])).length > TABLE_TEXT_COLUMN_CHARS));

        // ── 信息条 ──
        meta.textContent = '';
        const counter = document.createElement('span');
        counter.className = 'table-node-count';
        counter.textContent = state.columns.length + ' 列 · ' + state.rows.length + ' 行';
        meta.appendChild(counter);
        const inputs = document.createElement('span');
        inputs.className = 'table-node-inputs';
        inputs.textContent = channels.length + ' 个输入';
        meta.appendChild(inputs);
        // 默认全选时这个提示是废话，只在取消掉一部分之后才显示
        if(picked.size && picked.size < state.rows.length){
            const chip = document.createElement('span');
            chip.className = 'table-node-picked';
            chip.textContent = '已勾选 ' + picked.size + '/' + state.rows.length;
            meta.appendChild(chip);
        }
        const spacer = document.createElement('span');
        spacer.className = 'table-node-spacer';
        meta.appendChild(spacer);
        const addInput = tableButton('+ 输入列', '多开一列输入，可把连线拖到那一列上', 'table-node-action');
        addInput.onclick = () => addTableInputChannel(node);
        meta.appendChild(addInput);
        const addColumn = tableButton('新增列', '在末尾新增一列', 'table-node-action');
        addColumn.onclick = () => addTableColumn(node);
        meta.appendChild(addColumn);
        const addRow = tableButton('新增行', '在末尾新增一行', 'table-node-action');
        addRow.onclick = () => addTableRow(node);
        meta.appendChild(addRow);

        table.textContent = '';

        // ── colgroup：输入列(112) → 数据列(132) → 选择列(44) → 删除列(60) ──
        const colgroup = document.createElement('colgroup');
        channels.forEach(() => {
            const column = document.createElement('col');
            column.className = 'table-input-column';
            colgroup.appendChild(column);
        });
        state.columns.forEach(() => {
            const column = document.createElement('col');
            column.className = 'table-data-column';
            colgroup.appendChild(column);
        });
        const actionColumn = document.createElement('col');
        actionColumn.className = 'table-actions-column';
        colgroup.appendChild(actionColumn);
        const deleteColumn = document.createElement('col');
        deleteColumn.className = 'table-delete-column';
        colgroup.appendChild(deleteColumn);
        table.appendChild(colgroup);

        // ── 表头 ──
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');

        channels.forEach((channel, index) => {
            const cell = document.createElement('th');
            cell.className = 'table-cell table-head-cell table-input-head';
            cell.dataset.channel = channel.id;
            cell.title = channel.mode === 'sequence'
                ? '逐行对应：第 N 行取第 N 个输入，超出为空'
                : '按行取，超出后沿用最后一个输入';
            const label = document.createElement('span');
            label.className = 'table-input-label';
            label.textContent = model.channelLabel(index);
            cell.appendChild(label);
            const mode = document.createElement('button');
            mode.type = 'button';
            mode.className = 'table-input-mode';
            mode.textContent = tableChannelModeLabel(channel.mode);
            mode.onclick = event => { event.stopPropagation(); toggleTableChannelMode(node, index); };
            cell.appendChild(mode);
            const count = document.createElement('small');
            count.className = 'table-input-count';
            count.textContent = String(channel.items.length);
            cell.appendChild(count);
            // 只剩一列时不给删（ensureTableChannels 至少会留一列，删了也白删）
            if(channels.length > 1){
                const drop = tableHeadDeleteButton('删除这列输入（连到这一列的连线一起删）', () => removeTableInputChannel(node, index));
                cell.appendChild(drop);
            }
            headRow.appendChild(cell);
        });

        state.columns.forEach((name, index) => {
            const editingHere = Boolean(editing) && editing.kind === 'column' && editing.column === index;
            const cell = document.createElement('th');
            cell.className = 'table-cell table-head-cell';
            cell.title = name;
            if(textColumns[index]) cell.classList.add('is-text-column');
            if(editingHere) cell.classList.add('is-editing');
            const label = document.createElement('span');
            label.className = 'table-head-label';
            label.textContent = name;
            cell.appendChild(label);
            cell.appendChild(tableHeadDeleteButton('删除这一列', () => deleteTableColumn(node, index)));
            cell.ondblclick = event => { event.stopPropagation(); beginTableEdit(node, {kind:'column', column:index}); };
            if(editingHere){
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'table-head-editor';
                input.value = name;
                cell.appendChild(input);
                requestAnimationFrame(() => { input.focus(); input.select(); });
                bindTableHeadEditor(node, input, index);
            }
            headRow.appendChild(cell);
        });

        const actionHead = document.createElement('th');
        actionHead.className = 'table-cell table-head-cell table-actions-cell';
        const selectAll = document.createElement('input');
        selectAll.type = 'checkbox';
        selectAll.className = 'table-checkbox';
        selectAll.title = '全选';
        selectAll.checked = state.rows.length > 0 && picked.size === state.rows.length;
        selectAll.onchange = () => toggleAllTableRows(node, selectAll.checked);
        actionHead.appendChild(selectAll);
        headRow.appendChild(actionHead);

        const deleteHead = document.createElement('th');
        deleteHead.className = 'table-cell table-head-cell table-actions-cell table-delete-cell';
        deleteHead.textContent = '删除行';
        headRow.appendChild(deleteHead);

        thead.appendChild(headRow);
        table.appendChild(thead);

        // ── 表体 ──
        const tbody = document.createElement('tbody');
        if(!state.rows.length){
            const emptyRow = document.createElement('tr');
            const emptyCell = document.createElement('td');
            emptyCell.className = 'table-cell table-empty-cell';
            emptyCell.colSpan = channels.length + state.columns.length + 2;
            emptyCell.textContent = state.columns.length ? '暂无数据，点「新增行」开始填写' : '点「新增列」开始建表';
            emptyRow.appendChild(emptyCell);
            tbody.appendChild(emptyRow);
        }

        state.rows.forEach((row, rowIndex) => {
            const data = rowData[rowIndex] || {channelItems:[], entries:[], media:[], text:'', prompt:''};
            const channelItems = data.channelItems || [];
            const flatEntries = channelItems.reduce((all, list) => all.concat(list || []), []);
            const tr = document.createElement('tr');
            tr.dataset.row = String(rowIndex);
            if(picked.has(rowIndex)) tr.classList.add('is-selected');
            // 该行组装后真正会发出去的提示词（@图片N 已重编号），挂在 title 上方便核对
            if(data.prompt) tr.title = data.prompt;
            const dataValues = state.columns.map((name, index) => model.cellText(row[index]));
            const inputTexts = flatEntries.filter(entry => entry && entry.kind === 'text').map(entry => entry.text);
            const hasMedia = flatEntries.some(entry => entry && entry.kind && entry.kind !== 'text');
            tr.style.height = model.rowHeightForRow(dataValues, inputTexts, hasMedia) + 'px';

            // 输入列单元格：既是连线的放置目标（data-channel 供 toPort 落点识别），
            // 也能直接手动上传 / 替换这一格的参考素材。
            channels.forEach((channel, index) => {
                const cell = document.createElement('td');
                cell.className = 'table-cell table-media-cell';
                cell.dataset.channel = channel.id;
                const entries = channelItems[index] || [];
                fillTableMediaCell(cell, entries);
                const first = entries.filter(entry => entry && entry.url)[0] || null;
                // 这一格的引用写法直接标在角上：用户照着打 @图片N 就行，不用猜序号
                if(first && !llmTable){
                    const token = document.createElement('span');
                    token.className = 'table-cell-ref-token';
                    token.textContent = model.mentionTokenAt(first.kind, first.ordinal);
                    cell.appendChild(token);
                }
                if(first){
                    bindTableCellMediaView(cell, first.url, first.kind);
                    if(!llmTable){
                        const manualList = tableManualInputList(node, channel.id, rowIndex);
                        const showMedia = entries.filter(entry => entry && entry.url);
                        const actions = [];
                        if(manualList.length > 1){
                            // 格子有多张：一张一张替换，不是把整格换掉
                            showMedia.forEach((entry, itemIndex) => actions.push({
                                // 菜单里靠缩略图分辨是哪一张，不再显示 @图片N 这种序号
                                label: '替换',
                                token: model.mentionTokenAt(entry.kind, entry.ordinal),
                                thumb: entry.url,
                                mediaType: entry.kind,
                                onClick: () => pickTableCellFile(picked => {
                                    replaceTableManualInputItem(node, channel.id, rowIndex, itemIndex, picked);
                                    repaintTable(node);
                                }),
                                onDelete: () => {
                                    removeTableManualInputItem(node, channel.id, rowIndex, itemIndex);
                                    repaintTable(node);
                                }
                            }));
                        } else {
                            actions.push({label:'替换', onClick: () => pickTableCellFile(picked => {
                                setTableManualInputItem(node, channel.id, rowIndex, picked);
                                repaintTable(node);
                            })});
                        }
                        actions.push({label:'新增', onClick: () => pickTableCellFile(picked => {
                            addTableManualInputItem(node, channel.id, rowIndex, picked);
                            repaintTable(node);
                        })});
                        tableCellMoreButton(cell, actions);
                    }
                } else if(!llmTable){
                    tableCellAddButton(cell, () => pickTableCellFile(picked => {
                        setTableManualInputItem(node, channel.id, rowIndex, picked);
                        repaintTable(node);
                    }));
                }
                tr.appendChild(cell);
            });

            // 数据列单元格：文字（双击编辑）或媒体（上传/替换/删除）
            state.columns.forEach((name, index) => {
                const cell = document.createElement('td');
                cell.className = 'table-cell';
                if(textColumns[index]) cell.classList.add('is-text-column');
                const raw = row[index];
                const media = model.isMediaCell(raw) ? raw : null;
                const value = model.cellText(raw);
                if(media){
                    cell.classList.add('table-media-cell', 'is-media-cell');
                    fillTableMediaCell(cell, [{kind:media.mediaType, url:media.url, text:''}]);
                    bindTableCellMediaView(cell, media.url, media.mediaType);
                    if(!llmTable) tableCellMoreButton(cell, () => pickTableCellFile(picked => setTableCellMedia(node, rowIndex, index, picked)));
                } else {
                    const view = document.createElement('div');
                    view.className = 'table-cell-view';
                    if(!value) view.classList.add('is-empty');
                    // 文本里的 @图片N 指向同一行上传的素材时直接显示缩略图（自建表才做，LLM 表的提示词保持纯文本）
                    renderTableCellText(view, value, llmTable ? null : data.media);
                    // 空着的时候给一句说明：这里写文字，@ 能引用本行素材
                    if(!value && !llmTable && !data.media.length){
                        const hint = document.createElement('span');
                        hint.className = 'table-cell-hint';
                        hint.textContent = '文字；@ 可引用本行素材';
                        view.appendChild(hint);
                    }
                    cell.appendChild(view);
                    // 提示词格：双击改文字（两种表格都一样）
                    cell.ondblclick = event => { event.stopPropagation(); beginTableEdit(node, {kind:'cell', row:rowIndex, column:index}); };
                }
                if(editing && editing.kind === 'cell' && editing.row === rowIndex && editing.column === index){
                    cell.classList.add('is-editing');
                    const editor = document.createElement('textarea');
                    editor.className = 'table-cell-editor';
                    editor.value = value;
                    cell.appendChild(editor);
                    requestAnimationFrame(() => { editor.focus(); editor.select(); });
                    bindTableCellEditor(node, editor, rowIndex, index);
                }
                tr.appendChild(cell);
            });

            // 选择列：只放勾选框
            const actionCell = document.createElement('td');
            actionCell.className = 'table-cell table-actions-cell table-row-actions';
            const pick = document.createElement('input');
            pick.type = 'checkbox';
            pick.className = 'table-checkbox';
            pick.checked = picked.has(rowIndex);
            pick.onchange = () => toggleTableRow(node, rowIndex, pick.checked);
            actionCell.appendChild(pick);
            tr.appendChild(actionCell);

            // 删除列：独立一列，单元格里就是「删除行」
            const deleteCell = document.createElement('td');
            deleteCell.className = 'table-cell table-actions-cell table-delete-cell';
            const removeRow = tableButton('', '删除这一行', 'table-row-delete');
            const removeIcon = document.createElement('i');
            removeIcon.dataset.lucide = 'trash-2';
            removeRow.appendChild(removeIcon);
            removeRow.onclick = event => { event.stopPropagation(); deleteTableRow(node, rowIndex); };
            deleteCell.appendChild(removeRow);
            tr.appendChild(deleteCell);

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        // repaintTable() 不经过 render()，这里得自己刷新一次图标，
        // 否则重建出来的 <i data-lucide> 永远是空的。
        refreshIcons();

        node._tableSignature = tableNodeSignature(node);
        if(typeof requestAnimationFrame === 'function') requestAnimationFrame(() => syncTableNodeWidth(node));
        else syncTableNodeWidth(node);
    }

    node._tableEl = root;
    node._tablePaint = paint;
    paint();
    return root;
}

        return {
            novaTableModel, addTableNode, syncTableNodeWidth, tableDropPortFor, connectNodes,
            notifyCanvas, normalizeTableNodeHeight, normalizeContentHeightNode,
            tableBatchRunButtonHtml, tableBatchSingleButtonHtml, friendlyBatchError,
            generatorNeedsPromptMessage, tableDrivenHidden, renderTableBatchPanel, paintTableBatchPanel,
            generatorUpstreamTables, repaintBatchPanel,
            llmMediaGroups, llmOutputModeButtonsHtml, llmRunButtonLabel, materializeLlmTable,
            renderTableBody, runTableBatch,
            tableRowInputs, tableRowInputsStats, resetTableRowInputsStats,
        };
    };
})(typeof window !== 'undefined' ? window : globalThis);
