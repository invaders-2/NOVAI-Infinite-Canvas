// GPT 对话 · 会话：会话列表 / 打开 / 新建 / 删除、附件上传、发送（chat 流式 / agent 流式 / image 普通请求）、
// 能力运行（挂上智能体 / 技能后发消息：会话作用域接口 + SSE 进度 → 对话里的一条助手消息）、
// 流式事件（meta / reasoning / status / delta / done / error）、中断、重新生成。
// 接口、请求体字段、localStorage key（gpt_chat_last_conversation_v1）与旧版完全一致。
import { reactive, nextTick } from 'vue';
import { S, userId, uuid, chatModelForRequest, providersOf, sizeOf, sizeOpts, saveSettings } from './chatState.js';
import { chatSizeFromPrompt } from './sizes.js';
import { thoughtTraceEntries } from './thought.js';
import { readSSE } from './sse.js';
import { CAP, clearCapability, descriptorOf, isGenerateImage, wantsGeneratedImage } from './agents/capState.js';
import { genImagePair } from './agents/genImageState.js';
import { runCapability, getRun, streamRun, normalizeRun, normalizeArtifacts, isTerminal } from './agents/capabilityApi.js';
import { t, toast } from '../../lib/store.js';

const LAST_KEY = 'gpt_chat_last_conversation_v1';
export const ATTACHMENT_MAX = 20;

export const C = reactive({
    conversations: [],
    current: null,          // 当前会话（服务端对象；新会话首条发送前为本地占位 {id:'', title:'新对话', messages:[]}）
    messages: [],           // 正在显示的消息（含本地的「进行中」气泡）
    refs: [],               // 输入框附件
    uploading: 0,
    busy: false,
    loaded: false,
});

// 消息区的滚动钩子（MessageList 注册）：scroll(force) / anchor() / restore(anchor)
export const hooks = { scroll() {}, anchor() { return null; }, restore() {} };
// 本次会话里测到的思考耗时（十分之一秒），done 后整表重建时用来显示「已思考 x.xs」
export const thoughtDurations = new Map();
let controller = null;
let inflight = null;
// 切换 / 新建 / 删除会话前先停掉还在进行的请求，等它收尾，免得它的结果落到新会话上
async function settleInflight() {
    if (!C.busy) return;
    stop();
    try { await inflight; } catch (e) {}
}

const headers = () => ({ 'Content-Type': 'application/json', 'X-User-ID': userId() });
function remember(id) { try { if (id) localStorage.setItem(LAST_KEY, id); else localStorage.removeItem(LAST_KEY); } catch (e) {} }
function remembered() { try { return localStorage.getItem(LAST_KEY) || ''; } catch (e) { return ''; } }

function setCurrent(conv) {
    C.current = conv;
    if (conv && conv.id) remember(conv.id);
}
// 整表重建：keepPosition = 用户在翻历史时不弹回底部
export function showMessages(list, opts = {}) {
    const anchor = opts.keepPosition ? hooks.anchor() : null;
    C.messages = list.map(m => ({ ...m, _key: m.id || m._key || uuid() }));
    nextTick(() => { if (anchor) hooks.restore(anchor); else hooks.scroll(true); });
}

/* ───────── 会话 ───────── */
export async function loadConversations() {
    let data;
    try { data = await fetch('/api/conversations', { headers: { 'X-User-ID': userId() } }).then(r => r.json()); }
    catch (e) { data = { conversations: [] }; }
    C.conversations = data.conversations || [];
    C.loaded = true;
    if (!C.current) {
        const rid = remembered();
        const target = (rid && C.conversations.find(c => c.id === rid)) || C.conversations[0];
        if (target) await openConversation(target.id);
    }
    if (!C.current) showMessages([]);
}

export async function openConversation(id) {
    await settleInflight();
    try {
        const data = await fetch(`/api/conversations/${id}`, { headers: { 'X-User-ID': userId() } }).then(r => r.json());
        if (!data || !data.conversation) return;
        setCurrent(data.conversation);
        showMessages(data.conversation.messages || []);
    } catch (e) {
        toast('打开对话失败', { danger: true, icon: 'alert' });
    }
}

export async function newConversation() {
    await settleInflight();
    try {
        const data = await fetch('/api/conversations', { method: 'POST', headers: headers(), body: JSON.stringify({ title: '新对话' }) }).then(r => r.json());
        setCurrent(data.conversation);
        await loadConversations();
        showMessages([]);
    } catch (e) {
        toast('新建对话失败', { danger: true, icon: 'alert' });
    }
}

