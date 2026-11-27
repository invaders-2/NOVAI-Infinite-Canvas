(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.NovaTableModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict';

    // 多维表格数据模型 —— 按 DX OS builtin.table 的真实语义实现。
    // 规范来源：docs/v2/DXOS_TABLE_SPEC.md（从 DX OS 0.3.3 的 app bundle 逆向提取）。
    // 对应 DX OS 的函数：Mx（归一化）/ n6（深拷贝）/ Kh（序号校验）/ o6（列定位）/
    //                   i6（操作执行）/ mR（行高）/ Yw（节点尺寸）。
    //
    // 本模块是**纯数据层**：不碰 DOM、不碰网络、不碰画布节点状态。
    // 表格自身不执行任何生成——它只是数据容器（runnable:false）。

    const TABLE_KIND = 'table';
    const TABLE_VERSION = 1;

    // 手工编辑上限（DX OS: Wh / Zh / Vv）
    const MAX_COLUMNS = 200;
    const MAX_ROWS = 5000;
    const MAX_CELL_CHARS = 20000;

    // LLM 生成表格的上限（DX OS: a6()）——比手工严得多，因为要防模型输出爆量
    const LLM_MAX_COLUMNS = 40;
    const LLM_MAX_ROWS = 200;

    // 尺寸常量（DX OS: Fie / Bie / qie / Wie / Gie）
    const COLUMN_WIDTH = 132;        // 每列宽
    const RESERVED_WIDTH = 44;       // 预留（操作列等）
    const HEADER_HEIGHT = 38;        // 表头高
    const MAX_NODE_HEIGHT = 720;     // 节点最大高
    const EMPTY_MIN_HEIGHT = 44;     // 空表最小高
    const INPUT_COLUMN_WIDTH = 112;  // 输入列宽

    const UNNAMED_COLUMN = '未命名列';

    // 操作契约（照搬 DX OS builtinCanvasNodes.ts 的分级）
    const TABLE_OPERATIONS = {
        read_table: {kind:'query', risk:'low', sideEffect:'none', idempotency:'idempotent',
            confirmation:'on-ambiguity', reads:['table'], writes:[], title:'读取表格数据'},
        set_cell: {kind:'mutation', risk:'low', sideEffect:'local', idempotency:'keyed',
            confirmation:'on-ambiguity', reads:['table'], writes:['table'], title:'修改单元格'},
        set_cells: {kind:'mutation', risk:'low', sideEffect:'local', idempotency:'keyed',
            confirmation:'on-ambiguity', reads:['table'], writes:['table'], title:'批量修改单元格'},
        append_row: {kind:'mutation', risk:'low', sideEffect:'local', idempotency:'keyed',
            confirmation:'on-ambiguity', reads:['table'], writes:['table'], title:'追加表格行'},
        delete_row: {kind:'mutation', risk:'medium', sideEffect:'local', idempotency:'keyed',
            confirmation:'on-risk', reads:['table'], writes:['table'], title:'删除表格行'},
        add_column: {kind:'mutation', risk:'low', sideEffect:'local', idempotency:'keyed',
            confirmation:'on-ambiguity', reads:['table'], writes:['table'], title:'添加表格列'},
        delete_column: {kind:'mutation', risk:'medium', sideEffect:'local', idempotency:'keyed',
            confirmation:'on-risk', reads:['table'], writes:['table'], title:'删除表格列'},
    };

    /* 智能列（AI 列）：与 columns 平行的自然语言指令（空位 null）。
       一条指令只作用于自己那一列，绝不把 columns 改成对象。 */
    const AI_INSTRUCTION_MAX_CHARS = MAX_CELL_CHARS;
    const AI_COLUMN_BATCH_ROWS = 20;
    const AI_COLUMN_BATCH_ROWS_MAX = 50;
    const AI_COLUMN_MAX_TOKENS = 8192;
    const TABLE_SNAPSHOT_KIND = 'table-snapshot';

    function emptyTable(){
        return {kind:TABLE_KIND, version:TABLE_VERSION, columns:[], rows:[], selectedRows:[], mergedGroups:[],
            aiColumns:[]};
    }

    /* 单元格可以是文字，也可以是**媒体**（用户自己往格子里上传/替换的图片、视频）。
       媒体格存成对象，不能走 cellText 的 JSON.stringify —— 否则一存一读就变成一串 JSON。 */
    const MEDIA_CELL_KIND = 'media';

    function mediaCell(url, mediaType, name){
        const clean = String(url === null || url === undefined ? '' : url).trim();
        if(!clean) return '';
        const kind = String(mediaType || '').toLowerCase();
        return {
            kind: MEDIA_CELL_KIND,
            url: clean,
            mediaType: kind === 'video' ? 'video' : (kind === 'audio' ? 'audio' : 'image'),
            name: String(name || ''),
        };
    }

    function isMediaCell(value){
        return Boolean(value && typeof value === 'object' && value.kind === MEDIA_CELL_KIND && value.url);
    }

    // 单元格字符串化但不截断：批量写要按真实长度判超限，最终落盘的仍是 cellText
    function rawCellText(value){
        if(value === null || value === undefined) return '';
        if(isMediaCell(value)) return '';
        if(typeof value === 'string') return value;
        if(typeof value === 'object'){ try { return JSON.stringify(value); } catch(e){ return String(value); } }
        return String(value);
    }

    // 单元格一律字符串化并截断（DX OS: 非字符串走 JSON.stringify）；媒体格不进文字流
    function cellText(value){
        const text = rawCellText(value);
        return text.length > MAX_CELL_CHARS ? text.slice(0, MAX_CELL_CHARS) : text;
    }

    // 列名：trim → 空则「未命名列」→ 同名追加 (2)/(3)…（DX OS: Mx 的列处理 + 去重）
    function normalizeColumns(raw){
        const list = Array.isArray(raw) ? raw.slice(0, MAX_COLUMNS) : [];
        const seen = Object.create(null), out = [];
        list.forEach(item => {
            let title = String(item === null || item === undefined ? '' : item).trim();
            if(!title) title = UNNAMED_COLUMN;
            if(seen[title]){ seen[title] += 1; title = title + '(' + seen[title] + ')'; }
            else seen[title] = 1;
            out.push(title);
        });
        return out;
    }

    /* 一条 AI 列指令：空白算没有（null），updatedAt 只接受有限数字（毫秒），
       非法值归 0 —— 老数据/手写数据不能因为时间戳写法不同就整条丢掉。 */
    function normalizeAiColumn(raw){
        if(!raw || typeof raw !== 'object') return null;
        const instruction = cellText(raw.instruction).trim().slice(0, AI_INSTRUCTION_MAX_CHARS);
        if(!instruction) return null;
        const updatedAt = Math.floor(Number(raw.updatedAt));
        return {instruction, updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0};
    }

    // 与 columns 定长对齐：截到同列数，缺的补 null（空位必须占位，否则列增删会对不上）
    function normalizeAiColumns(raw, columnCount){
        const count = Math.max(0, Math.floor(Number(columnCount) || 0));
        const list = Array.isArray(raw) ? raw : [];
        const out = new Array(count).fill(null);
        list.slice(0, count).forEach((entry, index) => { out[index] = normalizeAiColumn(entry); });
        return out;
    }

    /* 选区 {r0,c0,r1,c1}（0-based，含端点）：越界夹回表内，反序交换成左上/右下。
       空表或字段不是有限数字时返回 null —— 这两种情况夹不出合法选区。 */
    function clampSelection(raw, rowCount, colCount){
        if(!raw || typeof raw !== 'object') return null;
        const rows = Math.max(0, Math.floor(Number(rowCount) || 0));
        const cols = Math.max(0, Math.floor(Number(colCount) || 0));
        if(!rows || !cols) return null;
        const nums = ['r0', 'c0', 'r1', 'c1'].map(key => Number(raw[key]));
        if(nums.some(value => !Number.isFinite(value))) return null;
        const clamp = (value, max) => Math.min(max - 1, Math.max(0, Math.floor(value)));
        let [r0, c0, r1, c1] = nums.map((value, index) => clamp(value, index % 2 === 0 ? rows : cols));
        if(r0 > r1){ const swap = r0; r0 = r1; r1 = swap; }
        if(c0 > c1){ const swap = c0; c0 = c1; c1 = swap; }
        return {r0, c0, r1, c1};
    }

    /** 选区归一化：table 尺寸变化后调用；非法/空表 → null。 */
    function normalizeSelection(table, selection){
        const t = normalizeTable(table).table;
        return clampSelection(selection, t.rows.length, t.columns.length);
    }

    // 行/列被删后把选区重新夹回表内；夹不出来就整条清掉
    function reclampSelection(table){
        if(!table || !table.selection) return;
        const selection = clampSelection(table.selection, table.rows.length, table.columns.length);
        if(selection) table.selection = selection;
        else delete table.selection;
    }

    // 缺字段算合法（老画布数据没有 aiColumns）；给了就必须是长度不超列数的 null/{instruction} 数组
    function aiColumnsAreStrict(raw, columnCount){
        if(raw.aiColumns === undefined || raw.aiColumns === null) return true;
        if(!Array.isArray(raw.aiColumns) || raw.aiColumns.length > columnCount) return false;
        return raw.aiColumns.every(entry => entry === null || entry === undefined
            || (typeof entry === 'object'
                && typeof entry.instruction === 'string'
                && Boolean(entry.instruction.trim())
                && entry.instruction.length <= AI_INSTRUCTION_MAX_CHARS
                && Number.isFinite(Number(entry.updatedAt))));
    }

    function selectionIsStrict(raw, rowCount, colCount){
        if(raw.selection === undefined || raw.selection === null) return true;
        return Boolean(clampSelection(raw.selection, rowCount, colCount));
    }

    function isStrict(raw){
        if(!raw || typeof raw !== 'object') return false;
        if(!Array.isArray(raw.columns) || !Array.isArray(raw.rows)) return false;
        if(raw.columns.length > MAX_COLUMNS || raw.rows.length > MAX_ROWS) return false;
        if(raw.columns.some(c => typeof c !== 'string' || !c.trim())) return false;
        if(!raw.rows.every(row => Array.isArray(row) && row.length === raw.columns.length
            && row.every(cell => typeof cell === 'string' || isMediaCell(cell)))) return false;
        if(!selectionIsStrict(raw, raw.rows.length, raw.columns.length)) return false;
        return aiColumnsAreStrict(raw, raw.columns.length);
    }

    /** 归一化任意输入为合法表格；永不抛错，越界静默修复。 */
    function normalizeTable(raw){
        const source = raw && typeof raw === 'object' ? raw : {};
        const repaired = !isStrict(source);
        const columns = normalizeColumns(source.columns);
        const rawRows = Array.isArray(source.rows) ? source.rows : [];
        const rows = rawRows.filter(Array.isArray).slice(0, MAX_ROWS)
            .map(row => columns.map((_, i) => {
                const cell = row[i];
                // 媒体格原样保留（重新构造一份，避免和源对象共享引用）
                return isMediaCell(cell) ? mediaCell(cell.url, cell.mediaType, cell.name) : cellText(cell);
            }));
        const selectedRows = (Array.isArray(source.selectedRows) ? source.selectedRows : [])
            .map(Number).filter(v => Number.isInteger(v) && v >= 0 && v < rows.length);
        const mergedGroups = (Array.isArray(source.mergedGroups) ? source.mergedGroups : [])
            .filter(Array.isArray).map(g => g.map(Number).filter(Number.isInteger));
        const aiColumns = normalizeAiColumns(source.aiColumns, columns.length);
        const selection = clampSelection(source.selection, rows.length, columns.length);
        const table = {kind:TABLE_KIND, version:TABLE_VERSION, columns, rows, selectedRows, mergedGroups, aiColumns};
        // 非法/越界的选区直接清掉，不留在表里等人再归一化一次
        if(selection) table.selection = selection;
        return {table, repaired};
    }

    /** 深拷贝（DX OS: n6） */
    function cloneTable(table){
        const t = normalizeTable(table).table;
        const clone = {kind:t.kind, version:t.version, columns:t.columns.slice(),
            rows:t.rows.map(r => r.slice()), selectedRows:t.selectedRows.slice(),
            mergedGroups:t.mergedGroups.map(g => g.slice()),
            aiColumns:t.aiColumns.map(entry => (entry ? {instruction:entry.instruction, updatedAt:entry.updatedAt} : null))};
        if(t.selection) clone.selection = {...t.selection};
        return clone;
    }

    // 1-based 序号 → 0-based 下标（DX OS: Kh）
    function toIndex(value, label, max){
        const n = Number(value);
        if(!Number.isInteger(n) || n < 1 || n > max) throw new Error(label + '必须是 1–' + max + '。');
        return n - 1;
    }

    /** 列定位：columnName 优先（要求唯一）→ column 1-based 序号（DX OS: o6） */
    function columnIndex(table, selector={}){
        const name = String(selector.columnName || '').trim();
        if(name){
            const hits = [];
            table.columns.forEach((c, i) => { if(c === name) hits.push(i); });
            if(hits.length > 1) throw new Error('列名“' + name + '”不唯一。');
            if(!hits.length) throw new Error('不存在列“' + name + '”。');
            return hits[0];
        }
        return toIndex(selector.column, '列序号', table.columns.length);
    }

    function rowIndex(table, value){ return toIndex(value, '行序号', table.rows.length); }

    /* 分镜表「时长(秒)」列：这一行的时长要真的当这一行视频的 duration 发出去，
       不只是拼进提示词。列名认全/半角括号与常见写法；认不出来返回 -1（行为不变）。
       只做全等匹配，「时间段(秒)」这类区间列不会被误认。 */
    const DURATION_COLUMN_KEYS = ['时长(秒)', '时长(s)', '时长(seconds)', '时长(sec)', '时长/秒',
        'duration(seconds)', 'duration(sec)', 'duration(s)', 'duration', '秒数', '时长'];
    function durationColumnKey(value){
        return String(value === null || value === undefined ? '' : value)
            .toLowerCase().replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')');
    }
    function durationColumnIndex(columns){
        const keys = (Array.isArray(columns) ? columns : []).map(durationColumnKey);
        for(const alias of DURATION_COLUMN_KEYS){
            const at = keys.indexOf(alias);
            if(at >= 0) return at;
        }
        return -1;
    }

    /* 单元格里的时长：纯数字（可带 s / 秒 单位）才算；空、文字、区间一律 null，
       让调用方回退到节点级 videoDuration。 */
    const DURATION_CELL_RE = /^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds|秒)?$/i;
    function cellDuration(value){
        if(isMediaCell(value)) return null;
        const matched = DURATION_CELL_RE.exec(cellText(value).trim());
        if(!matched) return null;
        const seconds = Number(matched[1]);
        return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
    }

    const OPERATION_IDS = Object.keys(TABLE_OPERATIONS);

    /** 执行一个操作，返回新表格（DX OS: i6）。表头/行列越界抛错，其余静默截断。 */
    function applyOperation(table, operationId, args={}){
        const opId = String(operationId || '');
        if(!TABLE_OPERATIONS[opId]) throw new Error('表格节点不支持操作：' + opId);
        const next = cloneTable(table);
        if(opId === 'read_table') return next;

        if(opId === 'set_cell'){
            const r = rowIndex(next, args.row);
            const c = columnIndex(next, args);
            next.rows[r][c] = isMediaCell(args.value) ? mediaCell(args.value.url, args.value.mediaType, args.value.name) : cellText(args.value);
            return next;
        }
        if(opId === 'set_cells'){
            if(!Array.isArray(args.cells)) throw new Error('批量修改需要 cells 数组。');
            /* 先全部校验再统一落笔：任何一格非法都不能留下半批改动。
               cellText 会静默截断，所以长度按原文另判一次。 */
            const writes = args.cells.map(item => {
                const cell = item && typeof item === 'object' ? item : {};
                const r = rowIndex(next, cell.row);
                const c = columnIndex(next, cell);
                if(!isMediaCell(cell.value) && rawCellText(cell.value).length > MAX_CELL_CHARS){
                    throw new Error('单元格内容不能超过 ' + MAX_CELL_CHARS + ' 字。');
                }
                const value = isMediaCell(cell.value)
                    ? mediaCell(cell.value.url, cell.value.mediaType, cell.value.name)
                    : cellText(cell.value);
                return {r, c, value};
            });
            writes.forEach(item => { next.rows[item.r][item.c] = item.value; });
            return next;
        }
        if(opId === 'append_row'){
            if(next.rows.length >= MAX_ROWS) throw new Error('表格最多允许 ' + MAX_ROWS + ' 行。');
            const values = args.values;
            const named = Boolean(values) && !Array.isArray(values) && typeof values === 'object';
            const list = Array.isArray(values) ? values : [];
            next.rows.push(next.columns.map((title, i) => cellText(named ? values[title] : list[i])));
            // 勾选语义＝默认全选，新增的行自动勾上
            next.selectedRows = Array.from(new Set(next.selectedRows.concat([next.rows.length - 1])))
                .filter(index => index >= 0 && index < next.rows.length)
                .sort((a, b) => a - b);
            return next;
        }
        if(opId === 'delete_row'){
            const r = rowIndex(next, args.row);
            next.rows.splice(r, 1);
            next.selectedRows = next.selectedRows.filter(i => i !== r)
                .map(i => (i > r ? i - 1 : i));
            reclampSelection(next);
            return next;
        }
        if(opId === 'add_column'){
            if(next.columns.length >= MAX_COLUMNS) throw new Error('表格最多允许 ' + MAX_COLUMNS + ' 列。');
            next.columns = normalizeColumns(next.columns.concat([args.title]));
            next.rows = next.rows.map(row => row.concat(['']));
            next.aiColumns = normalizeAiColumns(next.aiColumns.concat([null]), next.columns.length);
            return next;
        }
        if(opId === 'delete_column'){
            const c = columnIndex(next, args);
            next.columns.splice(c, 1);
            next.rows.forEach(row => row.splice(c, 1));
            next.aiColumns = normalizeAiColumns(next.aiColumns.filter((_, index) => index !== c), next.columns.length);
            reclampSelection(next);
            // 删列不改变行数，行选中状态原样保留
            return next;
        }
        throw new Error('表格节点不支持操作：' + opId);
    }

    /**
     * 行高（DX OS: mR）。按最长单元格折算行数：
     * 每 18 字一行 × 15px + 24px padding，夹在 [44（无媒体）/144（有媒体）, 160]。
     */
    function rowHeight(items, options={}){
        const perLine = Math.max(1, options.charactersPerLine ?? 18);
        const lineHeight = Math.max(1, options.lineHeight ?? 15);
        const padding = Math.max(0, options.verticalPadding ?? 24);
        const textMin = Math.max(1, options.textMinHeight ?? 44);
        const mediaMin = Math.max(1, options.mediaMinHeight ?? 84);
        const maxHeight = Math.max(mediaMin, options.maxHeight ?? 160);
        const lines = Math.max(1, ...(items || []).map(text =>
            // 媒体格不参与行高计算（它按缩略图算，走 hasMedia 那条下限）
            (isMediaCell(text) ? '' : String(text ?? '')).split('\n').reduce((sum, line) =>
                sum + Math.max(1, Math.ceil(Array.from(line).length / perLine)), 0)));
        return Math.min(maxHeight, Math.max(options.hasMedia ? mediaMin : textMin, padding + lines * lineHeight));
    }

    /** 节点尺寸（DX OS: Yw / ns）。inputColumns = 上游输入列数。 */
    function nodeSize(table, inputColumns=0){
        const t = normalizeTable(table).table;
        const colCount = Math.max(0, Number(inputColumns) || 0) + t.columns.length;
        const total = t.rows.length
            ? t.rows.reduce((sum, row, i) => sum + rowHeight(row, {hasMedia:false}), 0)
            : EMPTY_MIN_HEIGHT;
        return {
            width: Math.max(280, colCount * COLUMN_WIDTH + RESERVED_WIDTH + 2),
            height: HEADER_HEIGHT + total + 2,
        };
    }

    /* ── 输入列（DX OS §3：XS / Co / ab）────────────────────────────
       通道 = 一整列，表头「输入 N」，单元格是上游素材缩略图。
       items 里的 mode 决定逐行怎么取：
         sequence → [items[row]]              （逐行对应，一行一张，超出为空）
         all      → items 全部                （每行都用整列，一行多张）
         shared   → [items[min(row, len-1)]]  （按行取，超出后沿用最后一个） */
    const INPUT_CHANNEL_PREFIX = 'input-';
    const MENTION_LABELS = {image:'图片', video:'视频', audio:'音频', file:'文件'};
    const CHANNEL_MODES = ['sequence', 'all', 'shared'];
    const CHANNEL_MODE_LABELS = {sequence:'逐行', shared:'沿用', all:'全部'};

    function channelIdAt(index){ return INPUT_CHANNEL_PREFIX + (Math.max(0, Number(index) || 0) + 1); }

    function channelIndexFromId(channelId){
        const matched = /^input-(\d+)$/.exec(String(channelId || ''));
        if(!matched) return -1;
        const ordinal = Number(matched[1]);
        return Number.isInteger(ordinal) && ordinal >= 1 ? ordinal - 1 : -1;
    }

    /* 参考栏（输入列）默认「沿用」：一行取一张，行数超出后沿用最后一张。
       这里原来照搬 DX OS 的 refs.length > 1 ? "sequence" : "shared" ——
       >1 张就自动「逐行」，等于把参考栏拆成一列一张；实际用起来参考栏
       「一行一张、多的沿用最后一张」就够，不需要自动摊开。
       「逐行 / 全部」仍是显式可选项；分镜表规划里的 every-row 会明确写「全部」
       （每个镜头都要带上整组角色参考，不能掉成一张），所以模式本身不能删。 */
    function channelModeFor(){
        return 'shared';
    }

    function channelLabel(index){ return '输入 ' + (Math.max(0, Number(index) || 0) + 1); }

    function normalizeChannels(raw){
        const list = Array.isArray(raw) ? raw : [];
        return list.slice(0, MAX_COLUMNS).map((channel, index) => {
            const source = channel && typeof channel === 'object' ? channel : {};
            const items = (Array.isArray(source.items) ? source.items : []).slice(0, MAX_ROWS).map(entry => {
                const item = entry && typeof entry === 'object' ? entry : {};
                return {
                    type: item.type === 'text' ? 'text' : 'media',
                    nodeId: item.nodeId ? String(item.nodeId) : '',
                    text: cellText(item.text)
                };
            }).filter(item => item.nodeId || item.text.trim());
            return {
                id: String(source.id || channelIdAt(index)),
                mode: CHANNEL_MODES.includes(source.mode) ? source.mode : 'shared',
                items
            };
        });
    }

    /* ab(t, ch, row)：这一行该通道取到哪些条目。
       all 模式会返回整列，所以一律返回数组 —— 一行可以有多个参考图。 */
    function inputItemsForRow(channel, row){
        const items = Array.isArray(channel?.items) ? channel.items : [];
        if(!items.length) return [];
        const index = Math.max(0, Number(row) || 0);
        const mode = CHANNEL_MODES.includes(channel.mode) ? channel.mode : 'shared';
        if(mode === 'all') return items.slice();
        if(mode === 'sequence') return items[index] ? [items[index]] : [];
        return items[Math.min(index, items.length - 1)] ? [items[Math.min(index, items.length - 1)]] : [];
    }

    // 单条版本（取该行第一条），保留给只关心「有没有」的调用方
    function inputItemAt(channel, row){
        const list = inputItemsForRow(channel, row);
        return list.length ? list[0] : null;
    }

    function channelModeLabel(mode){ return CHANNEL_MODE_LABELS[mode] || CHANNEL_MODE_LABELS.shared; }

    // Xw(t, row, i)：行高要把输入列的文本值一起算进去，有媒体时下限抬到 144
    function rowHeightForRow(dataValues, inputTexts, hasMedia){
        return rowHeight([...(dataValues || []), ...(inputTexts || [])], {
            hasMedia: Boolean(hasMedia),
            mediaMinHeight: 144,
            maxHeight: 160
        });
    }

    /* ── 提示词（DX OS §4：L7 / jf）─────────────────────────────────
       引用不是 {列名} 占位符，而是 @图片1 / @视频2 / @音频3 / @文件4
       这种 mention（序号是全部引用里的全局序号）。表格行的值是**追加**
       进去的，不是替换。 */
    const MENTION_RE = /@(图片|视频|音频|文件)(\d+)/g;

    function mentionLabel(kind){ return MENTION_LABELS[String(kind || '')] || MENTION_LABELS.file; }

    function mentionTokenAt(kind, ordinal){ return '@' + mentionLabel(kind) + Math.max(1, Number(ordinal) || 1); }

    function mentionsIn(prompt){
        const out = [];
        String(prompt || '').replace(MENTION_RE, (token, label, digits) => {
            out.push({token, label, ordinal: Number(digits), index: Number(digits) - 1});
            return token;
        });
        return out;
    }

    /* 把提示词里的 @图片N 从「全局输入序号」改写成「该行参考图内的序号」。
       模型是照着全局输入清单写的序号，但每一行只拿到自己那份素材，
       不重编号的话 @图片4 这类引用在生成时全是悬空的。
       ordinalMap: 全局序号(1-based) → {position(该行内的 1-based 序号), kind}。
       对不上的引用保留原文并报出来 —— 绝不静默改写语义。 */
    function rewriteMentions(prompt, ordinalMap){
        const dangling = [];
        const text = String(prompt || '').replace(MENTION_RE, (token, label, digits) => {
            const ordinal = Number(digits);
            const target = ordinalMap instanceof Map ? ordinalMap.get(ordinal) : (ordinalMap || {})[ordinal];
            if(!target){
                dangling.push({token, label, ordinal, index: ordinal - 1, reason: 'missing'});
                return token;
            }
            if(mentionLabel(target.kind) !== label){
                dangling.push({token, label, ordinal, index: ordinal - 1, reason: 'kind'});
                return token;
            }
            return '@' + label + target.position;
        });
        return {text, dangling};
    }

    // 引用了不存在、或类型对不上的输入时要报出来，不能静默发出去
    function danglingMentions(prompt, references){
        const refs = Array.isArray(references) ? references : [];
        return mentionsIn(prompt).filter(mention => {
            const ref = refs[mention.index];
            return !ref || mentionLabel(ref.kind) !== mention.label;
        });
    }

    // jf(t, inputs, rowText) = 上游文本节点 + 节点自己的提示词 + 该行文本，\n 连接
    function buildRowPrompt(upstreamTexts, nodePrompt, rowText){
        return [
            ...(Array.isArray(upstreamTexts) ? upstreamTexts : []).map(text => String(text || '').trim()),
            String(nodePrompt || '').trim(),
            String(rowText || '').trim()
        ].filter(Boolean).join('\n');
    }

    /* ── 批量执行（DX OS §4 执行器 / §5 journal）─────────────────── */
    // failed 也在这里：不然失败行既标不上、续跑时也认不出来该重试
    const BATCH_ROW_STATUS = ['completed', 'running', 'pending', 'deferred', 'failed', 'cancelled'];
    const DEFAULT_BATCH_CONCURRENCY = 3;
    const MAX_BATCH_CONCURRENCY = 8;

    function batchFailurePolicy(raw){ return raw === 'stop' ? 'stop' : 'continue'; }

    function batchStartRow(raw, rowCount){
        const max = Math.max(1, Number(rowCount) || 0);
        const value = Math.floor(Number(raw));
        if(!Number.isFinite(value) || value < 1) return 1;
        return Math.min(value, max);
    }

    /* 并发 clamp 1..8。
       fallback 给不同目标类型用不同默认值：视频生成又慢又贵，
       未设置时默认 1（逐段串行），图像仍走 3。 */
    function batchConcurrency(raw, fallback){
        const fallbackValue = Math.floor(Number(fallback));
        const base = Number.isFinite(fallbackValue) && fallbackValue >= 1
            ? Math.min(MAX_BATCH_CONCURRENCY, fallbackValue)
            : DEFAULT_BATCH_CONCURRENCY;
        const value = Math.floor(Number(raw));
        if(!Number.isFinite(value) || value < 1) return base;
        return Math.min(MAX_BATCH_CONCURRENCY, value);
    }

    /* bl(t)：批量执行实际要跑的行。
       手动模式只取已选行；批量模式取起始行之后的全部。
       两种模式都跳过既没有媒体也没有文本的空行。 */
    function batchRowsToRun(rows, options={}){
        const list = Array.isArray(rows) ? rows : [];
        const manual = Boolean(options.manual);
        const startRow = batchStartRow(options.startRow, list.length);
        // 不传 selectedRows 就不按勾选过滤（兼容旧调用）；传了就是权威
        const selectedSet = Array.isArray(options.selectedRows)
            ? new Set(options.selectedRows.map(Number))
            : null;
        return list.filter(row => {
            if(!row) return false;
            const hasContent = (Array.isArray(row.media) && row.media.length) || String(row.text || '').trim();
            if(!hasContent) return false;
            // 取消勾选的行一律不跑，批量与独立运行都适用
            if(selectedSet && !selectedSet.has(Number(row.rowNumber) - 1)) return false;
            if(manual) return true;
            return Number(row.rowNumber) >= startRow;
        });
    }

    function emptyJournal(runId, rows, failurePolicy){
        return {
            runId: String(runId || ''),
            failurePolicy: batchFailurePolicy(failurePolicy),
            rows: (Array.isArray(rows) ? rows : []).map(row => ({
                rowNumber: Number(row?.rowNumber) || 0,
                text: cellText(row?.text),
                mediaNodeIds: (Array.isArray(row?.media) ? row.media : []).map(item => String(item?.nodeId || '')).filter(Boolean),
                status: 'pending',
                requestId: ''
            }))
        };
    }

    function normalizeJournal(raw){
        const source = raw && typeof raw === 'object' ? raw : {};
        return {
            runId: String(source.runId || ''),
            failurePolicy: batchFailurePolicy(source.failurePolicy),
            rows: (Array.isArray(source.rows) ? source.rows : []).map(row => {
                const item = row && typeof row === 'object' ? row : {};
                return {
                    rowNumber: Number(item.rowNumber) || 0,
                    text: cellText(item.text),
                    mediaNodeIds: (Array.isArray(item.mediaNodeIds) ? item.mediaNodeIds : []).map(String).filter(Boolean),
                    status: BATCH_ROW_STATUS.includes(item.status) ? item.status : 'pending',
                    requestId: String(item.requestId || '')
                };
            })
        };
    }

    // 断点续跑匹配：runId 对不上就新建；对得上则按 rowNumber 对齐
    function matchBatchJournal(existing, runId, rows, failurePolicy){
        const wanted = String(runId || '');
        if(!wanted) return emptyJournal('', rows, failurePolicy);
        const journal = normalizeJournal(existing);
        if(journal.runId !== wanted) return emptyJournal(wanted, rows, failurePolicy);
        const byNumber = new Map(journal.rows.map(row => [row.rowNumber, row]));
        const merged = emptyJournal(wanted, rows, failurePolicy);
        merged.rows = merged.rows.map(row => {
            const prior = byNumber.get(row.rowNumber);
            const sameText = prior && prior.text === row.text;
            const sameMedia = prior && prior.mediaNodeIds.join(',') === row.mediaNodeIds.join(',');
            /* 只沿用「已完成」和「仍在后台」的状态：completed 的行被跳过，
               running/deferred 的行不重复派发；failed 重置为 pending 以便重试。
               行内容被改过的一律重置。 */
            if(prior && prior.status !== 'pending' && prior.status !== 'failed' && sameText && sameMedia){
                return {...row, status: prior.status, requestId: prior.requestId};
            }
            return row;
        });
        return merged;
    }

    // 命中返回那一行，落空返回 null（之前命中返行、落空返 journal，返回类型不一致）
    function journalMarkRow(journal, rowNumber, status, requestId){
        const target = journal.rows.find(row => row.rowNumber === Number(rowNumber));
        if(!target) return null;
        if(BATCH_ROW_STATUS.includes(status)) target.status = status;
        if(requestId !== undefined) target.requestId = String(requestId || '');
        return target;
    }

    function journalPendingRows(journal){ return journal.rows.filter(row => row.status === 'pending'); }
    // 「仍在后台」的行：不能重复派发（DX OS §5 后台恢复检测）
    function journalInflightRows(journal){ return journal.rows.filter(row => row.status === 'running' || row.status === 'deferred'); }
    function journalCompletedRows(journal){ return journal.rows.filter(row => row.status === 'completed'); }
    function journalFailedRows(journal){ return journal.rows.filter(row => row.status === 'failed'); }
    function journalCancelledRows(journal){ return journal.rows.filter(row => row.status === 'cancelled'); }

    // 素材有效性：把缺文件/失效的行挑出来，别发出去再失败
    function batchMissingMaterials(rows){
        const missing = [];
        (Array.isArray(rows) ? rows : []).forEach(row => {
            (Array.isArray(row?.media) ? row.media : []).forEach(item => {
                if(item && item.invalid) missing.push({rowNumber: Number(row?.rowNumber) || 0, nodeId: String(item.nodeId || ''), reason: String(item.invalid)});
            });
        });
        return missing;
    }

    /* 共享游标 + N 个 worker（DX OS §4 的并发模型）。
       stopOnError 对应 tableBatchFailurePolicy === "stop"：出错后不再派发新行，
       已经在跑的行自然跑完。 */
    async function runWithSharedCursor(items, concurrency, worker, options={}){
        const list = Array.isArray(items) ? items : [];
        if(!list.length) return [];
        const limit = Math.min(Math.max(1, Number(concurrency) || 1), list.length);
        const stopOnError = Boolean(options.stopOnError);
        const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : null;
        const results = new Array(list.length);
        let cursor = 0;
        let failed = false;
        const run = async () => {
            while(true){
                if(stopOnError && failed) return;
                if(shouldStop && shouldStop()) return;
                const index = cursor;
                cursor += 1;
                if(index >= list.length) return;
                try {
                    results[index] = {ok:true, value: await worker(list[index], index)};
                } catch(error){
                    results[index] = {ok:false, error};
                    failed = true;
                }
            }
        };
        await Promise.all(Array.from({length:limit}, run));
        /* 停止时没轮到派发的行：显式标成「取消」，调用方据此区分 failed。
           不留下空洞，否则会跟「没跑」和「失败」混在一起。 */
        for(let index = 0; index < results.length; index += 1){
            if(results[index] === undefined) results[index] = {ok:false, cancelled:true};
        }
        return results;
    }

    /* ── LLM → 表格（DX OS §6：FS 规划 / BS 生成 / a6 校验 / CR 修复）─── */
    const TABLE_PARSE_ERRORS = {
        format: '模型没有返回统一的多维表格格式',
        columns: '模型返回的表格列名不完整',
        empty: '模型返回的多维表格没有任何内容',
        missing: '缺少多维表格输出'
    };
    const TABLE_REPAIR_INSTRUCTION = '请把下面未通过校验的结果修复为合法的多维表格 JSON。不要删减原有信息，不要输出解释或 Markdown。';
    const LLM_REPAIR_MAX_TOKENS = 8192;

    /* 把 JSON **字符串字面量内部**的裸控制字符转成转义序列。
       模型经常把真实换行写进字符串值里（原始响应里就是 0x0A），严格 JSON 会判
       「Bad control character in string literal」。字符串外的换行/缩进是合法空白，
       原样保留；反斜杠转义之后的字符不碰（本来就是对的 \n 写法不能被改坏）。 */
    function escapeJsonControlChars(source){
        const text = String(source || '');
        let out = '';
        let inString = false;
        let escaped = false;
        for(let index = 0; index < text.length; index += 1){
            const ch = text.charAt(index);
            if(!inString){
                out += ch;
                if(ch === '"') inString = true;
                continue;
            }
            if(escaped){ out += ch; escaped = false; continue; }
            if(ch === '\\'){ out += ch; escaped = true; continue; }
            if(ch === '"'){ out += ch; inString = false; continue; }
            const code = text.charCodeAt(index);
            if(code >= 0x20){ out += ch; continue; }
            if(ch === '\n') out += '\\n';
            else if(ch === '\r') out += '\\r';
            else if(ch === '\t') out += '\\t';
            else out += '\\u' + ('000' + code.toString(16)).slice(-4);
        }
        return out;
    }

    /* 先按原样 parse（合法 JSON 的结果与报错行为一点不变），失败了才做控制字符修复。 */
    function parseJsonLenient(body){
        try { return JSON.parse(body); }
        catch(error){
            try { return JSON.parse(escapeJsonControlChars(body)); }
            catch(retryError){ return null; }
        }
    }

    function stripJsonFence(text){
        let source = String(text || '').trim();
        const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(source);
        if(fenced) source = fenced[1].trim();
        else {
            const inline = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
            if(inline) source = inline[1].trim();
        }
        return source;
    }

    // 剥 ```json 代码块 → 取首尾大括号 → JSON.parse
    function extractJsonObject(text){
        const source = stripJsonFence(text);
        const first = source.indexOf('{');
        const last = source.lastIndexOf('}');
        if(first < 0 || last <= first) return null;
        return parseJsonLenient(source.slice(first, last + 1));
    }

    /* 顶层直接是数组的 JSON（模型偶尔省掉 {"shots":…} 外壳）。 */
    function extractJsonArray(text){
        const source = stripJsonFence(text);
        const first = source.indexOf('[');
        const last = source.lastIndexOf(']');
        if(first < 0 || last <= first) return null;
        const parsed = parseJsonLenient(source.slice(first, last + 1));
        return Array.isArray(parsed) ? parsed : null;
    }

    /* 模型返回里的**全部** JSON 数据块。
       视频分镜表这类长输出经常被模型拆成几块（若干代码块，或几段并列的 JSON 对象）。
       旧实现只认第一块 → 第一块里只有一行时，整张表就只剩第一行。
       这里按「代码块优先；没有代码块再扫顶层 {...} / [...]」收集，解析失败的块跳过。 */
    function extractJsonValues(text){
        const source = String(text || '');
        if(!source.trim()) return [];
        const values = [];
        const fenceRe = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
        let fenced;
        while((fenced = fenceRe.exec(source))){
            const body = String(fenced[1] || '').trim();
            if(!body) continue;
            const parsed = parseJsonLenient(body);
            if(parsed !== null && parsed !== undefined) values.push(parsed);
        }
        if(values.length) return values;
        /* 没有代码块：按顶层括号扫描（字符串里的括号不算），一段一段 parse。
           多个对象/数组之间夹散文也能逐段取出来。 */
        let start = -1;
        const stack = [];
        let inString = false;
        let escaped = false;
        for(let index = 0; index < source.length; index += 1){
            const ch = source.charAt(index);
            if(inString){
                if(escaped){ escaped = false; continue; }
                if(ch === '\\'){ escaped = true; continue; }
                if(ch === '"') inString = false;
                continue;
            }
            if(ch === '"'){ inString = true; continue; }
            if(ch === '{' || ch === '['){
                if(!stack.length) start = index;
                stack.push(ch);
                continue;
            }
            if(ch === '}' || ch === ']'){
                if(!stack.length) continue;
                const open = stack.pop();
                if((open === '{' && ch !== '}') || (open === '[' && ch !== ']')){
                    stack.length = 0;
                    start = -1;
                    continue;
                }
                if(stack.length || start < 0) continue;
                const parsed = parseJsonLenient(source.slice(start, index + 1));
                if(parsed !== null && parsed !== undefined) values.push(parsed);
                start = -1;
            }
        }
        return values;
    }

    /* 结构合法但整张表一个字都没有：实测模型偶发返回 [""] 这种空表，
       放过去的话批量执行会拿着空提示词去生成。判格式不合规，交给修复遍。 */
    function tableRowsAreEmpty(rows){
        return !rows.length || rows.every(row => row.every(cell => !String(cell || '').trim()));
    }

    /* a6(t)：校验模型返回的表格。
       LLM 侧上限比手工小得多（40 列 / 200 行），超了直接判格式不合规。
       返回合法表格，不合法抛错（文案照搬规范）。
       模型把一张表拆成多个数据块返回时，列结构相同的块按顺序合并行 ——
       分镜表分页/分块输出不会再只剩第一块那一行。 */
    function parseTableOutput(text){
        const blocks = extractJsonValues(text).filter(value => Boolean(value) && typeof value === 'object'
            && !Array.isArray(value) && value.kind === TABLE_KIND && Number(value.version) === TABLE_VERSION
            && Array.isArray(value.columns) && Array.isArray(value.rows));
        if(blocks.length){
            const primary = blocks[0];
            if(primary.columns.length > LLM_MAX_COLUMNS) throw new Error(TABLE_PARSE_ERRORS.format);
            if(!primary.columns.length) throw new Error(TABLE_PARSE_ERRORS.columns);
            /* 先按原始列名校验：模型给了空白列名属于格式不合规，要报出来让修复遍处理。
               手工建列时空列名会被兜底成「未命名列」，那是友好的；这里不能沿用那个兜底。 */
            const rawColumns = primary.columns.map(name => cellText(name));
            if(rawColumns.some(name => !String(name).trim())) throw new Error(TABLE_PARSE_ERRORS.columns);
            const columns = normalizeColumns(rawColumns);
            const rows = [];
            blocks.forEach(block => {
                /* 只有列结构相同的块才是同一张表的续页；不同结构的分块不合并，避免把两张表拼坏。 */
                const blockColumns = normalizeColumns(block.columns.map(name => cellText(name)));
                if(blockColumns.length !== columns.length || blockColumns.some((name, index) => name !== columns[index])) return;
                if(block.rows.length > LLM_MAX_ROWS) throw new Error(TABLE_PARSE_ERRORS.format);
                block.rows.forEach(row => {
                    const list = Array.isArray(row) ? row : [];
                    // 行按列数补齐
                    rows.push(columns.map((name, index) => cellText(list[index])));
                });
            });
            if(rows.length > LLM_MAX_ROWS) throw new Error(TABLE_PARSE_ERRORS.format);
            if(tableRowsAreEmpty(rows)) throw new Error(TABLE_PARSE_ERRORS.empty);
            const table = {kind:TABLE_KIND, version:TABLE_VERSION, columns, rows, selectedRows:[], mergedGroups:[]};
            /* 生成遍可以顺带回一份「每一组怎么用」的回执（inputGroups）。
               经典画布走 规划→生成 两遍，模式来自规划；智能画布只发一次请求，
               没有规划遍 —— 模式就靠这份回执，否则多图组会一律落到「沿用」，
               表现就是「一行只读一张白底图」（用户报的）。 */
            const groups = blocks.map(block => block.inputGroups).find(Array.isArray);
            if(groups) table.inputGroups = groups;
            return table;
        }
        /* 不是表格结构（或旧格式）：走原来的单对象解析，报错/修复行为保持不变。 */
        const parsed = extractJsonObject(text);
        if(!parsed || typeof parsed !== 'object') throw new Error(TABLE_PARSE_ERRORS.format);
        if(parsed.kind !== TABLE_KIND || Number(parsed.version) !== TABLE_VERSION) throw new Error(TABLE_PARSE_ERRORS.format);
        if(!Array.isArray(parsed.columns) || !Array.isArray(parsed.rows)) throw new Error(TABLE_PARSE_ERRORS.format);
        if(parsed.columns.length > LLM_MAX_COLUMNS || parsed.rows.length > LLM_MAX_ROWS) throw new Error(TABLE_PARSE_ERRORS.format);
        if(!parsed.columns.length) throw new Error(TABLE_PARSE_ERRORS.columns);
        const legacyColumns = parsed.columns.map(name => cellText(name));
        if(legacyColumns.some(name => !String(name).trim())) throw new Error(TABLE_PARSE_ERRORS.columns);
        const columns = normalizeColumns(legacyColumns);
        const rows = parsed.rows.slice(0, LLM_MAX_ROWS).map(row => {
            const list = Array.isArray(row) ? row : [];
            return columns.map((name, index) => cellText(list[index]));
        });
        if(tableRowsAreEmpty(rows)) throw new Error(TABLE_PARSE_ERRORS.empty);
        const table = {kind:TABLE_KIND, version:TABLE_VERSION, columns, rows, selectedRows:[], mergedGroups:[]};
        if(Array.isArray(parsed.inputGroups)) table.inputGroups = parsed.inputGroups;
        return table;
    }

    function buildRepairPrompt(badText){
        return TABLE_REPAIR_INSTRUCTION + '\n\n' + String(badText || '');
    }

    function inputLine(item, ordinal){
        const kind = mentionLabel(item && item.kind);
        const label = item && item.label ? ' — ' + item.label : '';
        return ordinal + '. ' + kind + '（' + mentionTokenAt(item && item.kind, ordinal) + '）' + label;
    }

    /* 输入清单文案。序号是**跨组的全局序号**，和 @图片N 一一对应。
       给了分组就按组渲染：模型必须知道哪些图是一组、这一组是「逐行对应」
       还是「每行都用」，否则只能靠文件名猜，行数和 @图片N 的映射都会错。 */
    function inputListText(inputs, groups, groupModes){
        const list = Array.isArray(inputs) ? inputs : [];
        const grouped = Array.isArray(groups) && groups.length ? groups : null;
        if(!grouped) return list.map((item, index) => inputLine(item, index + 1)).join('\n');

        const lines = [];
        let ordinal = 0;
        grouped.forEach((group, groupIndex) => {
            const entries = Array.isArray(group && group.entries) ? group.entries : [];
            const known = Array.isArray(groupModes) ? groupModes[groupIndex] : '';
            lines.push('第 ' + (groupIndex + 1) + ' 组：' + entries.length + ' 张'
                + (known ? '，' + channelModeLabel(known) : ''));
            entries.forEach(entry => {
                ordinal += 1;
                lines.push('  ' + inputLine(entry, ordinal));
            });
        });
        return lines.join('\n');
    }

    /* 从规划里取出每一组的执行方式：per-row → sequence，every-row → all。
       没指定的留空，调用方回落到自动推导。 */
    function planGroupModes(plan, groupCount){
        const out = new Array(Math.max(0, Number(groupCount) || 0)).fill('');
        const groups = plan && Array.isArray(plan.inputGroups) ? plan.inputGroups : [];
        groups.forEach(item => {
            const index = Number(item && item.group) - 1;
            if(index < 0 || index >= out.length) return;
            if(item.rowMode === 'per-row') out[index] = 'sequence';
            else if(item.rowMode === 'every-row') out[index] = 'all';
        });
        return out;
    }

    /* ── LLM 目标类型（分镜 / 单图）────────────────────────────────
       LLM 的多维表格下游接的是视频节点还是图像节点，决定提示词怎么组织：
       视频 → 分镜（一行一个镜头，画面/景别/运镜/时长写清楚）；
       图像 → 一行一张图的完整生成内容。 */
    function llmTargetKind(raw){ return raw === 'video' ? 'video' : 'image'; }

    // 视频分镜：规划遍附加约束
    const VIDEO_PLAN_BLOCK = [
        '',
        '【本次产出直接接到「视频生成」节点，所以每一行 = 一个分镜（一段视频）。】',
        '规划时必须按分镜组织：把用户要求拆成若干个镜头，逐个镜头写清画面内容、主体动作、景别与机位、运镜方式、光线氛围、时长。',
        '镜头数量：用户明确指定就按用户说的数量；没有指定时按叙事节奏拆成 4–6 个镜头。',
        '没有参考图/参考视频时（可用输入为「（无）」），完全依据用户提示词构思分镜，不要因为没有素材就拒绝出表。',
        '有参考素材时，参考决定主体外观、场景与风格的一致性，要在 mapping 里写清哪些镜头共用同一份参考。',
        '相邻镜头不要重复同一个动作，整段连起来要能讲完用户要的事。'
    ].join('\n');

    // 视频分镜：生成遍附加约束
    const VIDEO_GENERATE_BLOCK = [
        '',
        '【本次产出直接接到「视频生成」节点：每一行 = 一个分镜（一段视频）。】',
        '每一行必须是一条完整、独立、可直接送进视频模型的分镜。',
        '列结构至少要有这 3 列，缺一不可：「时长(秒)」「运镜」「画面描述」。',
        '「画面描述」是这一行的主体：写清主体与动作、场景与环境、景别与机位、光线与氛围；这一列必须信息完整，不能只写一句概括。',
        '「时长(秒)」写纯数字（如 1.5），「运镜」写几个词（如「缓慢推近」）——这两列写短值，不要把整段描述重复进每一列。',
        '除这 3 列外可以按任务增补（景别、机位、光线、台词/音效、衔接要求等），但绝不允许多个分镜共用一行，也不要把全部内容塞进单一一列。',
        '每一列的内容都会按顺序拼进这一行的正向提示词：不要创建「负向提示词」「禁止项」这类列，负面词汇会被当成画面描述。要排除的东西用正向句写进「画面描述」（例如「画面干净、无文字」）。',
        '同一段内容不要重复写在两列里。',
        '不要创建只用于计数的序号列——行的先后顺序已经表达了镜头顺序。',
        '不要把多个镜头塞进同一行，也不要让相邻镜头重复同一动作；行与行连起来应是一段连贯的镜头序列。',
        '没有参考素材时同样要出表：直接依据用户提示词拆分镜，行数就是镜头数量。'
    ].join('\n');

    /* FS(t)：规划遍提示词。只做规划，不要输出最终 rows。
       options.targetKind = 'video' 时按分镜组织。 */
    function buildListPlanPrompt(requirement, inputs, groups, options={}){
        const video = llmTargetKind(options.targetKind) === 'video';
        return [
            video
                ? '你在为一个「多维表格 → 视频分镜批量生成」工作流做任务规划。'
                : '你在为一个「多维表格批量生成」工作流做任务规划。',
            '',
            '用户要求：',
            String(requirement || '').trim(),
            '',
            '可用输入（按画布连线分组，序号是全局序号，与 @图片N 一一对应）：',
            inputListText(inputs, groups) || '（无）',
            '',
            '必须为每一个输入组指定它在逐行执行里的用法 rowMode。判据是「这一组里的图彼此是什么关系」：',
            '- "per-row"（逐行）：同一组里是**每行各一个不同主体/物品**（例如一组不同款商品的静物图，一行换一个主体）。第 N 行只引用这一组的第 N 张；这一组有几张就几行。',
            '- "every-row"（全部）：同一组是**同一个产品的多角度照片**（例如同一产品的白底多角度图），整组是这一行的多角度参考，每一行都要用上整组。',
            '一行具体引用哪一张，由「这一组是逐行还是全部」决定：逐行组按行号取一张，全部组整组都带上。',
            '行的数量由 per-row 的组决定；every-row 的组只增加每行带的素材数（多角度参考），不增加行数。',
            video ? VIDEO_PLAN_BLOCK : '',
            '',
            '只做规划，不要输出最终 rows。',
            '请只返回一个 JSON 对象，结构如下：',
            '{"task":"任务目标","rowCount":行数,"targetInputs":["目标主体输入"],"referenceInputs":["参考输入"],"inputGroups":[{"group":1,"role":"这一组是什么","rowMode":"per-row 或 every-row","mapping":"如何映射到行","transfer":"需要迁移的","doNotTransfer":"不要迁移的"}],"columns":["列名1","列名2"],"rowRules":["每行怎么定"],"qualityChecks":["怎么算合格"]}',
            '不要 Markdown 代码块，不要解释。'
        ].join('\n');
    }

    /* BS(t, plan)：生成遍提示词。约束逐条照搬规范。
       options.targetKind = 'video' 时按分镜组织。 */
    function buildListGeneratePrompt(requirement, inputs, groups, plan, options={}){
        let planText = '';
        if(plan && typeof plan === 'object'){ try { planText = JSON.stringify(plan, null, 2); } catch(error){ planText = ''; } }
        const modes = planGroupModes(plan, Array.isArray(groups) ? groups.length : 0);
        const video = llmTargetKind(options.targetKind) === 'video';
        return [
            video
                ? '请把结果整理为可逐行执行的视频分镜任务：每一行必须是一条完整、独立、可直接用于后续视频生成的分镜提示词。'
                : '请把结果整理为可逐行执行的生成任务：每一行必须是一条完整、独立、可直接用于后续图像生成的内容。',
            '',
            '已确认的规划：',
            planText || '（无规划，按用户要求自行判断）',
            '',
            '用户要求：',
            String(requirement || '').trim(),
            '',
            '可用输入（按画布连线分组，序号是全局序号，与 @图片N 一一对应）：',
            inputListText(inputs, groups, modes) || '（无）',
            '',
            '行数按「逐行」的组确定；「全部」的组每一行都带整组，不增加行数。',
            '严格遵守用户指定的数量；未指定时根据逐项输入数量和任务目标合理决定。',
            /* 「全部」的组每行都带整组素材，但模型常常只在提示词里 @ 这一组的第一张，
               其余几张在提示词里完全不出现 —— 用户看到的就是「多张白底图只读取一张」。
               强制要求逐张点出来，提示词、批量面板、结果节点上才能看到整组。 */
            '「逐行」的组：第 N 行的提示词**只能**引用这一组的第 N 张，写它对应的全局序号。绝不能引用同组其它行的图，也不要把整组都列一遍——每行就一张主体参考。',
            '「全部」的组：整组当作这一行的「多角度参考」，每一行都必须用 @图片N 把这一组的**每一张**都点出来（例如「参考 @图片5、@图片6 的白底多角度图」），不能只写其中一张。',
            '示例：第 1 组是 3 张静物图（逐行），第 2 组是同一个产品的 2 张白底多角度图（全部）。则第 1 行写 @图片1 + @图片4、@图片5；第 2 行写 @图片2 + @图片4、@图片5；第 3 行写 @图片3 + @图片4、@图片5。',
            '同时回报每一组的用法 inputGroups：{"group":组号,"rowMode":"per-row"或"every-row"}。per-row = 这一组是行驱动（第 N 行用第 N 张）；every-row = 每一行都要用上整组。',
            video ? VIDEO_GENERATE_BLOCK : '',
            '如果任务区分了「目标主体」和「风格/版式参考」，每行生成提示词都必须显式写清它们的关系。',
            '不要只写「使用图1」「参考图2」这类占位说明。每个文字单元格应提供与普通文本输出相当的信息密度。',
            '请根据任务自行设计最合适的列结构，不套固定模板。',
            '行的先后顺序已经可以表达执行顺序，因此通常不需要额外创建只用于计数的序号列。',
            '不要在 JSON 中创建图片、参考图或生成输入列，系统会在独立的输入区域按规划映射素材，不会覆盖文字列。',
            '只返回一个 JSON 对象，不要 Markdown 代码块，不要解释。',
            '{"kind":"table","version":1,"inputGroups":[{"group":1,"rowMode":"per-row 或 every-row"}],"columns":["列名1","列名2"],"rows":[["单元格1","单元格2"]]}'
        ].join('\n');
    }

    /* ── 参考视频分段（视频分镜表：一段 = 一行）──────────────────────
       参考视频按「每段秒数」切成若干段，一段一行：每行的视频参考只有这一段自己的
       片段，产品图 / 模特穿搭图每行都带。分段规则与后端 /api/video/segments 的
       plan_video_segments 完全一致（末段不足 1 秒并入上一段；超上限只留前 N 段），
       后端不可用时前端照它兜底算行数 —— 兜底没有片段地址，绝不能编造 clip_url。 */
    const VIDEO_SEGMENT_SECONDS_DEFAULT = 3;
    const VIDEO_SEGMENT_SECONDS_MIN = 1;
    const VIDEO_SEGMENT_SECONDS_MAX = 5;
    const VIDEO_SEGMENT_MAX_SEGMENTS = 30;
    const VIDEO_SEGMENT_MAX_SEGMENTS_LIMIT = 60;
    const VIDEO_SEGMENT_MIN_TAIL_SECONDS = 1;

    function segmentSeconds(raw){
        const value = Number(raw);
        if(!Number.isFinite(value)) return VIDEO_SEGMENT_SECONDS_DEFAULT;
        return Math.min(VIDEO_SEGMENT_SECONDS_MAX, Math.max(VIDEO_SEGMENT_SECONDS_MIN, value));
    }

    function segmentMaxSegments(raw){
        const value = Math.floor(Number(raw));
        if(!Number.isFinite(value) || value < 1) return VIDEO_SEGMENT_MAX_SEGMENTS;
        return Math.min(VIDEO_SEGMENT_MAX_SEGMENTS_LIMIT, value);
    }

    // 秒数文案：整数不带小数位（3 而不是 3.0），小数最多两位
    function formatSeconds(raw){
        const value = Number(raw);
        if(!Number.isFinite(value)) return '0';
        return String(Math.round(value * 100) / 100);
    }

    /* 分段规划：[{index,start,end,duration}]。
       1e-6 容差：时长恰为整数倍时不再多切一个 0 秒空段。 */
    function planVideoSegments(duration, seconds, maxSegments){
        const total = Number(duration);
        if(!Number.isFinite(total) || total <= 0) return [];
        const step = segmentSeconds(seconds);
        const round = value => Math.round(value * 1000) / 1000;
        const segments = [];
        let start = 0;
        while(start < total - 1e-6){
            const end = Math.min(start + step, total);
            segments.push({index:segments.length + 1, start:round(start), end:round(end), duration:round(end - start)});
            start += step;
        }
        if(segments.length > 1 && segments[segments.length - 1].duration < VIDEO_SEGMENT_MIN_TAIL_SECONDS){
            segments.pop();
            const last = segments[segments.length - 1];
            last.end = round(total);
            last.duration = round(last.end - last.start);
        }
        const limit = segmentMaxSegments(maxSegments);
        return segments.length > limit ? segments.slice(0, limit) : segments;
    }

    function segmentCountOf(duration, seconds, maxSegments){
        return planVideoSegments(duration, seconds, maxSegments).length;
    }

    /* 角色的判据分三层（优先级从高到低）：
       ① 节点名 / 文件名里的关键词；② 指令文本语境（用名字在指令里定位，看它前面
       最近的语义词）；③ 兜底：第一个没分类的图当产品，其余当模特/穿搭。
       语境这一层必须有：用户的素材名常常是 DSC07792.jpg 这种，关键词认不出来，
       但指令里写着「人物替换成 @lovart…，鞋子替换成 @DSC07792.jpg」。 */
    const SEGMENT_PRODUCT_RE = /产品|商品|鞋|靴|包|帽|主图|白底|细节|product|sku/i;
    const SEGMENT_MODEL_RE = /模特|人物|穿搭|服装|衣服|上身|outfit|model|look/i;
    const SEGMENT_CONTEXT_PRODUCT_RE = /产品|商品|鞋|靴|包|帽|logo|材质|细节|product|sku/gi;
    const SEGMENT_CONTEXT_MODEL_RE = /模特|人物|穿搭|服装|衣服|上身|outfit|model|look/gi;

    // 最近一次匹配的位置（-1 = 没匹配到）；用来判「名字前面最近的那个语义词」
    function lastMatchIndex(text, pattern){
        pattern.lastIndex = 0;
        let last = -1;
        let hit;
        while((hit = pattern.exec(text))){
            last = hit.index;
            if(!pattern.lastIndex) break;    // 零宽匹配保护，避免死循环
        }
        pattern.lastIndex = 0;
        return last;
    }

    function segmentEntryRole(entry, instructionText){
        const label = [entry && entry.label, entry && entry.name].filter(Boolean).join(' ');
        if(SEGMENT_PRODUCT_RE.test(label)) return 'product';
        if(SEGMENT_MODEL_RE.test(label)) return 'modelOutfit';
        const name = String((entry && entry.name) || '').trim();
        const text = String(instructionText || '');
        if(!name || !text) return '';
        const at = text.indexOf(name);
        if(at < 0) return '';
        const before = text.slice(0, at);
        const productAt = lastMatchIndex(before, SEGMENT_CONTEXT_PRODUCT_RE);
        const modelAt = lastMatchIndex(before, SEGMENT_CONTEXT_MODEL_RE);
        if(productAt < 0 && modelAt < 0) return '';
        return productAt >= modelAt ? 'product' : 'modelOutfit';
    }

    /* 素材分角色。kind==='video' 的只有第一个当参考分镜来源，其余视频进 others
       （多段参考视频无法同时当「本行那一段」的参考，只能忽略）。
       非图片（音频/文件）也进 others，不参与参考用法。 */
    function classifySegmentInputs(entries, instructionText){
        const list = Array.isArray(entries) ? entries : [];
        const out = {video:null, product:[], modelOutfit:[], others:[]};
        const unclassified = [];
        list.forEach(entry => {
            if(!entry) return;
            const kind = String(entry.kind || 'image');
            if(kind === 'video'){
                if(!out.video) out.video = entry;
                else out.others.push(entry);
                return;
            }
            if(kind !== 'image'){ out.others.push(entry); return; }
            const role = segmentEntryRole(entry, instructionText);
            if(role === 'product') out.product.push(entry);
            else if(role === 'modelOutfit') out.modelOutfit.push(entry);
            else unclassified.push(entry);
        });
        unclassified.forEach((entry, index) => {
            if(!index) out.product.push(entry);
            else out.modelOutfit.push(entry);
        });
        return out;
    }

    /* 逐段写画面描述：把这一批段的首帧图按顺序发给多模态模型。
       只描述图里真实存在的东西 —— 图看不清就照实写，不编造。
       options.onlyIndexes：这一批只是「补齐缺失段」时，开头就点名只写哪几段 ——
       不点名的话模型会以为又要从头写一遍，把已经拿到的段重复输出。 */
    function buildSegmentShotPrompt(requirement, entries, segments, options={}){
        const media = Array.isArray(entries) ? entries : [];
        const list = Array.isArray(segments) ? segments : [];
        if(!list.length) return '';
        const first = list[0];
        const last = list[list.length - 1];
        const step = formatSeconds(first.duration);
        const onlyIndexes = (Array.isArray(options.onlyIndexes) ? options.onlyIndexes : []).map(Number).filter(Number.isFinite);
        const lines = list.map((segment, index) => {
            const name = String((media[index] && media[index].name) || '').trim();
            return '第 ' + segment.index + ' 段（' + formatSeconds(segment.start) + '–' + formatSeconds(segment.end)
                + 's，共 ' + formatSeconds(segment.duration) + ' 秒）：下面第 ' + (index + 1) + ' 张图' + (name ? '（' + name + '）' : '');
        });
        return [
            onlyIndexes.length
                ? '你在为「参考视频分镜表」补齐缺失段：原片已按每段 ' + step + ' 秒切分，本次只写第 '
                    + onlyIndexes.join('、') + ' 段，下面 ' + list.length + ' 张图依次就是这几段的**首帧画面**。'
                : '你在为「参考视频分镜表」逐段写画面描述：原片已按每段 ' + step + ' 秒切分，'
                    + '下面 ' + list.length + ' 张图依次是第 ' + first.index + '–' + last.index + ' 段的**首帧画面**。',
            '',
            '用户要求：',
            String(requirement || '').trim(),
            '',
            ...lines,
            '',
            '要求：',
            '- 只写图里真实能看到的内容：主体与动作、场景与环境、景别与机位、光线与氛围。图里看不清或没有的东西一律不要编造。',
            '- 「画面描述」一到两句，写完整；「运镜」按这一帧的构图推断（如「缓慢推近」「固定机位」），拿不准就写「固定机位」。',
            '- 「景别」写「远景 / 全景 / 中景 / 近景 / 特写」之一。',
            '- 只返回一个 JSON 对象，不要 Markdown 代码块，不要解释：',
            '{"shots":[{"index":1,"画面描述":"...","运镜":"...","景别":"..."}]}'
        ].join('\n');
    }

    /* 解析逐段描述：{shots:[…]} 与「顶层直接数组」两种都认；解析失败返回 []（不抛错，
       出表不能因为它挂掉）。index 是字符串数字也认（模型常写 "index":"2"）。 */
    /* 取字段：先按原名找；模型把裸换行写进键名里（"\n景别"）时，
       再按「去掉控制字符与空白后同名」找一遍，否则那一列会白白空掉。 */
    function shotField(source, names){
        for(const name of names){
            const value = source[name];
            if(value !== undefined && value !== null && value !== '') return value;
        }
        const bare = key => String(key).replace(/[\u0000-\u001f\s]/g, '');
        for(const key of Object.keys(source)){
            if(!names.includes(bare(key))) continue;
            const value = source[key];
            if(value !== undefined && value !== null && value !== '') return value;
        }
        return '';
    }

    function parseSegmentShots(text){
        /* 段数多时模型常把同一个 shots 拆成几块返回：把每一块的 shots 都收进来，
           只认第一块会让后面几段全部落到兜底文案（分镜表看起来像只读了第一段）。 */
        const rawList = [];
        extractJsonValues(text).forEach(value => {
            if(Array.isArray(value)) rawList.push(...value);
            else if(value && typeof value === 'object' && Array.isArray(value.shots)) rawList.push(...value.shots);
        });
        if(!rawList.length){
            const parsed = extractJsonObject(text);
            const list = (parsed && typeof parsed === 'object' && Array.isArray(parsed.shots))
                ? parsed.shots
                : extractJsonArray(text);
            if(!Array.isArray(list)) return [];
            rawList.push(...list);
        }
        const byIndex = new Map();
        rawList.forEach((item, index) => {
            const source = item && typeof item === 'object' ? item : {};
            const raw = Number(source.index);
            const shot = {
                index: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : index + 1,
                '画面描述': cellText(shotField(source, ['画面描述', 'description', 'shot'])),
                '运镜': cellText(shotField(source, ['运镜', 'camera'])),
                '景别': cellText(shotField(source, ['景别', 'shotSize'])),
            };
            /* 多块合并：同一 index 重复出现时保留先出现的那条（补齐请求不会把已拿到的段改写）。 */
            if(!byIndex.has(shot.index)) byIndex.set(shot.index, shot);
        });
        return Array.from(byIndex.values()).sort((a, b) => a.index - b.index);
    }

    /* 「参考用法」文案：@序号是**全局序号**，由调用方按通道 ordinalBase 算好传进来
       （与 computeTableRowInputs / rewriteMentions 同一套口径）。 */
    function segmentReferenceLine(options={}){
        const video = mentionTokenAt('video', Math.max(1, Number(options.videoOrdinal) || 1));
        const products = (Array.isArray(options.productOrdinals) ? options.productOrdinals : []).map(Number).filter(n => n >= 1);
        const outfits = (Array.isArray(options.modelOutfitOrdinals) ? options.modelOutfitOrdinals : []).map(Number).filter(n => n >= 1);
        const range = formatSeconds(options.start) + '–' + formatSeconds(options.end) + 's';
        const head = video + ' 是本行的参考分镜片段（原片 ' + range + '）：严格照搬它的画面内容、景别、机位、运镜与节奏';
        if(!products.length) return head + '，其余保持不变。';
        const lines = [head + '；把画面中的原产品替换为 ' + products.map(n => mentionTokenAt('image', n)).join('、')
            + ' 的产品，其余保持不变，画面干净、无文字。'];
        if(outfits.length){
            lines.push('人物与穿搭参考 ' + outfits.map(n => mentionTokenAt('image', n)).join('、')
                + '（模特/穿搭），保持原片的人物动作与环境不变。');
        }
        return lines.join('\n');
    }

    /* 指令文本里 @ 到的媒体（mention chip）。
       用户经常只在指令里 @ 素材、并不连线，这些素材同样要能当产品 / 模特参考图，
       所以从 llmInstructionHtml 里把 chip 的 data-* 抠出来。
       plain = chip 还原成名字后的纯文本（分类要看名字前面的语义词，位置不能丢）。 */
    function unescapeMentionAttr(value){
        return String(value || '')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
    }

    function stripHtmlTags(html){
        return unescapeMentionAttr(String(html || '').replace(/<[^>]*>/g, '')).replace(/\u00a0/g, ' ');
    }

    /* 从 chip 的 <span ...> 起点往后数 <span>/</span> 配平，拿到整个 chip 的结束位置
       （plain 要把整块替换成名字，只跳到开标签会把 chip 里的名字再算一遍）。 */
    function mentionSpanEnd(source, tagStart){
        const tagRe = /<(\/?)span\b[^>]*>/gi;
        tagRe.lastIndex = tagStart;
        let depth = 0;
        let hit;
        while((hit = tagRe.exec(source))){
            if(hit[1] === '/'){
                depth -= 1;
                if(depth <= 0) return tagRe.lastIndex;
            } else {
                depth += 1;
            }
        }
        return -1;
    }

    function parseInstructionMentions(html){
        const source = String(html || '');
        const mentions = [];
        const spans = [];
        const classRe = /class="[^"]*mention-image-token[^"]*"/g;
        let hit;
        while((hit = classRe.exec(source))){
            const tagStart = source.lastIndexOf('<', hit.index);
            const tagEnd = source.indexOf('>', hit.index);
            if(tagStart < 0 || tagEnd < 0) continue;
            const tag = source.slice(tagStart, tagEnd + 1);
            const attr = name => {
                const matched = new RegExp('\\s' + name + '="([^"]*)"').exec(tag);
                return matched ? unescapeMentionAttr(matched[1]) : '';
            };
            const url = attr('data-url');
            if(!url) continue;
            const name = attr('data-name');
            const spanEnd = mentionSpanEnd(source, tagStart);
            spans.push({start:tagStart, end:spanEnd > tagEnd ? spanEnd : tagEnd + 1, name});
            const item = {
                kind: attr('data-kind') || 'image',
                url,
                name,
                nodeId: attr('data-node-id'),
                imageIndex: Number(attr('data-image-index') || 0),
            };
            // 同一张素材被 @ 多次只算一次（否则会重复占一个通道序号）
            if(!mentions.some(exist => exist.url === item.url)) mentions.push(item);
        }
        let plain = '';
        let cursor = 0;
        spans.forEach(span => {
            plain += stripHtmlTags(source.slice(cursor, span.start)) + span.name;
            cursor = span.end;
        });
        plain += stripHtmlTags(source.slice(cursor));
        return {mentions, plain};
    }

    /* 输出模式与按钮文案（DX OS: _u / US）。
       'list'       = 多维表格（下游是图像节点，或者链路还没接好）
       'list-video' = 视频分镜表（下游是视频节点）—— 显式选，链路没接好时也能出分镜
       llmOutputMode 只回答「是不是出表」；llmOutputModeChoice 回答「具体存哪一种」。 */
    const LLM_OUTPUT_MODES = ['text', 'list', 'list-video'];
    function llmOutputMode(raw){ return raw === 'list' || raw === 'list-video' ? 'list' : 'text'; }
    function llmOutputModeChoice(raw){ return LLM_OUTPUT_MODES.includes(raw) ? raw : 'text'; }
    function llmModeTargetKind(raw){ return raw === 'list-video' ? 'video' : ''; }

    function llmRunStageLabel(running, stage){
        if(!running) return '生成';
        if(stage === 'planning') return '规划中';
        if(stage === 'repairing') return '校验中';
        return '生成中';
    }

    function describeOperation(operationId){
        const op = TABLE_OPERATIONS[String(operationId || '')];
        return op ? JSON.parse(JSON.stringify(op)) : null;
    }

    function requiresConfirmation(operationId, options={}){
        const op = TABLE_OPERATIONS[String(operationId || '')];
        if(!op) return false;
        if(op.confirmation === 'always') return true;
        if(op.confirmation === 'on-risk') return Boolean(options.risky);
        if(op.confirmation === 'on-ambiguity') return Boolean(options.ambiguous);
        return false;
    }

    /* 批量结果节点的占位格切分：只有正在跑的几格显示 loading，其余是「排队中」。
       生效并发决定同时最多几格在转（串行 = 1）。纯函数，方便直接测。 */
    function batchSlotKinds(pendingSlots, concurrency){
        const slots = Math.max(0, Math.floor(Number(pendingSlots) || 0));
        const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
        const running = Math.min(slots, limit);
        return {running, queued: slots - running};
    }

    /* ── 批量逐行真实状态（结果节点进度框的真值）──
       行序来自 runTableBatch 本轮真正派发的行号（runContext.batchRowNumbers），
       每一行的状态只由它自己真正的开跑 / 完成 / 失败来改，不再按并发数猜。
       纯函数，方便直接测。 */
    const BATCH_ROW_STATES = ['queued', 'running', 'completed', 'failed', 'cancelled'];

    function batchRowPlan(rowNumbers){
        const order = (Array.isArray(rowNumbers) ? rowNumbers : [])
            .map(value => Number(value) || 0)
            .filter(value => value > 0);
        const states = {};
        order.forEach(rowNumber => { states[rowNumber] = 'queued'; });
        return {order, states};
    }

    function batchRowStateSet(states, rowNumber, state){
        const target = Number(rowNumber) || 0;
        const next = BATCH_ROW_STATES.includes(state) ? state : 'queued';
        if(!states || typeof states !== 'object' || !target) return states;
        if(!Object.prototype.hasOwnProperty.call(states, target)) return states;
        states[target] = next;
        return states;
    }

    function batchRowStateSummary(order, states){
        const list = Array.isArray(order) ? order : [];
        const map = states && typeof states === 'object' ? states : {};
        const summary = {total:list.length, queued:0, running:0, completed:0, failed:0, cancelled:0};
        list.forEach(rowNumber => {
            const state = BATCH_ROW_STATES.includes(map[rowNumber]) ? map[rowNumber] : 'queued';
            summary[state] += 1;
        });
        return summary;
    }

    function batchRowStatusText(summary){
        if(!summary || !summary.total) return '';
        /* 停止过：报「完成 / 已取消」，取消不算失败。 */
        if(summary.cancelled) return '已停止：完成 ' + summary.completed + ' · 已取消 ' + summary.cancelled
            + (summary.running ? '（在跑 ' + summary.running + '）' : '');
        return '已完成 ' + summary.completed + ' · 失败 ' + summary.failed
            + ' · 共 ' + summary.total
            + (summary.running ? '（在跑 ' + summary.running + '）' : '');
    }


    /* ── 智能列（AI 列）/ 选区批量改写 / 对比回滚 ────────────────────
       这一批只做数据层：算出要跑哪些行、怎么把模型输出按行回填、怎么比对与回滚。
       真正的请求/写格由调用方（画布）用 set_cells 落地。 */

    function aiColumnBatchSize(raw){
        const value = Math.floor(Number(raw));
        if(!Number.isFinite(value) || value < 1) return AI_COLUMN_BATCH_ROWS;
        return Math.min(AI_COLUMN_BATCH_ROWS_MAX, value);
    }

    // 整行一个字都没有（也没有媒体）＝没东西可改写，规划时跳过
    function rowHasContent(row){
        return (Array.isArray(row) ? row : []).some(cell => isMediaCell(cell) || Boolean(rawCellText(cell).trim()));
    }

    /* 智能列执行计划：[{columnIndex, rows:[1-based 行号…]}]。
       rows 用 1-based（与 set_cells 的 row 同一口径），columnIndex 与 columns 同下标（0-based）。 */
    function planAiColumn(table, columnIndex, options={}){
        const t = normalizeTable(table).table;
        const index = Math.floor(Number(columnIndex));
        if(!Number.isInteger(index) || index < 0 || index >= t.columns.length) return [];
        const batchSize = aiColumnBatchSize(options.batchSize);
        const wanted = Array.isArray(options.rows)
            ? new Set(options.rows.map(Number).filter(value => Number.isInteger(value) && value > 0))
            : null;
        const rows = [];
        t.rows.forEach((row, at) => {
            const rowNumber = at + 1;
            if(wanted && !wanted.has(rowNumber)) return;
            if(!rowHasContent(row)) return;
            rows.push(rowNumber);
        });
        const batches = [];
        for(let at = 0; at < rows.length; at += batchSize){
            batches.push({columnIndex: index, rows: rows.slice(at, at + batchSize)});
        }
        return batches;
    }

    /* cells 每项 {row, values:[各列原文]}；给字符串/数组时当作「只有目标列原文」。
       options.columnName 优先，其次 options.columnIndex 从 columns 里取目标列名。 */
    function aiColumnPrompt(instruction, cells, columns, options={}){
        const names = (Array.isArray(columns) ? columns : []).map((name, index) => {
            const text = String(name === null || name === undefined ? '' : name).trim();
            return text || ('第 ' + (index + 1) + ' 列');
        });
        const targetIndex = Number.isInteger(Number(options.columnIndex)) ? Math.floor(Number(options.columnIndex)) : -1;
        const targetName = String(options.columnName || (targetIndex >= 0 && names[targetIndex] ? names[targetIndex] : '')).trim()
            || '未指定列';
        const rows = (Array.isArray(cells) ? cells : []).map((entry, index) => {
            const item = entry && typeof entry === 'object' && !Array.isArray(entry)
                ? entry
                : {values: Array.isArray(entry) ? entry : [entry]};
            const rawRow = Number(item.row);
            const row = Number.isInteger(rawRow) && rawRow > 0 ? rawRow : index + 1;
            return {row, values: Array.isArray(item.values) ? item.values : [item.value]};
        });
        const rowLines = rows.map(item => {
            const lines = names.length
                ? names.map((name, col) => name + '：' + (rawCellText(item.values[col]).trim() || '（空）'))
                : ['原文：' + (rawCellText(item.values[0]).trim() || '（空）')];
            return '第 ' + item.row + ' 行\n' + lines.map(line => '  ' + line).join('\n');
        });
        return [
            '你在为一个「多维表格」的智能列批量生成单元格内容。',
            '目标列：「' + targetName + '」',
            '本列指令（每一行都按它产出）：',
            String(instruction || '').trim() || '（未填写指令：按目标列的列名理解，生成适合这一列的内容）',
            '',
            '表格列（按顺序）：' + (names.join('、') || '（无列名）'),
            '逐行原文（行号就是表格里的行号）：',
            rowLines.join('\n') || '（没有可处理的行）',
            '',
            '要求：',
            '- 只为上面列出的每一行各产出一条结果，不要新增、删除或合并行。',
            '- 行号必须与原文行号完全一致，不得改写。',
            '- 只依据该行原文和指令改写，不要编造原文里没有的信息。',
            '- 每条结果只写目标列该有的内容，不要带列名、行号、引号或 Markdown。',
            '- 只返回一个 JSON 对象，不要 Markdown 代码块，不要解释：',
            '{"values":[{"row":' + (rows[0] ? rows[0].row : 1) + ',"value":"改写后的单元格文本"}]}'
        ].join('\n');
    }

    /* patch 是选中区域原文：二维数组，或 {values, rowOffset, colOffset, columnNames}。
       带偏移时提示词里写整张表的真实行列号，调用方才能原样回填。 */
    function rewritePatchOf(patch){
        if(Array.isArray(patch)) return {values: patch, rowOffset: 0, colOffset: 0, columnNames: []};
        const source = patch && typeof patch === 'object' ? patch : {};
        const values = Array.isArray(source.values) ? source.values : (Array.isArray(source.rows) ? source.rows : []);
        const offset = raw => {
            const value = Math.floor(Number(raw));
            return Number.isFinite(value) && value > 0 ? value : 0;
        };
        return {
            values,
            rowOffset: offset(source.rowOffset),
            colOffset: offset(source.colOffset),
            columnNames: (Array.isArray(source.columnNames) ? source.columnNames : []).map(name => String(name || '')),
        };
    }

    function batchRewritePrompt(instruction, patch){
        const region = rewritePatchOf(patch);
        const rows = region.values.filter(Array.isArray);
        const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
        const regionLine = rows.length
            ? '选中区域：第 ' + (region.rowOffset + 1) + '–' + (region.rowOffset + rows.length)
                + ' 行，第 ' + (region.colOffset + 1) + '–' + (region.colOffset + Math.max(1, width))
                + ' 列（行列号都是整张表里的真实序号）'
            : '选中区域：（空）';
        const rowLines = rows.map((row, index) => {
            const rowNumber = region.rowOffset + index + 1;
            const cells = [];
            for(let col = 0; col < Math.max(1, width); col += 1){
                const colNumber = region.colOffset + col + 1;
                const name = region.columnNames[col]
                    ? region.columnNames[col] + '（第 ' + colNumber + ' 列）'
                    : '第 ' + colNumber + ' 列';
                cells.push('  ' + name + '：' + (rawCellText(row[col]).trim() || '（空）'));
            }
            return '第 ' + rowNumber + ' 行\n' + cells.join('\n');
        });
        return [
            '你在批量改写一张「多维表格」中选中区域的单元格。',
            '改写要求：',
            String(instruction || '').trim() || '（未填写要求：保持原意，只做通顺化与去噪）',
            '',
            regionLine,
            '区域原文：',
            rowLines.join('\n') || '（没有可改写的单元格）',
            '',
            '要求：',
            '- 只改写给出的格子：行号、列号必须原样照抄，不得新增、删除或合并行列。',
            '- 每一格只输出改写后的单元格文本，不要带行列号、列名、引号或 Markdown。',
            '- 不需要改写的格子可以不返回；返回的每一格都必须落在上面的行号、列号范围内。',
            '- 只依据原文与要求改写，不要编造原文里没有的信息。',
            '- 只返回一个 JSON 对象，不要 Markdown 代码块，不要解释：',
            '{"values":[{"row":1,"col":1,"value":"改写后的单元格文本"}]}'
        ].join('\n');
    }

    // 收 {row,value} 项：{"values":[…]}、顶层数组、多块 JSON、代码块都认
    function aiValueItems(text){
        const items = [];
        const push = value => {
            if(Array.isArray(value)) items.push(...value);
            else if(value && typeof value === 'object'){
                if(Array.isArray(value.values)) items.push(...value.values);
                else if(value.row !== undefined) items.push(value);
            }
        };
        const values = extractJsonValues(text);
        if(values.length){ values.forEach(push); return {items, parsed:true}; }
        const object = extractJsonObject(text);
        if(object){ push(object); return {items, parsed:true}; }
        const array = extractJsonArray(text);
        if(array){ push(array); return {items, parsed:true}; }
        return {items, parsed:false};
    }

    /* 解析智能列 / 批量改写的返回。成功哪些行（applied / values）、缺哪些行（missing）、
       非法行号/重复行/缺失值（invalid）、超出预期的行（extra）全部报出来，不静默吞。
       expectedRows 传行号数组（1-based）；传数字时按「前 N 行」理解。
       带 col 的结果（选区批量改写）按「行:列」收进 cells，行列号都是 1-based。 */
    function parseAiValues(text, expectedRows){
        const expectedSource = Array.isArray(expectedRows)
            ? expectedRows
            : (Number.isInteger(Number(expectedRows)) && Number(expectedRows) > 0
                ? Array.from({length:Number(expectedRows)}, (_, index) => index + 1)
                : []);
        const expected = Array.from(new Set(expectedSource
            .map(Number).filter(value => Number.isInteger(value) && value > 0))).sort((a, b) => a - b);
        const expectedSet = new Set(expected);
        const {items, parsed} = aiValueItems(text);
        /* 行级结果（智能列）按行号收；带 col 的单元格结果（选区批量改写）按「行:列」收。
           两种输入共用这一套容错，调用方不用各写一份。 */
        const values = {};
        const cells = {};
        const seen = new Set();
        const seenRows = new Set();
        const applied = [];
        const invalid = [];
        const extra = [];
        items.forEach(item => {
            if(!item || typeof item !== 'object' || Array.isArray(item)){
                invalid.push({row:null, reason:'shape'});
                return;
            }
            const rawRow = Number(item.row);
            if(!Number.isInteger(rawRow) || rawRow < 1){
                invalid.push({row:null, reason:'row'});
                return;
            }
            const hasCol = item.col !== undefined && item.col !== null;
            const rawCol = Number(item.col);
            if(hasCol && (!Number.isInteger(rawCol) || rawCol < 1)){
                invalid.push({row:rawRow, reason:'col'});
                return;
            }
            if(item.value === undefined || item.value === null){
                invalid.push({row:rawRow, reason:'value'});
                return;
            }
            const value = cellText(item.value);
            const address = hasCol ? rawRow + ':' + rawCol : String(rawRow);
            if(!expectedSet.has(rawRow)){
                extra.push(hasCol ? {row:rawRow, col:rawCol, value} : {row:rawRow, value});
                return;
            }
            if(seen.has(address)){
                invalid.push(hasCol ? {row:rawRow, col:rawCol, reason:'duplicate'} : {row:rawRow, reason:'duplicate'});
                return;
            }
            seen.add(address);
            seenRows.add(rawRow);
            if(hasCol){ cells[address] = value; applied.push({row:rawRow, col:rawCol, value}); }
            else { values[rawRow] = value; applied.push({row:rawRow, value}); }
        });
        const byAddress = (a, b) => a.row - b.row || (a.col || 0) - (b.col || 0);
        applied.sort(byAddress);
        extra.sort(byAddress);
        const missing = expected.filter(row => !seenRows.has(row));
        return {
            ok: parsed && !invalid.length && !extra.length && !missing.length,
            parsed,
            applied,
            values,
            cells,
            missing,
            invalid,
            extra,
        };
    }

    // 逐格比对用的文本：媒体格比 URL，否则比 cellText（截断后的落盘值）
    function diffCellText(value){
        return isMediaCell(value) ? String(value.url || '') : cellText(value);
    }

    /* 逐格差异（先行后列），行/列都是 1-based：只列真正变化的格子。 */
    function diffTables(before, after){
        const a = normalizeTable(before).table;
        const b = normalizeTable(after).table;
        const rowCount = Math.max(a.rows.length, b.rows.length);
        const colCount = Math.max(a.columns.length, b.columns.length);
        const changes = [];
        for(let row = 0; row < rowCount; row += 1){
            for(let col = 0; col < colCount; col += 1){
                const beforeValue = diffCellText(a.rows[row] ? a.rows[row][col] : '');
                const afterValue = diffCellText(b.rows[row] ? b.rows[row][col] : '');
                if(beforeValue === afterValue) continue;
                changes.push({
                    row: row + 1,
                    col: col + 1,
                    columnName: b.columns[col] !== undefined ? b.columns[col] : (a.columns[col] || ''),
                    before: beforeValue,
                    after: afterValue,
                });
            }
        }
        return changes;
    }

    /* 快照与 cloneTable 的区别：cloneTable 返回的就是一张可直接使用的表格；
       快照外面套一层 kind='table-snapshot'，只能整体还原（cloneTable(snapshot.table)），
       防止调用方把快照当表格局部改，改出与列数对不上的 aiColumns。 */
    function tableSnapshot(table){
        return {kind:TABLE_SNAPSHOT_KIND, version:TABLE_VERSION, table:cloneTable(table)};
    }

    return {
        TABLE_KIND, TABLE_VERSION,
        MAX_COLUMNS, MAX_ROWS, MAX_CELL_CHARS, LLM_MAX_COLUMNS, LLM_MAX_ROWS,
        COLUMN_WIDTH, RESERVED_WIDTH, HEADER_HEIGHT, MAX_NODE_HEIGHT, EMPTY_MIN_HEIGHT, INPUT_COLUMN_WIDTH,
        INPUT_CHANNEL_PREFIX, MENTION_LABELS, MENTION_RE,
        UNNAMED_COLUMN, TABLE_OPERATIONS, OPERATION_IDS,
        CHANNEL_MODES, CHANNEL_MODE_LABELS,
        channelIdAt, channelIndexFromId, channelModeFor, channelLabel, channelModeLabel,
        normalizeChannels, inputItemAt, inputItemsForRow, rewriteMentions,
        rowHeightForRow, mentionLabel, mentionTokenAt, mentionsIn, danglingMentions, buildRowPrompt,
        BATCH_ROW_STATUS, DEFAULT_BATCH_CONCURRENCY, MAX_BATCH_CONCURRENCY,
        batchFailurePolicy, batchStartRow, batchConcurrency, batchRowsToRun, batchSlotKinds,
        BATCH_ROW_STATES, batchRowPlan, batchRowStateSet, batchRowStateSummary, batchRowStatusText,
        emptyJournal, normalizeJournal, matchBatchJournal, journalMarkRow,
        journalPendingRows, journalInflightRows, journalCompletedRows, journalFailedRows, journalCancelledRows,
        batchMissingMaterials, runWithSharedCursor,
        TABLE_PARSE_ERRORS, TABLE_REPAIR_INSTRUCTION, LLM_REPAIR_MAX_TOKENS,
        extractJsonObject, extractJsonArray, escapeJsonControlChars, parseJsonLenient,
        parseTableOutput, buildRepairPrompt, inputListText,
        buildListPlanPrompt, buildListGeneratePrompt, planGroupModes, llmOutputMode, llmRunStageLabel,
        LLM_OUTPUT_MODES, llmOutputModeChoice, llmModeTargetKind,
        llmTargetKind, VIDEO_PLAN_BLOCK, VIDEO_GENERATE_BLOCK,
        VIDEO_SEGMENT_SECONDS_DEFAULT, VIDEO_SEGMENT_SECONDS_MIN, VIDEO_SEGMENT_SECONDS_MAX,
        VIDEO_SEGMENT_MAX_SEGMENTS, VIDEO_SEGMENT_MIN_TAIL_SECONDS,
        segmentSeconds, segmentMaxSegments, formatSeconds, planVideoSegments, segmentCountOf,
        SEGMENT_PRODUCT_RE, SEGMENT_MODEL_RE, segmentEntryRole, classifySegmentInputs,
        buildSegmentShotPrompt, parseSegmentShots, segmentReferenceLine, parseInstructionMentions,
        emptyTable, cellText, normalizeColumns, normalizeTable, cloneTable,
        MEDIA_CELL_KIND, mediaCell, isMediaCell,
        toIndex, columnIndex, rowIndex, applyOperation,
        DURATION_COLUMN_KEYS, durationColumnIndex, cellDuration,
        rowHeight, nodeSize, describeOperation, requiresConfirmation,
        AI_INSTRUCTION_MAX_CHARS, AI_COLUMN_BATCH_ROWS, AI_COLUMN_BATCH_ROWS_MAX, AI_COLUMN_MAX_TOKENS,
        TABLE_SNAPSHOT_KIND, normalizeAiColumns, normalizeSelection,
        aiColumnBatchSize, planAiColumn, aiColumnPrompt, batchRewritePrompt,
        parseAiValues, diffTables, tableSnapshot,
    };
});
