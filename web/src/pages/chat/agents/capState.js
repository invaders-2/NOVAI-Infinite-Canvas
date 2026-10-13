// 能力（智能体 / 技能）在对话页的共享状态：广场视图开关、已挂载到输入框的能力、列表缓存与参数 schema 懒加载。
// 组件（Composer / CapabilitySquare / MessageItem）都读这里的同一份状态，不各存一套。
import { reactive } from 'vue';
import { listCapabilities, getCapability, paramsOf } from './capabilityApi.js';

export const CAP = reactive({
    list: [],
    loaded: false,
    loading: false,
    error: '',
    square: '',          // '' | 'agent' | 'skill' —— 正文区的广场视图
    selected: null,      // 已挂到输入框的能力（列表项对象，含 params / input_schema）
});

export function kindTitle(kind) { return kind === 'skill' ? '全部技能' : '全部智能体'; }
export function kindUnit(kind) { return kind === 'skill' ? '技能' : '智能体'; }
export function searchPlaceholder(kind) {
    return kind === 'skill' ? '请输入想搜索的技能名称/描述' : '请输入想搜索的智能体名称/描述';
}

export function agentById(id) {
    const key = String(id || '');
    return CAP.list.find(c => c.id === key) || null;
}
export function agentName(id, fallback) {
    const c = agentById(id);
    return (c && c.name) || String(fallback || '') || String(id || '能力');
}
export function agentIcon(id) {
    const c = agentById(id);
    return (c && c.icon) || '';
}

export async function loadCapabilities(force) {
    if (CAP.loading) return CAP.list;
    if (CAP.loaded && !force) return CAP.list;
    CAP.loading = true;
    CAP.error = '';
    const res = await listCapabilities();
    CAP.loading = false;
    if (!res.ok) { CAP.error = res.error || '能力列表加载失败'; return CAP.list; }
    CAP.list = res.capabilities;
    CAP.loaded = true;
    CAP.error = '';
    return CAP.list;
}

export function openSquare(kind) {
    CAP.square = kind === 'skill' ? 'skill' : 'agent';
    loadCapabilities();
}
export function closeSquare() { CAP.square = ''; }

// 选中 = 挂到输入框（chip）；同时收起广场，输入框仍在底部
export function selectCapability(cap) {
    if (!cap || !cap.id) return;
    CAP.selected = Object.assign({}, cap, { params: {} });
    initParams(CAP.selected);
    CAP.square = '';
    if (!CAP.selected.input_schema) ensureSchema(CAP.selected);
}
export function clearCapability() { CAP.selected = null; }

export function paramListOf(cap) {
    return paramsOf(cap && cap.input_schema);
}
export function initParams(cap) {
    if (!cap) return;
    const fields = paramsOf(cap.input_schema);
    fields.forEach(f => { if (cap.params[f.name] == null) cap.params[f.name] = f.def; });
}

// 广场列表项不含 input_schema，参数弹层第一次打开时才拉详情（失败给可读提示，不阻塞发送）
export async function ensureSchema(cap) {
    if (!cap || cap.input_schema || cap.schemaLoading) return;
    cap.schemaLoading = true;
    cap.schemaError = '';
    const res = await getCapability(cap.id);
    cap.schemaLoading = false;
    if (!res.ok) { cap.schemaError = res.error || '参数加载失败'; return; }
    cap.input_schema = res.capability.input_schema;
    initParams(cap);
}

export function hasParamValues(cap) {
    if (!cap || !cap.params) return false;
    return Object.keys(cap.params).some(k => {
        const v = cap.params[k];
        return v !== '' && v !== null && v !== undefined && v !== false;
    });
}
