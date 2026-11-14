<script setup>
// 首页（2026-11 重做）：标题打字机 → 输入框（参考素材 / 技能 / 插件 / 素材库）→ 快速开始 → 模板库（点卡片先预览）。
// 建画布与种子协议沿用旧 home.html：POST /api/canvases 建空白画布，再把种子写进 localStorage
// （novai_canvas_seed:<画布 id>），画布侧读一次即删。改种子字段要同步智能画布的种子翻译（canvas-next）。
// 首页所有入口（输入框发送 / 快速开始 / 模板 / 最近项目）都进「智能画布」（kind=classic → /static/canvas.html）：
// 种子规格两边一致，由画布侧翻译成节点；旧智能画布（/static/smart-canvas.html）只剩历史画布与外链在用。
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import VendorLogo from '../../components/VendorLogo.vue';
import NvVeilBg from '../../components/NvVeilBg.vue';
import EffortSlider from '../../components/EffortSlider.vue';
import { state, toast } from '../../lib/store.js';
import { openCanvasUrl, navigate } from '../../lib/bridge.js';
import { CATS, TEMPLATES, TEMPLATE_MAP, SEED_PREFIX } from './templates.js';
import TemplatePreview from './TemplatePreview.vue';
import { ICONS } from '../../lib/icons.js';

/* ───────── 标题：逐字打出 → 停顿 → 逐字删除 → 下一句 ───────── */
const LINES = ['今天想创作点什么？', '给新品做一套电商主图？', '把一句剧情变成分镜？', '让产品图动起来？', '给角色做一套三视图？'];
const typed = ref(LINES[0]);
const typing = ref(false);
let ttTimer = null;
function startTypewriter() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let li = 0, ci = LINES[0].length, del = true;
    const step = () => {
        const full = LINES[li];
        if (state.active !== 'home' || document.hidden) { ttTimer = setTimeout(step, 600); return; }
        if (!del) {
            if (ci < full.length) { ci++; typed.value = full.slice(0, ci); typing.value = true; ttTimer = setTimeout(step, 85 + Math.random() * 60); }
            else { typing.value = false; del = true; ttTimer = setTimeout(step, 2600); }
        } else if (ci > 0) { ci--; typed.value = full.slice(0, ci); typing.value = true; ttTimer = setTimeout(step, 38); }
        else { del = false; li = (li + 1) % LINES.length; ttTimer = setTimeout(step, 350); }
    };
    ttTimer = setTimeout(step, 3000);   // 第一句先完整停 3 秒
}

/* ───────── 输入框 ───────── */
const text = ref('');
const refs = ref([]);           // {id, url, name, kind, preview, loading}
const skill = ref(null);        // {id, name, description}
const busy = ref(false);
const drag = ref(false);
const shaking = ref(false);
const inputEl = ref(null);
const fileEl = ref(null);
const uploading = computed(() => refs.value.some(r => r.loading));
const canSend = computed(() => !busy.value && !uploading.value && (text.value.trim().length > 0 || refs.value.length > 0 || !!skill.value));

function autoGrow() { /* 输入区是 contenteditable，高度由 CSS（min/max-height）控制 */ }
function onKey(e) {
    if (onMentionKey(e)) return;
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        if (e.shiftKey) { document.execCommand('insertLineBreak'); syncText(); } else submit();
    }
}
function onPaste(e) {
    const files = Array.from((e.clipboardData && e.clipboardData.items) || []).map(it => (it.kind === 'file' ? it.getAsFile() : null)).filter(Boolean);
    e.preventDefault();
    if (files.length) { addFiles(files); return; }
    // 只收纯文本，别把网页里的格式 / 图片标签贴进来
    const plain = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
    if (plain) { document.execCommand('insertText', false, plain); syncText(); }
}
function hasFiles(e) { const ty = e.dataTransfer && e.dataTransfer.types; return !!(ty && Array.from(ty).includes('Files')); }
let dragDepth = 0;
function onDragEnter(e) { if (hasFiles(e)) { dragDepth++; drag.value = true; e.preventDefault(); } }
function onDragOver(e) { if (hasFiles(e)) e.preventDefault(); }
function onDragLeave() { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) drag.value = false; }
function onDrop(e) { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; drag.value = false; addFiles(e.dataTransfer.files); }

function guessKind(f) {
    const ty = String(f.type || '');
    if (ty.startsWith('image/')) return 'image';
    if (ty.startsWith('video/')) return 'video';
    if (ty.startsWith('audio/')) return 'audio';
    return 'file';
}
function addFiles(files) {
    let list = Array.from(files || []).filter(f => f && (typeof f.size !== 'number' || f.size > 0));
    if (!list.length) return;
    const room = 6 - refs.value.length;
    if (room <= 0) { toast('最多 6 个参考素材'); return; }
    if (list.length > room) toast('最多 6 个参考素材，已取前 ' + room + ' 个');
    list = list.slice(0, room);
    const entries = list.map((f, i) => {
        const kind = guessKind(f);
        return reactive({ id: 'r' + Date.now() + '_' + i, url: '', name: f.name || '素材', kind, preview: (kind === 'image' || kind === 'video') ? URL.createObjectURL(f) : '', loading: true });
    });
    refs.value = refs.value.concat(entries);
    const form = new FormData();
    list.forEach(f => form.append('files', f, f.name || 'file'));
    fetch('/api/ai/upload', { method: 'POST', body: form })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(data => {
            const out = (data && data.files) || [];
            entries.forEach((entry, i) => {
                const f = out[i];
                if (f && f.url) { entry.url = f.url; entry.name = f.name || entry.name; entry.kind = f.kind || entry.kind; entry.loading = false; }
                else refs.value = refs.value.filter(r => r !== entry);
            });
        })
        .catch(() => {
            refs.value = refs.value.filter(r => !entries.includes(r));
            toast('素材上传失败，请重试', { danger: true, icon: 'alert' });
        });
}
function addLibraryAsset(a) {
    if (refs.value.length >= 6) { toast('最多 6 个参考素材'); return; }
    if (refs.value.some(r => r.url === a.url)) return;
    refs.value = refs.value.concat([reactive({ id: 'lib_' + Date.now(), url: a.url, name: a.name, kind: a.kind, preview: a.thumb || a.url, loading: false })]);
}
function removeRef(id) { refs.value = refs.value.filter(r => r.id !== id); }
function readyRefs() { return refs.value.filter(r => r.url && !r.loading).map(r => ({ url: r.url, name: r.name, kind: r.kind || 'image' })); }
function shake() {
    shaking.value = false;
    requestAnimationFrame(() => { shaking.value = true; setTimeout(() => { shaking.value = false; }, 420); });
    inputEl.value && inputEl.value.focus();
}

