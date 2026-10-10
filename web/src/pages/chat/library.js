// 系统提示词弹层的数据：角色库（persona，纯快捷填充）+ 长期记忆库（memory，服务端自动注入）。
// 接口与旧版一致：GET/POST /api/personas、DELETE /api/personas/{id}；GET/POST /api/memories、PATCH/DELETE /api/memories/{id}。
// 真正生效的系统提示词始终是 S.systemPrompt 这段自由文本；角色选中态由文本反推。
import { reactive, computed } from 'vue';
import { S, saveSettings } from './chatState.js';
import { C } from './session.js';

export const L = reactive({
    personas: [],
    personasLoaded: false,
    memories: [],
    memoryScope: 'global',
    personaFlash: '',     // 临时提示（2 秒后恢复）
    memoryNote: '',       // 记忆库状态行的临时覆盖（下次列表刷新时清掉）
    saving: false,
    adding: false,
});

export function personaById(id) { const s = String(id || ''); return s ? L.personas.find(p => p && p.id === s) || null : null; }
export function personaIdForContent(text) {
    const v = String(text || '').trim();
    if (!v) return '';
    const hit = L.personas.find(p => p && String(p.content || '').trim() === v);
    return hit ? hit.id : '';
}
export const activePersona = computed(() => personaById(S.activePersonaId));
export const personaStatus = computed(() => {
    if (L.personaFlash) return L.personaFlash;
    if (activePersona.value) return '当前角色：' + String(activePersona.value.name || '');
    return String(S.systemPrompt || '').trim() ? '自定义提示词' : '未选择角色';
});
let flashTimer = 0;
function flash(text) {
    L.personaFlash = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { L.personaFlash = ''; }, 2000);
}

export function syncPersonaState() { S.activePersonaId = personaIdForContent(S.systemPrompt); }

// textarea 输入：立即写入 systemPrompt 并落盘（不点保存直接关面板也不丢）
export function onPromptInput(value) {
    S.systemPrompt = String(value || '');
    S.activePersonaId = personaIdForContent(S.systemPrompt);
    saveSettings();
}
export function applyPersona(id) {
    const p = personaById(id);
    if (!p) return;
    S.activePersonaId = p.id;
    S.systemPrompt = String(p.content || '').trim();
    saveSettings();
}
export function clearPrompt() {
    S.systemPrompt = '';
    S.activePersonaId = '';
    saveSettings();
}
export function savePrompt() {
    S.systemPrompt = String(S.systemPrompt || '').trim();
    syncPersonaState();
    saveSettings();
}

export async function loadPersonas() {
    try {
        const data = await fetch('/api/personas').then(r => r.json());
        L.personas = Array.isArray(data && data.personas) ? data.personas : [];
    } catch (e) { L.personas = []; }
    L.personasLoaded = true;
    syncPersonaState();
}

// 返回 true = 保存成功
export async function savePersona(name) {
    const content = String(S.systemPrompt || '').trim();
    if (!content) { flash('请先填写提示词内容'); return false; }
    const n = String(name || '').trim();
    if (!n) { flash('请填写角色名称'); return false; }
    L.saving = true;
    try {
        const res = await fetch('/api/personas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n, description: '', content }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((data && data.detail) || '保存失败');
        if (Array.isArray(data && data.personas)) L.personas = data.personas;
        S.activePersonaId = String((data && data.persona && data.persona.id) || '');
        // 存角色 ≡ 认可这段文本：同步提交给 systemPrompt
        S.systemPrompt = content;
        saveSettings();
        return true;
    } catch (e) {
        flash(String((e && e.message) || '保存失败'));
        return false;
    } finally {
        L.saving = false;
    }
}

export async function deleteActivePersona() {
    const p = activePersona.value;
    if (!p || p.builtin) return;
    try {
        const res = await fetch('/api/personas/' + encodeURIComponent(p.id), { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((data && data.detail) || '删除失败');
        if (Array.isArray(data && data.personas)) L.personas = data.personas;
        syncPersonaState();
        saveSettings();
    } catch (e) {
        flash(String((e && e.message) || '删除失败'));
    }
}

/* ───────── 记忆库 ───────── */
export const memoryEnabled = computed(() => L.memories.filter(m => m && m.enabled !== false).length);
export const memoryStatus = computed(() => L.memoryNote || (memoryEnabled.value + ' 条已启用'));
function setMemories(data) {
    if (Array.isArray(data && data.memories)) L.memories = data.memories;
    L.memoryNote = '';
}
export async function loadMemories() {
    try {
        const data = await fetch('/api/memories').then(r => r.json());
        L.memories = Array.isArray(data && data.memories) ? data.memories : [];
    } catch (e) { L.memories = []; }
    L.memoryNote = '';
}
async function call(url, method, body, fallback) {
    const res = await fetch(url, body ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.detail) || fallback);
    return data;
}
export function setMemoryScope(scope) { L.memoryScope = scope === 'conversation' ? 'conversation' : 'global'; }

// 返回 true = 已添加（调用方清空输入框）
export async function addMemory(text) {
    const content = String(text || '').trim();
    if (!content) return false;
    L.adding = true;
    try {
        let scope = L.memoryScope;
        let conversationId = '';
        let fellBack = false;
        if (scope === 'conversation') {
            conversationId = (C.current && C.current.id) || '';
            if (!conversationId) { scope = 'global'; fellBack = true; setMemoryScope('global'); }
        }
        const data = await call('/api/memories', 'POST', { content, scope, conversation_id: conversationId }, '添加失败');
        setMemories(data);
        if (fellBack) L.memoryNote = memoryEnabled.value + ' 条已启用 · 当前对话尚未创建，已存为全局';
        return true;
    } catch (e) {
        L.memoryNote = String((e && e.message) || '添加失败');
        return false;
    } finally {
        L.adding = false;
    }
}
// 只 PATCH enabled 时后端 scope 默认 "global"，会把「本对话」条目打回全局；带上这条自己的 scope / conversation_id（同设置页 memoryApi.js）
export async function toggleMemory(item) {
    const enabled = item.enabled === false;
    const body = item.scope === 'conversation'
        ? { enabled, scope: 'conversation', conversation_id: item.conversation_id || '' }
        : { enabled };
    try { setMemories(await call('/api/memories/' + encodeURIComponent(item.id), 'PATCH', body, '更新失败')); }
    catch (e) { L.memoryNote = String((e && e.message) || '更新失败'); }
}
export async function switchMemoryScope(item) {
    const next = item.scope === 'conversation' ? 'global' : 'conversation';
    let conversationId = '';
    if (next === 'conversation') {
        conversationId = (C.current && C.current.id) || '';
        if (!conversationId) { L.memoryNote = '当前对话尚未创建，无法切到「本对话」'; return; }
    }
    try { setMemories(await call('/api/memories/' + encodeURIComponent(item.id), 'PATCH', { scope: next, conversation_id: conversationId }, '切换失败')); }
    catch (e) { L.memoryNote = String((e && e.message) || '切换失败'); }
}
export async function deleteMemory(item) {
    try { setMemories(await call('/api/memories/' + encodeURIComponent(item.id), 'DELETE', null, '删除失败')); }
    catch (e) { L.memoryNote = String((e && e.message) || '删除失败'); }
}
