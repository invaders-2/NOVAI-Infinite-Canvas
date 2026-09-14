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

    /* ── 输入列（DX OS §3：XS / Co / ab）────────────────────────────
       通道 = 一整列，表头「输入 N」，单元格是上游素材缩略图。
       items 里的 mode 决定逐行怎么取：
         sequence → items[row]                （逐行对应，超出为 null）
         其他     → items[min(row, len-1)]    （按行取，超出后沿用最后一个） */
    const INPUT_CHANNEL_PREFIX = 'input-';
    const MENTION_LABELS = {image:'图片', video:'视频', audio:'音频', file:'文件'};

    function channelIdAt(index){ return INPUT_CHANNEL_PREFIX + (Math.max(0, Number(index) || 0) + 1); }

    function channelIndexFromId(channelId){
        const matched = /^input-(\d+)$/.exec(String(channelId || ''));
        if(!matched) return -1;
        const ordinal = Number(matched[1]);
        return Number.isInteger(ordinal) && ordinal >= 1 ? ordinal - 1 : -1;
    }

    // DX OS: refs.length > 1 ? "sequence" : "shared"
    function channelModeFor(refs){
        return (Array.isArray(refs) ? refs.length : 0) > 1 ? 'sequence' : 'shared';
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
                mode: source.mode === 'sequence' ? 'sequence' : 'shared',
                items
            };
        });
    }

    // ab(t, ch, row)
    function inputItemAt(channel, row){
        const items = Array.isArray(channel?.items) ? channel.items : [];
        if(!items.length) return null;
        const index = Math.max(0, Number(row) || 0);
        if(channel.mode === 'sequence') return items[index] || null;
        return items[Math.min(index, items.length - 1)] || null;
    }

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
    const BATCH_ROW_STATUS = ['completed', 'running', 'pending', 'deferred', 'failed'];
    const DEFAULT_BATCH_CONCURRENCY = 3;
    const MAX_BATCH_CONCURRENCY = 8;

    function batchFailurePolicy(raw){ return raw === 'stop' ? 'stop' : 'continue'; }

    function batchStartRow(raw, rowCount){
        const max = Math.max(1, Number(rowCount) || 0);
        const value = Math.floor(Number(raw));
        if(!Number.isFinite(value) || value < 1) return 1;
        return Math.min(value, max);
    }

    // 并发 clamp 1..8
    function batchConcurrency(raw){
        const value = Math.floor(Number(raw));
        if(!Number.isFinite(value) || value < 1) return DEFAULT_BATCH_CONCURRENCY;
        return Math.min(MAX_BATCH_CONCURRENCY, value);
    }

    /* bl(t)：批量执行实际要跑的行。
       手动模式只取已选行；批量模式取起始行之后的全部。
       两种模式都跳过既没有媒体也没有文本的空行。 */
    function batchRowsToRun(rows, options={}){
        const list = Array.isArray(rows) ? rows : [];
        const selected = new Set((Array.isArray(options.selectedRows) ? options.selectedRows : []).map(Number));
        const manual = Boolean(options.manual);
        const startRow = batchStartRow(options.startRow, list.length);
        return list.filter(row => {
            if(!row) return false;
            const hasContent = (Array.isArray(row.media) && row.media.length) || String(row.text || '').trim();
            if(!hasContent) return false;
            if(manual) return selected.has(Number(row.rowNumber) - 1);
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
        const results = new Array(list.length);
        let cursor = 0;
        let failed = false;
        const run = async () => {
            while(true){
                if(stopOnError && failed) return;
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
        return results;
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
        INPUT_CHANNEL_PREFIX, MENTION_LABELS, MENTION_RE,
        UNNAMED_COLUMN, TABLE_OPERATIONS, OPERATION_IDS,
        channelIdAt, channelIndexFromId, channelModeFor, channelLabel, normalizeChannels, inputItemAt,
        rowHeightForRow, mentionLabel, mentionTokenAt, mentionsIn, danglingMentions, buildRowPrompt,
        BATCH_ROW_STATUS, DEFAULT_BATCH_CONCURRENCY, MAX_BATCH_CONCURRENCY,
        batchFailurePolicy, batchStartRow, batchConcurrency, batchRowsToRun,
        emptyJournal, normalizeJournal, matchBatchJournal, journalMarkRow,
        journalPendingRows, journalInflightRows, journalCompletedRows, journalFailedRows,
        batchMissingMaterials, runWithSharedCursor,
        emptyTable, cellText, normalizeColumns, normalizeTable, cloneTable,
        toIndex, columnIndex, rowIndex, applyOperation,
        rowHeight, nodeSize, describeOperation, requiresConfirmation,
    };
});