export async function deleteConversation(id) {
    if (C.current && C.current.id === id) await settleInflight();
    try { await fetch(`/api/conversations/${id}`, { method: 'DELETE', headers: { 'X-User-ID': userId() } }); }
    catch (e) { toast('删除失败', { danger: true, icon: 'alert' }); return; }
    const wasCurrent = C.current && C.current.id === id;
    if (wasCurrent) { C.current = null; remember(''); showMessages([]); }
    C.conversations = C.conversations.filter(c => c.id !== id);
    await loadConversations();
}

/* ───────── 附件 ───────── */
export async function uploadFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    const available = Math.max(0, ATTACHMENT_MAX - C.refs.length);
    if (!available) { toast(`最多 ${ATTACHMENT_MAX} 个附件`, { icon: 'alert' }); return; }
    const form = new FormData();
    list.slice(0, available).forEach(f => form.append('files', f));
    C.uploading++;
    try {
        const r = await fetch('/api/ai/upload', { method: 'POST', body: form });
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).detail) || '上传失败');
        const data = await r.json();
        (data.files || []).forEach((item, i) => {
            // 能力运行走 multipart 上传原始文件，这里把选中的 File 留一份（对象展开后仍是原始 File）
            const raw = list[i] || list.find(x => x.name === item.name);
            C.refs.push(raw ? { ...item, file: raw } : item);
        });
    } catch (e) {
        toast(e.message || '上传失败', { danger: true, icon: 'alert' });
    } finally {
        C.uploading--;
    }
}
export function removeRef(i) { C.refs.splice(i, 1); }

export function isImageRef(ref) {
    const kind = String((ref && ref.kind) || '').toLowerCase();
    const mime = String((ref && ref.mime) || '').toLowerCase();
    const url = String((ref && ref.url) || '').toLowerCase();
    return kind === 'image' || mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|tiff?)(\?|#|$)/.test(url);
}
export function attachmentName(ref) { return (ref && ref.name) || String((ref && ref.url) || '').split('/').pop() || '附件'; }
export function imageUrlsOf(msg) {
    return Array.isArray(msg.image_urls) && msg.image_urls.length ? msg.image_urls : (msg.image_url ? [msg.image_url] : []);
}

/* ───────── 发送 ───────── */
function postJSON(url, body, signal) {
    return fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal });
}
async function failDetail(r) { return ((await r.json().catch(() => ({}))).detail) || t('chat.requestFailed', '请求失败'); }

// 本地「进行中」气泡的思考状态（ThoughtBlock 渲染）
function liveThought() { return { live: true, entries: [], start: performance.now(), tenths: null, settled: false, open: true }; }
function settle(th) {
    if (!th || th.settled) return;
    th.tenths = Math.floor((performance.now() - th.start) / 100);
    th.settled = true;
    th.open = false;
}

