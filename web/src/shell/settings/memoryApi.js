// 设置 · 记忆：长期记忆库（/api/memories）的读取与增删改。
// 接口与作用域口径与 GPT 对话页记忆库（pages/chat/library.js）完全一致：
//   global 全局 / conversation 本对话；每条带 enabled 启用开关（默认开），由服务端自动注入 system prompt。
// 后端没有「记忆总开关」字段，批量启停直接逐条 PATCH 每条自己的 enabled，不新造字段。
import { reactive } from 'vue';

const LAST_CONVERSATION_KEY = 'gpt_chat_last_conversation_v1';

export const L = reactive({
    memories: [],
    loaded: false,
    scope: 'global',
    note: '',
    adding: false,
});

// 与 GPT 对话页同一个「当前对话」口径：对话页把当前会话 id 落在这个 key 上
export function currentConversationId() {
    try { return localStorage.getItem(LAST_CONVERSATION_KEY) || ''; } catch (e) { return ''; }
}

async function call(url, method, body, fallback) {
    const res = await fetch(url, body ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.detail) || fallback);
    return data;
}

function setMemories(data) {
    if (Array.isArray(data && data.memories)) L.memories = data.memories;
    L.note = '';
}

export async function loadMemories() {
    try { setMemories(await call('/api/memories', 'GET', null, '加载失败')); }
    catch (e) { L.memories = []; L.note = String((e && e.message) || '加载失败'); }
    L.loaded = true;
}

export function setScope(scope) { L.scope = scope === 'conversation' ? 'conversation' : 'global'; }

// 返回 true = 已添加（调用方清空输入框）
export async function addMemory(text) {
    const content = String(text || '').trim();
    if (!content) return false;
    L.adding = true;
    try {
        let scope = L.scope;
        let conversationId = '';
        let fellBack = false;
        if (scope === 'conversation') {
            conversationId = currentConversationId();
            if (!conversationId) { scope = 'global'; fellBack = true; setScope('global'); }
        }
        setMemories(await call('/api/memories', 'POST', { content, scope, conversation_id: conversationId }, '添加失败'));
        if (fellBack) L.note = '当前对话尚未创建，已存为全局';
        return true;
    } catch (e) {
        L.note = String((e && e.message) || '添加失败');
        return false;
    } finally {
        L.adding = false;
    }
}

// 只 PATCH enabled 时后端 scope 默认 "global"，会把「本对话」条目打回全局；
// 因此带上这条自己的 scope / conversation_id，开关只改启用状态、不动作用域。
export async function toggleMemory(item) {
    const enabled = item.enabled === false;
    const body = item.scope === 'conversation'
        ? { enabled, scope: 'conversation', conversation_id: item.conversation_id || '' }
        : { enabled };
    try { setMemories(await call('/api/memories/' + encodeURIComponent(item.id), 'PATCH', body, '更新失败')); }
    catch (e) { L.note = String((e && e.message) || '更新失败'); }
}

export async function switchMemoryScope(item) {
    const next = item.scope === 'conversation' ? 'global' : 'conversation';
    let conversationId = '';
    if (next === 'conversation') {
        conversationId = currentConversationId();
        if (!conversationId) { L.note = '当前对话尚未创建，无法切到「本对话」'; return; }
    }
    try { setMemories(await call('/api/memories/' + encodeURIComponent(item.id), 'PATCH', { scope: next, conversation_id: conversationId }, '切换失败')); }
    catch (e) { L.note = String((e && e.message) || '切换失败'); }
}

export async function deleteMemory(item) {
    try { setMemories(await call('/api/memories/' + encodeURIComponent(item.id), 'DELETE', null, '删除失败')); }
    catch (e) { L.note = String((e && e.message) || '删除失败'); }
}

// 批量启用 / 停用：逐条 PATCH 目标 enabled；已是目标状态的条目不重复请求。
// 同样带上各自的 scope / conversation_id，避免「本对话」条目被后端默认值打回全局。
export async function setAllEnabled(enabled) {
    const snapshot = L.memories.slice();
    for (const item of snapshot) {
        if ((item.enabled !== false) === enabled) continue;
        const body = item.scope === 'conversation'
            ? { enabled, scope: 'conversation', conversation_id: item.conversation_id || '' }
            : { enabled };
        try { setMemories(await call('/api/memories/' + encodeURIComponent(item.id), 'PATCH', body, '更新失败')); }
        catch (e) { L.note = String((e && e.message) || '更新失败'); return false; }
    }
    return true;
}
