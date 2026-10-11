<script setup>
// ComfyUI 后端地址：列表 / 添加 / 删除（二次确认，保存后生效）/ 保存（PUT /api/comfyui/instances）
import { ref, onMounted, nextTick } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import WfDialog from './WfDialog.vue';
import { toast } from '../../../lib/store.js';
import { notifyChange } from './wfStore.js';

let seq = 0;
const rows = ref([]);              // [{ key, value }]
const loading = ref(true);
const saving = ref(false);
const invalidKey = ref(null);
const pendingRemove = ref(null);
const listEl = ref(null);

function setRows(list) { rows.value = (list || []).map(v => ({ key: ++seq, value: String(v || '') })); }
async function load() {
    loading.value = true;
    try {
        const data = await fetch('/api/comfyui/instances').then(r => r.json());
        setRows(Array.isArray(data.instances) ? data.instances : []);
    } catch (e) { console.error(e); }
    loading.value = false;
}
function add() {
    rows.value = [...rows.value, { key: ++seq, value: '' }];
    nextTick(() => { const inputs = listEl.value && listEl.value.querySelectorAll('input'); if (inputs && inputs.length) inputs[inputs.length - 1].focus(); });
}
function askRemove(row) { pendingRemove.value = row; }
function doRemove() {
    const row = pendingRemove.value;
    pendingRemove.value = null;
    if (!row) return;
    rows.value = rows.value.filter(r => r !== row);
    toast('已从列表移除，保存后生效', { icon: 'check' });
}
async function save() {
    if (saving.value) return;
    const cleaned = rows.value.map(r => String(r.value || '').trim()).filter(Boolean);
    if (!cleaned.length) {
        const first = rows.value[0];
        invalidKey.value = first ? first.key : null;
        nextTick(() => { const el = listEl.value && listEl.value.querySelector('input'); if (el) el.focus(); });
        toast('请至少填一个 ComfyUI 后端地址', { danger: true, icon: 'alert' });
        return;
    }
    saving.value = true;
    try {
        const res = await fetch('/api/comfyui/instances', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instances: cleaned }) });
        if (!res.ok) { let d = '保存失败'; try { d = (await res.json()).detail || d; } catch (e) {} throw new Error(d); }
        const data = await res.json();
        setRows(data.instances || cleaned);
        notifyChange('comfy-instances-changed');
        toast('ComfyUI 后端地址已保存', { icon: 'check' });
    } catch (e) { toast((e && e.message) || '保存失败', { danger: true, icon: 'alert' }); }
    saving.value = false;
}
function onInput(row, e) { row.value = e.target.value; if (invalidKey.value === row.key) invalidKey.value = null; }
onMounted(load);
</script>

<template>
    <section class="grp">
        <span class="cap">ComfyUI 后端地址</span>
        <div ref="listEl" class="list">
            <div v-if="loading" class="nv-skel sk"></div>
            <TransitionGroup v-else name="li">
                <div v-for="(r, i) in rows" :key="r.key" class="inst" :class="{ bad: invalidKey === r.key }">
                    <span class="n">{{ i + 1 }}</span>
                    <input type="text" :value="r.value" placeholder="host:port" spellcheck="false" :aria-label="'后端地址 ' + (i + 1)" @input="onInput(r, $event)" @keydown.enter="save" />
                    <button type="button" class="nv-icon-btn sm x" title="删除" aria-label="删除" @click="askRemove(r)"><NvIcon name="x" /></button>
                </div>
            </TransitionGroup>
        </div>
        <button type="button" class="nv-btn sm wide" @click="add"><NvIcon name="plus" />添加后端</button>
        <button type="button" class="nv-btn sm primary wide" :disabled="saving" @click="save"><span v-if="saving" class="spin s12"></span><NvIcon v-else name="save" />保存</button>
        <span class="hint">格式：<span class="mono">host:port</span>（如 <span class="mono">127.0.0.1:8188</span>）· 多个后端自动分流</span>
        <WfDialog :open="!!pendingRemove" title="删除后端地址" desc="确定从列表删除该 ComfyUI 后端地址吗？删除后需点击「保存」生效。" confirm-text="删除" danger @confirm="doRemove" @cancel="pendingRemove = null" />
    </section>
</template>

<style scoped>
.grp { display: flex; flex-direction: column; gap: 8px; padding: 14px; border-radius: 14px; background: var(--fill-1); }
.cap { font: 400 10.5px/14px var(--font-mono); letter-spacing: .05em; color: var(--ink-3); text-transform: uppercase; }
.list { position: relative; display: flex; flex-direction: column; gap: 6px; }
.sk { height: 34px; border-radius: 10px; }
.inst { display: flex; align-items: center; gap: 6px; padding: 4px; border-radius: 10px; background: var(--solid); transition: background var(--duration-fast); }
.inst.bad { background: var(--danger-fill); }
.inst .n { width: 18px; flex: none; text-align: center; font: 400 10.5px/1 var(--font-mono); color: var(--ink-3); }
.inst input { flex: 1; min-width: 0; height: 26px; padding: 0 8px; border: 0; outline: 0; border-radius: 7px; background: var(--fill-1); color: var(--ink); font: 400 11.5px/1 var(--font-mono); transition: background var(--duration-fast); }
.inst input:hover { background: var(--fill-2); }
.inst input:focus { background: var(--fill-2); }
.inst .x { width: 26px; height: 26px; color: var(--ink-3); }
.inst .x .nv-i { width: 13px; height: 13px; }
.wide { width: 100%; }
.s12 { width: 12px; height: 12px; }
.hint { font: 400 11px/17px var(--font-sans); color: var(--ink-3); }
.mono { font-family: var(--font-mono); }
.li-enter-active, .li-leave-active { transition: opacity 200ms var(--ease-out), transform 200ms var(--ease-out); }
.li-enter-from, .li-leave-to { opacity: 0; transform: translateY(-4px); }
.li-leave-active { position: absolute; left: 0; right: 0; }
.li-move { transition: transform 200ms var(--ease-out); }
</style>
