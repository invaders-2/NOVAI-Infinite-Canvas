(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.NovaWorkflowUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    const MATRIX_VERSION = 2;
    const MATRIX_TYPES = ['image', 'video'];
    // 行状态规范词表。必须与后端 server/node_types/task_table.py 的 ROW_STATUSES 保持一致，
    // 否则会出现「后端写了 success、前端不认识而降级成 draft」的语义分裂（已在 runtime gate 实测到）。
    // 内部统一使用 done / stopped；success / canceled 作为契约别名在读取时归一。
    const MATRIX_STATUSES = ['draft', 'ready', 'queued', 'running', 'done', 'failed', 'blocked', 'stale', 'canceling', 'stopped'];
    const MATRIX_STATUS_ALIASES = {idle:'draft', success:'done', canceled:'stopped', cancelled:'stopped'};
    // Phase 2D：执行输入（Execution Input）——决定「行执行语义」的字段。
    // revision 只看执行语义是否变化，而不是看哪个 UI 事件触发了编辑；name/selected/展示态不在此列。
    const EXECUTION_INPUT_KEYS = [
        'prompt', 'task', 'type', 'outputType', 'overlay',
        'dependencies', 'dependsOn', 'references', 'targetNodeId',
        'model', 'modelParams', 'fieldMapping',
        'globalReferences', 'sharedReferences'
    ];
    // 兼容旧入口：判断某个字段是否属于执行输入（供轻量查询，revision 统一机制不依赖它）。
    function isExecutionField(field){ return EXECUTION_INPUT_KEYS.includes(String(field || '')); }

    // 稳定归一化一个执行输入里的参考/映射列表，供签名比较（顺序无关、忽略展示字段）。
    function _signatureRefs(refs){
        return (Array.isArray(refs) ? refs : []).map(ref => {
            if(typeof ref === 'string') return 'url:' + ref;
            const o = ref || {};
            return ['url', 'value', 'kind', 'role', 'purpose', 'sourceNodeId', 'sourceRowId', 'slot', 'weight']
                .map(k => k + '=' + String(o[k] ?? '')).join('&');
        }).sort().join('|');
    }

    // 计算一行的执行语义签名：执行输入变化 → 签名变化 → revision += 1。
    // context（由 buildRowExecutionContext 统一解析）优先于 row 上的冗余字段。
    function computeRowExecutionSignature(row, context={}){
        const deps = [...new Set((row?.dependencies ?? row?.dependsOn ?? []).map(String))].sort().join(',');
        const inputs = {
            prompt: String(row?.prompt ?? row?.task ?? ''),
            type: String(row?.type ?? row?.outputType ?? ''),
            overlay: JSON.stringify(row?.overlay ?? null),
            dependsOn: deps,
            references: _signatureRefs(row?.references),
            targetNodeId: String(context.targetNodeId ?? row?.targetNodeId ?? ''),
            model: String(context.model ?? row?.model ?? ''),
            provider: String(context.provider ?? row?.provider ?? ''),
            modelParams: JSON.stringify(context.modelParams ?? row?.modelParams ?? {}),
            fieldMapping: JSON.stringify(context.fieldMapping ?? row?.fieldMapping ?? {}),
            globalSharedRefs: _signatureRefs([...(context.globalReferences ?? []), ...(context.sharedReferences ?? [])])
        };
        return JSON.stringify(inputs);
    }

    // 统一 revision 递增入口：执行语义变化才 bump，否则原样返回（不改 revision）。
    function markRowChangedIfExecutionInputsDiffer(prevRow, nextRow, context={}){
        if(computeRowExecutionSignature(prevRow, context) === computeRowExecutionSignature(nextRow, context)) return nextRow;
        return {...nextRow, revision: (Number(nextRow?.revision) || 1) + 1};
    }

    // ---- Row Execution Context Builder（唯一事实来源）----
    // 解析某一行「实际会使用」的执行上下文：routed target / model / provider / modelParams /
    // fieldMapping / global·shared references / row references / dependency。
    // revision 判定、Execution Snapshot、Run 创建都必须复用这里，禁止另写一套「执行输入怎么拼」。

    // 真实生成参数白名单：只纳入真正传给 provider 的参数；UI/展示/坐标字段一律排除。
    const MODEL_PARAM_KEYS = [
        'model', 'provider_id', 'apiProvider',
        'width', 'height', 'size', 'quality', 'n', 'count',
        'aspect_ratio', 'aspectRatio', 'resolution', 'duration',
        'seed', 'steps', 'guidance', 'cfg', 'guidanceScale',
        'enhancePrompt', 'enableUpsample', 'upsampleRes', 'watermark',
        'camerafixed', 'returnLastFrame', 'generateAudio', 'multimodal',
        'useFrameRoles', 'reference_images', 'references',
        'negativePrompt', 'lora', 'loras', 'prompt', 'params', 'workflow_json'
    ];
    function extractModelParams(targetNode){
        if(!targetNode || typeof targetNode !== 'object') return {};
        const out = {};
        MODEL_PARAM_KEYS.forEach(key => {
            const v = targetNode[key];
            if(v !== undefined && v !== null && v !== '') out[key] = v;
        });
        return out;
    }
    // 各 node-type / provider 的真实执行参数补充。只纳入「真正进入 provider request」的字段，
    // 从真实 request builder 核对：
    //   rh: webappId / workflowId / nodeInfoList / instanceType / useWallet
    //   minimax: minimaxEngine / segments（时间线）/ aspectRatio / duration
    //   ltxDirector: ltxTimelineData（导演时间线）
    //   comfy: workflow_json / params
    const NODE_TYPE_EXECUTION_PARAMS = {
        rh: ['webappId', 'workflowId', 'nodeInfoList', 'instanceType', 'useWallet'],
        minimax: ['minimaxEngine', 'segments', 'aspectRatio', 'duration'],
        ltxDirector: ['ltxTimelineData'],
        comfy: ['workflow_json', 'params']
    };
    function extractExecutionModelParams(targetNode){
        const generic = extractModelParams(targetNode);
        if(!targetNode || typeof targetNode !== 'object') return generic;
        const extraKeys = NODE_TYPE_EXECUTION_PARAMS[String(targetNode.type || '')] || [];
        const extra = {};
        extraKeys.forEach(key => {
            const v = targetNode[key];
            const empty = v === undefined || v === null || v === ''
                || (Array.isArray(v) && v.length === 0)
                || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
            if(!empty) extra[key] = v;
        });
        return {...generic, ...extra};
    }
    // 全局上下文里与「执行语义」相关的引用：产品参考 + 配色/字体/大纲 + 统一宽度。
    function extractGlobalReferences(tableNode){
        const gc = tableNode?.globalContext || {};
        const refs = [];
        ['productReference', 'palette', 'font', 'outline'].forEach(key => {
            if(gc[key]) refs.push({key, value: String(gc[key])});
        });
        if(gc.commonWidth) refs.push({key:'commonWidth', value:String(gc.commonWidth)});
        return refs;
    }
    function buildRowExecutionContext(tableNode, row, canvasState={}){
        const rowId = String(row?.rowId ?? row?.id ?? '');
        const nodes = Array.isArray(canvasState.nodes) ? canvasState.nodes : [];
        const mappings = rowTargetMappings(tableNode, rowId);
        const targetNodeId = mappings[0]?.targetNodeId || row?.targetNodeId || '';
        const target = nodes.find(n => String(n.id) === String(targetNodeId)) || null;
        return {
            targetNodeId: String(targetNodeId),
            targetNodeType: String(target?.type ?? ''),
            model: String(target?.model ?? row?.model ?? ''),
            provider: String(target?.apiProvider ?? target?.provider_id ?? row?.provider ?? ''),
            modelParams: extractExecutionModelParams(target),
            // fieldMapping 只含「字段映射」本身（上游字段 → 表格字段），按行过滤；
            // target 路由不进 fieldMapping（它已由 targetNodeId 精确到行，避免一改路由就误 bump 全表）
            fieldMapping: (tableNode?.sourceMappings ?? []).filter(m => !m.rowId || m.rowId === rowId),
            globalReferences: extractGlobalReferences(tableNode),
            sharedReferences: tableNode?.sharedReferences ?? [],
            references: row?.references ?? [],
            dependencies: row?.dependencies ?? row?.dependsOn ?? []
        };
    }

    // 把一行的 execution context 规范化为 canonical Snapshot DTO（提交 POST /api/runs 用）。
    // 唯一来源仍是 buildRowExecutionContext，禁止在 API client 再手写一套「哪些字段影响执行」。
    function buildExecutionSnapshotDTO(tableNode, row, canvasState={}){
        const ctx = buildRowExecutionContext(tableNode, row, canvasState);
        const rowId = String(row?.rowId ?? row?.id ?? '');
        const deep = value => { try { return JSON.parse(JSON.stringify(value ?? {})); } catch(e) { return {}; } };
        return {
            snapshot_version: 1,
            row_id: rowId,
            row_revision: Number(row?.revision || 1),
            type: String(row?.type ?? row?.outputType ?? 'image'),
            prompt: String(row?.prompt ?? row?.task ?? ''),
            references: (row?.references ?? []).map(ref => ({...ref})),
            dependencies: (row?.dependencies ?? row?.dependsOn ?? []).map(String),
            target_node_id: String(ctx.targetNodeId ?? ''),
            target_node_type: String(ctx.targetNodeType ?? ''),
            model: String(ctx.model ?? ''),
            provider_id: String(ctx.provider ?? ''),
            params: deep(ctx.modelParams),
            mapping: { sources: deep(ctx.fieldMapping) }
        };
    }

    // 哪些行真正消费某个目标节点（specific 优先、否则通用 fallback）。
    function rowsConsumingTarget(tableNode, targetNodeId){
        const tid = String(targetNodeId || '');
        return (tableNode?.rows ?? [])
            .map(row => String(row?.rowId ?? row?.id ?? ''))
            .filter(rowId => rowTargetMappings(tableNode, rowId).some(m => String(m.targetNodeId) === tid));
    }

    // 捕获一批行在当前状态下的执行签名（供 before/after 比较一次）。
    function captureRowExecutionSignatures(tableNode, rowIds, buildContext){
        const sigs = {};
        (rowIds || []).forEach(rowId => {
            const key = String(rowId);
            const row = (tableNode?.rows ?? []).find(r => String(r.rowId ?? r.id) === key);
            if(!row) return;
            sigs[key] = computeRowExecutionSignature(row, buildContext(tableNode, row));
        });
        return sigs;
    }

    // 对比 before 签名：只有执行语义真正变化的行才 revision += 1（每行最多 +1）。
    function markRowsChangedSince(tableNode, beforeSignatures, buildContext){
        return (tableNode?.rows ?? []).map(row => {
            const key = String(row.rowId ?? row.id);
            const before = beforeSignatures?.[key];
            if(before === undefined) return row;
            const after = computeRowExecutionSignature(row, buildContext(tableNode, row));
            if(after === before) return row;
            return {...row, revision: (Number(row.revision) || 1) + 1};
        });
    }

    // 执行输入变化后的 stale 传播：变化行自身用 revision 判定 stale；依赖闭包一律标 stale
    // （下游行自己的 revision 不变，只是上游结果过期——与 revision 解耦）。
    function markRowsAndDependentsStale(rows, changedRowIds){
        const changed = new Set((changedRowIds || []).map(String));
        let out = (rows || []).map(row => {
            const key = String(row?.rowId ?? row?.id ?? '');
            if(changed.has(key) && ['done', 'failed', 'stale'].includes(row?.status) && rowIsStale(row)){
                return {...row, status:'stale', error:'执行输入已变化，待更新'};
            }
            return row;
        });
        (changedRowIds || []).forEach(id => { out = markDependentsStale(out, id); });
        return out;
    }

    // Phase 2D：stale 判定。有结果（lastRunRevision > 0）且 revision 已越过上次运行版本 → 过期。
    function rowIsStale(row){
        const lastRun = Number(row?.lastRunRevision || 0);
        const revision = Number(row?.revision || 1);
        return lastRun > 0 && revision > lastRun;
    }
    // 统一节点类型：传统画布与智能画布共用同一份表格语义
    const MATRIX_NODE_TYPE = 'matrix';
    // 历史类型：智能画布的 v0 残件，加载时迁移到统一类型
    const LEGACY_MATRIX_NODE_TYPES = ['smart-matrix'];
    let rowSequence = 0;

    function matrixRowId(value){
        const current = String(value || '').trim();
        if(current) return current;
        rowSequence += 1;
        return `row-${Date.now().toString(36)}-${rowSequence.toString(36)}`;
    }

    function normalizeRef(ref, fallback={}){
        if(typeof ref === 'string') ref = {url:ref};
        const value = ref && typeof ref === 'object' ? ref : {};
        const kind = ['image', 'video', 'text'].includes(value.kind) ? value.kind : (fallback.kind || 'image');
        return {
            ...value,
            id:String(value.id || fallback.id || `${kind}-${String(value.url || value.value || '').slice(-24)}`),
            url:String(value.url || ''),
            value:String(value.value || ''),
            name:String(value.name || fallback.name || kind),
            kind,
            sourceNodeId:String(value.sourceNodeId || value.nodeId || fallback.sourceNodeId || ''),
            purpose:['shared', 'row', 'previous', 'context'].includes(value.purpose) ? value.purpose : (fallback.purpose || 'row')
        };
    }

    function normalizeOverlay(overlay){
        if(typeof overlay === 'string') return {text:overlay, x:32, y:32, fontSize:36, color:'#ffffff', align:'left'};
        const value = overlay && typeof overlay === 'object' ? overlay : {};
        return {
            ...value,
            text:String(value.text || ''),
            x:Number.isFinite(Number(value.x)) ? Number(value.x) : 32,
            y:Number.isFinite(Number(value.y)) ? Number(value.y) : 32,
            fontSize:Math.max(8, Number(value.fontSize) || 36),
            color:String(value.color || '#ffffff'),
            align:['left', 'center', 'right'].includes(value.align) ? value.align : 'left'
        };
    }

    function normalizeMatrixRow(row={}, index=0, previousRowId='', options={}){
        const source = row && typeof row === 'object' ? row : {prompt:String(row || '')};
        const rowId = matrixRowId(source.rowId || source.id);
        const legacyContinuous = Boolean(options.legacy && index > 0 && source.dependsOnPrevious !== false);
        const dependencies = Array.isArray(source.dependencies)
            ? source.dependencies.map(String).filter(Boolean)
            : Array.isArray(source.dependsOn)
                ? source.dependsOn.map(String).filter(Boolean)
                : ((source.dependsOnPrevious || legacyContinuous) && previousRowId ? [previousRowId] : []);
        const legacyResultRefs = Array.isArray(source.resultRefs) ? source.resultRefs : [];
        const output = source.output && typeof source.output === 'object' ? source.output : {};
        const type = MATRIX_TYPES.includes(source.type) ? source.type : (source.outputType === 'video' ? 'video' : 'image');
        let status = String(source.status || 'draft');
        if(status === 'idle') status = 'draft';
        // 契约别名归一：success -> done、canceled -> stopped，避免与后端词汇分裂
        if(MATRIX_STATUS_ALIASES[status]) status = MATRIX_STATUS_ALIASES[status];
        if(!MATRIX_STATUSES.includes(status)) status = 'draft';
        const edited = Array.isArray(source.userEditedFields) ? source.userEditedFields.map(String) : (source.userEdited ? ['name', 'prompt', 'overlay'] : []);
        const refs = (Array.isArray(output.refs) ? output.refs : legacyResultRefs).map(ref => normalizeRef(ref, {purpose:'row'}));
        return {
            ...source,
            rowId,
            id:rowId,
            order:Number.isFinite(Number(source.order)) ? Number(source.order) : index,
            selected:source.selected !== false,
            name:String(source.name || source.step || source.title || `步骤 ${index + 1}`),
            prompt:String(source.prompt ?? source.task ?? ''),
            task:String(source.prompt ?? source.task ?? ''),
            references:(Array.isArray(source.references) ? source.references : []).map(ref => normalizeRef(ref, {purpose:'row'})),
            dependencies:[...new Set(dependencies)],
            dependsOnPrevious:dependencies.length === 1 && dependencies[0] === previousRowId,
            type,
            outputType:type,
            status,
            error:String(source.error || output.error || ''),
            fieldErrors:Array.isArray(source.fieldErrors) ? source.fieldErrors : [],
            output:{...output, text:String(output.text ?? source.resultText ?? ''), refs, updatedAt:Number(output.updatedAt || source.resultUpdatedAt || 0)},
            resultText:String(output.text ?? source.resultText ?? ''),
            resultRefs:refs,
            overlay:normalizeOverlay(source.overlay ?? source.textOverlay),
            userEditedFields:[...new Set(edited)],
            userEdited:Boolean(source.userEdited || edited.length),
            // Phase 2D：版本字段显式归一化（数字/字符串），与后端 _coerce_row 对齐
            revision:Math.max(1, Number(source.revision) || 1),
            lastRunRevision:Math.max(0, Number(source.lastRunRevision) || 0),
            resultVersion:Math.max(0, Number(source.resultVersion) || 0),
            executionId:String(source.executionId || '')
        };
    }

    function normalizeMatrixNode(node={}){
        const source = node && typeof node === 'object' ? node : {};
        const inputRows = Array.isArray(source.rows) && source.rows.length ? source.rows : [{}];
        const legacy = Number(source.matrixVersion || 0) < MATRIX_VERSION;
        let previousRowId = '';
        const rows = inputRows.map((row, index) => {
            const normalized = normalizeMatrixRow(row, index, previousRowId, {legacy});
            previousRowId = normalized.rowId;
            return normalized;
        });
        return {
            ...source,
            matrixVersion:MATRIX_VERSION,
            title:String(source.title || source.name || '多维表格'),
            name:String(source.name || source.title || '多维表格'),
            mode:source.mode === 'continuous' ? 'continuous' : 'batch',
            view:['table', 'gallery', 'long'].includes(source.view) ? source.view : 'table',
            rows,
            globalContext:{...{productReference:'', palette:'', font:'', outline:'', commonWidth:1024}, ...(source.globalContext || {})},
            sharedReferences:(Array.isArray(source.sharedReferences) ? source.sharedReferences : []).map(ref => normalizeRef(ref, {purpose:'shared'})),
            sourceMappings:Array.isArray(source.sourceMappings) ? source.sourceMappings.map(mapping => normalizeConnectionMapping(mapping, 'source')) : [],
            targetMappings:Array.isArray(source.targetMappings) ? source.targetMappings.map(mapping => normalizeConnectionMapping(mapping, 'target')) : [],
            range:{startRowId:String(source.range?.startRowId || rows[0]?.rowId || ''), endRowId:String(source.range?.endRowId || rows[rows.length - 1]?.rowId || '')},
            running:Boolean(source.running),
            stopRequested:Boolean(source.stopRequested),
            validationErrors:Array.isArray(source.validationErrors) ? source.validationErrors : []
        };
    }

    // 目标节点串行化锁。返回的函数可安全并发调用：同一 targetId 严格串行，不同 targetId 并行。
    // 修复点：原 canvas.js 实现用 previous.resolve(previous)（Promise 实例无此方法，首次即抛 TypeError），
    // 并把 current.finally(...) 的返回值存进 Map、却拿 current 比较清理，导致锁链永不释放。
    function createMatrixTargetLock(){
        const locks = new Map();
        const runWithTargetLock = function(targetId, task){
            const previous = locks.get(targetId) || Promise.resolve();
            const chain = Promise.resolve(previous).catch(() => {}).then(task);
            const tracked = chain.then(() => null, () => null);
            locks.set(targetId, tracked);
            tracked.then(() => { if(locks.get(targetId) === tracked) locks.delete(targetId); });
            return chain;
        };
        // 仅供自检与测试：观察锁链是否最终释放（size 必须回到 0）
        runWithTargetLock.size = () => locks.size;
        runWithTargetLock.keys = () => [...locks.keys()];
        return runWithTargetLock;
    }

    let matrixTaskSequence = 0;
    function matrixTaskId(nodeId, rowId){
        matrixTaskSequence += 1;
        const safe = value => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
        return `mt-${safe(nodeId)}-${safe(rowId)}-${Date.now().toString(36)}-${matrixTaskSequence}`;
    }

    // 确定性结果归属：用「执行前 URL 集合」差集，而不是「执行前条数 slice」。
    // 条数差分在并发下会错位；URL 集合差集即使目标节点被整体替换也不会误判。
    // 每个结果都带上 task_id -> row_id -> matrix_node_id -> target_node_id 归属。
    function matrixOwnedRefs(allRefs, beforeUrls, expectedType, attribution={}){
        const before = beforeUrls instanceof Set ? beforeUrls : new Set((beforeUrls || []).map(String));
        return (allRefs || [])
            .filter(ref => ref && ref.url && !before.has(ref.url))
            .map(ref => ({...ref, ...attribution}))
            .filter(ref => ref.url && (!expectedType || ref.kind === expectedType));
    }

    function isMatrixNode(node){
        const type = String(node?.type || '');
        return type === MATRIX_NODE_TYPE || LEGACY_MATRIX_NODE_TYPES.includes(type);
    }

    // legacy smart-matrix(v0) / matrix(v1) -> 统一 matrix(v2)
    // 幂等：normalize 结果再 normalize 结果不变；重复加载不会重复转换、不丢字段
    function migrateMatrixNode(node){
        if(!isMatrixNode(node)) return node;
        const source = node && typeof node === 'object' ? node : {};
        const normalized = normalizeMatrixNode(source);
        normalized.type = MATRIX_NODE_TYPE;
        normalized.matrixVersion = MATRIX_VERSION;
        // v0 残件字段：previousOutputs 属于展示态，保留但不参与执行
        if(source.previousOutputs && !normalized.previousOutputs) normalized.previousOutputs = source.previousOutputs;
        return normalized;
    }

    function rowResult(row){ return normalizeMatrixRow(row).output; }
    function patchRowById(rows, rowId, patch){ return (rows || []).map(row => String(row?.rowId || row?.id) === String(rowId) ? {...row, ...(patch || {})} : row); }
    function patchRow(rows, index, patch){ return (rows || []).map((row, rowIndex) => rowIndex === index ? {...row, ...(patch || {})} : row); }

    function dependentRowIds(rows, changedRowId){
        const result = new Set(), queue = [String(changedRowId || '')];
        while(queue.length){
            const current = queue.shift();
            (rows || []).forEach(row => {
                const rowId = String(row?.rowId || row?.id || '');
                if(result.has(rowId) || !(row?.dependencies || []).map(String).includes(current)) return;
                result.add(rowId); queue.push(rowId);
            });
        }
        return [...result];
    }

    function markDependentsStale(rows, changedRowId, reason='上游结果已变化，待更新'){
        const affected = new Set(dependentRowIds(rows, changedRowId));
        return (rows || []).map(row => affected.has(String(row?.rowId || row?.id)) && ['done', 'failed'].includes(row?.status) ? {...row, status:'stale', error:reason} : row);
    }

    function markFollowingRowsStale(rows, index){
        const normalized = normalizeMatrixNode({rows}).rows;
        return markDependentsStale(normalized, normalized[index]?.rowId);
    }

    function patchRowAndMarkDependents(rows, index, patch, continuous, context={}){
        const normalized = normalizeMatrixNode({rows}).rows, rowId = normalized[index]?.rowId;
        const prev = normalized.find(row => String(row.rowId) === String(rowId));
        let updated = patchRowById(normalized, rowId, patch);
        // 统一机制：revision 由「执行语义是否变化」决定（markRowChangedIfExecutionInputsDiffer），
        // 而不是逐个 UI 事件手写 revision += 1。
        updated = updated.map(row => String(row.rowId) === String(rowId)
            ? markRowChangedIfExecutionInputsDiffer(prev, row, context)
            : row);
        // 自身结果过期（revision > lastRunRevision 且曾有结果）
        updated = updated.map(row => {
            if(String(row.rowId) !== String(rowId)) return row;
            if(['done', 'failed'].includes(row.status) && rowIsStale(row)) return {...row, status:'stale', error:'步骤输入已变化，待更新'};
            return row;
        });
        return continuous ? markDependentsStale(updated, rowId) : updated;
    }

    function mergeRowsWithoutOverwrite(rows, incoming){
        const output = normalizeMatrixNode({rows}).rows.map(row => ({...row}));
        (incoming || []).forEach((value, incomingIndex) => {
            const next = normalizeMatrixRow(value, output.length + incomingIndex);
            const sameIndex = output.findIndex(row => row.rowId === next.rowId);
            if(sameIndex >= 0){
                const existing = output[sameIndex], protectedFields = new Set(existing.userEditedFields || []), patch = {...next};
                ['name', 'prompt', 'task', 'type', 'outputType', 'references', 'dependencies', 'overlay'].forEach(field => {
                    if(existing.userEdited || protectedFields.has(field)) patch[field] = existing[field];
                });
                output[sameIndex] = {...existing, ...patch, rowId:existing.rowId, id:existing.rowId};
                return;
            }
            const emptyIndex = output.findIndex(row => !row.userEdited && !String(row.prompt || '').trim() && !row.output?.refs?.length);
            if(emptyIndex >= 0) output[emptyIndex] = {...next, rowId:output[emptyIndex].rowId, id:output[emptyIndex].rowId};
            else output.push(next);
        });
        return normalizeMatrixNode({rows:output}).rows;
    }

    function normalizeConnectionMapping(connection={}, direction='source'){
        const rawPurpose = String(connection.purpose || '');
        return {
            connectionId:String(connection.id || connection.connectionId || ''), sourceNodeId:String(connection.from || connection.sourceNodeId || ''), targetNodeId:String(connection.to || connection.targetNodeId || ''),
            rowId:String(connection.rowId || ''), slot:String(connection.slot || (direction === 'source' ? 'references' : 'prompt')),
            purpose:['shared', 'row', 'previous', 'context', 'unassigned'].includes(rawPurpose) ? rawPurpose : (connection.rowId ? 'row' : (direction === 'source' ? 'unassigned' : 'context')),
            mediaType:String(connection.mediaType || connection.kind || ''), targetType:String(connection.targetType || '')
        };
    }

    function routeTargets(rowType, targets){
        const expected = rowType === 'video' ? 'video' : 'image';
        return (targets || []).filter(target => {
            const type = String(target?.matrixType || target?.mediaType || target?.targetType || target?.type || '');
            return expected === 'video' ? type === 'video' : ['image', 'generator', 'midjourney', 'msgen', 'comfy', 'ltxDirector', 'rh'].includes(type);
        });
    }

    function rangeRows(matrix){
        const node = normalizeMatrixNode(matrix), start = node.rows.findIndex(row => row.rowId === node.range.startRowId), end = node.rows.findIndex(row => row.rowId === node.range.endRowId);
        if(start < 0 || end < 0 || start > end) return [];
        return node.rows.slice(start, end + 1).filter(row => row.selected !== false);
    }

    function validateMatrix(matrix, context={}){
        const node = normalizeMatrixNode(matrix), errors = [], ids = new Set(node.rows.map(row => row.rowId)), ranged = rangeRows(node);
        if(!node.rows.length) errors.push({code:'rows.empty', field:'rows', message:'至少需要一个步骤'});
        if(!ranged.length) errors.push({code:'range.invalid', field:'range', message:'生成范围无效或没有选中步骤'});
        const checkedRows = ranged.length ? ranged : node.rows;
        checkedRows.forEach(row => {
            if(!row.prompt.trim()) errors.push({code:'prompt.required', rowId:row.rowId, field:'prompt', message:`${row.name}：提示词不能为空`});
            if(!MATRIX_TYPES.includes(row.type)) errors.push({code:'type.invalid', rowId:row.rowId, field:'type', message:`${row.name}：输出类型无效`});
            row.dependencies.forEach(dependency => {
                if(!ids.has(dependency)) errors.push({code:'dependency.missing', rowId:row.rowId, field:'dependencies', message:`${row.name}：依赖步骤不存在`});
                if(dependency === row.rowId) errors.push({code:'dependency.self', rowId:row.rowId, field:'dependencies', message:`${row.name}：不能依赖自身`});
            });
            row.references.forEach(ref => { if(!['image', 'video', 'text'].includes(ref.kind)) errors.push({code:'reference.type', rowId:row.rowId, field:'references', connectionId:ref.connectionId || '', message:`${row.name}：参考类型不支持`}); });
            if(context.targets && !routeTargets(row.type, context.targets).length) errors.push({code:'target.missing', rowId:row.rowId, field:'connection', message:`${row.name}：未连接${row.type === 'video' ? '视频' : '图片'}生成节点`});
        });
        node.sourceMappings.filter(mapping => mapping.purpose === 'unassigned').forEach(mapping => {
            errors.push({code:'mapping.unassigned', rowId:mapping.rowId, field:'sourceMappings', connectionId:mapping.connectionId, message:'有上游素材尚未选择用途'});
        });
        // Phase 2D P1-2：多行多 target 已支持「按行指定」（rowTargetMappings 优先取特定目标）。
        // 仍禁止的只有：同一媒体类型存在 ≥2 个「未按行指定」的通用目标（会导致每行重复派发）。
        if(Array.isArray(context.targets) && context.targets.length){
            ['image', 'video'].forEach(mediaType => {
                const candidates = routeTargets(mediaType, context.targets);
                if(candidates.length < 2) return;
                const generalCount = candidates.filter(target => {
                    const mapping = (node.targetMappings || []).find(item => item.connectionId === target.connectionId || item.targetNodeId === target.id);
                    return !mapping || !mapping.rowId;
                }).length;
                if(generalCount >= 2){
                    errors.push({code:'target.multi', field:'targetMappings',
                        message:`表格连接了 ${generalCount} 个${mediaType === 'video' ? '视频' : '图片'}生成节点，但未按行指定目标。请断开多余连接，或为每行明确指定唯一目标`});
                }
            });
        }
        if(node.mode === 'continuous'){
            const graph = topologicalLayers(node.rows.map(row => row.rowId), node.rows.flatMap(row => row.dependencies.map(dependency => ({from:dependency, to:row.rowId}))));
            graph.cycleIds.forEach(rowId => errors.push({code:'dependency.cycle', rowId, field:'dependencies', message:'连续依赖存在循环'}));
            const rangeIds = new Set(ranged.map(row => row.rowId));
            ranged.forEach(row => row.dependencies.forEach(dependency => {
                if(rangeIds.has(dependency)) return;
                const previous = node.rows.find(candidate => candidate.rowId === dependency);
                if(!previous || previous.status !== 'done' || !previous.output.updatedAt) errors.push({code:'dependency.unavailable', rowId:row.rowId, field:'dependencies', message:`${row.name}：范围外前序结果缺失或已过期`});
            }));
        }
        return {valid:errors.length === 0, errors, rows:ranged};
    }

    function executionPlan(matrix, context={}){
        const node = normalizeMatrixNode(matrix), validation = validateMatrix(node, context);
        if(!validation.valid) return {valid:false, errors:validation.errors, rows:[]};
        if(node.mode === 'batch') return {valid:true, errors:[], rows:validation.rows, layers:[validation.rows]};
        const selected = new Set(validation.rows.map(row => row.rowId));
        const edges = node.rows.flatMap(row => row.dependencies.filter(id => selected.has(id)).map(id => ({from:id, to:row.rowId})));
        const graph = topologicalLayers([...selected], edges), byId = new Map(node.rows.map(row => [row.rowId, row]));
        const layers = graph.layers.map(layer => layer.map(rowId => byId.get(rowId)).filter(Boolean));
        return {valid:true, errors:[], rows:layers.flat(), layers};
    }

    function uniqueRefs(refs){
        const seen = new Set();
        return (refs || []).map(ref => normalizeRef(ref)).filter(ref => {
            const key = `${ref.kind}:${ref.sourceNodeId}:${ref.id}:${ref.url}:${ref.value}`;
            if(seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function mappedUpstreamRefs(node, row, context={}){
        const refs = (context.upstreamRefs || []).map(ref => normalizeRef(ref));
        const mappings = node.sourceMappings || [];
        const buckets = {shared:[], row:[], previous:[], context:[]};
        refs.forEach(ref => {
            const matches = mappings.filter(mapping => {
                if(mapping.connectionId && ref.connectionId && mapping.connectionId !== ref.connectionId) return false;
                if(mapping.sourceNodeId && ref.sourceNodeId && mapping.sourceNodeId !== ref.sourceNodeId) return false;
                return !mapping.rowId || mapping.rowId === row.rowId;
            });
            if(!matches.length){
                if(['shared', 'row', 'previous', 'context'].includes(ref.purpose)) buckets[ref.purpose].push(ref);
                return;
            }
            matches.forEach(mapping => {
                if(mapping.purpose === 'unassigned') return;
                buckets[mapping.purpose].push({...ref, purpose:mapping.purpose, slot:mapping.slot, rowId:mapping.rowId || ''});
            });
        });
        Object.keys(buckets).forEach(key => { buckets[key] = uniqueRefs(buckets[key]); });
        return buckets;
    }

    // 多行多 target：某行有「按行指定」的目标映射时，只走这些特定目标；
    // 没有特定目标才回落到通用目标（rowId 为空）。避免一行同时派发到多个目标（每行拿到多个结果）。
    function rowTargetMappings(node, rowId){
        const mappings = (node.targetMappings || []);
        const specific = mappings.filter(mapping => mapping.rowId && mapping.rowId === rowId);
        if(specific.length) return specific;
        return mappings.filter(mapping => !mapping.rowId);
    }

    function buildRowPayload(matrix, rowId, context={}){
        const node = normalizeMatrixNode(matrix), row = node.rows.find(candidate => candidate.rowId === rowId);
        if(!row) throw new Error('步骤不存在');
        const dependencies = row.dependencies.map(id => node.rows.find(candidate => candidate.rowId === id)).filter(Boolean);
        const previousRefs = dependencies.flatMap(item => item.output.refs.map(ref => ({...ref, purpose:'previous'})));
        const previousText = dependencies.map(item => item.output.text).filter(Boolean).join('\n\n');
        const resolvedPrompt = resolveContinuousTokens(row.prompt, {text:previousText, image:previousRefs.find(ref => ref.kind === 'image')?.url || '', video:previousRefs.find(ref => ref.kind === 'video')?.url || ''}, node.globalContext);
        const mapped = mappedUpstreamRefs(node, row, context);
        const sharedRefs = uniqueRefs([...node.sharedReferences, ...mapped.shared]);
        const rowRefs = uniqueRefs([...row.references, ...mapped.row, ...mapped.context]);
        const dependencyRefs = uniqueRefs([...mapped.previous, ...previousRefs]);
        const mappedTexts = (context.upstreamTexts || []).filter(item => {
            const relevant = node.sourceMappings.filter(mapping => mapping.sourceNodeId === String(item?.sourceNodeId || '') && (!mapping.rowId || mapping.rowId === row.rowId));
            return !relevant.length || relevant.some(mapping => ['context', 'shared', 'row'].includes(mapping.purpose));
        }).map(item => String(item?.value || '')).filter(Boolean);
        const upstreamText = [context.upstreamText, ...mappedTexts].filter(Boolean).join('\n\n');
        return {
            rowId:row.rowId,
            type:row.type,
            prompt:[upstreamText, resolvedPrompt].filter(Boolean).join('\n\n'),
            refs:uniqueRefs([...sharedRefs, ...rowRefs, ...dependencyRefs]),
            referenceBuckets:{shared:sharedRefs, row:rowRefs, previous:dependencyRefs},
            mapping:{sources:node.sourceMappings, targets:rowTargetMappings(node, row.rowId)},
            overlay:row.overlay,
            dependencies:[...row.dependencies]
        };
    }

    function createMockRunner(handler){
        const calls = [];
        const runner = async payload => { const snapshot = JSON.parse(JSON.stringify(payload)); calls.push(snapshot); return handler ? handler(snapshot, calls.length - 1) : {text:`mock:${snapshot.rowId}`, refs:[]}; };
        runner.calls = calls;
        return runner;
    }

    async function executeMatrix(matrix, context={}, runner){
        if(typeof runner !== 'function') throw new Error('缺少任务 runner');
        const sourceMatrix = matrix && typeof matrix === 'object' ? matrix : {};
        sourceMatrix.stopRequested = false;
        let node = normalizeMatrixNode(matrix);
        const plan = executionPlan(node, context);
        if(!plan.valid) return {...node, validationErrors:plan.errors};
        const plannedIds = new Set(plan.rows.map(row => row.rowId));
        node.running = true;
        node.stopRequested = false;
        node.validationErrors = [];
        node.rows = node.rows.map(row => plannedIds.has(row.rowId) ? {...row, status:'queued', error:''} : row);
        const emit = () => { if(typeof context.onUpdate === 'function') context.onUpdate(node); };
        const stopped = () => Boolean(sourceMatrix.stopRequested || context.signal?.aborted || context.shouldStop?.());
        const stopQueued = message => {
            node.stopRequested = true;
            node.rows = node.rows.map(row => row.status === 'queued' ? {...row, status:'stopped', error:message} : row);
        };
        const runOne = async planned => {
            const rowId = planned.rowId;
            if(stopped()) return false;
            const before = node.rows.find(row => row.rowId === rowId);
            if(node.mode === 'continuous' && before?.status === 'done') node.rows = markDependentsStale(node.rows, rowId);
            node.rows = patchRowById(node.rows, rowId, {status:'running', error:''});
            emit();
            try {
                const result = await runner(buildRowPayload(node, rowId, context));
                const output = {text:String(result?.text || ''), refs:(result?.refs || []).map(ref => normalizeRef(ref)), updatedAt:Number(result?.updatedAt || Date.now())};
                const donePatch = {status:'done', output, resultText:output.text, resultRefs:output.refs};
                // Phase 2D：运行成功时落版本——lastRunRevision 追平本次 revision，resultVersion+1，executionId=run_id
                if(Number.isFinite(Number(result?.revision))) donePatch.lastRunRevision = Number(result.revision);
                if(result?.runId) donePatch.executionId = String(result.runId);
                if(result?.runId) donePatch.resultVersion = (Number(before?.resultVersion) || 0) + 1;
                node.rows = patchRowById(node.rows, rowId, donePatch);
                emit();
                return true;
            } catch(error){
                node.rows = patchRowById(node.rows, rowId, {status:'failed', error:error?.message || String(error)});
                emit();
                return false;
            }
        };
        if(node.mode === 'batch'){
            const concurrency = Math.max(1, Math.min(plan.rows.length || 1, Number(context.concurrency) || plan.rows.length || 1));
            let cursor = 0;
            const worker = async () => {
                while(cursor < plan.rows.length && !stopped()){
                    const current = plan.rows[cursor++];
                    await runOne(current);
                }
            };
            await Promise.all(Array.from({length:concurrency}, worker));
        } else {
            for(const planned of plan.rows){
                if(stopped()) break;
                const ok = await runOne(planned);
                if(!ok) break;
            }
        }
        if(stopped() || node.rows.some(row => row.status === 'queued')) stopQueued(stopped() ? '已按用户要求停止' : '前序步骤失败，未继续运行');
        node.running = false;
        emit();
        return node;
    }

    function topologicalLayers(nodeIds, connections){
        const ids = [...new Set((nodeIds || []).filter(Boolean))], allowed = new Set(ids), indegree = new Map(ids.map(id => [id, 0])), children = new Map(ids.map(id => [id, []]));
        (connections || []).forEach(connection => {
            if(!allowed.has(connection?.from) || !allowed.has(connection?.to) || connection.from === connection.to) return;
            const list = children.get(connection.from); if(list.includes(connection.to)) return;
            list.push(connection.to); indegree.set(connection.to, indegree.get(connection.to) + 1);
        });
        const layers = [], remaining = new Set(ids);
        while(remaining.size){
            const layer = ids.filter(id => remaining.has(id) && indegree.get(id) === 0); if(!layer.length) break;
            layers.push(layer); layer.forEach(id => { remaining.delete(id); children.get(id).forEach(child => indegree.set(child, indegree.get(child) - 1)); });
        }
        return {layers, cycleIds:ids.filter(id => remaining.has(id))};
    }

    function resolveContinuousTokens(value, previous={}, shared={}){
        const tokens = {'{{上一行文字}}':previous.text || '', '{{上一行图片}}':previous.image || '', '{{上一行视频}}':previous.video || '', '{{商品参考}}':shared.productReference || '', '{{配色}}':shared.palette || '', '{{字体}}':shared.font || '', '{{内容大纲}}':shared.outline || ''};
        return Object.entries(tokens).reduce((output, [token, replacement]) => output.split(token).join(String(replacement || '')), String(value || ''));
    }

    function continuousSnapshot(globalContext={}, previousOutputs={}){ return {globalContext:{...(globalContext || {})}, previousOutputs:{text:String(previousOutputs?.text || ''), image:String(previousOutputs?.image || ''), video:String(previousOutputs?.video || '')}}; }

    function flattenRelayConnections(nodeIds, connections, relayIds){
        const allowed = new Set(nodeIds || []), relays = new Set(relayIds || []), edges = [];
        (connections || []).forEach(connection => {
            if(allowed.has(connection?.from) && allowed.has(connection?.to)) edges.push({from:connection.from, to:connection.to});
            if(!allowed.has(connection?.from) || !relays.has(connection?.to)) return;
            (connections || []).filter(next => next.from === connection.to && allowed.has(next.to)).forEach(next => edges.push({from:connection.from, to:next.to}));
        });
        return edges.filter((edge, index) => edges.findIndex(item => item.from === edge.from && item.to === edge.to) === index);
    }

    function parseCsvRows(text){
        const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim()); if(!lines.length) return [];
        const parseLine = line => { const values = []; let value = '', quoted = false; for(let i = 0; i < line.length; i++){ const char = line[i]; if(char === '"' && quoted && line[i + 1] === '"'){ value += '"'; i++; } else if(char === '"') quoted = !quoted; else if(char === ',' && !quoted){ values.push(value); value = ''; } else value += char; } values.push(value); return values; };
        const rows = lines.map(parseLine), header = rows[0].map(value => value.trim().toLowerCase()), hasHeader = header.some(value => ['task','prompt','任务','提示词','step','步骤','type','类型'].includes(value));
        const indexOf = choices => header.findIndex(value => choices.includes(value));
        const promptIndex = Math.max(0, indexOf(['task','prompt','任务','提示词'])), nameIndex = indexOf(['step','name','步骤','名称']), overlayIndex = indexOf(['overlay','文字叠加']), typeIndex = indexOf(['type','类型','输出类型']);
        return rows.slice(hasHeader ? 1 : 0).map((values, index) => normalizeMatrixRow({prompt:String(values[promptIndex] || '').trim(), name:nameIndex >= 0 ? String(values[nameIndex] || '').trim() : `步骤 ${index + 1}`, overlay:overlayIndex >= 0 ? String(values[overlayIndex] || '').trim() : '', type:typeIndex >= 0 && /video|视频/i.test(values[typeIndex]) ? 'video' : 'image'}, index));
    }

    function verticalStitchLayout(items, commonWidth, gap=0){
        const width = Math.max(1, Math.round(Number(commonWidth) || 1));
        const normalized = (items || []).map(item => { const sourceWidth = Math.max(1, Number(item?.width) || width), sourceHeight = Math.max(1, Number(item?.height) || 1); return {...item, drawWidth:width, drawHeight:Math.max(1, Math.round(sourceHeight * width / sourceWidth))}; });
        let y = 0; const placements = normalized.map((item, index) => { const placed = {...item, x:0, y}; y += item.drawHeight + (index < normalized.length - 1 ? Math.max(0, Number(gap) || 0) : 0); return placed; });
        return {width, height:y, placements};
    }

    function overlayTextLines(text, maxWidth, measure, maxLines=4){
        const chars = Array.from(String(text || '').trim()), lines = []; let line = '';
        chars.forEach(char => { const next = line + char; if(line && measure(next) > maxWidth){ if(lines.length < maxLines) lines.push(line); line = char; } else line = next; });
        if(line && lines.length < maxLines) lines.push(line); return lines;
    }

    return {MATRIX_VERSION, MATRIX_TYPES, MATRIX_STATUSES, MATRIX_NODE_TYPE, LEGACY_MATRIX_NODE_TYPES, EXECUTION_INPUT_KEYS, isExecutionField, computeRowExecutionSignature, markRowChangedIfExecutionInputsDiffer, buildRowExecutionContext, buildExecutionSnapshotDTO, extractModelParams, extractExecutionModelParams, extractGlobalReferences, rowsConsumingTarget, captureRowExecutionSignatures, markRowsChangedSince, markRowsAndDependentsStale, rowIsStale, isMatrixNode, migrateMatrixNode, createMatrixTargetLock, matrixTaskId, matrixOwnedRefs, matrixRowId, normalizeRef, normalizeOverlay, normalizeMatrixRow, normalizeMatrixNode, normalizeConnectionMapping, rowResult, patchRow, patchRowById, dependentRowIds, markDependentsStale, markFollowingRowsStale, patchRowAndMarkDependents, mergeRowsWithoutOverwrite, routeTargets, rangeRows, validateMatrix, executionPlan, uniqueRefs, mappedUpstreamRefs, rowTargetMappings, buildRowPayload, createMockRunner, executeMatrix, topologicalLayers, resolveContinuousTokens, continuousSnapshot, flattenRelayConnections, parseCsvRows, verticalStitchLayout, overlayTextLines};
});