export function send(text, refsOverride) {
    if (C.busy) return Promise.resolve(false);
    // AI 生图走既有图像模式（/api/chat mode=image）；agent / skill 走会话作用域能力运行
    const runCap = CAP.selected && !isGenerateImage(CAP.selected);
    inflight = runCap ? doRunCapability(text) : doSend(text, refsOverride);
    return inflight;
}
async function doSend(text, refsOverride) {
    const message = String(text || '').trim();
    if (!message || C.busy) return false;
    const mode = S.mode;
    // capability 描述符要在清除挂载前取；AI 生图用完即卸（与能力运行一致）
    const capDescriptor = descriptorOf(CAP.selected);
    if (capDescriptor && capDescriptor.type === 'generate-image') clearCapability();
    const requestedSize = chatSizeFromPrompt(message, sizeOf(), S.chatResolution, sizeOpts.value);
    const pendingRefs = refsOverride ? refsOverride.slice() : C.refs.slice();
    if (!refsOverride) C.refs = [];
    if (!C.current) setCurrent({ id: '', title: '新对话', messages: [] });
    const userMsg = reactive({ _key: uuid(), role: 'user', content: message, attachments: pendingRefs, created_at: Date.now() });
    const live = reactive({
        _key: uuid(), role: 'assistant', live: true, streaming: mode === 'chat', created_at: Date.now(),
        content: mode === 'image' ? t('chat.generatingImage', '正在生成图片...') : '',
        pending: mode === 'image', thought: mode === 'image' ? null : liveThought(),
    });
    C.messages.push(userMsg, live);
    C.busy = true;
    controller = new AbortController();
    const signal = controller.signal;
    let gotMeta = false;
    hooks.scroll(true);

    const base = { conversation_id: C.current.id || '', message, system_prompt: String(S.systemPrompt || '').trim(), reference_images: pendingRefs, think_level: S.thinkLevel };
    if (capDescriptor) base.capability = capDescriptor;
    const chatModel = chatModelForRequest();
    const msModel = S.provider === 'modelscope' ? chatModel : '';
    try {
        if (mode === 'image') {
            const r = await postJSON('/api/chat', { ...base, mode, size: requestedSize, model: S.activeChatModel, image_model: S.activeImageModel, provider: S.activeImageProvider }, signal);
            if (!r.ok) throw new Error(await failDetail(r));
            const data = await r.json();
            setCurrent(data.conversation);
            showMessages(data.conversation.messages || []);
            await loadConversations();
        } else {
            const url = mode === 'agent' ? '/api/chat/agent/stream' : '/api/chat/stream';
            const body = mode === 'agent'
                ? { ...base, mode: 'agent', size: requestedSize, model: chatModel, ms_model: msModel, image_model: S.activeImageModel, provider: S.provider, image_provider: S.activeImageProvider }
                : { ...base, mode: 'chat', model: chatModel, ms_model: msModel, provider: S.provider };
            const r = await postJSON(url, body, signal);
            if (!r.ok) throw new Error(await failDetail(r));
            await readStream(r, live, () => { gotMeta = true; });
        }
    } catch (err) {
        const aborted = err && err.name === 'AbortError';
        const prior = (C.current && C.current.messages) || [];
        // 没收到 meta 时服务端会话里还没有这条用户消息：保留本地那条
        const list = gotMeta ? prior.slice() : prior.concat(userMsg);
        if (aborted) {
            const th = live.thought;
            if (th) settle(th);
            list.push({ ...live, live: false, streaming: false, pending: false, stopped: true, thought: th && th.entries.length ? th : null, content: live.pending ? '' : live.content });
        } else {
            list.push({ role: 'assistant', content: (err && err.message) || t('chat.requestFailed', '请求失败'), error: true });
        }
        showMessages(list, { keepPosition: true });
        if (aborted && gotMeta) loadConversations();
    } finally {
        C.busy = false;
        controller = null;
        hooks.scroll(false);
    }
    return true;
}

export function stop() { if (controller) controller.abort(); }

// 重新生成：用这条回复之前的那条用户消息（文本 + 附件）按当前设置再发一次
export function regenerate(msg) {
    const i = C.messages.indexOf(msg);
    for (let j = (i < 0 ? C.messages.length : i) - 1; j >= 0; j--) {
        const m = C.messages[j];
        if (m.role === 'user' && m.content) return send(m.content, m.attachments || []);
    }
    return false;
}

async function readStream(res, live, onMeta) {
    let full = '';
    let reasoning = '';
    const steps = [];
    const th = live.thought;
    const entries = () => thoughtTraceEntries(reasoning).concat(steps.map(text => ({ text, status: true })));
    await readSSE(res, async ev => {
        if (ev.type === 'meta') {
            onMeta();
            setCurrent(ev.conversation);
        } else if (ev.type === 'reasoning') {
            reasoning += ev.delta || '';
            if (th) th.entries = entries();
            hooks.scroll(false);
        } else if (ev.type === 'status') {
            if (ev.detail) steps.push(String(ev.detail));
            if (th) th.entries = entries();
            hooks.scroll(false);
        } else if (ev.type === 'delta') {
            full += ev.delta || '';
            if (th && !th.settled) settle(th);
            live.content = full;
            hooks.scroll(false);
        } else if (ev.type === 'error') {
            throw new Error(ev.detail || t('chat.requestFailed', '请求失败'));
        } else if (ev.type === 'done') {
            live.streaming = false;
            if (th && !th.settled) settle(th);
            if (ev.message && ev.message.id && th && th.entries.length && th.tenths != null) thoughtDurations.set(ev.message.id, th.tenths);
            setCurrent(ev.conversation);
            showMessages(ev.conversation.messages || [], { keepPosition: true });
            await loadConversations();
        }
    });
    live.streaming = false;
}

/* ───────── 能力运行（智能体 / 技能）：进度与结果就是对话里的一条助手消息 ───────── */
function mergeArtifacts(a, b) {
    const out = [];
    const seen = new Set();
    (a || []).concat(b || []).forEach(x => {
        if (!x || !x.url || seen.has(x.url)) return;
        seen.add(x.url);
        out.push(x);
    });
    return out;
}

