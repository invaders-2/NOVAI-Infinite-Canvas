(function(root, factory){
    const api = factory();
    if(typeof module === 'object' && module.exports) module.exports = api;
    if(root) root.NovaWorkflowUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    // 本模块原为「矩阵 / 多维表格」的共享语义层（行模型、执行签名、revision、
    // 依赖 DAG、CSV 导入、长图拼接等，约 700 行）。旧的矩阵表格实现已整体移除，
    // 此处只保留两个**通用图算法**——分组一键运行（runCanvasGroup）仍在用它们，
    // 与表格无关。新的多维表格将按 DX OS 规范另行实现。
    //
    // 保留：topologicalLayers（拓扑分层 + 环检测）
    //       flattenRelayConnections（穿透转接点展开边）
    // 已移除：MATRIX_* 常量、normalizeMatrixRow/Node、validateMatrix、executeMatrix、
    //         buildRowPayload、revision/执行签名、patchRow*、CSV 解析、拼接排版等。

    /** 按依赖分层；返回 {layers, cycleIds}（cycleIds 非空表示存在环）。 */
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

    /** 把经过「转接点」(relay) 的间接边展开为直接边，并按 from/to 去重。 */
    function flattenRelayConnections(nodeIds, connections, relayIds){
        const allowed = new Set(nodeIds || []), relays = new Set(relayIds || []), edges = [];
        (connections || []).forEach(connection => {
            if(allowed.has(connection?.from) && allowed.has(connection?.to)) edges.push({from:connection.from, to:connection.to});
            if(!allowed.has(connection?.from) || !relays.has(connection?.to)) return;
            (connections || []).filter(next => next.from === connection.to && allowed.has(next.to)).forEach(next => edges.push({from:connection.from, to:next.to}));
        });
        return edges.filter((edge, index) => edges.findIndex(item => item.from === edge.from && item.to === edge.to) === index);
    }

    return {topologicalLayers, flattenRelayConnections};
});