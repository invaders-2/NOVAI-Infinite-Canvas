// 能力（智能体 / 技能）在对话页的共享状态：广场视图开关、已挂载到输入框的能力、列表缓存与参数 schema 懒加载。
// 组件（Composer / CapabilitySquare / MessageItem）都读这里的同一份状态，不各存一套。
import { reactive } from 'vue';
import { listCapabilities, getCapability, paramsOf, listSuggestions } from './capabilityApi.js';

export const CAP = reactive({
    list: [],
    loaded: false,
    loading: false,
    error: '',
    square: '',          // '' | 'agent' | 'skill' —— 正文区的广场视图
    panel: '',           // '' | 'skill' —— 输入框下方的技能面板（空状态入口）
    selected: null,      // 已挂到输入框的能力（列表项对象，含 params / input_schema）
    suggestions: [],     // 猜你想问（后端下发，可配置）
    suggestLoaded: false,
    suggestLoading: false,
});

export function kindTitle(kind) { return kind === 'skill' ? '全部技能' : '全部智能体'; }
export function kindUnit(kind) { return kind === 'skill' ? '技能' : '智能体'; }
export function searchPlaceholder(kind) {
    return kind === 'skill' ? '请输入想搜索的技能名称/描述' : '请输入想搜索的智能体名称/描述';
}

/* ───────── 选中能力后的输入区（提示模板 / 必填 / 上传类型 / 教程） ───────── */