function upsertStep(msg, index, patch) {
    const key = index == null ? '' : String(index);
    const list = msg.steps.slice();
    let at = -1;
    for (let i = 0; i < list.length; i++) {
        const cur = list[i];
        if (key ? String(cur.index) === key : (cur.index == null && !cur.tool && patch.tool)) { at = i; break; }
    }
    if (at < 0) list.push(Object.assign({ index: index == null ? list.length : index, tool: '', status: 'pending', summary: '' }, patch));
    else list[at] = Object.assign({}, list[at], patch);
    msg.steps = list;
}

function stepSummary(ev) {
    if (!ev) return '';
    if (ev.ok === false) return String(ev.error || ev.message || '执行失败');
    const parts = [];
    if (ev.summary) parts.push(String(ev.summary));
    if (ev.message) parts.push(String(ev.message));
    if (!ev.summary && ev.description) parts.push(String(ev.description));
    const r = ev.result && typeof ev.result === 'object' ? ev.result : null;
    if (r) {
        if (r.name) parts.push(String(r.name));
        else if (r.value != null) parts.push(String(r.value));
        if (r.row_count != null) parts.push(String(r.row_count) + ' 行');
    }
    return parts.join(' · ');
}

function applyPlan(msg, ev) {
    const steps = Array.isArray(ev.steps) ? ev.steps : [];
    steps.forEach((s, i) => {
        const o = s && typeof s === 'object' ? s : {};
        const idx = o.index == null ? i : o.index;
        upsertStep(msg, idx, { tool: String(o.tool || ''), summary: String(o.description || o.label || o.tool || ('步骤 ' + (i + 1))) });
    });
}

function pushArtifact(msg, a) {
    const list = normalizeArtifacts([a], msg.run_id);
    if (list.length) msg.artifacts = mergeArtifacts(msg.artifacts, list);
}

function applyRunToMessage(msg, run) {
    if (!msg || !run) return;
    if (run.status) msg.status = run.status;
    if (run.steps && run.steps.length) msg.steps = run.steps;
    if (run.artifacts && run.artifacts.length) msg.artifacts = mergeArtifacts(msg.artifacts, run.artifacts);
    if (run.error) msg.error = run.error;
    if (isTerminal(run.status)) msg.live = false;
}

async function pollRun(runId, live) {
    const res = await getRun(runId);
    if (!res.ok) return null;
    applyRunToMessage(live, res.run);
    return res.run;
}

// SSE 实时推进 + 轮询兜底（进度流不可用时仍能走完）
function listenRun(runId, live, signal) {
    let pollTimer = 0;
    let listening = true;
    const finish = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; } listening = false; };
    const onEvent = (ev, name) => {
        if (!ev || typeof ev !== 'object') return;
        const type = String(name || ev.type || '').toLowerCase();
        if (type === 'run_start') { if (!isTerminal(live.status)) live.status = 'running'; return; }
        if (type === 'plan') { applyPlan(live, ev); return; }
        if (type === 'step_start') {
            upsertStep(live, ev.index, { tool: String(ev.tool || ''), status: 'running', summary: String(ev.description || ev.label || '') });
            return;
        }
        if (type === 'step_result') {
            upsertStep(live, ev.index, { tool: String(ev.tool || ''), status: ev.ok === false ? 'error' : 'done', summary: stepSummary(ev) });
            return;
        }
        if (type === 'error') { live.status = 'failed'; live.error = String(ev.message || ev.detail || ev.error || '运行失败'); live.live = false; return; }
        if (type === 'done') { applyRunToMessage(live, normalizeRun(ev)); finish(); return; }
        // 兼容旧形状 / 画布同款事件体（带 run / run_id、status / steps / artifacts）
        if (ev.run && typeof ev.run === 'object') applyRunToMessage(live, normalizeRun(ev.run));
        else if (ev.run_id && (ev.status || ev.steps || ev.artifacts)) applyRunToMessage(live, normalizeRun(ev));
        if (type === 'artifact') pushArtifact(live, ev.artifact || ev);
    };
    pollTimer = setInterval(() => { if (listening) pollRun(runId, live); }, 2500);
    return streamRun(runId, onEvent, signal)
        .catch(err => { if (err && err.name === 'AbortError') live.stopped = true; else live.sse_failed = true; })
        .then(async () => {
            if (listening) await pollRun(runId, live);
            finish();
            live.live = false;
        });
}

