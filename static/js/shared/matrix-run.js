/**
 * Phase 2C：Run 层（Task Engine 之上的编排层）
 *
 * 这不是第二套 Task Engine。任务仍然由后端 Task Engine 执行，这里只负责：
 *   1. 一次表格运行 = 一个 Run，一行 = 一个 RowRun；
 *   2. 派发任务时把 run_id / row_id / row_revision / table_node_id / target_node_id
 *      作为 run_context 交给后端，后端会把同样的归属盖到每个产物上（result.refs）；
 *   3. 收结果时用 ownedRefs() 直接按 run_id + row_id 取——确定性归属，
 *      不再用「执行前 URL 集合差集」去猜。
 *
 * legacy fallback：如果任务结果没有 refs（老任务 / 未走 Run 链路 / 后端未升级），
 * 才回落到 URL 差集。新链路一律走 ownedRefs。
 */
(function(root, factory){
    const api = factory(typeof globalThis !== 'undefined' ? globalThis.NovaWorkflowUtils : null);
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.NovaMatrixRun = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(NovaWorkflowUtils){

    const RUN_STATUSES = ['draft', 'queued', 'running', 'done', 'partial', 'failed', 'blocked', 'stale', 'canceling', 'stopped'];
    const RUN_STATUS_ALIASES = {idle:'draft', success:'done', canceled:'stopped', cancelled:'stopped'};
    const ROW_RUN_STATUSES = ['draft', 'ready', 'queued', 'running', 'done', 'failed', 'blocked', 'stale', 'canceling', 'stopped'];
    const ROW_RUN_STATUS_ALIASES = {idle:'draft', success:'done', canceled:'stopped', cancelled:'stopped'};
    const RUN_TERMINAL = ['done', 'partial', 'failed', 'blocked', 'stopped'];
    const RUN_MODES = ['batch', 'continuous'];
    const ATTRIBUTION_FIELDS = ['run_id', 'row_run_id', 'row_id', 'row_revision', 'canvas_id', 'table_node_id', 'target_node_id', 'task_id'];

    let runSequence = 0;

    function normalizeStatus(value, aliases){
        const raw = String(value || '').trim().toLowerCase();
        return (aliases || {})[raw] || raw;
    }

    function safeId(value){ return String(value || '').replace(/[^a-zA-Z0-9_-]/g, ''); }

    function newRunId(){
        runSequence += 1;
        return `run_${Date.now().toString(36)}_${runSequence}_${Math.random().toString(16).slice(2, 10)}`;
    }

    function newRowRunId(runId, rowId){
        runSequence += 1;
        return `rr_${safeId(runId)}_${safeId(rowId)}_${Date.now().toString(36)}_${runSequence}`;
    }

    /**
     * Execution Snapshot：启动即冻结。
     * 冻结后编辑表格（改 prompt / 改参考图 / 改目标节点）都不会影响已经在跑的任务。
     */
    function buildExecutionSnapshot({rowId='', rowRevision=1, payload=null, target=null,
                                     model='', providerId='', params=null, targetNodeId=''} = {}){
        const source = payload && typeof payload === 'object' ? payload : {};
        return Object.freeze({
            row_id:String(rowId || ''),
            row_revision:Number(rowRevision || 1),
            prompt:String(source.prompt || ''),
            references:(Array.isArray(source.refs) ? source.refs : []).map(ref => ({...ref})),
            dependencies:(Array.isArray(source.dependencies) ? source.dependencies : []).map(String),
            target_node_id:String(targetNodeId || target?.id || ''),
            model:String(model || source.model || ''),
            provider_id:String(providerId || source.provider_id || ''),
            params:Object.assign({}, params || source.params || {}),
            mapping:Object.assign({}, source.mapping || {})
        });
    }

    function createRowRun(rowId, options={}){
        return {
            row_run_id:String(options.rowRunId || ''),
            run_id:String(options.runId || ''),
            row_id:String(rowId || ''),
            row_revision:Number(options.rowRevision || 1),
            status:'queued',
            target_node_id:String(options.targetNodeId || ''),
            task_id:'',
            error:'',
            result_refs:[],
            snapshot:options.snapshot || null,
            created_at:Date.now() / 1000,
            started_at:null,
            finished_at:null
        };
    }

    /**
     * 创建一个 Run。selectedRowIds 决定本次执行范围——范围必须是稳定 rowId，
     * 绝不能用行号（行号会因插入/删除/排序而变化）。
     */
    function createRun({tableNodeId='', canvasId='', mode='batch', selectedRowIds=null, rows=null, runId=null} = {}){
        const selected = (Array.isArray(selectedRowIds) ? selectedRowIds : (Array.isArray(rows) ? rows : []))
            .map(id => String((id && id.rowId) || id || '')).filter(Boolean);
        const runIdFinal = String(runId || newRunId());
        return {
            run_id:runIdFinal,
            table_node_id:String(tableNodeId || ''),
            canvas_id:String(canvasId || ''),
            mode:RUN_MODES.includes(mode) ? mode : 'batch',
            selected_row_ids:selected,
            status:'draft',
            created_at:Date.now() / 1000,
            started_at:null,
            finished_at:null,
            cancel_requested_at:null,
            row_runs:selected.map(rowId => createRowRun(rowId, {runId:runIdFinal, rowRunId:newRowRunId(runIdFinal, rowId)})),
            child_task_ids:[]
        };
    }

    function rowRun(run, rowId){
        if(!run || !Array.isArray(run.row_runs)) return null;
        const key = String(rowId || '');
        return run.row_runs.find(item => String(item.row_id) === key) || null;
    }

    /** child_task_ids 永远是 row_runs 里 task_id 的投影，避免两处真相。 */
    function syncChildTaskIds(run){
        if(!run) return [];
        const seen = new Set(), out = [];
        (run.row_runs || []).forEach(rr => {
            const tid = String(rr.task_id || '');
            if(tid && !seen.has(tid)){ seen.add(tid); out.push(tid); }
        });
        run.child_task_ids = out;
        return out;
    }

    /** 派发任务时挂到请求体上的归属上下文（后端会存进 task.run_context）。 */
    function runContextFor(run, rowRunOrRowId){
        const rr = (rowRunOrRowId && typeof rowRunOrRowId === 'object')
            ? rowRunOrRowId
            : rowRun(run, rowRunOrRowId);
        return {
            run_id:safeId(run?.run_id),
            row_run_id:safeId(rr?.row_run_id || ''),
            row_id:safeId(rr?.row_id || rowRunOrRowId),
            row_revision:Number(rr?.row_revision || 1),
            canvas_id:safeId(run?.canvas_id || ''),
            table_node_id:safeId(run?.table_node_id),
            target_node_id:safeId(rr?.target_node_id)
        };
    }

    /**
     * 确定性归属：只取「本 run 的这一行」的产物。
     * 新链路唯一的结果读取方式。result.refs 由后端 stamp_result() 生成。
     */
    function ownedRefs(result, runId, rowId){
        if(!result || typeof result !== 'object' || !Array.isArray(result.refs)) return [];
        const rid = safeId(runId), rwid = safeId(rowId);
        return result.refs
            .filter(ref => ref && ref.url && String(ref.run_id || '') === rid && String(ref.row_id || '') === rwid)
            .map(ref => ({...ref}));
    }

    /**
     * legacy fallback：结果没有 refs（老任务 / 未走 Run 链路）时才用 URL 差集。
     * 新链路不应走到这里——走到说明后端没盖章或任务不是 Run 派发的。
     */
    function fallbackOwnedRefs(allRefs, beforeUrls, expectedType, attribution){
        const before = beforeUrls instanceof Set ? beforeUrls : new Set((beforeUrls || []).map(String));
        return (allRefs || [])
            .filter(ref => ref && ref.url && !before.has(ref.url))
            .map(ref => ({...ref, ...(attribution || {})}))
            .filter(ref => !expectedType || ref.kind === expectedType);
    }

    /**
     * 收结果：先走确定性归属，拿不到才回落差集，并标记 usedFallback 便于观测。
     */
    function collectRowRefs({result=null, run=null, rowId='', allRefs=null, beforeUrls=null,
                             expectedType='', attribution=null} = {}){
        const owned = ownedRefs(result, run?.run_id, rowId);
        if(owned.length) return {refs:owned, usedFallback:false};
        return {
            refs:fallbackOwnedRefs(allRefs, beforeUrls, expectedType, {
                run_id:safeId(run?.run_id), row_id:safeId(rowId), ...(attribution || {})
            }),
            usedFallback:true
        };
    }

    function patchRowRun(run, rowId, patch){
        const rr = rowRun(run, rowId);
        if(!rr) return run;
        Object.assign(rr, patch || {});
        if(patch && patch.status) rr.status = normalizeStatus(patch.status, ROW_RUN_STATUS_ALIASES);
        if(['done', 'failed', 'stopped', 'canceling'].includes(rr.status) && !rr.finished_at){
            rr.finished_at = Date.now() / 1000;
        }
        syncChildTaskIds(run);
        return run;
    }

    function setRunStatus(run, status){
        if(!run) return run;
        run.status = normalizeStatus(status, RUN_STATUS_ALIASES);
        if(run.status === 'running' && !run.started_at) run.started_at = Date.now() / 1000;
        if(RUN_TERMINAL.includes(run.status) && !run.finished_at) run.finished_at = Date.now() / 1000;
        return run;
    }

    /**
     * 落盘用的紧凑版本。snapshot 与完整 refs 不进画布 JSON——
     * 它们只在运行期有意义，全量存会让画布文件迅速膨胀。
     */
    function serializeRun(run){
        if(!run) return null;
        return {
            run_id:run.run_id,
            table_node_id:run.table_node_id,
            canvas_id:run.canvas_id,
            mode:run.mode,
            selected_row_ids:(run.selected_row_ids || []).slice(),
            status:run.status,
            created_at:run.created_at,
            started_at:run.started_at,
            finished_at:run.finished_at,
            cancel_requested_at:run.cancel_requested_at,
            child_task_ids:(run.child_task_ids || []).slice(),
            row_runs:(run.row_runs || []).map(rr => ({
                row_run_id:rr.row_run_id,
                run_id:rr.run_id,
                row_id:rr.row_id,
                row_revision:rr.row_revision,
                status:rr.status,
                target_node_id:rr.target_node_id,
                task_id:rr.task_id,
                error:rr.error,
                created_at:rr.created_at,
                result_refs:(rr.result_refs || []).map(ref => ({
                    url:ref.url, kind:ref.kind || '', task_id:ref.task_id || rr.task_id || ''
                }))
            }))
        };
    }

    /** 从 Run 汇总出表格行状态（供前端渲染），不覆盖 Run 自身数据。 */
    function rowStatusMap(run){
        const out = {};
        (run?.row_runs || []).forEach(rr => { out[String(rr.row_id)] = rr.status; });
        return out;
    }

    return {
        RUN_STATUSES, RUN_STATUS_ALIASES, ROW_RUN_STATUSES, ROW_RUN_STATUS_ALIASES,
        RUN_TERMINAL, RUN_MODES, ATTRIBUTION_FIELDS,
        normalizeStatus, safeId, newRunId, newRowRunId,
        buildExecutionSnapshot, createRowRun, createRun, rowRun, syncChildTaskIds,
        runContextFor, ownedRefs, fallbackOwnedRefs, collectRowRefs,
        patchRowRun, setRunStatus, rowStatusMap, serializeRun
    };
});
