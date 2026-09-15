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

    // 单元格一律字符串化并截断（DX OS: 非字符串走 JSON.stringify）；媒体格不进文字流
    function cellText(value){
        if(value === null || value === undefined) return '';
        if(isMediaCell(value)) return '';
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
            && row.every(cell => typeof cell === 'string' || isMediaCell(cell)));
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
            next.rows[r][c] = isMediaCell(args.value) ? mediaCell(args.value.url, args.value.mediaType, args.value.name) : cellText(args.value);
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

    /* ── LLM → 表格（DX OS §6：FS 规划 / BS 生成 / a6 校验 / CR 修复）─── */
    const TABLE_PARSE_ERRORS = {
        format: '模型没有返回统一的多维表格格式',
        columns: '模型返回的表格列名不完整',
        empty: '模型返回的多维表格没有任何内容',
        missing: '缺少多维表格输出'
    };
    const TABLE_REPAIR_INSTRUCTION = '请把下面未通过校验的结果修复为合法的多维表格 JSON。不要删减原有信息，不要输出解释或 Markdown。';
    const LLM_REPAIR_MAX_TOKENS = 8192;

    // 剥 ```json 代码块 → 取首尾大括号 → JSON.parse
    function extractJsonObject(text){
        let source = String(text || '').trim();
        const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(source);
        if(fenced) source = fenced[1].trim();
        else {
            const inline = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
            if(inline) source = inline[1].trim();
        }
        const first = source.indexOf('{');
        const last = source.lastIndexOf('}');
        if(first < 0 || last <= first) return null;
        try { return JSON.parse(source.slice(first, last + 1)); }
        catch(error){ return null; }
    }

    /* a6(t)：校验模型返回的表格。
       LLM 侧上限比手工小得多（40 列 / 200 行），超了直接判格式不合规。
       返回合法表格，不合法抛错（文案照搬规范）。 */
    function parseTableOutput(text){
        const parsed = extractJsonObject(text);
        if(!parsed || typeof parsed !== 'object') throw new Error(TABLE_PARSE_ERRORS.format);
        if(parsed.kind !== TABLE_KIND || Number(parsed.version) !== TABLE_VERSION) throw new Error(TABLE_PARSE_ERRORS.format);
        if(!Array.isArray(parsed.columns) || !Array.isArray(parsed.rows)) throw new Error(TABLE_PARSE_ERRORS.format);
        if(parsed.columns.length > LLM_MAX_COLUMNS || parsed.rows.length > LLM_MAX_ROWS) throw new Error(TABLE_PARSE_ERRORS.format);
        if(!parsed.columns.length) throw new Error(TABLE_PARSE_ERRORS.columns);
        /* 先按原始列名校验：模型给了空白列名属于格式不合规，要报出来让修复遍处理。
           手工建列时空列名会被兜底成「未命名列」，那是友好的；这里不能沿用那个兜底。 */
        const rawColumns = parsed.columns.map(name => cellText(name));
        if(rawColumns.some(name => !String(name).trim())) throw new Error(TABLE_PARSE_ERRORS.columns);
        const columns = normalizeColumns(rawColumns);
        const rows = parsed.rows.slice(0, LLM_MAX_ROWS).map(row => {
            const list = Array.isArray(row) ? row : [];
            // 行按列数补齐
            return columns.map((name, index) => cellText(list[index]));
        });
        /* 结构合法但整张表一个字都没有：实测模型偶发返回 [""] 这种空表，
           放过去的话批量执行会拿着空提示词去生成。判格式不合规，交给修复遍。 */
        if(!rows.length || rows.every(row => row.every(cell => !String(cell || '').trim()))){
            throw new Error(TABLE_PARSE_ERRORS.empty);
        }
        return {kind:TABLE_KIND, version:TABLE_VERSION, columns, rows, selectedRows:[], mergedGroups:[]};
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
            '必须为每一个输入组指定它在逐行执行里的用法 rowMode：',
            '- "per-row"：这一组是**行驱动**，第 N 行用第 N 张。多张参考图 → 多行。',
            '- "every-row"：这一组**每一行都要用上全部**。例如多张可替换的素材 → 每行都带整组。',
            '行的数量由 per-row 的组决定；every-row 的组只增加每行带的素材数，不增加行数。',
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
            '严格遵守用户指定的数量；未指定时根据逐项输入数量和任务目标合理决定。图片组通常逐张映射到各行，单图参考通常应用到所有相关行。',
            video ? VIDEO_GENERATE_BLOCK : '',
            '如果任务区分了「目标主体」和「风格/版式参考」，每行生成提示词都必须显式写清它们的关系。',
            '不要只写「使用图1」「参考图2」这类占位说明。每个文字单元格应提供与普通文本输出相当的信息密度。',
            '请根据任务自行设计最合适的列结构，不套固定模板。',
            '行的先后顺序已经可以表达执行顺序，因此通常不需要额外创建只用于计数的序号列。',
            '不要在 JSON 中创建图片、参考图或生成输入列，系统会在独立的输入区域按规划映射素材，不会覆盖文字列。',
            '只返回一个 JSON 对象，不要 Markdown 代码块，不要解释。',
            '{"kind":"table","version":1,"columns":["列名1","列名2"],"rows":[["单元格1","单元格2"]]}'
        ].join('\n');
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
        batchFailurePolicy, batchStartRow, batchConcurrency, batchRowsToRun,
        emptyJournal, normalizeJournal, matchBatchJournal, journalMarkRow,
        journalPendingRows, journalInflightRows, journalCompletedRows, journalFailedRows,
        batchMissingMaterials, runWithSharedCursor,
        TABLE_PARSE_ERRORS, TABLE_REPAIR_INSTRUCTION, LLM_REPAIR_MAX_TOKENS,
        extractJsonObject, parseTableOutput, buildRepairPrompt, inputListText,
        buildListPlanPrompt, buildListGeneratePrompt, planGroupModes, llmOutputMode, llmRunStageLabel,
        LLM_OUTPUT_MODES, llmOutputModeChoice, llmModeTargetKind,
        llmTargetKind, VIDEO_PLAN_BLOCK, VIDEO_GENERATE_BLOCK,
        emptyTable, cellText, normalizeColumns, normalizeTable, cloneTable,
        MEDIA_CELL_KIND, mediaCell, isMediaCell,
        toIndex, columnIndex, rowIndex, applyOperation,
        rowHeight, nodeSize, describeOperation, requiresConfirmation,
    };
});
