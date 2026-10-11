// 在线生图的平台 / 模型解析（移植自 static/online.html：imageProviders / providerModels / runningHubEntries /
// providerProtocol / updateAdaptivePanel 的协议判断）。纯函数：传入 /api/config 的 api_providers 与默认模型。

export const PROTOCOL_BADGE = {
    api: ['online.modeApi', 'API 生图'], apimart: ['online.modeApi', 'API 生图'], modelscope: ['online.modeModelscope', 'ModelScope'],
    runninghub: ['online.modeRunningHub', 'RunningHub'], jimeng: ['online.modeJimeng', '即梦'],
    volcengine: ['online.modeVolcengine', '火山引擎'], gemini: ['online.modeGemini', 'Gemini'],
};
// 仅 OpenAI / APIMart（gpt-image 系）后端会消费 quality；其它协议隐藏
export const QUALITY_PROTOCOLS = new Set(['api', 'apimart']);

export function uniqueModels(list) {
    const seen = new Set();
    return (list || []).map(item => String(item || '').trim()).filter(item => item && !seen.has(item) && seen.add(item));
}

export function imageProviders(apiProviders, models) {
    const list = (apiProviders || []).filter(p => p.enabled !== false && (
        (p.image_models || []).length || (p.rh_apps || []).length || (p.rh_workflows || []).length
    ));
    return list.length ? list : [{ id: 'comfly', name: 'Comfly', image_models: [models.gpt, models.nano] }];
}

export function providerById(apiProviders, models, id) {
    const list = imageProviders(apiProviders, models);
    return list.find(p => p.id === id) || list[0];
}

export function providerModels(apiProviders, models, id) {
    const p = providerById(apiProviders, models, id);
    return uniqueModels((p && p.image_models) || [models.gpt]);
}

export function protocolOf(p) {
    p = p || {};
    const proto = String(p.protocol || '').toLowerCase();
    const pid = String(p.id || '').toLowerCase();
    const base = String(p.base_url || '').toLowerCase();
    if (proto === 'modelscope' || pid === 'modelscope') return 'modelscope';
    if (proto === 'runninghub' || pid === 'runninghub') return 'runninghub';
    if (proto === 'jimeng' || pid === 'jimeng') return 'jimeng';
    if (proto === 'volcengine' || pid === 'volcengine') return 'volcengine';
    if (proto === 'gemini') return 'gemini';
    if (proto === 'apimart' || base.includes('apimart.ai')) return 'apimart';
    return 'api';
}

/* RunningHub：同一平台下同步模型 API / 工作流 / AI 应用。
 * 模型 API 直接提交原始模型名；value=app:ID / workflow:ID 走 RH 应用/工作流路径。 */
function runningHubEntryId(entry, kind) {
    if (!entry || typeof entry !== 'object') return '';
    const raw = kind === 'model' ? (entry.model || entry.id || entry.name)
        : kind === 'workflow' ? (entry.workflowId || entry.id)
            : (entry.appId || entry.webappId || entry.id);
    return String(raw || '').trim();
}
export function runningHubEntries(p) {
    p = p || {};
    const collect = (list, kind) => (list || [])
        .filter(e => e && e.enabled !== false && e.hidden !== true)
        .map(e => ({ kind, id: runningHubEntryId(e, kind), title: String(e.title || e.note || '').trim() }))
        .filter(e => e.id);
    const modelEntries = uniqueModels(p.image_models || []).map(model => ({ kind: 'model', id: model, title: model }));
    return [...modelEntries, ...collect(p.rh_workflows, 'workflow'), ...collect(p.rh_apps, 'app')];
}
export function entryKey(e) { return e.kind === 'model' ? e.id : `${e.kind}:${e.id}`; }

// 从 /api/config 推默认模型（与旧 initModels 相同）
export function modelsFromConfig(cfg) {
    const imageModels = (cfg && cfg.image_models) || [];
    return {
        nano: imageModels.find(m => m.toLowerCase().includes('nano')) || 'nano-banana-pro',
        gpt: imageModels.find(m => !m.toLowerCase().includes('nano')) || (cfg && cfg.image_model) || 'gpt-image-2',
    };
}
