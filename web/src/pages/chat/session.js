// GPT 对话 · 会话：会话列表 / 打开 / 新建 / 删除、附件上传、发送（chat 流式 / agent 流式 / image 普通请求）、
// 流式事件（meta / reasoning / status / delta / done / error）、中断、重新生成。
// 接口、请求体字段、localStorage key（gpt_chat_last_conversation_v1）与旧版完全一致。
import { reactive, nextTick } from 'vue';
import { S, userId, uuid, chatModelForRequest, sizeOf, sizeOpts, saveSettings } from './chatState.js';
import { chatSizeFromPrompt } from './sizes.js';
import { thoughtTraceEntries } from './thought.js';
import { readSSE } from './sse.js';
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
        C.refs.push(...(data.files || []));
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
    inflight = doSend(text, refsOverride);
    return inflight;
}
async function doSend(text, refsOverride) {
    const message = String(text || '').trim();
    if (!message || C.busy) return false;
    const mode = S.mode;
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

export function initSession() {
    saveSettings();
    return loadConversations();
}
