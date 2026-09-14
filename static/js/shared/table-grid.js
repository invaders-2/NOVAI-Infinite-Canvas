(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.NovaTableGrid = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict';

    // DXOS 风格的多维表格数据模型（纯数据网格 + 单元格操作契约）。
    // 参考实现：DX OS 0.3.7 的 builtin.table / dx-canvas-nodes/v2。
    // 本模块只做「数据 + 校验 + 操作规划」，不碰 DOM、不碰网络、不碰画布节点状态。

    const TABLE_KIND = 'table';
    const TABLE_VERSION = 1;
    const MAX_COLUMNS = 200;           // 列数上限（越界静默截断）
    const MAX_ROWS = 5000;             // 行数上限
    const MAX_CELL_CHARS = 20000;      // 单元格字符上限
    const MAX_COLUMN_TITLE = 120;      // 列名长度上限
    const MAX_REQUEST_IDS = 64;        // requestId 环形缓冲长度（幂等回放）
    const UNNAMED_COLUMN = '未命名列';
    const INPUT_COLUMN_PATTERN = /^(?:生成输入|输入\s*\d+)$/;

    // ---- 操作契约 ----------------------------------------------------------
    // 与 DXOS 分级一致：读最低 → 增改次之 → 删最高（删用 on-risk 触发确认）。
    const TABLE_OPERATIONS = {
        read_table: {
            kind:'query', risk:'low', sideEffect:'none', idempotency:'idempotent',
            confirmation:'on-ambiguity', reads:['table'], writes:[], title:'读取表格数据',
            inputSchema:{ type:'object', properties:{} }
        },
        set_cell: {
            kind:'mutation', risk:'low', sideEffect:'local', idempotency:'keyed',
            confirmation:'on-ambiguity', reads:['table'], writes:['table'], title:'修改单元格',
            inputSchema:{ type:'object', properties:{
                row:{type:'integer', minimum:1}, column:{type:'integer', minimum:1},
                columnName:{type:'string'}, value:{type:'string', maxLength:20000}
            }, required:['row','value'] }
        },
        append_row: {
            kind:'mutation', risk:'low', sideEffect:'local', idempotency:'keyed',
            confirmation:'on-ambiguity', reads:['table'], writes:['table'], title:'追加表格行',
            inputSchema:{ type:'object', properties:{ values:{type:'array'} }, required:['values'] }
        },
        delete_row: {
            kind:'mutation', risk:'medium', sideEffect:'local', idempotency:'keyed',
            confirmation:'on-risk', reads:['table'], writes:['table'], title:'删除表格行',
            inputSchema:{ type:'object', properties:{ row:{type:'integer', minimum:1} }, required:['row'] }
        },
        add_column: {
            kind:'mutation', risk:'low', sideEffect:'local', idempotency:'keyed',
            confirmation:'on-ambiguity', reads:['table'], writes:['table'], title:'添加表格列',
            inputSchema:{ type:'object', properties:{ title:{type:'string', maxLength:120} }, required:['title'] }
        },
        delete_column: {
            kind:'mutation', risk:'medium', sideEffect:'local', idempotency:'keyed',
            confirmation:'on-risk', reads:['table'], writes:['table'], title:'删除表格列',
            inputSchema:{ type:'object', properties:{
                column:{type:'integer', minimum:1}, columnName:{type:'string'}} }
        }
    };

    function describeOperation(operationId){
        const op = TABLE_OPERATIONS[String(operationId || '')];
        return op ? JSON.parse(JSON.stringify(op)) : null;
    }

    function operationIds(){ return Object.keys(TABLE_OPERATIONS); }

    // 按 confirmation 语义判断是否需要向用户确认（Agent / 批量执行前调用）。
    function requiresConfirmation(operationId, options){
        const op = TABLE_OPERATIONS[String(operationId || '')];
        if(!op) return false;
        const opts = options || {};
        if(op.confirmation === 'always') return true;
        if(op.confirmation === 'on-risk') return Boolean(opts.risky);
        if(op.confirmation === 'on-ambiguity') return Boolean(opts.ambiguous);
        return false;
    }

    // ---- 归一化 ------------------------------------------------------------

    function emptyTable(){
        return { kind:TABLE_KIND, version:TABLE_VERSION, columns:[], rows:[], selectedRows:[], mergedGroups:[] };
    }

    function cellToString(value){
        if(value === null || value === undefined) return '';
        if(typeof value === 'string') return value.length > MAX_CELL_CHARS ? value.slice(0, MAX_CELL_CHARS) : value;
        if(typeof value === 'object'){
            let text;
            try { text = JSON.stringify(value); } catch(error){ text = String(value); }
            return text.length > MAX_CELL_CHARS ? text.slice(0, MAX_CELL_CHARS) : text;
        }
        return String(value);
    }

    // 列名归一：trim → 空则「未命名列」→ 截断 → 去重（追加 (2)/(3)…）。
    function normalizeColumnTitles(rawColumns){
        const seen = Object.create(null);
        const out = [];
        const list = Array.isArray(rawColumns) ? rawColumns.slice(0, MAX_COLUMNS) : [];
        for(let i = 0; i < list.length; i += 1){
            const value = list[i];
            let title = String(value === null || value === undefined ? '' : value).trim();
            if(!title) title = UNNAMED_COLUMN;
            if(title.length > MAX_COLUMN_TITLE) title = title.slice(0, MAX_COLUMN_TITLE);
            if(seen[title]){
                seen[title] += 1;
                title = title + '(' + seen[title] + ')';
            } else {
                seen[title] = 1;
            }
            out.push(title);
        }
        return out;
    }

    // 是否满足严格形态（列名全为非空字符串；行长度等于列数且元素全为字符串）。
    function isStrictTable(raw){
        if(!raw || typeof raw !== 'object') return false;
        if(!Array.isArray(raw.columns) || !Array.isArray(raw.rows)) return false;
        if(raw.columns.some(function(item){ return typeof item !== 'string' || !item.trim(); })) return false;
        if(raw.columns.length > MAX_COLUMNS || raw.rows.length > MAX_ROWS) return false;
        return raw.rows.every(function(row){
            return Array.isArray(row)
                && row.length === raw.columns.length
                && row.every(function(cell){ return typeof cell === 'string'; });
        });
    }

    /**
     * 归一化任意输入为合法表格。永不抛错：越界一律静默修复并记入 issues。
     * @returns {{table: object, repaired: boolean, issues: string[]}}
     */
    function normalizeTable(raw){
        const source = raw && typeof raw === 'object' ? raw : {};
        const issues = [];
        const repaired = !isStrictTable(source);

        const columns = normalizeColumnTitles(source.columns);
        if(Array.isArray(source.columns) && source.columns.length > MAX_COLUMNS){
            issues.push('列数超过 ' + MAX_COLUMNS + '，已截断');
        }

        const rawRows = Array.isArray(source.rows) ? source.rows : [];
        if(rawRows.length > MAX_ROWS) issues.push('行数超过 ' + MAX_ROWS + '，已截断');
        const rows = rawRows
            .filter(function(row){ return Array.isArray(row); })
            .slice(0, MAX_ROWS)
            .map(function(row){
                return columns.map(function(_, index){ return cellToString(row[index]); });
            });

        const selectedRows = (Array.isArray(source.selectedRows) ? source.selectedRows : [])
            .map(Number)
            .filter(function(value){ return Number.isInteger(value) && value >= 0 && value < rows.length; });

        const mergedGroups = (Array.isArray(source.mergedGroups) ? source.mergedGroups : [])
            .filter(function(group){ return Array.isArray(group); })
            .map(function(group){
                return group.map(Number).filter(function(value){ return Number.isInteger(value); });
            });

        return {
            table: {
                kind: TABLE_KIND,
                version: TABLE_VERSION,
                columns: columns,
                rows: rows,
                selectedRows: selectedRows,
                mergedGroups: mergedGroups
            },
            repaired: repaired,
            issues: issues
        };
    }

    function cloneTable(table){
        const normalized = normalizeTable(table).table;
        return {
            kind: normalized.kind,
            version: normalized.version,
            columns: normalized.columns.slice(),
            rows: normalized.rows.map(function(row){ return row.slice(); }),
            selectedRows: normalized.selectedRows.slice(),
            mergedGroups: normalized.mergedGroups.map(function(group){ return group.slice(); })
        };
    }

    function tablesEqual(left, right){ return JSON.stringify(left) === JSON.stringify(right); }

    // ---- 定位 --------------------------------------------------------------

    // 1-based 序号 → 0-based 下标。越界抛错。
    function toIndex(value, label, max){
        const num = Number(value);
        if(!Number.isInteger(num) || num < 1 || num > max){
            throw new Error(label + '必须是 1–' + max + '。');
        }
        return num - 1;
    }

    function columnIndexByTitle(table, title){
        const name = String(title || '').trim();
        if(!name) return -1;
        const hits = [];
        table.columns.forEach(function(column, index){ if(column === name) hits.push(index); });
        if(hits.length > 1) throw new Error('列名“' + name + '”不唯一。');
        if(!hits.length) throw new Error('不存在列“' + name + '”。');
        return hits[0];
    }

    /**
     * 列定位双通道：columnName 优先（要求唯一），否则 column 按 1-based 序号。
     * @returns {number} 0-based 下标
     */
    function resolveColumnIndex(table, selector){
        const args = selector || {};
        const name = String(args.columnName || '').trim();
        if(name) return columnIndexByTitle(table, name);
        return toIndex(args.column, '列序号', table.columns.length);
    }

    function resolveRowIndex(table, value){ return toIndex(value, '行序号', table.rows.length); }

    // ---- 输入列 ------------------------------------------------------------

    function isInputColumn(title){ return INPUT_COLUMN_PATTERN.test(String(title || '')); }

    function leadingInputColumnCount(table){
        let count = 0;
        while(count < table.columns.length && isInputColumn(table.columns[count])) count += 1;
        return count;
    }

    /** 剥离开头由上游连线自动生成的输入列（幂等：已剥离则原样返回）。 */
    function detachInputColumns(table){
        const copy = cloneTable(table);
        const count = leadingInputColumnCount(copy);
        if(!count) return { table: copy, detached: 0 };
        copy.columns.splice(0, count);
        copy.rows.forEach(function(row){ row.splice(0, count); });
        copy.selectedRows = copy.selectedRows
            .filter(function(index){ return index >= count; })
            .map(function(index){ return index - count; });
        return { table: copy, detached: count };
    }

    /** 在最左侧补足输入列（列名「生成输入」/「输入 N」）。 */
    function ensureInputColumns(table, count){
        const copy = cloneTable(table);
        const target = Math.max(0, Math.min(Number(count) || 0, MAX_COLUMNS));
        const current = leadingInputColumnCount(copy);
        if(current >= target) return copy;
        const titles = [];
        for(let i = current; i < target; i += 1){
            titles.push(i === 0 ? '生成输入' : '输入 ' + i);
        }
        copy.columns = titles.concat(copy.columns).slice(0, MAX_COLUMNS);
        copy.rows = copy.rows.map(function(row){
            return titles.map(function(){ return ''; }).concat(row).slice(0, MAX_COLUMNS);
        });
        return copy;
    }

    // ---- requestId 环形缓冲 ------------------------------------------------

    function appendRequestId(history, requestId){
        const list = Array.isArray(history) ? history.map(String).filter(Boolean) : [];
        const id = String(requestId || '');
        if(!id) return list.slice(-MAX_REQUEST_IDS);
        const next = list.filter(function(item){ return item !== id; });
        next.push(id);
        return next.slice(-MAX_REQUEST_IDS);
    }

    function hasRequestId(history, requestId){
        const id = String(requestId || '');
        if(!id) return false;
        return (Array.isArray(history) ? history : []).map(String).indexOf(id) >= 0;
    }

    // ---- 操作执行 ----------------------------------------------------------

    function applyOperation(table, operationId, args){
        const input = args || {};
        const next = cloneTable(table);
        if(operationId === 'read_table') return next;

        if(operationId === 'set_cell'){
            const row = resolveRowIndex(next, input.row);
            const column = resolveColumnIndex(next, input);
            next.rows[row][column] = cellToString(input.value);
            return next;
        }

        if(operationId === 'append_row'){
            if(next.rows.length >= MAX_ROWS) throw new Error('表格最多允许 ' + MAX_ROWS + ' 行。');
            const values = input.values;
            const isNamed = Boolean(values) && !Array.isArray(values) && typeof values === 'object';
            const list = Array.isArray(values) ? values : [];
            next.rows.push(next.columns.map(function(title, index){
                return cellToString(isNamed ? values[title] : list[index]);
            }));
            return next;
        }

        if(operationId === 'delete_row'){
            const row = resolveRowIndex(next, input.row);
            next.rows.splice(row, 1);
            next.selectedRows = next.selectedRows
                .filter(function(index){ return index !== row; })
                .map(function(index){ return index > row ? index - 1 : index; });
            return next;
        }

        if(operationId === 'add_column'){
            if(next.columns.length >= MAX_COLUMNS) throw new Error('表格最多允许 ' + MAX_COLUMNS + ' 列。');
            next.columns = normalizeColumnTitles(next.columns.concat([input.title]));
            next.rows = next.rows.map(function(row){ return row.concat(['']); });
            return next;
        }

        if(operationId === 'delete_column'){
            const column = resolveColumnIndex(next, input);
            next.columns.splice(column, 1);
            next.rows.forEach(function(row){ row.splice(column, 1); });
            next.selectedRows = next.selectedRows.filter(function(index){ return index < next.columns.length; });
            return next;
        }

        throw new Error('表格节点不支持操作：' + operationId);
    }

    /**
     * plan / apply 契约：纯函数，返回新表格与变更描述，不改动入参。
     * 命中已存在的 requestId 时返回 replayed:true 且数据不变（幂等回放）。
     * @returns {{operationId:string, table:object, before:object, after:object,
     *            changed:boolean, replayed:boolean, requestId:string, requestIds:string[]}}
     */
    function planTableOperation(table, operationId, args, requestId, requestIds){
        const opId = String(operationId || '');
        if(!TABLE_OPERATIONS[opId]) throw new Error('表格节点不支持操作：' + opId);
        const before = cloneTable(table);
        const id = String(requestId || '');

        if(id && hasRequestId(requestIds, id)){
            return {
                operationId: opId, table: before, before: before, after: before,
                changed: false, replayed: true, requestId: id,
                requestIds: appendRequestId(requestIds, id)
            };
        }

        const after = applyOperation(before, opId, args);
        const changed = !tablesEqual(before, after);
        const nextIds = opId === 'read_table'
            ? (Array.isArray(requestIds) ? requestIds.slice() : [])
            : appendRequestId(requestIds, id);

        return {
            operationId: opId, table: after, before: before, after: after,
            changed: changed, replayed: false, requestId: id, requestIds: nextIds
        };
    }

    return {
        TABLE_KIND, TABLE_VERSION, MAX_COLUMNS, MAX_ROWS, MAX_CELL_CHARS, MAX_COLUMN_TITLE,
        MAX_REQUEST_IDS, UNNAMED_COLUMN, TABLE_OPERATIONS,
        emptyTable, normalizeTable, cloneTable, tablesEqual, cellToString, normalizeColumnTitles,
        isStrictTable, toIndex, resolveColumnIndex, resolveRowIndex, columnIndexByTitle,
        isInputColumn, leadingInputColumnCount, detachInputColumns, ensureInputColumns,
        appendRequestId, hasRequestId, applyOperation, planTableOperation,
        describeOperation, operationIds, requiresConfirmation
    };
});