/* ───────── 画布：新建 / 打开（与旧首页同一套） ───────── */
function canvasUrl(c, opts = {}) {
    const enc = encodeURIComponent(c.id);
    const project = encodeURIComponent(c.project || 'default');
    const beat = opts.ctx === 'beat' || c.kind !== 'smart';
    return (beat ? '/static/canvas.html' : '/static/smart-canvas.html') + '?id=' + enc + '&project=' + project;
}
function timeTitle(prefix) { return prefix + ' ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
async function createCanvas(title) {
    const r = await fetch('/api/canvases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: String(title || '').slice(0, 60) || timeTitle('智能画布'), icon: '🧩', kind: 'classic', project: 'default' }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (!data || !data.canvas) throw new Error('no canvas');
    return data.canvas;
}
async function launch(title, seed, opts) {
    if (busy.value) return false;
    busy.value = true;
    try {
        const c = await createCanvas(title);
        if (seed) { try { localStorage.setItem(SEED_PREFIX + c.id, JSON.stringify(seed)); } catch (e) {} }
        clearEditor(); refs.value = []; skill.value = null;
        nextTick(autoGrow);
        openCanvasUrl(canvasUrl(c, opts));
        return true;
    } catch (e) {
        toast('创建画布失败，请检查服务是否在运行', { danger: true, icon: 'alert' });
        return false;
    } finally {
        busy.value = false;
    }
}
// 把模板变成种子：首页的参考素材放进 ref 节点、输入框文字放进 brief 节点
function seedFromTemplate(t, opts = {}) {
    const rs = readyRefs();
    const tx = text.value.trim();
    const nodes = t.nodes.map(n => {
        const copy = JSON.parse(JSON.stringify(n));
        if (copy.ref && rs.length) copy.images = rs;
        if (copy.brief) copy.text = tx;
        return copy;
    });
    const seed = { v: 1, nodes, toast: t.toast };
    if (opts.agent) {
        seed.agent = t.agent + (tx ? '\n\n补充要求：' + tx : '');
        seed.autoSend = true;
        seed.toast = '';
    }
    return seed;
}
function useTemplate(id, opts) {
    const t = TEMPLATE_MAP[id];
    if (t) return launch(timeTitle(t.title), seedFromTemplate(t, opts), { ctx: 'beat' });
    return Promise.resolve(false);
}
// 发送 = 新建画布，交给画布助手（Agent）规划执行；挂了技能时在第一句点名技能，助手会用 activate_skill 载入完整说明
function submit() {
    if (busy.value) return;
    if (uploading.value) { toast('参考素材还在上传…'); return; }
    const tx = text.value.trim();
    const rs = readyRefs();
    if (!tx && !rs.length && !skill.value) { shake(); return; }
    const title = tx ? tx.replace(/\s+/g, ' ').slice(0, 20) : (skill.value ? skill.value.name : timeTitle('智能画布'));
    const nodes = [];
    if (rs.length) nodes.push({ key: 'ref', type: 'image', title: '参考图', images: rs, col: 0 });
    let agent = tx || (rs.length ? '看看画布上的参考素材，帮我规划可以做什么' : '');
    const sk = skill.value;
    if (sk && sk.ref) agent = `请使用技能「${sk.name}」来完成。\n` + (agent || '先告诉我这个技能需要我提供什么。');
    else if (sk) agent = `请使用技能「${sk.name}」（技能 ID：${sk.id}）来完成。\n` + (agent || '先告诉我这个技能需要我提供什么。');
    const seed = { v: 1, nodes, agent, autoSend: true, renderer: 'beat' };
    if (sk && sk.ref) seed.skillRef = sk.ref;
    launch(title, seed, { ctx: 'beat' });
}

/* ───────── 快速开始 ───────── */
function quickStart(kind) {
    const tx = text.value.trim();
    const rs = readyRefs();
    const nodes = [];
    if (rs.length) nodes.push({ key: 'ref', type: 'image', title: '参考图', images: rs, col: 0 });
    if (kind === 'blank') { launch(timeTitle('智能画布'), nodes.length ? { v: 1, nodes } : null, { ctx: 'beat' }); return; }
    if (kind === 'batch') { useTemplate('batch'); return; }
    const video = kind === 'video';
    nodes.push({ key: 'gen', type: 'gen', title: video ? '视频' : '图片', prompt: tx, video, ratio: video ? '16:9' : '', inputs: rs.length ? ['ref'] : [], col: rs.length ? 1 : 0 });
    launch(tx ? tx.replace(/\s+/g, ' ').slice(0, 20) : timeTitle(video ? '视频创作' : '图片创作'),
        { v: 1, nodes, toast: tx ? '' : (video ? '在视频节点里写下画面描述，再点运行' : '在图片节点里写下画面描述，再点运行') }, { ctx: 'beat' });
}

/* ───────── 最新项目（输入框下面）：新建 + 最近编辑的 3 张画布；画布不够 3 张时用快速开始补位 ───────── */
const recent = ref([]);
const recentReady = ref(false);
const QUICK_FILL = [
    { kind: 'image', label: '图片创作', desc: '提示词 → 出图' },
    { kind: 'video', label: '视频创作', desc: '图片 / 文字 → 视频' },
    { kind: 'batch', label: '批量出图', desc: '多维表格一行一张' },
];
const fillers = computed(() => (recentReady.value ? QUICK_FILL.slice(0, Math.max(0, 3 - recent.value.length)) : []));
const tsOf = c => { const v = Number(c.updated_at || c.created_at || 0); return v < 1e10 ? v * 1000 : v; };
function ago(c) {
    const t = tsOf(c); if (!t) return '';
    const m = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    const h = Math.round(m / 60); if (h < 24) return h + ' 小时前';
    const d = Math.round(h / 24); if (d < 30) return d + ' 天前';
    return new Date(t).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
const GENERIC_THREAD = /^(新对话|新的对话|新会话|对话\s*\d*|untitled|new chat)$/i;
async function loadRecent() {
    try {
        const r = await fetch('/api/canvases', { headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error();
        const d = await r.json();
        const list = (d.canvases || []).slice().sort((a, b) => tsOf(b) - tsOf(a)).slice(0, 3);
        recent.value = list.map(c => ({ ...c, chip: '' }));
        // 卡片底部那条：这张画布当前对话的标题（画布助手最后在做的事），拿不到就显示「继续创作」
        list.forEach(async c => {
            try {
                const t = await fetch('/api/agent/threads?canvas_id=' + encodeURIComponent(c.id), { headers: { Accept: 'application/json' } });
                if (!t.ok) return;
                const td = await t.json();
                const ths = (td.threads || []).filter(x => x && x.title && !GENERIC_THREAD.test(String(x.title).trim()) && x.message_count !== 0);
                const th = ths.find(x => x.id === td.active_id) || ths.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0];
                const row = recent.value.find(x => x.id === c.id);
                if (th && row) row.chip = String(th.title).trim();
            } catch (e) {}
        });
    } catch (e) { /* 服务没起来时保持空 */ }
    recentReady.value = true;
}
function coverOf(c) { const u = (c.thumbnails || []).filter(Boolean)[0]; return u ? thumbUrl(u) : ''; }
function onCoverError(c) { c.thumbnails = (c.thumbnails || []).slice(1); }
function openProject(c) { openCanvasUrl(canvasUrl(c)); }
function allProjects() { navigate('canvas'); }
function onPageFocus(e) { if (e.detail && e.detail.id === 'home') { loadRecent(); loadPlugins(); loadDefaultModel(); } }
// 在设置 / 应用市场里改了插件或技能，回到首页时同步
watch(() => state.settingsOpen, open => { if (!open) { loadPlugins(); if (skillsState.value === 'ready') loadSkills(); } });

/* ───────── 弹层：添加 / 技能 / 插件 ───────── */
const pop = ref('');            // '' | add | skill | plugin
function togglePop(id) { closeMention(); pop.value = pop.value === id ? '' : id; if (pop.value === 'skill') loadSkills(); if (pop.value === 'plugin') loadPlugins(); if (pop.value === 'model') openModelPop(); }
function closePop() { pop.value = ''; }
function onDocDown(e) {
    if (pop.value && !e.target.closest('.hp-pop, .hp-chip')) closePop();
    if (mention.open && !e.target.closest('.hp-mention, .hp-input')) closeMention();
}
function onEsc(e) { if (e.key !== 'Escape') return; if (preview.value) return; if (picker.open) { picker.open = false; return; } closePop(); }

// 技能 = 自己导入的技能（/api/capabilities kind=skill）+ 应用市场里「添加到助手」的技能（/api/store/catalog installed）。
// 每次打开都重新拉，跟设置 / 应用市场里的改动保持同步。市场技能走 skillRef（store:<name>），由后端把技能手册注入系统提示。
const skills = ref([]);
const apps = ref([]);           // 应用市场里的应用（目前都没开放，/ 菜单里显示「即将上线」）
const skillsState = ref('idle');
const skillQ = ref('');
async function loadSkills() {
    if (skillsState.value === 'loading') return;
    if (skillsState.value !== 'ready') skillsState.value = 'loading';
    const get = url => fetch(url, { headers: { Accept: 'application/json' } }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    const [caps, cat] = await Promise.allSettled([get('/api/capabilities'), get('/api/store/catalog')]);
    if (caps.status === 'rejected' && cat.status === 'rejected') { if (skillsState.value !== 'ready') skillsState.value = 'error'; return; }
    const mine = caps.status === 'fulfilled' ? ((caps.value && caps.value.capabilities) || []).filter(c => c && c.kind === 'skill' && c.enabled !== false && c.id)
        .map(c => ({ id: String(c.id), name: String(c.name || c.id), description: String(c.description || ''), source: 'mine' })) : [];
    const data = cat.status === 'fulfilled' ? ((cat.value && cat.value.data) || cat.value || {}) : {};
    const items = Array.isArray(data.items) ? data.items : [];
    const market = items.filter(it => it && it.kind === 'skill' && it.installed && it.store_available !== false && it.name)
        .map(it => ({ id: 'store:' + it.name, ref: 'store:' + it.name, name: String(it.display_name || it.name), description: String(it.marketing_line || it.description || ''), source: 'market' }));
    apps.value = items.filter(it => it && it.kind === 'app' && it.name)
        .map(it => ({ id: 'app:' + it.name, name: String(it.display_name || it.name), description: String(it.marketing_line || it.description || ''), available: it.store_available !== false }));
    skills.value = market.concat(mine);
    skillsState.value = 'ready';
}
const shownSkills = computed(() => {
    const q = skillQ.value.trim().toLowerCase();
    return q ? skills.value.filter(s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)) : skills.value;
});
function pickSkill(s) { closePop(); setSkillToken(s); }

// 插件：画布助手能调用的外部工具 = 联网搜索 + 已启用的 MCP 服务
const web = ref(null);          // null 未知 / true / false
const mcp = ref([]);
const mcpBusy = ref('');
async function loadPlugins() {
    try { const r = await fetch('/api/agent/web-access'); if (r.ok) web.value = Boolean((await r.json()).enabled); } catch (e) {}
    try { const r = await fetch('/api/mcp/servers', { headers: { Accept: 'application/json' } }); if (r.ok) { const d = await r.json(); mcp.value = Array.isArray(d && d.servers) ? d.servers : []; } } catch (e) {}
}
const pluginCount = computed(() => (web.value ? 1 : 0) + mcp.value.filter(s => s.enabled).length);
async function toggleWeb() {
    const next = !web.value;
    try {
        const r = await fetch('/api/agent/web-access', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        web.value = Boolean((await r.json()).enabled);
        toast(web.value ? '已允许画布助手联网搜索' : '已关闭画布助手联网搜索', { icon: 'check' });
    } catch (e) { toast('保存联网设置失败', { danger: true, icon: 'alert' }); }
}
// 停用可以直接做；启用要确认它会在本机运行命令，交给设置里的 MCP 页（那里有确认弹窗）
async function toggleMcp(s) {
    if (!s.enabled) { openSettings('mcp'); return; }
    if (mcpBusy.value) return;
    mcpBusy.value = s.name;
    try {
        const r = await fetch('/api/mcp/servers/' + encodeURIComponent(s.name) + '/disable', { method: 'POST', headers: { Accept: 'application/json' } });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.detail || ('HTTP ' + r.status));
        mcp.value = mcp.value.map(row => row.name === s.name ? (body.server || { ...row, enabled: false }) : row);
        toast('已停用 ' + s.name);
    } catch (e) { toast((e && e.message) || '停用失败', { danger: true, icon: 'alert' }); }
    finally { mcpBusy.value = ''; }
}
function openSettings(tab) { closePop(); state.settingsTab = tab; state.settingsOpen = true; }

/* ───────── 对话模型：底栏 chip + 两级菜单（先供应商，再模型） ─────────
   默认模型存服务端（GET/PUT /api/agent/default-model，"平台id::模型名"，空串 = 跟随系统设置）；
   画布助手打开时读 localStorage canvas-next:agent:model 当自己选中的模型，所以两边一起写。
   只影响之后新建的画布，不改当前页面。 */
const chatModel = ref('');              // '' = 跟随系统设置的默认模型
const modelVendors = ref([]);           // [{ id, name, models: [{ id, name }] }]
const modelVendor = ref('');            // 二级 flyout 打开的供应商（'' = 没开）
const modelTop = ref(0);                // 二级浮层 top：相对 .hp-model-wrap = 当前供应商行的 top
const modelQ = ref('');
const modelState = ref('idle');         // idle | loading | ready | error
const modelPopEl = ref(null);           // 打开时把当前模型滚到可见位置
const modelName = id => (id ? String(id).split('::').slice(1).join('::') || String(id) : '');
const chatModelLabel = computed(() => (chatModel.value ? modelName(chatModel.value) : '默认模型'));
/* 模型强度：/api/config 的 provider.model_caps[模型名].think 是档位真值源（后端按模型能力下发）；
   和画布助手共用 canvas-next:agent:think（空串 = 删除）。没档位 / 没选中模型时滑块不显示。 */
const THINK_KEYS = ['low', 'mid', 'high', 'xhigh', 'max'];
const thinkLevel = ref('');
try { thinkLevel.value = localStorage.getItem('canvas-next:agent:think') || ''; } catch (e) {}
function normalizeThinkLevels(raw) {
    const known = (Array.isArray(raw) ? raw : []).map(v => String(v == null ? '' : v).trim()).filter(v => THINK_KEYS.includes(v));
    return [...new Set(known)].sort((a, b) => THINK_KEYS.indexOf(a) - THINK_KEYS.indexOf(b));
}
const chatThinkLevels = computed(() => {
    if (!chatModel.value) return [];
    for (const g of modelVendors.value) {
        const hit = (g.models || []).find(m => m.id === chatModel.value);
        if (hit) return hit.think || [];
    }
    return [];
});
function applyThinkLevel(level) {
    const next = String(level == null ? '' : level).trim();
    thinkLevel.value = next;
    try { if (next) localStorage.setItem('canvas-next:agent:think', next); else localStorage.removeItem('canvas-next:agent:think'); } catch (e) {}
}
// 换模型后收敛到合法档位；模型不支持（没档位）只隐藏滑块，不清掉和画布助手共用的偏好
watch(chatThinkLevels, (levels) => {
    if (!levels.length) return;
    if (thinkLevel.value && !levels.includes(thinkLevel.value)) applyThinkLevel(levels[0]);
});
const activeVendor = computed(() => modelVendors.value.find(v => v.id === modelVendor.value) || null);
const activeModels = computed(() => {
    const list = activeVendor.value ? activeVendor.value.models : [];
    const q = modelQ.value.trim().toLowerCase();
    return q ? list.filter(m => m.name.toLowerCase().includes(q)) : list;
});
async function loadDefaultModel() {
    try {
        const r = await fetch('/api/agent/default-model', { headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        chatModel.value = (d && d.model) || '';
    } catch (e) { /* 读不到就保持原样，chip 还显示上一次的值 */ }
}
async function loadModelGroups() {
    modelState.value = 'loading';
    try {
        const r = await fetch('/api/config', { headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const cfg = await r.json();
        const rows = Array.isArray(cfg && cfg.api_providers) ? cfg.api_providers : [];
        // 过滤规则照 novai-canvas-ui/src/novaiBackend.ts 的 listModels
        const groups = rows.filter(p => {
            if (!p || p.enabled === false) return false;
            const protocol = String(p.protocol || '').toLowerCase();
            const local = /local|ollama|comfy|本机/i.test(String(p.id || '') + ' ' + String(p.name || ''));
            return p.has_key === true || p.has_wallet_key === true || local || ['jimeng', 'codex', 'gemini-cli'].includes(protocol);
        }).map(p => {
            const pid = String(p.id || '');
            const caps = p.model_caps && typeof p.model_caps === 'object' ? p.model_caps : {};
            const models = (Array.isArray(p.chat_models) ? p.chat_models : []).map(v => String(v || '').trim()).filter(Boolean)
                .map(name => ({ id: pid + '::' + name, name, think: normalizeThinkLevels(caps[name] && caps[name].think) }));
            return { id: pid, name: String(p.name || p.id), models };
        }).filter(g => g.id);
        // 当前模型所在供应商不在 /api/config 里：补一个「当前」分组，别让 chip 的状态在菜单里找不到
        if (chatModel.value) {
            const pid = chatModel.value.split('::')[0];
            const hit = groups.find(g => g.id === pid);
            if (hit) { if (!hit.models.some(m => m.id === chatModel.value)) hit.models.unshift({ id: chatModel.value, name: modelName(chatModel.value), think: [] }); }
            else groups.unshift({ id: pid, name: '当前', models: [{ id: chatModel.value, name: modelName(chatModel.value), think: [] }] });
        }
        modelVendors.value = groups;
        modelState.value = 'ready';
        return groups;
    } catch (e) {
        modelState.value = 'error';
        return [];
    }
}
/* 二级 = 一级左侧的子菜单浮层：绝对定位（right:100%，贴边无间隙），top 跟着当前供应商行。
   一级始终保留；鼠标划过别的供应商就换内容 + 换 top，不靠 pointerleave 关闭。
   关闭：点菜单外 / 选模型 / Esc；「默认对话模型」行也会收起二级。 */
function closeFlyout() { modelVendor.value = ''; modelQ.value = ''; }
/* 模型列表滚到当前模型（尽量居中）；没有当前模型就回顶部。
   用 offsetTop 直接算，不碰 scrollIntoView，免得把整页带着滚。 */
function scrollModelList() {
    const root = modelPopEl.value; if (!root) return;
    const box = root.querySelector('.hp-mpanel-models .hp-list'); if (!box) return;
    const cur = box.querySelector('.hp-it.cur');
    if (!cur) { box.scrollTop = 0; return; }
    const top = cur.offsetTop - box.offsetTop;
    box.scrollTop = Math.max(0, top - Math.max(0, (box.clientHeight - cur.offsetHeight) / 2));
}
watch(modelVendor, v => { if (v) nextTick(scrollModelList); });
function showVendor(id, event) {
    if (event && event.currentTarget && modelPopEl.value) {
        const rr = event.currentTarget.getBoundingClientRect();
        const wr = modelPopEl.value.getBoundingClientRect();
        modelTop.value = Math.max(0, Math.round(rr.top - wr.top));
    }
    if (modelVendor.value === id) return;
    modelQ.value = '';
    modelVendor.value = id;
}
function clickVendor(id, event) {
    showVendor(id, event);
    nextTick(() => {
        const input = modelPopEl.value && modelPopEl.value.querySelector('.hp-mpanel-models .hp-search input');
        if (input) input.focus();
    });
}
/* 菜单 Teleport 到 #nv-layer 用 fixed 定位：composer 自己是 backdrop root，菜单留在里面磨砂会变平色、二级还会被裁。
   位置按 composer 的视口矩形算：下方 6px、右边对齐（距视口右 14）。页面一滚/一缩放就关掉，别让它飘。 */
const modelPos = ref({ top: '0px', right: '0px' });
function computeModelPos() {
    const el = document.querySelector('.hp-composer');
    if (!el) return;
    const r = el.getBoundingClientRect();
    modelPos.value = { top: Math.round(r.bottom + 6) + 'px', right: Math.round(window.innerWidth - r.right + 14) + 'px' };
}
function onModelViewportChange(e) {
    if (pop.value !== 'model') return;
    // 模型列表自己滚动（滚到当前模型、手动滚）不算页面滚动，别误关
    const t = e && e.target;
    if (t && t.closest && t.closest('.hp-model-wrap')) return;
    closePop();
}
function openModelPop() {
    modelQ.value = '';
    modelVendor.value = '';
    computeModelPos();
    loadModelGroups();
}
async function setDefaultModel(id, name) {
    try {
        const r = await fetch('/api/agent/default-model', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: id }),
        });
        if (!r.ok) {
            const body = await r.json().catch(() => ({}));
            throw new Error(body.detail || ('HTTP ' + r.status));
        }
        chatModel.value = id;
        try {
            if (id) localStorage.setItem('canvas-next:agent:model', id);
            else localStorage.removeItem('canvas-next:agent:model');
        } catch (e) {}
        closePop();
        toast(id ? '已切换对话模型：' + (name || modelName(id)) : '已恢复默认对话模型', { icon: 'check' });
    } catch (e) {
        toast('切换对话模型失败：' + ((e && e.message) || '未知错误'), { danger: true, icon: 'alert' });
    }
}
function pickModel(m) { setDefaultModel(m.id, m.name); }
function useDefaultModel() { setDefaultModel('', ''); }

/* ───────── 输入框里的 @ 和 / ─────────
   @  引用素材：已经加进来的参考素材 + 素材库里的图片 / 视频（选库里的会顺手加进参考素材）
   /  调用插件、技能和应用：插件 = 联网搜索 + MCP 服务（没开的顺手打开），技能挂到输入框，应用目前只显示「即将上线」 */
const mention = reactive({ open: false, type: '', q: '', start: 0, index: 0, x: 14, y: 0 });
let mNode = null;               // 触发 @ / 的那个文本节点（DOM 节点不放进响应式）

/* ── 输入区：contenteditable。@ 引用的素材、/ 选的技能 / 插件在里面是不可编辑的小标签（data-tk），
   提交时序列化成纯文本：素材 → @名字（图N），插件 → /名字，技能不进正文（走 skill / skillRef）。 ── */
const editorEmpty = ref(true);
function iconSvg(name) { return '<svg class="nv-i" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || '') + '</svg>'; }
function escHtml(v) { return String(v || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function tokenText(t) {
    const k = t.dataset.tk;
    if (k === 'ref') { const i = refs.value.findIndex(r => r.id === t.dataset.id); return '@' + (t.dataset.name || '') + (i >= 0 ? '（图' + (i + 1) + '）' : ''); }
    if (k === 'plugin') return '/' + (t.dataset.name || '');
    return '';
}
function serialize(el) {
    let out = '';
    const walk = n => {
        n.childNodes.forEach(c => {
            if (c.nodeType === 3) out += c.nodeValue;
            else if (c.nodeType === 1) {
                if (c.dataset && c.dataset.tk) out += tokenText(c);
                else if (c.tagName === 'BR') out += '\n';
                else { if ((c.tagName === 'DIV' || c.tagName === 'P') && out && !out.endsWith('\n')) out += '\n'; walk(c); }
            }
        });
    };
    walk(el);
    return out.replace(/ /g, ' ');
}
function syncText() {
    const el = inputEl.value; if (!el) return;
    text.value = serialize(el);
    const hasTk = !!el.querySelector('[data-tk]');
    editorEmpty.value = !hasTk && !el.textContent.replace(/ /g, ' ').trim();
    if (editorEmpty.value && el.innerHTML && !el.textContent) el.innerHTML = '';
    // 技能标签被删掉了 → 取消技能
    if (skill.value && !el.querySelector('[data-tk="skill"]')) skill.value = null;
}
function clearEditor() { const el = inputEl.value; if (el) el.innerHTML = ''; text.value = ''; editorEmpty.value = true; }
const LONG = 3;   // 标签里名字最多露 3 个字，多出来的渐隐
function makeToken(kind, o) {
    const t = document.createElement('span');
    t.className = 'hp-tk ' + kind;
    t.contentEditable = 'false';
    t.dataset.tk = kind;
    t.dataset.name = o.name || '';
    if (o.id) t.dataset.id = o.id;
    t.title = o.name || '';
    const long = [...String(o.name || '')].length > LONG ? ' long' : '';
    if (kind === 'ref') {
        t.innerHTML = (o.thumb ? '<img class="th" alt="" src="' + escHtml(o.thumb) + '">' : '<span class="th ic">' + iconSvg(o.icon || 'file') + '</span>')
            + '<span class="nm' + long + '">' + escHtml(o.name) + '</span><span class="ix"></span>';
        const img = t.querySelector('img');
        if (img) img.onerror = () => { const sp = document.createElement('span'); sp.className = 'th ic'; sp.innerHTML = iconSvg(o.icon || 'image'); img.replaceWith(sp); };
    } else {
        t.innerHTML = iconSvg(o.icon || 'wand2') + '<span class="nm' + long + '">' + escHtml(o.name) + '</span>';
    }
    return t;
}
// 参考素材变了（删了 / 顺序变了 / 上传完成）：同步输入区里的素材标签，删掉失效的，序号「图N」重排
function syncRefTokens() {
    const el = inputEl.value; if (!el) return;
    el.querySelectorAll('[data-tk="ref"]').forEach(t => {
        const i = refs.value.findIndex(r => r.id === t.dataset.id);
        if (i < 0) { const nx = t.nextSibling; if (nx && nx.nodeType === 3 && /^ /.test(nx.nodeValue)) nx.nodeValue = nx.nodeValue.slice(1); t.remove(); return; }
        const ix = t.querySelector('.ix'); if (ix) ix.textContent = '图' + (i + 1);
    });
    syncText();
}
watch(() => refs.value.map(r => r.id).join('|'), () => nextTick(syncRefTokens));
function placeCaretAfter(node) {
    const sel = window.getSelection(); const r = document.createRange();
    r.setStartAfter(node); r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
}
// 在 range 处插入标签 + 一个不换行空格，光标落到空格后面
function insertTokenAt(range, tk) {
    const sp = document.createTextNode(' ');
    range.insertNode(sp);
    range.insertNode(tk);
    placeCaretAfter(sp);
    syncText();
}
let lastRange = null;
function rememberRange() {
    const el = inputEl.value; const sel = window.getSelection();
    if (el && sel.rangeCount && el.contains(sel.getRangeAt(0).startContainer)) lastRange = sel.getRangeAt(0).cloneRange();
}
function rangeForInsert() {
    const el = inputEl.value;
    if (lastRange && el && el.contains(lastRange.startContainer)) return lastRange.cloneRange();
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); return r;
}
function setSkillToken(s) {
    const el = inputEl.value; if (!el) { skill.value = s; return; }
    el.querySelectorAll('[data-tk="skill"]').forEach(t => t.remove());   // 一次只挂一个技能
    skill.value = s;
    el.focus();
    const r = document.createRange(); r.setStart(el, 0); r.collapse(true);   // 技能放在最前面
    insertTokenAt(r, makeToken('skill', { name: s.name, icon: 'wand2', id: s.id }));
    skill.value = s;
    const end = document.createRange(); end.selectNodeContents(el); end.collapse(false);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(end);
}

// 弹层贴着 @ / 字符出现：取那个字符的屏幕位置，换算到输入框容器坐标（界面缩放时按比例还原）
function placeMention() {
    const el = inputEl.value; if (!el || !mNode) return;
    const box = el.closest('.hp-composer'); if (!box) return;
    const r = document.createRange();
    const len = mNode.nodeValue.length;
    r.setStart(mNode, Math.min(mention.start, len)); r.setEnd(mNode, Math.min(mention.start + 1, len));
    const rc = r.getBoundingClientRect(), bc = box.getBoundingClientRect();
    const k = box.offsetWidth ? bc.width / box.offsetWidth : 1;
    const w = mention.type === '@' ? 372 : 340;
    const maxX = Math.max(8, box.clientWidth - w - 8);
    mention.x = Math.min(maxX, Math.max(8, (rc.left - bc.left) / k - 10));
    mention.y = (rc.bottom - bc.top) / k + 6;
}
function closeMention() { mention.open = false; }
function detectMention() {
    const el = inputEl.value; if (!el) return;
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) { closeMention(); return; }
    const node = sel.anchorNode, off = sel.anchorOffset;
    if (!node || node.nodeType !== 3 || !el.contains(node)) { closeMention(); return; }
    const m = node.nodeValue.slice(0, off).match(/(^|[\s ])([@/])([^\s @/]{0,24})$/);
    if (!m) { closeMention(); return; }
    const reopen = !mention.open || mention.type !== m[2];
    mNode = node;
    Object.assign(mention, { open: true, type: m[2], q: m[3], start: off - m[3].length - 1 });
    if (reopen) { mention.index = 0; pop.value = ''; if (m[2] === '@') ensureAssets(); else { loadSkills(); loadPlugins(); } }
    else mention.index = Math.min(mention.index, Math.max(0, mentionItems.value.filter(x => !x.head).length - 1));
    placeMention();
}
function onInput() { syncText(); detectMention(); rememberRange(); }
function onSelect() { rememberRange(); if (mention.open) detectMention(); }
async function ensureAssets() {
    if (picker.items.length || picker.loading) return;
    picker.loading = true;
    try {
        const r = await fetch('/api/asset-library', { headers: { Accept: 'application/json' } });
        const data = await r.json();
        const out = [];
        flattenAssets(data && data.library, out, new Set());
        picker.items = out;
    } catch (e) { picker.items = []; }
    picker.loading = false;
}
const KIND_ICON = { image: 'image', video: 'video', audio: 'music', file: 'file' };
// 缩略图：先走预览接口（小图），失败退回原图，原图也失败就显示类型图标
const thumbFail = reactive(new Set());
function onThumbErr(e, row) {
    const img = e.target;
    const raw = row.data && row.data.url;
    if (raw && img.dataset.fallback !== '1' && img.getAttribute('src') !== raw && row.kind !== 'ref') { img.dataset.fallback = '1'; img.src = raw; return; }
    thumbFail.add(row.key);
}
const KIND_NAME = { image: '图片', video: '视频', audio: '音频', file: '文件' };
// 扁平列表（含分组标题行 head），键盘上下只在可选项之间移动
const mentionItems = computed(() => {
    if (!mention.open) return [];
    const q = mention.q.trim().toLowerCase();
    const hit = (...xs) => !q || xs.some(x => String(x || '').toLowerCase().includes(q));
    const out = [];
    const group = (title, rows) => { if (rows.length) { out.push({ head: true, title }); rows.forEach(r => out.push(r)); } };
    if (mention.type === '@') {
        const attached = refs.value.filter(r => !r.loading && hit(r.name));
        group('已添加的素材', attached.map(r => ({ key: 'ref:' + r.id, group: '已添加的素材', kind: 'ref', icon: KIND_ICON[r.kind] || 'file', thumb: r.kind === 'image' ? (r.preview || thumbUrl(r.url)) : '', badge: r.kind === 'video' ? 'play' : '', name: r.name, sub: KIND_NAME[r.kind] || '文件', data: r })));
        const urls = new Set(refs.value.map(r => r.url));
        const lib = picker.items.filter(a => !urls.has(a.url) && hit(a.name)).slice(0, 16);
        group('素材库', lib.map(a => ({ key: 'lib:' + a.id, group: '素材库', kind: 'lib', icon: KIND_ICON[a.kind] || 'image', thumb: a.thumb || (a.kind === 'image' ? thumbUrl(a.url) : ''), badge: a.kind === 'video' ? 'play' : '', name: a.name, sub: KIND_NAME[a.kind] + ' · 素材库', data: a })));
    } else {
        const plugs = [];
        if (hit('联网搜索', 'web', '网页')) plugs.push({ key: 'web', kind: 'web', icon: 'globe', name: '联网搜索', sub: web.value ? '已开启 · 搜索公开网页、读取正文' : '未开启 · 选中后自动打开' });
        mcp.value.filter(s => hit(s.name)).forEach(s => plugs.push({ key: 'mcp:' + s.name, kind: 'mcp', icon: 'plug', name: s.name, sub: s.enabled ? 'MCP 服务 · ' + (s.tool_count || 0) + ' 个工具' : 'MCP 服务 · 未启用，选中去设置里启用', data: s }));
        group('插件', plugs);
        group('技能', skills.value.filter(s => hit(s.name, s.description)).slice(0, 8).map(s => ({ key: 'sk:' + s.id, kind: 'skill', icon: 'wand2', name: s.name, sub: s.description || (s.source === 'market' ? '应用市场技能' : '我导入的技能'), data: s })));
        group('应用', apps.value.filter(a => hit(a.name, a.description)).slice(0, 6).map(a => ({ key: a.id, kind: 'app', icon: 'grid9', name: a.name, sub: a.available ? a.description : '即将上线', disabled: !a.available, data: a })));
    }
    return out;
});
const mentionRows = computed(() => mentionItems.value.filter(x => !x.head));
// 用标签替换掉「@查询词」/「/查询词」
function replaceWithToken(tk) {
    const el = inputEl.value;
    closeMention();
    if (!el || !mNode || !el.contains(mNode)) return;
    const sel = window.getSelection();
    const caret = sel.rangeCount && sel.anchorNode === mNode ? sel.anchorOffset : mNode.nodeValue.length;
    const r = document.createRange();
    r.setStart(mNode, Math.min(mention.start, mNode.nodeValue.length));
    r.setEnd(mNode, Math.max(Math.min(caret, mNode.nodeValue.length), Math.min(mention.start, mNode.nodeValue.length)));
    r.deleteContents();
    el.focus();
    if (tk) insertTokenAt(r, tk);
    else { const s2 = window.getSelection(); s2.removeAllRanges(); s2.addRange(r); syncText(); }
}
function pickMention(row) {
    if (!row || row.head || row.disabled) return;
    if (row.kind === 'ref' || row.kind === 'lib') {
        let ref = row.kind === 'ref' ? row.data : null;
        if (!ref) {
            if (refs.value.length >= 6) { toast('最多 6 个参考素材'); return; }
            addLibraryAsset(row.data);
            ref = refs.value.find(r => r.url === row.data.url);
        }
        if (!ref) return;
        replaceWithToken(makeToken('ref', { id: ref.id, name: ref.name, thumb: ref.kind === 'image' ? (ref.preview || thumbUrl(ref.url)) : '', icon: KIND_ICON[ref.kind] || 'file' }));
        nextTick(syncRefTokens);
        return;
    }
    if (row.kind === 'web') { if (!web.value) toggleWeb(); replaceWithToken(makeToken('plugin', { name: '联网搜索', icon: 'globe' })); return; }
    if (row.kind === 'mcp') {
        if (!row.data.enabled) { replaceWithToken(null); openSettings('mcp'); return; }
        replaceWithToken(makeToken('plugin', { name: row.name, icon: 'plug' }));
        return;
    }
    if (row.kind === 'skill') {
        const el = inputEl.value;
        if (el) el.querySelectorAll('[data-tk="skill"]').forEach(t => t.remove());
        skill.value = row.data;
        replaceWithToken(makeToken('skill', { name: row.data.name, icon: 'wand2', id: row.data.id }));
        skill.value = row.data;
        return;
    }
    if (row.kind === 'app') { replaceWithToken(makeToken('app', { name: row.name, icon: 'grid9' })); }
}
function onMentionKey(e) {
    if (!mention.open) return false;
    const rows = mentionRows.value;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMention(); return true; }
    if (!rows.length) return false;
    const grid = mention.type === '@';
    const step = { ArrowDown: grid ? 4 : 1, ArrowUp: grid ? -4 : -1, ArrowRight: grid ? 1 : 0, ArrowLeft: grid ? -1 : 0 }[e.key];
    if (step) { e.preventDefault(); mention.index = Math.min(rows.length - 1, Math.max(0, mention.index + step)); return true; }
    if ((e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) || e.key === 'Tab') { e.preventDefault(); pickMention(rows[mention.index]); return true; }
    return false;
}

/* ───────── 素材库选择（右侧抽屉） ───────── */
const picker = reactive({ open: false, loading: false, items: [], q: '', kind: 'all' });
function assetKindOf(item) {
    const url = String(item.url || '').toLowerCase();
    const kind = String(item.kind || item.type || '').toLowerCase();
    if (kind.includes('video') || /\.(mp4|webm|mov|m4v)(\?|#|$)/.test(url)) return 'video';
    if (kind.includes('audio') || /\.(mp3|wav|flac|ogg|m4a)(\?|#|$)/.test(url)) return 'audio';
    return 'image';
}
// /api/asset-library 是「库 → 分组 → 条目」的树：这里只要扁平的带 url 的条目
function flattenAssets(node, out, seen) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(n => flattenAssets(n, out, seen)); return; }
    if (typeof node.url === 'string' && node.url && !seen.has(node.url)) {
        seen.add(node.url);
        out.push({ id: node.id || node.url, url: node.url, name: node.name || node.title || '素材', kind: assetKindOf(node), thumb: node.thumb || node.thumbnail || node.preview || '' });
    }
    Object.keys(node).forEach(k => { const v = node[k]; if (v && typeof v === 'object') flattenAssets(v, out, seen); });
}
async function openPicker() {
    closePop();
    picker.open = true;
    if (picker.items.length || picker.loading) return;
    picker.loading = true;
    try {
        const r = await fetch('/api/asset-library', { headers: { Accept: 'application/json' } });
        const data = await r.json();
        const out = [];
        flattenAssets(data && data.library, out, new Set());
        picker.items = out;
    } catch (e) { picker.items = []; }
    picker.loading = false;
}
const pickerItems = computed(() => {
    const q = picker.q.trim();
    return picker.items.filter(a => (picker.kind === 'all' || a.kind === picker.kind) && (!q || a.name.includes(q)));
});
function pickAsset(a) { addLibraryAsset(a); picker.open = false; inputEl.value && inputEl.value.focus(); }
function thumbUrl(u) { return u && /^\/(output|assets)\//.test(u) ? '/api/media-preview?url=' + encodeURIComponent(u) + '&w=360' : u; }

/* ───────── 模板库 ───────── */
const cat = ref('全部');
const tplQ = ref('');
const templates = computed(() => {
    const q = tplQ.value.trim().toLowerCase();
    return TEMPLATES.filter(t => (cat.value === '全部' || t.cat === cat.value)
        && (!q || [t.title, t.desc, t.cat].some(x => x && String(x).toLowerCase().includes(q))));
});
const isTplSearch = computed(() => tplQ.value.trim() !== '');
/* bento 栅格：每 5 张一组（前 2 大 16:9 + 后 3 小 4:3），最后一组按剩余张数收尾；搜索态退回原来的等宽 5 列 */
function bentoClass(index) {
    if (isTplSearch.value) return '';
    const n = templates.value.length;
    if (!n) return '';
    if (n <= 4) {
        if (n === 1) return 'is-full';
        if (n === 2) return 'is-half';
        if (n === 3) return 'is-third';
        return 'is-half';
    }
    const pos = index % 5;
    const rest = n - index + pos;
    if (rest >= 5) return pos < 2 ? 'is-wide' : 'is-small';
    if (rest === 1) return 'is-full';
    if (rest === 2) return 'is-half';
    if (rest === 3) return 'is-third';
    return 'is-half';
}
const preview = ref(null);      // 正在预览的模板
function openPreview(t) { preview.value = t; }

/* 带视频的模板卡：移上去才播，移出暂停回第一帧（只叠一层同尺寸 video，不动布局） */
function cardVideoIn(e) { const v = e.currentTarget.querySelector('video'); if (v) { v.currentTime = 0; v.play().catch(() => {}); } }
function cardVideoOut(e) { const v = e.currentTarget.querySelector('video'); if (v) { v.pause(); v.currentTime = 0; } }
async function usePreviewed(opts) { const t = preview.value; if (!t) return; const ok = await useTemplate(t.id, opts); if (ok) preview.value = null; }

/* ───────── 生命周期 ───────── */
/* 输入框是首页唯一需要盯着的动效：指针进来或聚焦就把背后的光幕停掉（光幕是 GPU 大头），
   离开时只有在焦点也离开 composer 的情况下才恢复——弹层是 composer 的子节点，不会误判 */
const veilHold = ref(false);
function onComposerLeave(e) {
    const to = e.relatedTarget;
    if (to && e.currentTarget && e.currentTarget.contains(to)) return;
    veilHold.value = false;
}

onMounted(() => {
    autoGrow();
    startTypewriter();
    loadPlugins();
    loadRecent();
    loadDefaultModel();
    window.addEventListener('novai-page-focus', onPageFocus);
    window.addEventListener('novai-canvas-focus', loadRecent);
    window.addEventListener('scroll', onModelViewportChange, true);
    window.addEventListener('resize', onModelViewportChange);
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onEsc);
});
onBeforeUnmount(() => {
    clearTimeout(ttTimer);
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onEsc);
    window.removeEventListener('novai-page-focus', onPageFocus);
    window.removeEventListener('novai-canvas-focus', loadRecent);
    window.removeEventListener('scroll', onModelViewportChange, true);
    window.removeEventListener('resize', onModelViewportChange);
});
</script>

<template>
    <div class="hp">
        <NvVeilBg :hold="veilHold" />
        <div class="hp-scroll">
            <div class="hp-inner">
                <h1 class="hp-title" aria-label="今天想创作点什么？"><span aria-hidden="true">{{ typed }}</span><span class="hp-caret" :class="{ typing }" aria-hidden="true"></span></h1>

                <!-- 输入框 -->
                <div class="hp-composer" data-beam="hp" data-active="" :class="{ drag, shaking }" @dragenter="onDragEnter" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop"
                     @pointerenter="veilHold = true" @pointerleave="onComposerLeave" @focusin="veilHold = true" @focusout="onComposerLeave">
                    <div v-if="refs.length" class="hp-attached">
                        <span v-for="r in refs" :key="r.id" class="hp-att" :class="{ loading: r.loading }">
                            <img v-if="r.preview && r.kind === 'image'" :src="r.preview" alt="" />
                            <span v-else class="gi"><NvIcon :name="r.kind === 'video' ? 'video' : r.kind === 'audio' ? 'music' : 'file'" /></span>
                            <span>{{ r.loading ? '上传中…' : r.name }}</span>
                            <button type="button" aria-label="移除" @click="removeRef(r.id)"><NvIcon name="x" /></button>
                        </span>
                    </div>
                    <div ref="inputEl" class="hp-input" :class="{ empty: editorEmpty }" contenteditable="true" role="textbox" aria-multiline="true" spellcheck="false"
                         aria-label="描述你想做的东西" data-placeholder="描述你想做的东西，例如「给这双鞋做一套电商主图，白底 + 户外场景各 3 张」&#10;输入 @ 引用素材和文件，输入 / 调用插件、技能和应用；也可以直接拖入或粘贴图片"
                         @input="onInput" @keydown="onKey" @keyup="onSelect" @paste="onPaste" @click="onSelect" @blur="rememberRange(); closeMention()"></div>
                    <div class="hp-row">
                        <div class="hp-left">
                            <button type="button" class="hp-chip ic" :class="{ open: pop === 'add' }" title="添加图片 / 视频 / 文档" aria-label="添加" @click="togglePop('add')"><NvIcon name="plus" /></button>
                            <button type="button" class="hp-chip" :class="{ open: pop === 'skill' }" @click="togglePop('skill')"><NvIcon name="wand2" />技能</button>
                            <button type="button" class="hp-chip" :class="{ open: pop === 'plugin' }" @click="togglePop('plugin')"><NvIcon name="plug" />插件<span v-if="pluginCount" class="n">{{ pluginCount }}</span></button>
                            <button type="button" class="hp-chip ghost" @click="openPicker"><NvIcon name="library" />素材</button>
                        </div>
                        <div class="hp-right">
                            <button type="button" class="hp-chip hp-model-chip" :class="{ open: pop === 'model' }" :title="'对话模型：' + chatModelLabel" aria-haspopup="dialog" :aria-expanded="pop === 'model'" @click="togglePop('model')">
                                <NvIcon name="sparkles" /><span class="mn">{{ chatModelLabel }}</span><NvIcon name="chev" class="cd" />
                            </button>
                            <button type="button" class="hp-send" :disabled="!canSend" aria-label="发送" title="新建画布，交给画布助手" @click="submit">
                                <span v-if="busy" class="hp-spin"></span><NvIcon v-else name="up" />
                            </button>
                        </div>
                    </div>
                    <input ref="fileEl" type="file" multiple hidden accept="image/*,video/*,audio/*,.pdf,.txt,.md,.doc,.docx,.xlsx,.xls,.csv" @change="e => { addFiles(e.target.files); e.target.value = ''; }" />

                    <Transition name="hp-pop">
                        <div v-if="mention.open" class="hp-pop hp-mention" :class="{ grid: mention.type === '@' }" :style="{ left: mention.x + 'px', top: mention.y + 'px' }" role="listbox" :aria-label="mention.type === '@' ? '引用素材' : '插件、技能和应用'" @mousedown.prevent>
                            <div v-if="mention.type === '@'" class="hp-list">
                                <template v-for="g in ['已添加的素材', '素材库']" :key="g">
                                    <div v-if="mentionRows.some(r => r.group === g)" class="hp-grp">{{ g }}</div>
                                    <div v-if="mentionRows.some(r => r.group === g)" class="hp-tiles">
                                        <button v-for="row in mentionRows.filter(r => r.group === g)" :key="row.key" type="button" class="hp-tile" role="option" :class="{ cur: mentionRows[mention.index] === row }" :aria-selected="mentionRows[mention.index] === row" :title="row.name"
                                                @mouseenter="mention.index = mentionRows.indexOf(row)" @click="pickMention(row)">
                                            <span class="tm"><img v-if="row.thumb && !thumbFail.has(row.key)" :src="row.thumb" alt="" loading="lazy" @error="e => onThumbErr(e, row)"><NvIcon v-else :name="row.icon" /><i v-if="row.badge" class="bd"><NvIcon :name="row.badge" /></i></span>
                                            <span class="nm">{{ row.name }}</span>
                                        </button>
                                    </div>
                                </template>
                                <div v-if="!mentionRows.length" class="hp-empty">{{ picker.loading ? '正在读取素材…' : (mention.q ? '没有匹配的素材' : '还没有素材，可以先上传或拖入文件') }}</div>
                            </div>
                            <div v-else class="hp-list">
                                <template v-for="row in mentionItems" :key="row.head ? 'h:' + row.title : row.key">
                                    <div v-if="row.head" class="hp-grp">{{ row.title }}</div>
                                    <button v-else type="button" class="hp-it" role="option" :class="{ cur: mentionRows[mention.index] === row }" :aria-selected="mentionRows[mention.index] === row" :disabled="row.disabled"
                                            @mouseenter="mention.index = mentionRows.indexOf(row)" @click="pickMention(row)">
                                        <span class="ic" :class="{ th: row.thumb }"><img v-if="row.thumb" :src="row.thumb" alt=""><NvIcon v-else :name="row.icon" /></span>
                                        <span class="tx"><b>{{ row.name }}</b><small>{{ row.sub }}</small></span>
                                        <NvIcon v-if="row.kind === 'skill' && skill && skill.id === row.data.id" class="chk" name="check" />
                                    </button>
                                </template>
                                <div v-if="!mentionRows.length" class="hp-empty">
                                    {{ mention.type === '@' ? (picker.loading ? '正在读取素材…' : (mention.q ? '没有匹配的素材' : '还没有素材，可以先上传或拖入文件')) : '没有匹配的插件、技能或应用' }}
                                </div>
                            </div>
                            <div class="hp-foot"><span>{{ mention.type === '@' ? '方向键选择 · 回车引用' : '↑↓ 选择 · 回车使用' }}</span><span>Esc 关闭</span></div>
                        </div>
                    </Transition>
                    <Transition name="hp-pop">
                        <div v-if="pop === 'add'" class="hp-pop" style="left: 14px; width: 240px">
                            <button type="button" class="hp-it" @click="closePop(); fileEl && fileEl.click()"><span class="ic"><NvIcon name="upload" /></span><span class="tx"><b>上传本地文件</b><small>图片、视频、音频或文档</small></span></button>
                            <button type="button" class="hp-it" @click="openPicker"><span class="ic"><NvIcon name="library" /></span><span class="tx"><b>从素材库选</b><small>生成作品与上传的素材</small></span></button>
                        </div>
                    </Transition>
                    <Transition name="hp-pop">
                        <div v-if="pop === 'skill'" class="hp-pop" style="left: 52px">
                            <label class="hp-search"><NvIcon name="search" /><input v-model="skillQ" placeholder="搜索技能" autocomplete="off" /></label>
                            <div class="hp-list">
                                <div v-if="skillsState === 'loading'" class="hp-empty">正在读取技能…</div>
                                <div v-else-if="skillsState === 'error'" class="hp-empty">技能列表读取失败</div>
                                <template v-else>
                                    <div v-if="shownSkills.length" class="hp-grp">可用技能 · {{ shownSkills.length }} 个</div>
                                    <button v-for="s in shownSkills" :key="s.id" type="button" class="hp-it" @click="pickSkill(s)">
                                        <span class="ic"><NvIcon name="wand2" /></span><span class="tx"><b>{{ s.name }}</b><small>{{ s.description }}</small></span>
                                        <NvIcon v-if="skill && skill.id === s.id" class="chk" name="check" />
                                    </button>
                                    <div v-if="!shownSkills.length" class="hp-empty">{{ skills.length ? '没有找到相关技能' : '还没有技能，可以在设置 → 技能里导入，或去应用市场添加' }}</div>
                                </template>
                            </div>
                            <div class="hp-foot"><button type="button" @click="closePop(); navigate('store')">去应用市场添加技能</button><button type="button" @click="openSettings('skills')">管理技能</button></div>
                        </div>
                    </Transition>
                    <Transition name="hp-pop">
                        <div v-if="pop === 'plugin'" class="hp-pop" style="left: 128px">
                            <div class="hp-grp">画布助手可以调用的工具</div>
                            <button type="button" class="hp-it" :aria-pressed="web === true" @click="toggleWeb">
                                <span class="ic"><NvIcon name="globe" /></span><span class="tx"><b>联网搜索</b><small>搜索公开网页、读取网页正文</small></span><span class="hp-sw"></span>
                            </button>
                            <button v-for="s in mcp" :key="s.name" type="button" class="hp-it" :aria-pressed="!!s.enabled" :disabled="mcpBusy === s.name" @click="toggleMcp(s)">
                                <span class="ic"><NvIcon name="plug" /></span><span class="tx"><b>{{ s.name }}</b><small>{{ s.enabled ? ('MCP 服务 · ' + (s.tool_count || 0) + ' 个工具') : 'MCP 服务 · 未启用，点开去设置里启用' }}</small></span><span class="hp-sw"></span>
                            </button>
                            <div v-if="!mcp.length" class="hp-empty" style="padding: 10px 8px">还没有添加 MCP 服务</div>
                            <div class="hp-foot"><button type="button" @click="openSettings('mcp')">管理插件</button><button type="button" @click="openSettings('mcp')">添加 MCP 服务</button></div>
                        </div>
                    </Transition>
                    <Teleport to="#nv-layer">
                    <Transition name="hp-pop">
                        <div v-if="pop === 'model'" ref="modelPopEl" class="hp-pop hp-model-wrap" :style="modelPos" role="dialog" aria-label="对话模型">
                            <div class="hp-mpanel hp-mpanel-vendors">
                                <div class="hp-mpanel-hd"><b>对话模型</b><small>· 选择供应商</small></div>
                                <div class="hp-mv-list">
                                    <button type="button" class="hp-mv def" :class="{ cur: !chatModel }" @pointerenter="closeFlyout()" @click="useDefaultModel()">
                                        <span class="nm">默认对话模型<small>跟随系统设置</small></span>
                                        <NvIcon v-if="!chatModel" name="check" class="chk" />
                                    </button>
                                    <button v-for="g in modelVendors" :key="g.id" type="button" class="hp-mv" :class="{ on: modelVendor === g.id }"
                                            @pointerenter="showVendor(g.id, $event)" @click="clickVendor(g.id, $event)">
                                        <VendorLogo class="hp-mv-logo" :name="g.name" :id="g.id" :size="16" />
                                        <span class="nm">{{ g.name }}</span>
                                        <NvIcon v-if="chatModel && chatModel.split('::')[0] === g.id" name="check" class="chk" />
                                        <span class="n">{{ g.models.length }} 个模型</span>
                                        <NvIcon name="chevr" class="ar" />
                                    </button>
                                    <div v-if="modelState === 'loading'" class="hp-empty">正在读取供应商…</div>
                                    <div v-else-if="modelState === 'error'" class="hp-empty">模型列表读取失败</div>
                                    <div v-else-if="!modelVendors.length" class="hp-empty">没有可用的供应商</div>
                                </div>
                                <EffortSlider v-if="chatModel && chatThinkLevels.length > 1" class="hp-effort" :levels="chatThinkLevels" :value="thinkLevel" @update:value="applyThinkLevel" />
                                <div class="hp-mpanel-foot">
                                    <button type="button" @click="openSettings('api-settings')">模型设置</button>
                                    <button v-if="modelState === 'error'" type="button" @click="openModelPop()">重试</button>
                                </div>
                            </div>
                            <Transition name="hp-pop">
                                <div v-if="modelVendor && activeVendor" class="hp-mpanel hp-mpanel-models" :style="{ top: modelTop + 'px' }">
                                    <label v-if="activeVendor.models.length > 8" class="hp-search"><NvIcon name="search" /><input v-model="modelQ" placeholder="搜索模型" autocomplete="off" /></label>
                                    <div class="hp-list">
                                        <button v-for="m in activeModels" :key="m.id" type="button" class="hp-it" :class="{ cur: chatModel === m.id }" :title="m.id" @click="pickModel(m)">
                                            <VendorLogo :name="activeVendor && activeVendor.name" :id="activeVendor && activeVendor.id" :model="m.name" :size="14" />
                                            <span class="tx"><b>{{ m.name }}</b></span>
                                            <NvIcon v-if="chatModel === m.id" name="check" class="chk" />
                                        </button>
                                        <div v-if="!activeModels.length" class="hp-empty">{{ modelQ.trim() ? '没有匹配的模型' : '这个供应商还没有模型' }}</div>
                                    </div>
                                </div>
                            </Transition>
                        </div>
                    </Transition>
                    </Teleport>
                    <div data-beam-bloom aria-hidden="true"></div>
                </div>

                <!-- 快速开始 -->
                <!-- 最新项目：新建 + 最近编辑的画布（不足 3 张用快速开始补位）+ 所有项目 -->
                <div class="hp-recent">
                    <button type="button" class="hp-new" @click="quickStart('blank')"><NvIcon name="plus" /><span>新建项目</span></button>
                    <button v-for="c in recent" :key="c.id" type="button" class="hp-pj" :title="c.title || '未命名画布'" @click="openProject(c)">
                        <span class="cv"><img v-if="coverOf(c)" :src="coverOf(c)" alt="" loading="lazy" decoding="async" @error="onCoverError(c)"><span v-else class="ph"><NvIcon name="grid9" /></span></span>
                        <span class="mt"><b>{{ c.title || '未命名画布' }}</b><em>编辑于 {{ ago(c) }}</em></span>
                        <span class="go"><span>{{ c.chip || '继续创作' }}</span><NvIcon name="arrowdr" class="ne" /></span>
                    </button>
                    <button v-for="q in fillers" :key="q.kind" type="button" class="hp-pj fill" @click="quickStart(q.kind)">
                        <span class="cv art"><template v-if="q.kind === 'image'"><svg viewBox="0 0 150 84"><rect x="8" y="24" width="48" height="36" rx="6" class="n"/><path d="M16 34h28M16 42h22M16 50h26" class="ln" stroke-width="2" stroke-linecap="round"/><path d="M58 42c14 0 14-18 30-18" class="ln" fill="none" stroke-width="1.5"/><circle cx="58" cy="42" r="3" class="pt"/><rect x="88" y="8" width="54" height="68" rx="7" class="n"/><rect x="94" y="14" width="42" height="46" rx="4" class="f"/><path d="m96 56 12-14 8 8 6-5 12 11" class="ln" fill="none" stroke-width="1.5"/><circle cx="124" cy="25" r="3.5" class="d"/></svg></template><template v-else-if="q.kind === 'video'"><svg viewBox="0 0 150 84"><rect x="8" y="18" width="44" height="48" rx="6" class="n"/><rect x="13" y="23" width="34" height="38" rx="3" class="f"/><path d="m15 58 10-11 7 6 5-4 9 9" class="ln" fill="none" stroke-width="1.5"/><path d="M54 42h26" class="ln" stroke-width="1.5"/><circle cx="54" cy="42" r="3" class="pt"/><rect x="82" y="16" width="62" height="52" rx="7" class="n"/><rect x="88" y="22" width="50" height="32" rx="4" class="f"/><path d="m109 31 9 7-9 7z" class="d"/><rect x="88" y="59" width="50" height="3" rx="1.5" class="f"/><rect x="88" y="59" width="22" height="3" rx="1.5" class="d"/></svg></template><template v-else><svg viewBox="0 0 150 84"><rect x="6" y="14" width="62" height="56" rx="6" class="n"/><path d="M6 28h62M6 42h62M6 56h62M26 14v56" class="ln" stroke-width="1"/><path d="M70 42h16" class="ln" stroke-width="1.5"/><circle cx="70" cy="42" r="3" class="pt"/><rect x="100" y="10" width="40" height="40" rx="5" class="f2"/><rect x="94" y="20" width="40" height="40" rx="5" class="f2"/><rect x="88" y="30" width="40" height="40" rx="5" class="n"/><path d="m92 64 9-10 6 5 5-4 12 9" class="ln" fill="none" stroke-width="1.5"/></svg></template></span>
                        <span class="mt"><b>{{ q.label }}</b><em>快速开始</em></span>
                        <span class="go"><span>{{ q.desc }}</span><NvIcon name="arrowdr" class="ne" /></span>
                    </button>
                </div>
                <div class="hp-all"><button type="button" @click="allProjects">所有项目<NvIcon name="arrowr" /></button></div>

                <!-- 模板库 -->
                <section class="hp-tpl">
                    <div class="hp-tpl-head">
                        <h2>模板库</h2>
                        <div class="hp-tabs" role="tablist">
                            <button v-for="c in CATS" :key="c" type="button" role="tab" :aria-selected="cat === c" :class="{ on: cat === c }" @click="cat = c">{{ c }}</button>
                        </div>
                        <label class="hp-tpl-search"><NvIcon name="search" /><input v-model="tplQ" type="search" placeholder="搜索模板" aria-label="搜索模板" autocomplete="off" /><button v-if="tplQ" type="button" aria-label="清空" @click="tplQ = ''"><NvIcon name="x" /></button></label>
                    </div>
                    <p v-if="!templates.length" class="hp-tpl-empty">没有找到「{{ tplQ }}」相关的模板</p>
                    <div class="hp-grid" :class="{ 'is-search': isTplSearch }">
                        <button v-for="(t, i) in templates" :key="t.id" type="button" class="hp-card" :class="bentoClass(i)" :title="t.desc" @pointerenter="cardVideoIn" @pointerleave="cardVideoOut" @click="openPreview(t)">
                            <img :src="t.media" alt="" loading="lazy" />
                            <video v-if="t.video" :src="t.video" muted loop playsinline preload="none" aria-hidden="true"></video>
                            <span class="tag">{{ t.cat }}</span>
                            <span class="use" title="直接用这个模板新建画布" @click.stop="useTemplate(t.id)"><NvIcon name="plus" />用这个模板</span>
                            <span class="t"><b>{{ t.title }}</b><small>{{ t.desc }}</small></span>
                        </button>
                    </div>
                </section>
            </div>
        </div>
        <!-- 底部同款渐变磨砂 -->
        <!-- 底部渐变磨砂已挪到外壳（App.vue 的 .bt-fx），首页 / 画布列表 / 素材库 / 应用市场共用 -->

        <!-- 素材库选择 -->
        <Teleport to="#nv-layer">
            <Transition name="hp-fade"><div v-if="picker.open" class="hp-scrim" @click="picker.open = false"></div></Transition>
            <Transition name="hp-drawer">
                <aside v-if="picker.open" class="hp-drawer" aria-label="从素材库选择">
                    <div class="hd"><h3>从素材库选择<small>点一下加进输入框</small></h3><button type="button" class="hp-x" aria-label="关闭" @click="picker.open = false"><NvIcon name="x" /></button></div>
                    <div class="tools">
                        <div class="hp-seg"><button v-for="k in [['all','全部'],['image','图片'],['video','视频']]" :key="k[0]" type="button" :class="{ on: picker.kind === k[0] }" @click="picker.kind = k[0]">{{ k[1] }}</button></div>
                        <label class="hp-search grow"><NvIcon name="search" /><input v-model="picker.q" placeholder="搜索素材" autocomplete="off" /></label>
                    </div>
                    <div class="body">
                        <div v-if="picker.loading" class="hp-empty">正在读取素材库…</div>
                        <div v-else-if="!pickerItems.length" class="hp-empty">{{ picker.items.length ? '没有匹配的素材' : '素材库还是空的，可以先在「素材库」里上传' }}</div>
                        <div v-else class="grid">
                            <button v-for="a in pickerItems" :key="a.id" type="button" class="as" :title="a.name" @click="pickAsset(a)">
                                <video v-if="a.kind === 'video'" :src="a.url" muted preload="metadata"></video>
                                <img v-else :src="thumbUrl(a.thumb || a.url)" alt="" loading="lazy" />
                                <span class="k">{{ a.kind === 'video' ? '视频' : a.kind === 'audio' ? '音频' : '图片' }}</span>
                            </button>
                        </div>
                    </div>
                </aside>
            </Transition>
        </Teleport>

        <TemplatePreview v-if="preview" :template="preview" :busy="busy" @close="preview = null" @use="usePreviewed()" @agent="usePreviewed({ agent: true })" />
    </div>
</template>

<style scoped>
.hp { position: absolute; inset: 0; background: var(--shell-bg); color: var(--ink); --hp-panel: rgba(255,255,255,.82); --hp-card: rgba(0,0,0,.04); --hp-card-h: rgba(0,0,0,.07); --hp-pop: #fff; --hp-ill: #c7c7cc; --hp-ill-2: #e5e5ea; --hp-ill-n: #fff; --hp-glass: rgba(255,255,255,.55); --hp-glass-h: rgba(255,255,255,.72); }
.hp-scroll { position: absolute; inset: 0; overflow: auto; }
.hp-inner { max-width: 1180px; margin: 0 auto; padding: calc(var(--tbh) + 36px) 24px 96px; display: flex; flex-direction: column; align-items: center; }

/* 标题打字机 */
.hp-title { margin: 20px 0 22px; min-height: 1.4em; font: 600 26px/1.3 var(--font-sans); letter-spacing: -.01em; display: flex; align-items: center; justify-content: center; text-align: center; }
.hp-title > span:first-child { white-space: pre; }
.hp-caret { display: inline-block; width: 2px; height: 1.05em; margin-left: 4px; border-radius: 1px; background: var(--ink); animation: hpBlink 1s steps(1) infinite; }
.hp-caret.typing { animation: none; }
@keyframes hpBlink { 50% { opacity: 0; } }

/* 输入框：画布助手 composer 放大版，磨砂浮卡 */
.hp-composer { position: relative; z-index: 10; width: 100%; max-width: 780px; border-radius: 20px; background: var(--hp-panel); backdrop-filter: var(--material-thick); -webkit-backdrop-filter: var(--material-thick);
    box-shadow: var(--shadow-lift); padding: 14px 14px 12px; transition: box-shadow var(--duration-fast) var(--ease-out); }
.hp-composer.drag { box-shadow: var(--shadow-lift), 0 0 0 2px var(--ink-4); }
.hp-composer.shaking { animation: hpShake .4s; }
@keyframes hpShake { 20%, 60% { transform: translateX(-5px); } 40%, 80% { transform: translateX(5px); } }

/* 流光边框：npm border-beam@1.4.1 原版移植（size=md / colorVariant=colorful / borderRadius=20）。
   结构与数值照官方：容器转 --beam-angle-hp + 淡入 --beam-opacity-hp；::after 是 1px 环（白/黑扫光 conic + 9 颗彩色径向光斑）；
   ::before 是跟着扫光走的内层泛光；[data-beam-bloom] 是 blur(8px) 的外泛光。test1 → hp；
   深浅色只差 9 处（环与泛光颜色、三层不透明度、内阴影、bloom 饱和度），用变量切。
   与官方的两处差别（2026-11 流畅度）：① 官方 1.96s 一圈是按 348 宽的 demo 卡的，780 宽卡上每帧位移太大，放慢到
   --beam-duration: 3.6s；② 去掉官方 12s 的 hue-shift（两个全尺寸 filter 动画，纯烧 GPU），彩色光斑用静态配色。
   官方在这里有 overflow: hidden，去掉——技能/插件弹层要伸到卡片外。 */
@property --beam-angle-hp { syntax: "<angle>"; initial-value: 0deg; inherits: true; }
@property --beam-opacity-hp { syntax: "<number>"; initial-value: 0; inherits: true; }

[data-beam="hp"] {
    position: relative;
    border-radius: 20px;
    --hp-ring-rgb: 0, 0, 0;
    --hp-ring-a1: 0.08; --hp-ring-a2: 0.2; --hp-ring-a3: 0.4; --hp-ring-a4: 0.55;
    --hp-stroke-opacity: 0.12;
    --hp-inner-shadow: rgba(0, 0, 0, 0.14);
    --hp-inner-opacity: 0.26;
    --hp-bloom-rgb: 0, 0, 0;
    --hp-bloom-a1: 0.02; --hp-bloom-a4: 0.4; --hp-bloom-a5: 0.6;
    --hp-bloom-saturate: 1.5;
    --hp-bloom-opacity: 0.34;
}
html.theme-dark [data-beam="hp"] {
    --hp-ring-rgb: 255, 255, 255;
    --hp-ring-a1: 0.1; --hp-ring-a2: 0.3; --hp-ring-a3: 0.6; --hp-ring-a4: 0.75;
    --hp-stroke-opacity: 0.26;
    --hp-inner-shadow: rgba(255, 255, 255, 0.27);
    --hp-inner-opacity: 0.42;
    --hp-bloom-rgb: 255, 255, 255;
    --hp-bloom-a1: 0.03; --hp-bloom-a4: 0.45; --hp-bloom-a5: 0.85;
    --hp-bloom-saturate: 1.2;
    --hp-bloom-opacity: 0.24;
}

[data-beam="hp"][data-active] {
    --beam-duration: 3.6s;
    animation: beam-spin-hp var(--beam-duration) linear infinite, beam-fade-in-hp 0.6s ease forwards;
}
[data-beam="hp"][data-fading] {
    --beam-duration: 3.6s;
    animation: beam-spin-hp var(--beam-duration) linear infinite, beam-fade-out-hp 0.5s ease forwards;
}

[data-beam="hp"][data-active]::after,
[data-beam="hp"][data-fading]::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 19px;
    padding: 1px;
    clip-path: inset(0 round 20px);
    background: conic-gradient(
            from var(--beam-angle-hp),
            transparent 0%, transparent 54%,
            rgba(var(--hp-ring-rgb), var(--hp-ring-a1)) 57%,
            rgba(var(--hp-ring-rgb), var(--hp-ring-a2)) 60%,
            rgba(var(--hp-ring-rgb), var(--hp-ring-a3)) 63%,
            rgba(var(--hp-ring-rgb), var(--hp-ring-a4)) 66%,
            rgba(var(--hp-ring-rgb), var(--hp-ring-a3)) 69%,
            rgba(var(--hp-ring-rgb), var(--hp-ring-a2)) 72%,
            rgba(var(--hp-ring-rgb), var(--hp-ring-a1)) 75%,
            transparent 78%, transparent 100%
        ),
        radial-gradient(ellipse 70px 40px at 33% -7.4%, rgb(255, 50, 100), transparent),
        radial-gradient(ellipse 60px 35px at 12% -5%, rgb(40, 140, 255), transparent),
        radial-gradient(ellipse 40px 70px at 2.1% 68.3%, rgb(50, 200, 80), transparent),
        radial-gradient(ellipse 20px 35px at 2.1% 68.3%, rgb(30, 185, 170), transparent),
        radial-gradient(ellipse 180px 32px at 74.4% 100%, rgb(100, 70, 255), transparent),
        radial-gradient(ellipse 85px 26px at 55% 100%, rgb(40, 140, 255), transparent),
        radial-gradient(ellipse 74px 32px at 93.9% 0%, rgb(255, 120, 40), transparent),
        radial-gradient(ellipse 26px 42px at 100% 27.1%, rgb(240, 50, 180), transparent),
        radial-gradient(ellipse 52px 48px at 100% 27.1%, rgb(180, 40, 240), transparent);
    -webkit-mask:
        conic-gradient(
            from var(--beam-angle-hp),
            transparent 0%, transparent 30%,
            rgba(255, 255, 255, 0.1) 36%, rgba(255, 255, 255, 0.35) 44%,
            white 52%, white 80%,
            rgba(255, 255, 255, 0.35) 86%, rgba(255, 255, 255, 0.1) 92%,
            transparent 95%, transparent 100%
        ),
        linear-gradient(#fff 0 0) content-box,
        linear-gradient(#fff 0 0);
    -webkit-mask-composite: source-in, xor;
    mask:
        conic-gradient(
            from var(--beam-angle-hp),
            transparent 0%, transparent 30%,
            rgba(255, 255, 255, 0.1) 36%, rgba(255, 255, 255, 0.35) 44%,
            white 52%, white 80%,
            rgba(255, 255, 255, 0.35) 86%, rgba(255, 255, 255, 0.1) 92%,
            transparent 95%, transparent 100%
        ),
        linear-gradient(#fff 0 0) content-box,
        linear-gradient(#fff 0 0);
    mask-composite: intersect, exclude;
    pointer-events: none;
    z-index: 2;
    opacity: calc(var(--beam-opacity-hp) * var(--hp-stroke-opacity) * var(--beam-stroke-opacity, 1) * var(--beam-strength, 1));
}

[data-beam="hp"][data-active]::before,
[data-beam="hp"][data-fading]::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 20px;
    background: radial-gradient(ellipse 63px 36px at 33% -7.4%, rgba(255, 50, 100, 0.45), transparent),
        radial-gradient(ellipse 54px 32px at 12% -5%, rgba(40, 140, 255, 0.45), transparent),
        radial-gradient(ellipse 36px 63px at 2.1% 68.3%, rgba(50, 200, 80, 0.45), transparent),
        radial-gradient(ellipse 18px 32px at 2.1% 68.3%, rgba(30, 185, 170, 0.45), transparent),
        radial-gradient(ellipse 162px 29px at 74.4% 100%, rgba(100, 70, 255, 0.45), transparent),
        radial-gradient(ellipse 77px 23px at 55% 100%, rgba(40, 140, 255, 0.45), transparent),
        radial-gradient(ellipse 67px 29px at 93.9% 0%, rgba(255, 120, 40, 0.45), transparent),
        radial-gradient(ellipse 23px 38px at 100% 27.1%, rgba(240, 50, 180, 0.45), transparent),
        radial-gradient(ellipse 47px 43px at 100% 27.1%, rgba(180, 40, 240, 0.45), transparent);
    box-shadow: inset 0 0 9px 1px var(--hp-inner-shadow);
    -webkit-mask-image:
        conic-gradient(
            from var(--beam-angle-hp),
            transparent 0%, transparent 30%,
            rgba(255, 255, 255, 0.1) 36%, rgba(255, 255, 255, 0.35) 44%,
            white 52%, white 80%,
            rgba(255, 255, 255, 0.35) 86%, rgba(255, 255, 255, 0.1) 92%,
            transparent 95%, transparent 100%
        ),
        linear-gradient(white, transparent 28px, transparent calc(100% - 28px), white),
        linear-gradient(to right, white, transparent 28px, transparent calc(100% - 28px), white);
    -webkit-mask-composite: source-in, source-over;
    mask-image:
        conic-gradient(
            from var(--beam-angle-hp),
            transparent 0%, transparent 30%,
            rgba(255, 255, 255, 0.1) 36%, rgba(255, 255, 255, 0.35) 44%,
            white 52%, white 80%,
            rgba(255, 255, 255, 0.35) 86%, rgba(255, 255, 255, 0.1) 92%,
            transparent 95%, transparent 100%
        ),
        linear-gradient(white, transparent 28px, transparent calc(100% - 28px), white),
        linear-gradient(to right, white, transparent 28px, transparent calc(100% - 28px), white);
    mask-composite: intersect, add;
    pointer-events: none;
    z-index: 1;
    opacity: calc(var(--beam-opacity-hp) * var(--hp-inner-opacity) * var(--beam-inner-opacity, 1) * var(--beam-strength, 1));
    clip-path: inset(0 round 20px);
}

[data-beam="hp"] [data-beam-bloom] {
    display: none;
    position: absolute;
    inset: 0;
    border-radius: 19px;
    clip-path: inset(0 round 20px);
    background: conic-gradient(
        from var(--beam-angle-hp),
        transparent 0%, transparent 58%,
        rgba(var(--hp-bloom-rgb), var(--hp-bloom-a1)) 62%,
        rgba(var(--hp-bloom-rgb), 0.08) 65%,
        rgba(var(--hp-bloom-rgb), 0.2) 67%,
        rgba(var(--hp-bloom-rgb), var(--hp-bloom-a4)) 69%,
        rgba(var(--hp-bloom-rgb), var(--hp-bloom-a5)) 70%,
        rgba(var(--hp-bloom-rgb), var(--hp-bloom-a5)) 70.5%,
        rgba(var(--hp-bloom-rgb), var(--hp-bloom-a4)) 71.5%,
        rgba(var(--hp-bloom-rgb), 0.2) 73%,
        rgba(var(--hp-bloom-rgb), 0.08) 75%,
        rgba(var(--hp-bloom-rgb), var(--hp-bloom-a1)) 78%,
        transparent 82%
    );
    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    mask-composite: exclude;
    padding: 1px;
    filter: blur(8px) brightness(1.30) saturate(var(--hp-bloom-saturate));
    pointer-events: none;
    z-index: 3;
    opacity: 0;
}
[data-beam="hp"][data-active] [data-beam-bloom],
[data-beam="hp"][data-fading] [data-beam-bloom] {
    display: block;
    opacity: calc(var(--beam-opacity-hp) * var(--hp-bloom-opacity) * var(--beam-bloom-opacity, 1) * var(--beam-strength, 1));
}

@keyframes beam-spin-hp {
    to { --beam-angle-hp: 360deg; }
}
@keyframes beam-fade-in-hp {
    to { --beam-opacity-hp: 1; }
}
@keyframes beam-fade-out-hp {
    from { --beam-opacity-hp: 1; }
    to { --beam-opacity-hp: 0; }
}
[data-beam="hp"][data-paused],
[data-beam="hp"][data-paused]::after,
[data-beam="hp"][data-paused]::before,
[data-beam="hp"][data-paused] [data-beam-bloom] {
    animation-play-state: paused !important;
}

/* 关动效时容器没有 fade-in，--beam-opacity-hp 会停在 0（光消失），显式给 1 留一帧静态光 */
@media (prefers-reduced-motion: reduce) {
    [data-beam="hp"],
    [data-beam="hp"]::before,
    [data-beam="hp"]::after,
    [data-beam="hp"] [data-beam-bloom] { animation: none !important; }
    [data-beam="hp"] { --beam-opacity-hp: 1; }
}
.hp-attached { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 4px 8px; }
.hp-att { height: 30px; max-width: 220px; padding: 0 6px 0 3px; border-radius: 9px; background: var(--hp-card); display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
.hp-att img, .hp-att .gi { width: 24px; height: 24px; border-radius: 6px; object-fit: cover; flex-shrink: 0; }
.hp-att .gi { background: var(--hp-card-h); display: flex; align-items: center; justify-content: center; color: var(--ink-3); }
.hp-att .gi .nv-i, .hp-att.skill > .nv-i { width: 13px; height: 13px; }
.hp-att.skill { padding-left: 9px; }
.hp-att.skill > .nv-i { color: var(--ink-3); }
.hp-att.loading { opacity: .6; }
.hp-att > span:not(.gi) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hp-att button { width: 18px; height: 18px; border: 0; border-radius: 9px; background: transparent; color: var(--ink-3); display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; }
.hp-att button:hover { background: var(--hp-card-h); color: var(--ink); }
.hp-att button .nv-i { width: 11px; height: 11px; }
.hp-input { position: relative; display: block; width: 100%; box-sizing: border-box; min-height: 86px; max-height: 240px; overflow-y: auto; border: 0; outline: none; background: transparent; padding: 4px 6px; color: var(--ink); font: 400 14px/1.75 var(--font-sans); box-shadow: none; white-space: pre-wrap; word-break: break-word; cursor: text; }
.hp-input:focus { outline: none; box-shadow: none; background: transparent; }
.hp-input.empty::before { content: attr(data-placeholder); position: absolute; left: 6px; right: 6px; top: 4px; color: var(--ink-4); pointer-events: none; white-space: pre-wrap; }
.hp-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; }
.hp-left { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.hp-chip { height: 30px; padding: 0 10px; border: 0; border-radius: 15px; background: var(--hp-card); color: var(--ink-2); display: inline-flex; align-items: center; gap: 5px; font: 500 12px/1 var(--font-sans); cursor: pointer;
    transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out); }
.hp-chip .nv-i { width: 14px; height: 14px; }
.hp-chip:hover, .hp-chip.open { background: var(--hp-card-h); color: var(--ink); }
.hp-chip.ghost { background: transparent; }
.hp-chip.ic { width: 30px; padding: 0; justify-content: center; }
.hp-chip .n { font-size: 11px; color: var(--ink-4); }
.hp-model-chip .mn { max-width: 118px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hp-model-chip .cd { width: 12px; height: 12px; color: var(--ink-4); flex-shrink: 0; }
.hp-model-chip.open .cd { color: var(--ink-2); }

/* 对话模型：画布助手式两级菜单（一级供应商 hover 开二级模型），磨砂玻璃。
   Teleport 到 #nv-layer + fixed：composer 自己是 backdrop root，留在里面磨砂会采样不到页面背景、变成平色，二级还会被裁。 */
.hp-pop.hp-model-wrap {
    position: fixed; z-index: 60; width: auto; padding: 0; background: transparent; box-shadow: none;
    /* .hp 上的页面变量 Teleport 出去后拿不到，这里补一份 */
    --hp-pop: #fff; --hp-card: rgba(0, 0, 0, .04); --hp-card-h: rgba(0, 0, 0, .07);
}
html.theme-dark .hp-pop.hp-model-wrap { --hp-pop: #1e1e20; --hp-card: rgba(255, 255, 255, .04); --hp-card-h: rgba(255, 255, 255, .07); }
/* 磨砂玻璃（一级 / 二级共用）+ 柔和投影；零 border / 零发丝线。 */
.hp-mpanel {
    width: 300px; padding: 6px; border-radius: 14px; border: 0;
    background: color-mix(in srgb, var(--hp-pop) 86%, transparent);
    -webkit-backdrop-filter: blur(42px) saturate(180%);
    backdrop-filter: blur(42px) saturate(180%);
    box-shadow: 0 18px 40px rgba(0, 0, 0, .14), 0 4px 12px rgba(0, 0, 0, .07);
}
html.theme-dark .hp-mpanel { box-shadow: 0 18px 40px rgba(0, 0, 0, .36), 0 4px 12px rgba(0, 0, 0, .22); }
/* 二级子菜单：绝对定位在一级面板左侧，right:100% 贴边（中间不留缝），top = 当前供应商行（内联 style 覆盖） */
.hp-mpanel-models { position: absolute; top: 0; right: 100%; width: 300px; display: flex; flex-direction: column; z-index: 2; }
.hp-mpanel-hd { display: flex; align-items: baseline; gap: 6px; padding: 4px 8px 6px; }
.hp-mpanel-hd b { font: 400 11px/1.2 var(--font-sans); color: var(--ink-3); }
.hp-mpanel-hd small { font-size: 11px; color: var(--ink-4); }
.hp-mv-list { display: flex; flex-direction: column; gap: 2px; max-height: 240px; overflow: auto; }
.hp-effort { margin: 4px 0 2px; }
.hp-mv { min-height: 36px; padding: 0 8px; border: 0; border-radius: 9px; background: transparent; color: var(--ink-2); display: flex; align-items: center; gap: 6px;
    font: 400 13px/1 var(--font-sans); cursor: pointer; text-align: left; transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out); }
.hp-mv:hover, .hp-mv.on { background: var(--hp-card-h); color: var(--ink); }
.hp-mv.cur { background: var(--hp-card); color: var(--ink); }
.hp-mv.def { min-height: 40px; padding: 6px 8px; }
.hp-mv .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hp-mv.def .nm { white-space: normal; }
.hp-mv .nm small { display: block; font-size: 11px; color: var(--ink-4); margin-top: 2px; }
.hp-mv .n { font-size: 11px; color: var(--ink-4); flex-shrink: 0; }
.hp-mv .chk { width: 13px; height: 13px; color: var(--ink); flex-shrink: 0; }
.hp-mv .ar { width: 12px; height: 12px; color: var(--ink-4); flex-shrink: 0; }
.hp-mpanel-foot { display: flex; justify-content: space-between; gap: 8px; padding: 8px 8px 2px; margin-top: 4px; }
.hp-mpanel-foot button { border: 0; background: transparent; padding: 0; color: var(--ink-3); font: 400 11px/1.4 var(--font-sans); cursor: pointer; }
.hp-mpanel-models .hp-search { margin-bottom: 4px; }
.hp-mpanel-models .hp-list { max-height: 300px; }
/* 二级模型列表：Prompt Input 版式 —— 行高 38px、13px 左对齐，选中不铺色块，只在右侧出 14px 线性对勾 + 字重 600 */
.hp-mpanel-models .hp-it { min-height: 38px; padding: 0 10px; border-radius: 9px; gap: 8px; }
.hp-mpanel-models .hp-it .tx { min-width: 0; }
.hp-mpanel-models .hp-it b { font-size: 13px; font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hp-mpanel-models .hp-it.cur { background: transparent; }
.hp-mpanel-models .hp-it.cur b { font-weight: 600; }
.hp-mpanel-models .hp-it .chk { width: 14px; height: 14px; color: var(--ink); flex-shrink: 0; }
.hp-right { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.hp-send { width: 34px; height: 34px; border: 0; border-radius: 50%; background: var(--accent); color: var(--on-accent); display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; transition: opacity var(--duration-fast), transform var(--duration-instant); }
.hp-send:active { transform: scale(.94); }
.hp-send:disabled { opacity: .3; cursor: default; transform: none; }
.hp-send .nv-i { width: 16px; height: 16px; }
.hp-spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: hpSpin .7s linear infinite; }
@keyframes hpSpin { to { transform: rotate(360deg); } }

/* 弹层：实底 + 投影，无描边；opacity + 4px 位移 */
.hp-pop { position: absolute; top: calc(100% - 6px); z-index: 30; width: 340px; max-width: calc(100vw - 48px); padding: 8px; border-radius: 16px; background: var(--hp-pop); box-shadow: var(--shadow-pop); }
.hp-pop-enter-active, .hp-pop-leave-active { transition: opacity .14s ease, transform .14s ease; }
.hp-pop-enter-from, .hp-pop-leave-to { opacity: 0; transform: translateY(4px); }
.hp-search { height: 32px; border-radius: 10px; background: var(--hp-card); display: flex; align-items: center; gap: 6px; padding: 0 10px; color: var(--ink-4); margin-bottom: 4px; }
.hp-search .nv-i { width: 13px; height: 13px; flex-shrink: 0; }
.hp-search input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--ink); font: 400 12px/1 var(--font-sans); box-shadow: none; }
.hp-search:focus-within { background: var(--hp-card-h); }
.hp-list { max-height: 300px; overflow: auto; }
.hp-grp { font-size: 11px; color: var(--ink-4); padding: 8px 8px 4px; }
.hp-it { width: 100%; display: flex; align-items: center; gap: 10px; padding: 7px 8px; border: 0; border-radius: 10px; background: transparent; color: var(--ink); text-align: left; cursor: pointer; font-family: var(--font-sans); }
.hp-it:hover { background: var(--hp-card-h); }
.hp-mention .hp-it:hover { background: transparent; }
.hp-mention .hp-it.cur { background: var(--hp-card-h); }
.hp-mention .hp-it:disabled { cursor: default; opacity: .55; }
.hp-mention .ic.th { overflow: hidden; padding: 0; }
.hp-mention .ic.th img { width: 100%; height: 100%; object-fit: cover; }
.hp-mention.grid { width: 372px; }
.hp-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; padding: 2px 4px 6px; }
.hp-tile { min-width: 0; padding: 4px; border: 0; border-radius: 10px; background: transparent; cursor: pointer; color: var(--ink); font-family: var(--font-sans); display: flex; flex-direction: column; gap: 4px; }
.hp-tile.cur { background: var(--hp-card-h); }
.hp-tile .tm { position: relative; display: flex; align-items: center; justify-content: center; aspect-ratio: 1; border-radius: 8px; overflow: hidden; background: var(--hp-card); color: var(--ink-3); }
.hp-tile .tm img { width: 100%; height: 100%; object-fit: cover; display: block; }
.hp-tile .tm > .nv-i { width: 18px; height: 18px; }
.hp-tile .tm .bd { position: absolute; right: 4px; bottom: 4px; width: 16px; height: 16px; border-radius: 5px; background: rgba(0,0,0,.5); color: #fff; display: flex; align-items: center; justify-content: center; }
.hp-tile .tm .bd .nv-i { width: 9px; height: 9px; }
.hp-tile .nm { font-size: 11px; line-height: 14px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; }
.hp-tile.cur .tm { box-shadow: 0 0 0 2px var(--ink); }
.hp-mention .hp-foot span { color: var(--ink-4); font: 400 11px/1.4 var(--font-sans); }
.hp-it:disabled { opacity: .5; cursor: default; }
.hp-it .ic { width: 28px; height: 28px; border-radius: 8px; background: var(--hp-card); display: flex; align-items: center; justify-content: center; color: var(--ink-3); flex-shrink: 0; }
.hp-it .ic .nv-i { width: 14px; height: 14px; }
.hp-it .tx { flex: 1; min-width: 0; }
.hp-it b { display: block; font-size: 12px; font-weight: 500; }
.hp-it small { display: block; font-size: 11px; color: var(--ink-3); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hp-it .chk { width: 14px; height: 14px; }
.hp-sw { width: 26px; height: 15px; border-radius: 8px; background: var(--fill-3); position: relative; flex-shrink: 0; transition: background .14s ease; }
.hp-sw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 11px; height: 11px; border-radius: 50%; background: var(--solid); transition: transform .14s ease; }
.hp-it[aria-pressed="true"] .hp-sw { background: var(--ink); }
.hp-it[aria-pressed="true"] .hp-sw::after { transform: translateX(11px); }
.hp-foot { display: flex; justify-content: space-between; gap: 8px; padding: 8px 8px 2px; margin-top: 4px; }
.hp-foot button { border: 0; background: transparent; padding: 0; color: var(--ink-3); font: 400 11px/1.4 var(--font-sans); cursor: pointer; }
.hp-foot button:hover { color: var(--ink); }
.hp-empty { padding: 18px 8px; text-align: center; color: var(--ink-4); font-size: 12px; }

/* 快速开始 */
.hp-quick { width: 100%; max-width: 780px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 28px; }
.hp-q { border: 0; background: transparent; padding: 0; text-align: left; color: var(--ink); cursor: pointer; font-family: var(--font-sans); }
.hp-q .art { height: 108px; border-radius: 14px; background: var(--hp-card); display: flex; align-items: center; justify-content: center; transition: background var(--duration-fast), transform var(--duration-base) var(--ease-out); }
.hp-q:hover .art { background: var(--hp-card-h); transform: translateY(-2px); }
.hp-q .art svg { width: 150px; height: 84px; max-width: 90%; }
.hp-q .art.plus .nv-i { width: 28px; height: 28px; color: var(--ink-3); }
.hp-q .art .n { fill: var(--hp-ill-n); stroke: var(--hp-ill); }
.hp-q .art .f { fill: var(--hp-ill-2); }
.hp-q .art .f2 { fill: var(--hp-ill-2); stroke: var(--hp-ill); }
.hp-q .art .ln { stroke: var(--hp-ill); }
.hp-q .art .pt { fill: var(--shell-bg); stroke: var(--hp-ill); }
.hp-q .art .d { fill: var(--hp-ill); }
.hp-q .lb { display: block; font-size: 12px; font-weight: 500; margin-top: 8px; padding-left: 2px; }
.hp-q .ds { display: block; font-size: 11px; color: var(--ink-3); padding-left: 2px; margin-top: 2px; }

/* 最新项目 */
.hp-recent { width: 100%; max-width: 780px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 28px; }
.hp-new, .hp-pj { min-width: 0; border: 0; border-radius: 18px; background: var(--hp-glass); backdrop-filter: blur(24px) saturate(160%); -webkit-backdrop-filter: blur(24px) saturate(160%); color: var(--ink); cursor: pointer; font-family: var(--font-sans); text-align: left; transition: background var(--duration-fast), transform var(--duration-base) var(--ease-out); }
.hp-new:hover, .hp-pj:hover { background: var(--hp-glass-h); transform: translateY(-2px); }
.hp-new { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 196px; font: 500 13px/1 var(--font-sans); }
.hp-new .nv-i { width: 22px; height: 22px; color: var(--ink-2); }
.hp-pj { display: flex; flex-direction: column; gap: 8px; padding: 6px; overflow: hidden; }
.hp-pj .cv { position: relative; display: block; aspect-ratio: 16 / 10; border-radius: 12px; overflow: hidden; background: var(--hp-card); }
.hp-pj .cv img { width: 100%; height: 100%; object-fit: cover; display: block; }
.hp-pj .cv .ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--ink-4); }
.hp-pj .cv .ph .nv-i { width: 20px; height: 20px; }
.hp-pj .cv.art { display: flex; align-items: center; justify-content: center; }
.hp-pj .cv.art svg { width: 130px; height: 74px; max-width: 86%; }
.hp-pj .cv.art .n { fill: var(--hp-ill-n); stroke: var(--hp-ill); }
.hp-pj .cv.art .f { fill: var(--hp-ill-2); }
.hp-pj .cv.art .f2 { fill: var(--hp-ill-2); stroke: var(--hp-ill); }
.hp-pj .cv.art .ln { stroke: var(--hp-ill); }
.hp-pj .cv.art .pt { fill: var(--shell-bg); stroke: var(--hp-ill); }
.hp-pj .cv.art .d { fill: var(--hp-ill); }
.hp-pj .mt { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; gap: 8px; padding: 0 4px; min-width: 0; overflow: hidden; }
.hp-pj .mt b { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 12px/16px var(--font-sans); color: var(--ink-2); }
.hp-pj .mt em { min-width: 0; overflow: hidden; text-overflow: ellipsis; font: normal 400 11px/16px var(--font-sans); color: var(--ink-3); white-space: nowrap; }
.hp-pj .go { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 10px; border-radius: 10px; background: var(--hp-card); }
.hp-pj:hover .go { background: var(--hp-card-h); }
.hp-pj .go span { flex: 1; min-width: 0; font: 500 12px/1 var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hp-pj .go .ne { width: 13px; height: 13px; color: var(--ink-3); transform: rotate(-90deg); flex: none; transition: transform var(--duration-fast) var(--ease-out), color var(--duration-fast); }
.hp-pj:hover .go .ne { color: var(--ink); transform: rotate(-90deg) translate(1px, 1px); }
.hp-all { width: 100%; max-width: 780px; display: flex; justify-content: flex-end; margin-top: 10px; }
.hp-all button { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 6px; border: 0; border-radius: 8px; background: transparent; font: 400 12px/1 var(--font-sans); color: var(--ink-3); cursor: pointer; }
.hp-all button:hover { color: var(--ink); }
.hp-all .nv-i { width: 13px; height: 13px; }

/* 模板库 */
.hp-tpl { width: 100%; margin-top: 56px; }
.hp-tpl-head { display: flex; align-items: center; gap: 16px; margin-bottom: 14px; flex-wrap: wrap; }
.hp-tpl-head h2 { margin: 0; font: 600 15px/1.3 var(--font-sans); }
.hp-tabs { display: flex; gap: 2px; flex-wrap: wrap; }
/* 模板库右上角搜索（磨砂玻璃；点进去无描边/阴影/上浮） */
.hp-tpl-search { margin-left: auto; width: 220px; max-width: 100%; height: 32px; border-radius: 16px; padding: 0 6px 0 12px; display: flex; align-items: center; gap: 6px; color: var(--ink-4);
    background: var(--hp-glass); backdrop-filter: blur(24px) saturate(160%); -webkit-backdrop-filter: blur(24px) saturate(160%); transition: background var(--duration-fast); }
.hp-tpl-search:focus-within { background: var(--hp-glass-h); }
.hp-tpl-search .nv-i { width: 13px; height: 13px; flex: none; }
.hp-tpl-search input { flex: 1; min-width: 0; height: 100%; border: 0; outline: none; box-shadow: none; background: transparent; color: var(--ink); font: 400 12px/1 var(--font-sans); -webkit-appearance: none; appearance: none; }
.hp-tpl-search input::-webkit-search-cancel-button { display: none; }
.hp-tpl-search button { width: 22px; height: 22px; border: 0; border-radius: 11px; background: transparent; color: var(--ink-3); display: flex; align-items: center; justify-content: center; cursor: pointer; flex: none; }
.hp-tpl-search button:hover { background: var(--hp-card-h); color: var(--ink); }
.hp-tpl-search button .nv-i { width: 11px; height: 11px; }
.hp-tpl-empty { margin: 24px 0; text-align: center; font-size: 12px; color: var(--ink-3); }
@media (max-width: 720px) { .hp-tpl-search { margin-left: 0; width: 100%; } }
.hp-tabs button { height: 28px; padding: 0 12px; border: 0; border-radius: 14px; background: transparent; color: var(--ink-3); font: 500 12px/1 var(--font-sans); cursor: pointer; }
.hp-tabs button:hover { color: var(--ink); }
.hp-tabs button.on { background: var(--hp-card-h); color: var(--ink); }
.hp-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 16px; }
/* bento 栅格：每 5 张一组（2 大 16:9 + 3 小 4:3），尾组按剩余张数用 is-full / is-half / is-third 收尾 */
.hp-grid .hp-card.is-wide { grid-column: span 3; aspect-ratio: 16 / 9; }
.hp-grid .hp-card.is-half { grid-column: span 3; aspect-ratio: 16 / 9; }
.hp-grid .hp-card.is-small { grid-column: span 2; aspect-ratio: 4 / 3; }
.hp-grid .hp-card.is-third { grid-column: span 2; aspect-ratio: 4 / 3; }
.hp-grid .hp-card.is-full { grid-column: span 6; aspect-ratio: 21 / 9; }
.hp-grid:not(.is-search) .hp-card { border-radius: 20px; }
.hp-card.is-wide .t b { font-size: 16px; }
.hp-card.is-full .t b { font-size: 18px; }
/* 搜索态退回原来的 5 列等宽卡片 */
.hp-grid.is-search { grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 14px; }
/* <=1100 统一干净的两列：所有 bento 卡都占半宽、4:3，避免大小卡混排留半格空洞 */
@media (max-width: 1100px) {
    .hp-grid, .hp-grid.is-search { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .hp-grid .hp-card.is-wide, .hp-grid .hp-card.is-half, .hp-grid .hp-card.is-full, .hp-grid .hp-card.is-small, .hp-grid .hp-card.is-third { grid-column: span 1; aspect-ratio: 4 / 3; }
}
@media (max-width: 560px) {
    .hp-grid, .hp-grid.is-search { grid-template-columns: minmax(0, 1fr); }
    .hp-grid .hp-card.is-wide, .hp-grid .hp-card.is-half, .hp-grid .hp-card.is-full, .hp-grid .hp-card.is-small, .hp-grid .hp-card.is-third { grid-column: span 1; aspect-ratio: 4 / 3; }
}
.hp-card { position: relative; display: block; width: 100%; aspect-ratio: 3 / 4; border: 0; padding: 0; border-radius: 16px; overflow: hidden; background: var(--hp-card); text-align: left; cursor: pointer;
    transition: transform var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out); }
.hp-card img { width: 100%; height: 100%; object-fit: cover; display: block; }
.hp-card video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; opacity: 0; pointer-events: none; transition: opacity var(--duration-fast); }
.hp-card:hover video, .hp-card:focus-visible video { opacity: 1; }
.hp-card::after { content: ''; position: absolute; inset: 68% 0 0; background: linear-gradient(180deg, transparent 0%, rgba(0,0,0,.22) 40%, rgba(0,0,0,.66) 100%); -webkit-backdrop-filter: blur(18px) saturate(160%); backdrop-filter: blur(18px) saturate(160%); -webkit-mask-image: linear-gradient(180deg, transparent 0%, #000 50%); mask-image: linear-gradient(180deg, transparent 0%, #000 50%); pointer-events: none; }
.hp-card .t { position: absolute; left: 14px; right: 14px; bottom: 12px; z-index: 1; color: #fff; }
.hp-card .t b { display: block; font: 600 13px/1.3 var(--font-sans); }
.hp-card .t small { display: block; font-size: 11px; opacity: .8; margin-top: 3px; }
.hp-card .tag { position: absolute; top: 10px; left: 10px; z-index: 1; height: 22px; padding: 0 8px; border-radius: 11px; font-size: 11px; color: #fff; background: rgba(0,0,0,.32); backdrop-filter: blur(12px); display: flex; align-items: center; }
.hp-card .use { position: absolute; right: 10px; top: 10px; z-index: 1; height: 26px; padding: 0 10px; border-radius: 13px; background: rgba(0,0,0,.32); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); box-shadow: 0 4px 14px rgba(0,0,0,.18); color: #fff; font: 500 11px/1 var(--font-sans); display: flex; align-items: center; gap: 4px;
    opacity: 0; transform: translateY(-3px); transition: opacity .16s, transform .16s; }
.hp-card .use .nv-i { width: 12px; height: 12px; }
.hp-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
.hp-card:hover .use, .hp-card:focus-visible .use { opacity: 1; transform: none; }

/* 底部渐变磨砂（与标题栏同款，方向相反） */
.hp-bfx { position: absolute; left: 0; right: 0; bottom: 0; height: 72px; z-index: 5; pointer-events: none; }
.hp-bfx i { position: absolute; inset: 0; display: block; }
.hp-bfx i:nth-child(1) { backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); -webkit-mask: linear-gradient(to top, #000 45%, transparent); mask: linear-gradient(to top, #000 45%, transparent); }
.hp-bfx i:nth-child(2) { backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); -webkit-mask: linear-gradient(to top, #000 30%, transparent 75%); mask: linear-gradient(to top, #000 30%, transparent 75%); }
.hp-bfx i:nth-child(3) { backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%); -webkit-mask: linear-gradient(to top, #000 15%, transparent 55%); mask: linear-gradient(to top, #000 15%, transparent 55%); }
.hp-bfx i:nth-child(4) { background: linear-gradient(to top, var(--tb-tint), transparent 85%); }

@media (max-width: 640px) {
    .hp-inner { padding-left: 16px; padding-right: 16px; }
    .hp-quick, .hp-recent { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .hp-pop { left: 0 !important; width: calc(100vw - 48px) !important; }
    /* 模型菜单是 fixed 的 teleport 容器，不吃上面那条宽度/左对齐 */
    .hp-pop.hp-model-wrap { left: auto !important; width: auto !important; }
    /* 二级浮层贴在一级左侧：窄屏跟一级同宽，切换时不横向跳 */
    .hp-mpanel { width: 200px; }
}
@media (prefers-reduced-motion: reduce) { .hp-caret { display: none; } .hp-card, .hp-q .art { transition: none; } }
</style>

<style>
/* 深色：放非 scoped 块（scoped 下 :global(html.theme-dark) .x 会把整条选择器编译成 html.theme-dark） */
html.theme-dark .hp { --hp-panel: rgba(26,26,26,.74); --hp-card: rgba(255,255,255,.04); --hp-card-h: rgba(255,255,255,.07); --hp-pop: #1e1e20; --hp-ill: #4a4a4f; --hp-ill-2: #2a2a2d; --hp-ill-n: #1f1f22; --hp-glass: rgba(38,38,40,.52); --hp-glass-h: rgba(48,48,50,.62); }

/* 输入区里的标签：用 DOM API 插进 contenteditable，拿不到 scoped 属性，所以放这里 */
.hp-input .hp-tk { --tk-bg: #fff; --tk-bd: rgba(0,0,0,.12); --tk-ref: rgba(0,0,0,.05); display: inline-flex; align-items: center; gap: 5px; height: 24px; margin: 0 2px; padding: 0 8px 0 6px; vertical-align: middle; position: relative; top: -1px;
    border-radius: 8px; border: 1px solid var(--tk-bd); background: var(--tk-bg); color: var(--ink); font: 500 12.5px/1 var(--font-sans); white-space: nowrap; user-select: none; -webkit-user-select: none; cursor: default; }
.hp-input .hp-tk .nv-i { width: 13px; height: 13px; color: var(--ink-2); flex: none; }
.hp-input .hp-tk .nm { display: inline-block; white-space: nowrap; overflow: hidden; }
.hp-input .hp-tk .nm.long { max-width: 3.4em; -webkit-mask-image: linear-gradient(to right, #000 52%, transparent); mask-image: linear-gradient(to right, #000 52%, transparent); }
.hp-input .hp-tk.ref { padding-left: 3px; background: var(--tk-ref); border-color: transparent; box-shadow: inset 0 0 0 1px var(--tk-bd); }
.hp-input .hp-tk.ref .th { width: 18px; height: 18px; border-radius: 5px; object-fit: cover; flex: none; display: block; }
.hp-input .hp-tk.ref .th.ic { display: inline-flex; align-items: center; justify-content: center; background: var(--tk-bg); }
.hp-input .hp-tk.ref .th.ic .nv-i { width: 11px; height: 11px; }
.hp-input .hp-tk.ref .ix { font-weight: 400; font-size: 11.5px; color: var(--ink-3); }
html.theme-dark .hp-input .hp-tk { --tk-bg: #252528; --tk-bd: rgba(255,255,255,.14); --tk-ref: rgba(255,255,255,.06); }

/* 素材库选择抽屉：teleport 到 #nv-layer，样式不能 scoped */
.hp-scrim { position: fixed; inset: 0; z-index: 70; background: var(--scrim); }
.hp-drawer { position: fixed; z-index: 71; top: 12px; right: 12px; bottom: 12px; width: 420px; max-width: calc(100vw - 24px); border-radius: 18px; background: var(--solid); box-shadow: var(--shadow-dialog); display: flex; flex-direction: column; color: var(--ink); font-family: var(--font-sans); }
.hp-drawer .hd { display: flex; align-items: center; gap: 8px; padding: 16px 16px 10px; }
.hp-drawer h3 { margin: 0; flex: 1; font: 600 15px/1.3 var(--font-sans); }
.hp-drawer h3 small { margin-left: 8px; font-size: 11px; font-weight: 400; color: var(--ink-3); }
.hp-drawer .tools { display: flex; gap: 8px; align-items: center; padding: 0 16px 10px; }
.hp-drawer .hp-search { height: 32px; border-radius: 16px; background: var(--fill-1); display: flex; align-items: center; gap: 6px; padding: 0 12px; color: var(--ink-4); flex: 1; min-width: 0; }
.hp-drawer .hp-search .nv-i { width: 13px; height: 13px; }
.hp-drawer .hp-search input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--ink); font: 400 12px/1 var(--font-sans); box-shadow: none; }
.hp-drawer .hp-search:focus-within { background: var(--fill-2); }
.hp-seg { display: flex; gap: 2px; padding: 2px; border-radius: 10px; background: var(--fill-1); flex-shrink: 0; }
.hp-seg button { height: 26px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; color: var(--ink-3); font: 500 12px/1 var(--font-sans); cursor: pointer; }
.hp-seg button.on { background: var(--solid); color: var(--ink); box-shadow: var(--shadow-float); }
.hp-drawer .body { flex: 1; overflow: auto; padding: 0 16px 16px; }
.hp-drawer .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.hp-drawer .as { position: relative; aspect-ratio: 1; border: 0; padding: 0; border-radius: 12px; overflow: hidden; background: var(--fill-1); cursor: pointer; }
.hp-drawer .as img, .hp-drawer .as video { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .3s; }
.hp-drawer .as:hover img, .hp-drawer .as:hover video { transform: scale(1.04); }
.hp-drawer .as .k { position: absolute; left: 6px; bottom: 6px; height: 18px; padding: 0 6px; border-radius: 9px; font-size: 10.5px; color: #fff; background: rgba(0,0,0,.4); display: flex; align-items: center; }
.hp-drawer .hp-empty { padding: 40px 8px; text-align: center; color: var(--ink-4); font-size: 12px; }
.hp-x { width: 30px; height: 30px; border: 0; border-radius: 15px; background: transparent; color: var(--ink-3); display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; }
.hp-x:hover { background: var(--fill-1); color: var(--ink); }
.hp-x .nv-i { width: 16px; height: 16px; }
.hp-fade-enter-active, .hp-fade-leave-active { transition: opacity .2s; }
.hp-fade-enter-from, .hp-fade-leave-to { opacity: 0; }
.hp-drawer-enter-active, .hp-drawer-leave-active { transition: transform .28s cubic-bezier(.2,.8,.2,1); }
.hp-drawer-enter-from, .hp-drawer-leave-to { transform: translateX(calc(100% + 24px)); }
</style>