// 服务端会话是唯一真相；服务端这条没带步骤 / 产物时才用本次真实观察到的事件补
function mergeLiveInto(messages, snap) {
    return (messages || []).map(m => {
        if (!m || m.role !== 'assistant') return m;
        const sameRun = snap.run_id && m.run_id === snap.run_id;
        const sameId = snap.id && m.id === snap.id;
        if (!sameRun && !sameId) return m;
        return Object.assign({}, m, {
            type: m.type || 'capability',
            capability_id: m.capability_id || snap.capability_id,
            capability_name: m.capability_name || snap.capability_name,
            run_id: m.run_id || snap.run_id,
            status: m.status || snap.status,
            steps: (m.steps && m.steps.length) ? m.steps : snap.steps,
            artifacts: mergeArtifacts(m.artifacts, snap.artifacts),
            error: m.error || snap.error,
            stopped: m.stopped || snap.stopped,
        });
    });
}

async function reloadConversation(id, snap) {
    try {
        const data = await fetch(`/api/conversations/${id}`, { headers: { 'X-User-ID': userId() } }).then(r => r.json());
        if (!data || !data.conversation) return false;
        setCurrent(data.conversation);
        showMessages(mergeLiveInto(data.conversation.messages || [], snap), { keepPosition: true });
        return true;
    } catch (e) { return false; }
}

async function ensureConversation() {
    if (C.current && C.current.id) return C.current.id;
    try {
        const data = await fetch('/api/conversations', { method: 'POST', headers: headers(), body: JSON.stringify({ title: '新对话' }) }).then(r => r.json());
        if (data && data.conversation && data.conversation.id) { setCurrent(data.conversation); return data.conversation.id; }
    } catch (e) {}
    return '';
}

function capFiles() {
    return C.refs.filter(r => r && (r.file || r.raw)).map(r => ({ file: r.file || r.raw, name: attachmentName(r) }));
}

async function doRunCapability(text) {
    const cap = CAP.selected;
    if (!cap) return false;
    const message = String(text || '').trim();
    const pendingRefs = C.refs.slice();
    const files = capFiles();
    if (!message && !files.length) return false;

    const params = Object.assign({}, cap.params || {});
    if (S.provider) params.provider = S.provider;
    const model = chatModelForRequest();
    if (model) params.model = model;
    // 生图类能力：用户在输入框顶部选过「生图模型」才带上 image_provider / image_model（后端最高优先级）；
    // 没选、或选过的模型已从平台配置里失效，都不发这两个字段，后端按既有规则自动选平台与模型
    if (wantsGeneratedImage(cap)) {
        const picked = genImagePair(providersOf('image'));
        if (picked) { params.image_provider = picked.provider; params.image_model = picked.model; }
    }

    const convId = await ensureConversation();
    if (!convId) { toast('新建对话失败，无法运行', { danger: true, icon: 'alert' }); return false; }

    const userMsg = reactive({
        _key: uuid(), role: 'user', content: message, attachments: pendingRefs,
        capability_id: cap.id, capability_name: cap.name, created_at: Date.now(),
    });
    const live = reactive({
        _key: uuid(), role: 'assistant', type: 'capability', live: true, created_at: Date.now(),
        capability_id: cap.id, capability_name: cap.name, run_id: '', status: 'running',
        steps: [], artifacts: [], content: '', error: '', stopped: false, sse_failed: false,
    });
    C.messages.push(userMsg, live);
    C.refs = [];
    clearCapability();
    C.busy = true;
    controller = new AbortController();
    hooks.scroll(true);
    try {
        const res = await runCapability(convId, cap.id, files, params, message, controller.signal, descriptorOf(cap));
        if (!res.ok) {
            live.live = false;
            if (res.aborted) { live.stopped = true; live.status = 'aborted'; }
            else { live.status = 'failed'; live.error = res.error || '运行请求失败'; }
            showMessages(C.messages.slice(), { keepPosition: true });
            return false;
        }
        live.run_id = res.runId;
        if (res.assistantMessageId) live.id = res.assistantMessageId;
        if (res.userMessageId) userMsg.id = res.userMessageId;
        await listenRun(res.runId, live, controller.signal);
        const snap = {
            id: live.id, run_id: live.run_id, capability_id: live.capability_id, capability_name: live.capability_name,
            status: live.status, steps: live.steps.slice(), artifacts: live.artifacts.slice(), error: live.error, stopped: live.stopped,
        };
        // 结果留存走服务端会话（刷新后还在）；重拉失败时保留本地这条本次真实观察到的消息
        const ok = await reloadConversation(convId, snap);
        if (!ok) showMessages(C.messages.slice(), { keepPosition: true });
        await loadConversations();
    } finally {
        C.busy = false;
        controller = null;
        hooks.scroll(false);
    }
    return true;
}

export function initSession() {
    saveSettings();
    return loadConversations();
}