// input_schema.files 是独立的文件输入声明（paramsOf 只取 params，文件不走参数弹层）
export function inputFilesOf(cap) {
    const files = cap && cap.input_schema && cap.input_schema.files;
    return Array.isArray(files) ? files.filter(f => f && typeof f === 'object') : [];
}
// [上传表格] 的 accept：取该能力声明的文件类型并集，声明为空时不限制
export function acceptOf(cap) {
    const out = [];
    inputFilesOf(cap).forEach(f => {
        const list = Array.isArray(f.accept) ? f.accept : (f.accept ? [f.accept] : []);
        list.forEach(x => { const v = String(x == null ? '' : x).trim(); if (v && out.indexOf(v) < 0) out.push(v); });
    });
    return out.join(',');
}
export function hasRequiredInput(cap) {
    if (inputFilesOf(cap).some(f => f.required === true)) return true;
    return paramListOf(cap).some(p => p.required === true);
}
// 提示模板文案：全部来自能力定义，按「用法说明 → 文件声明 → 参数说明 → 简介 → skill_prompt 摘要」取，不写死
export function promptTemplateOf(cap) {
    if (!cap) return '';
    const usage = String(cap.usage_instruction || '').trim();
    if (usage) return usage;
    const files = inputFilesOf(cap);
    const file = files.find(f => f.required === true) || files[0];
    if (file) {
        const label = String(file.label || file.name || '').trim();
        const desc = String(file.description || '').trim();
        if (label && desc) return label + '：' + desc;
        if (desc) return desc;
        if (label) return label;
    }
    const params = paramListOf(cap);
    const param = params.find(p => p.required === true) || params[0];
    if (param) {
        const t = String(param.hint || '').trim() || String(param.label || '').trim();
        if (t) return t;
    }
    const desc = String(cap.description || '').trim();
    if (desc) return desc;
    return skillPromptSummary(cap.skill_prompt);
}
// skill_prompt 里第一条正文（跳过标题行/列表标记），只做兜底，不整段展示
function skillPromptSummary(raw) {
    const lines = String(raw || '').split('\n').map(s => s.trim()).filter(Boolean);
    return lines.find(l => !/^[#\-*]/.test(l) && !/^本期运行形态/.test(l)) || '';
}
// [查看教程] 只在能力带结构完整的教程时出现（数据源 server/agents/tutorials.json）；
// 后端没声明教程的能力返回 null —— 按钮不显示，这是刻意设计
export function tutorialOf(cap) {
    const t = cap && cap.tutorial;
    if (!t || typeof t !== 'object') return null;
    const title = String(t.title || '').trim();
    const steps = (Array.isArray(t.steps) ? t.steps : []).filter(s => s && String(s.text || '').trim());
    return title && steps.length ? { title: title, steps: steps } : null;
}

/* ───────── 技能分类（与 /api/capabilities 的 skill 部分对应） ───────── */

export const SKILL_TYPES = ['system', 'mine', 'subscribe'];
export function skillTypeOf(skill) {
    const t = String((skill && (skill.skill_type || skill.skillType)) || '').toLowerCase();
    return SKILL_TYPES.indexOf(t) >= 0 ? t : 'system';
}
export function skillTypeLabel(type) {
    if (type === 'mine') return '我的技能';
    if (type === 'subscribe') return '订阅技能';
    return '系统技能';
}
export function skillUsageOf(skill) {
    const raw = skill && (skill.usage_count != null ? skill.usage_count
        : (skill.usageCount != null ? skill.usageCount : skill.current_user_usage_count));
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
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
    CAP.panel = '';
    loadCapabilities();
}
export function closeSquare() { CAP.square = ''; }
export function closePanel() { CAP.panel = ''; }
// 空状态（未挂载能力）下由「技能」入口展开：在输入框下方显示完整技能面板
export function toggleSkillPanel() {
    const next = CAP.panel === 'skill' ? '' : 'skill';
    CAP.panel = next;
    if (next) { CAP.square = ''; loadCapabilities(); }
}

// 选中 = 挂到输入框（chip）；同时收起广场 / 技能面板，输入框仍在底部
export function selectCapability(cap) {
    if (!cap || !cap.id) return;
    CAP.selected = Object.assign({}, cap, { params: {} });
    initParams(CAP.selected);
    CAP.square = '';
    CAP.panel = '';
    if (!CAP.selected.input_schema) ensureSchema(CAP.selected);
}
export function clearCapability() { CAP.selected = null; }

/* ───────── capability 描述符（sealseek 形态）与 AI 生图挂载 ───────── */

// AI 生图不是一个目录能力：用同一套「挂到输入框」机制承载，type=generate-image
export const GEN_IMAGE_CAP = {
    id: 'generate-image', kind: 'generate-image', name: 'AI生图', icon: 'image',
    description: '直接用一句话生成商品图片', available: true, enabled: true,
    input_schema: { files: [], params: [] }, params: {}, card_type: 3,
};

export function isGenerateImage(cap) { return !!cap && String(cap.kind || cap.type || '') === 'generate-image'; }

// 已挂载的能力 → 随请求发送的 capability 描述符（字段名对齐 sealseek：type/agentId/skillCode/cardType）
export function descriptorOf(cap) {
    if (!cap) return null;
    const kind = String(cap.kind || cap.type || '');
    if (kind === 'generate-image') {
        return { type: 'generate-image', cardType: Number(cap.card_type || cap.cardType) || 0 };
    }
    if (kind === 'skill') {
        return { type: 'skill', capabilityId: String(cap.id || ''),
                 skillCode: String(cap.source_skill_code || ''), skillName: String(cap.name || '') };
    }
    return { type: 'agent', capabilityId: String(cap.id || ''),
             agentId: Number(cap.source_agent_id || 0) || 0, name: String(cap.name || '') };
}

export function selectGenerateImage(cardType) {
    CAP.selected = Object.assign({}, GEN_IMAGE_CAP, { card_type: Number(cardType) || 3, params: {} });
    CAP.square = '';
    CAP.panel = '';
}

/* ───────── 能力生图的模型选择（用户选哪个平台的哪个生图模型跑这次能力） ───────── */

// 判定依据与后端 openclaw_capability._wants_generated_image 对齐：
// 交付物含 image，或用户显式填了 image_prompt；params.generate_image === false 一票否决。
// 只有这类能力才在输入框顶部显示「生图模型」，避免给不生图的能力加无效控件。
export function wantsGeneratedImage(cap) {
    if (!cap) return false;
    const params = cap.params || {};
    if (params.generate_image === false) return false;
    if (String(params.image_prompt || '').trim()) return true;
    return (cap.deliverables || []).some(d => String((d && d.kind) || '').toLowerCase() === 'image');
}

// 选择本身（GEN_IMAGE / 跨刷新持久化 / 失效回退）在 ./genImageState.js

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
    const detail = res.capability;
    cap.input_schema = detail.input_schema;
    if (detail.usage_instruction) cap.usage_instruction = detail.usage_instruction;
    if (detail.tutorial) cap.tutorial = detail.tutorial;
    initParams(cap);
}

/* ───────── 猜你想问（后端下发，可配置） ───────── */

export function capabilityForSuggestion(s) {
    const cid = s && s.capability && s.capability.capabilityId;
    if (!cid) return null;
    return CAP.list.find(c => c.id === cid) || null;
}
export async function loadSuggestions(force) {
    if (CAP.suggestLoading) return CAP.suggestions;
    if (CAP.suggestLoaded && !force) return CAP.suggestions;
    CAP.suggestLoading = true;
    const res = await listSuggestions();
    CAP.suggestLoading = false;
    if (!res.ok) { CAP.suggestions = []; return CAP.suggestions; }
    CAP.suggestions = res.suggestions;
    CAP.suggestLoaded = true;
    return CAP.suggestions;
}

export function hasParamValues(cap) {
    if (!cap || !cap.params) return false;
    return Object.keys(cap.params).some(k => {
        const v = cap.params[k];
        return v !== '' && v !== null && v !== undefined && v !== false;
    });
}
