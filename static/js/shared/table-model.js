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
        append_row: {kind:'mutation', risk:'low', sideEffect:'local', idempotency:'keyed',
            confirmation:'on-ambiguity', reads:['table'], writes:['table'], title:'追加表格行'},
        delete_row: {kind:'mutation', risk:'medium', sideEffect:'local', idempotency:'keyed',
            confirmation:'on-risk', reads:['table'], writes:['table'], title:'删除表格行'},
        add_column: {kind:'mutation', risk:'low', sideEffect:'local', idempotency:'keyed',
            confirmation:'on-ambiguity', reads:['table'], writes:['table'], title:'添加表格列'},
        delete_column: {kind:'mutation', risk:'medium', sideEffect:'local', idempotency:'keyed',
            confirmation:'on-risk', reads:['table'], writes:['table'], title:'删除表格列'},
    };

    function emptyTable(){
        return {kind:TABLE_KIND, version:TABLE_VERSION, columns:[], rows:[], selectedRows:[], mergedGroups:[]};
    }

    // 单元格一律字符串化并截断（DX OS: 非字符串走 JSON.stringify）
    function cellText(value){
        if(value === null || value === undefined) return '';
        let text;
        if(typeof value === 'string') text = value;
        else if(typeof value === 'object'){ try { text = JSON.stringify(value); } catch(e){ text = String(value); } }
        else text = String(value);
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

    function isStrict(raw){
        if(!raw || typeof raw !== 'object') return false;
        if(!Array.isArray(raw.columns) || !Array.isArray(raw.rows)) return false;
        if(raw.columns.length > MAX_COLUMNS || raw.rows.length > MAX_ROWS) return false;
        if(raw.columns.some(c => typeof c !== 'string' || !c.trim())) return false;
        return raw.rows.every(row => Array.isArray(row) && row.length === raw.columns.length
            && row.every(cell => typeof cell === 'string'));
    }

    /** 归一化任意输入为合法表格；永不抛错，越界静默修复。 */
    function normalizeTable(raw){
        const source = raw && typeof raw === 'object' ? raw : {};
        const repaired = !isStrict(source);
        const columns = normalizeColumns(source.columns);
        const rawRows = Array.isArray(source.rows) ? source.rows : [];
        const rows = rawRows.filter(Array.isArray).slice(0, MAX_ROWS)
            .map(row => columns.map((_, i) => cellText(row[i])));
        const selectedRows = (Array.isArray(source.selectedRows) ? source.selectedRows : [])
            .map(Number).filter(v => Number.isInteger(v) && v >= 0 && v < rows.length);
        const mergedGroups = (Array.isArray(source.mergedGroups) ? source.mergedGroups : [])
            .filter(Array.isArray).map(g => g.map(Number).filter(Number.isInteger));
        return {
            table:{kind:TABLE_KIND, version:TABLE_VERSION, columns, rows, selectedRows, mergedGroups},
            repaired,
        };
    }

    /** 深拷贝（DX OS: n6） */
    function cloneTable(table){
        const t = normalizeTable(table).table;
        return {kind:t.kind, version:t.version, columns:t.columns.slice(),
            rows:t.rows.map(r => r.slice()), selectedRows:t.selectedRows.slice(),
            mergedGroups:t.mergedGroups.map(g => g.slice())};
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
            next.rows[r][c] = cellText(args.value);
            return next;
        }
        if(opId === 'append_row'){
            if(next.rows.length >= MAX_ROWS) throw new Error('表格最多允许 ' + MAX_ROWS + ' 行。');
            const values = args.values;
            const named = Boolean(values) && !Array.isArray(values) && typeof values === 'object';
            const list = Array.isArray(values) ? values : [];
            next.rows.push(next.columns.map((title, i) => cellText(named ? values[title] : list[i])));
            return next;
        }
        if(opId === 'delete_row'){
            const r = rowIndex(next, args.row);
            next.rows.splice(r, 1);
            next.selectedRows = next.selectedRows.filter(i => i !== r)
                .map(i => (i > r ? i - 1 : i));
            return next;
        }
        if(opId === 'add_column'){
            if(next.columns.length >= MAX_COLUMNS) throw new Error('表格最多允许 ' + MAX_COLUMNS + ' 列。');
            next.columns = normalizeColumns(next.columns.concat([args.title]));
            next.rows = next.rows.map(row => row.concat(['']));
            return next;
        }
        if(opId === 'delete_column'){
            const c = columnIndex(next, args);
            next.columns.splice(c, 1);
            next.rows.forEach(row => row.splice(c, 1));
            next.selectedRows = next.selectedRows.filter(i => i < next.columns.length);
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
            String(text ?? '').split('\n').reduce((sum, line) =>
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

    return {
        TABLE_KIND, TABLE_VERSION,
        MAX_COLUMNS, MAX_ROWS, MAX_CELL_CHARS, LLM_MAX_COLUMNS, LLM_MAX_ROWS,
        COLUMN_WIDTH, RESERVED_WIDTH, HEADER_HEIGHT, MAX_NODE_HEIGHT, EMPTY_MIN_HEIGHT, INPUT_COLUMN_WIDTH,
        UNNAMED_COLUMN, TABLE_OPERATIONS, OPERATION_IDS,
        emptyTable, cellText, normalizeColumns, normalizeTable, cloneTable,
        toIndex, columnIndex, rowIndex, applyOperation,
        rowHeight, nodeSize, describeOperation, requiresConfirmation,
    };
});
