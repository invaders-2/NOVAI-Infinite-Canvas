<script setup>
// RunningHub 专属：双 Key（RH币必填 / 账户余额可选）+ 应用与工作流卡片 + 工作流 / 应用参数编辑器。
// 数据流同旧 api-settings.js：卡片增删改直接改 provider.rh_apps / rh_workflows（就地修改），
// 需要落盘时调用 props.save()（= 主面板的 saveProviders），Key 输入框的值由主面板保存前通过 collect() 取走。
import { ref, computed, watch } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import RhKeys from './rh/RhKeys.vue';
import RhEntryCard from './rh/RhEntryCard.vue';
import RhEditor from './rh/RhEditor.vue';
import ApiConfirm from './kit/ApiConfirm.vue';
import { toast, t } from '../../../lib/store.js';
import { useConfirm } from './kit/kit.js';
import { parseRunningHubRunRef, normalizeRhEntries, ensureRunningHubLists, isStaticRunningHubEntry, createRhThumbnailDataUrl, pickFile } from './rh/rh-utils.js';

const props = defineProps({
    provider: Object,
    providers: Array,
    save: Function,                                   // async () => boolean：主面板保存全部平台（旧 saveProviders）
    section: { type: String, default: 'all' },        // 'all' | 'keys'（只渲染 Key 卡）| 'entries'（只渲染应用与工作流）
});
const emit = defineEmits(['changed', 'dirty', 'save']);
const confirm = useConfirm();

const isRh = computed(() => !!props.provider && props.provider.id === 'runninghub');
const showKeys = computed(() => isRh.value && props.section !== 'entries');
const showEntries = computed(() => isRh.value && props.section !== 'keys');

/* ── Key ── */
const free = ref('');
const wallet = ref('');
const busyKey = ref('');
const edited = ref(false);
function reset() { free.value = ''; wallet.value = ''; edited.value = false; paste.value = ''; }
watch(() => props.provider, reset);
watch(() => !!(free.value.trim() || wallet.value.trim() || edited.value), v => emit('dirty', v), { immediate: true });

async function doSave() {
    if (props.save) return (await props.save()) !== false;
    emit('save');
    return true;
}
async function saveKey(kind) {
    if (!isRh.value || busyKey.value) return;
    const key = (kind === 'wallet' ? wallet.value : free.value).trim();
    if (!key) { toast(t('api.enterKeyAlert', '请输入 Key'), { danger: true, icon: 'alert' }); return; }
    busyKey.value = kind;
    try {
        const ok = await doSave();
        if (ok) { if (kind === 'wallet') wallet.value = ''; else free.value = ''; }
    } finally { busyKey.value = ''; }
}
async function clearKey(kind) {
    if (!isRh.value || busyKey.value) return;
    const ok = await confirm.ask({ title: t('api.confirmClearKey', '确认清除当前 Key？'), desc: kind === 'wallet' ? '清除已保存的账户余额 Key。' : '清除已保存的 RH币 Key。', ok: '清除' });
    if (!ok) return;
    if (kind === 'wallet') props.provider._clearWalletKey = true;
    else props.provider._clearKey = true;
    busyKey.value = kind;
    try {
        const saved = await doSave();
        if (saved) { if (kind === 'wallet') wallet.value = ''; else free.value = ''; }
    } finally { busyKey.value = ''; }
}

/* ── 应用与工作流 ── */
const paste = ref('');
const pasteParsed = computed(() => parseRunningHubRunRef(paste.value));
const apps = computed(() => (isRh.value ? normalizeRhEntries(props.provider.rh_apps || [], 'app').filter(e => e.hidden !== true) : []));
const workflows = computed(() => (isRh.value ? normalizeRhEntries(props.provider.rh_workflows || [], 'workflow').filter(e => e.hidden !== true) : []));
const groups = computed(() => [
    { kind: 'app', title: 'AI 应用', list: apps.value, empty: '粘贴 /run/ai-app/... 后点击创建 AI 应用卡片' },
    { kind: 'workflow', title: '工作流', list: workflows.value, empty: '粘贴 /run/workflow/... 后点击创建工作流卡片' },
]);
function listKey(kind) { return kind === 'app' ? 'rh_apps' : 'rh_workflows'; }
function realEntry(kind, id) {
    ensureRunningHubLists(props.provider);
    return props.provider[listKey(kind)].find(e => e.id === id) || null;
}

async function createFromPaste() {
    if (!isRh.value) return;
    const parsed = parseRunningHubRunRef(paste.value);
    if (!parsed) { toast('请粘贴 /run/ai-app/... 或 /run/workflow/...', { danger: true, icon: 'alert' }); return; }
    const item = props.provider;
    ensureRunningHubLists(item);
    const list = item[listKey(parsed.type)];
    const idx = list.findIndex(e => e.id === parsed.id);
    const exists = idx >= 0 && list[idx].hidden !== true;
    if (idx >= 0 && list[idx].hidden === true) {
        list[idx] = { ...list[idx], enabled: true, hidden: false };
    } else if (!exists) {
        list.unshift({
            id: parsed.id,
            appId: parsed.type === 'app' ? parsed.id : undefined,
            workflowId: parsed.type === 'workflow' ? parsed.id : undefined,
            title: parsed.type === 'app' ? `AI 应用 ${parsed.id.slice(-6)}` : `工作流 ${parsed.id.slice(-6)}`,
            note: '',
            thumbnail: '',
            enabled: true,
        });
    }
    paste.value = '';
    if (exists) { toast('这个 RunningHub 项目已经存在'); return; }
    const ok = await doSave();
    toast(ok ? '已创建并保存 RunningHub 卡片' : '已创建 RunningHub 卡片，但自动保存失败', ok ? { icon: 'check' } : { danger: true, icon: 'alert' });
}
function updateEntry(kind, id, prop, value) {
    const entry = realEntry(kind, id);
    if (!entry) return;
    entry[prop] = value;
    edited.value = true;
}
async function pickThumb(kind, id) {
    const file = await pickFile('image/*');
    if (!file) return;
    try {
        updateEntry(kind, id, 'thumbnail', await createRhThumbnailDataUrl(file));
        toast('缩略图已更新，点保存生效');
    } catch (e) { toast(e.message || '上传缩略图失败', { danger: true, icon: 'alert' }); }
}
async function removeEntry(kind, id) {
    const item = props.provider;
    ensureRunningHubLists(item);
    const list = item[listKey(kind)];
    const idx = list.findIndex(e => e.id === id);
    if (idx < 0) return;
    const entry = list[idx];
    const entryId = String((kind === 'workflow' ? (entry.workflowId || entry.id) : (entry.appId || entry.id)) || '').trim();
    if (isStaticRunningHubEntry(kind, entry)) list[idx] = { ...entry, enabled: false, hidden: true };
    else list.splice(idx, 1);
    if (kind === 'workflow' && entryId) {
        try { await fetch(`/api/runninghub/workflows/${encodeURIComponent(entryId)}`, { method: 'DELETE' }); } catch (_) {}
    }
    const ok = await doSave();
    toast(ok ? '已删除并保存' : '已删除，但自动保存失败', ok ? { icon: 'check' } : { danger: true, icon: 'alert' });
}

/* ── 编辑器 ── */
const editor = ref({ open: false, mode: 'workflow', entry: null });
function openEditor(kind, id) {
    const entry = realEntry(kind, id);
    if (!entry) return;
    editor.value = { open: true, mode: kind, entry };
}
// 编辑器保存：把字段写回 provider 里对应卡片，再保存全部平台（旧 saveRhWorkflowEditor 里的 saveProviders）
async function commitEditor(mode, id, patch) {
    const entry = realEntry(mode, id);
    if (!entry) return false;
    Object.assign(entry, patch);
    return doSave();
}

/* ── 给主面板 ── */
// 保存前合并进 provider 的字段（旧 syncEditor：输入框有值才覆盖）
function collect() {
    if (!isRh.value) return {};
    const out = {};
    if (free.value.trim()) out.api_key = free.value.trim();
    if (wallet.value.trim()) out.wallet_api_key = wallet.value.trim();
    return out;
}
// 测试连接 / 拉取模型用的 Key（旧 currentProviderApiKey：余额 Key 优先）
function currentApiKey() { return wallet.value.trim() || free.value.trim(); }
// 新手引导卡同步输入（旧 syncOnboardingKeyInput）
function setKey(kind, value) { if (kind === 'wallet') wallet.value = value || ''; else free.value = value || ''; }
function getKeys() { return { free: free.value, wallet: wallet.value }; }
defineExpose({ collect, reset, currentApiKey, setKey, getKeys });
</script>

<template>
    <div v-if="isRh" class="rh">
        <section v-if="showKeys" class="rh-tile">
            <RhKeys v-model:free="free" v-model:wallet="wallet" :provider="provider" :busy="busyKey" @save="saveKey" @clear="clearKey" />
        </section>

        <section v-if="showEntries" class="rh-sec">
            <div class="rh-sech">
                <div><b>应用与工作流</b><span>粘贴运行路径后，点击右侧创建卡片。</span></div>
            </div>
            <div class="rh-paste">
                <label class="nv-field rh-pin"><input v-model="paste" type="text" placeholder="/run/ai-app/... 或 /run/workflow/..." aria-label="RunningHub 运行路径" @keydown.enter="createFromPaste"></label>
                <button type="button" class="nv-btn sm" @click="createFromPaste"><NvIcon name="plus" />创建</button>
            </div>
            <Transition name="hint"><div v-if="pasteParsed" class="rh-hint">已识别 RunningHub {{ pasteParsed.type === 'app' ? 'AI 应用' : '工作流' }} 路径，点击右侧创建卡片</div></Transition>
            <div class="rh-cols">
                <div v-for="g in groups" :key="g.kind" class="rh-group">
                    <div class="rh-gh"><b>{{ g.title }}</b><span>{{ g.list.length }}</span></div>
                    <TransitionGroup tag="div" name="rhl" class="rh-list">
                        <RhEntryCard v-for="e in g.list" :key="e.id" :entry="e" :kind="g.kind"
                                     @thumb="pickThumb(g.kind, e.id)" @update="(p, v) => updateEntry(g.kind, e.id, p, v)"
                                     @edit="openEditor(g.kind, e.id)" @remove="removeEntry(g.kind, e.id)" />
                        <div v-if="!g.list.length" key="__empty" class="rh-empty">{{ g.empty }}</div>
                    </TransitionGroup>
                </div>
            </div>
        </section>

        <RhEditor :open="editor.open" :mode="editor.mode" :entry="editor.entry" :commit="commitEditor" @close="editor.open = false" />
        <ApiConfirm :state="confirm.st.value" @done="confirm.done" />
    </div>
</template>

<style scoped>
.rh { display: flex; flex-direction: column; gap: 22px; min-width: 0; }
.rh-tile { background: var(--fill-1); border-radius: 14px; padding: 14px 16px; min-width: 0; }
.rh-sec { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.rh-sech b { display: block; font: 500 13px/19px var(--font-sans); color: var(--ink); }
.rh-sech span { display: block; font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); }
.rh-paste { display: flex; align-items: center; gap: 8px; }
.rh-pin { flex: 1; min-width: 0; }
.rh-pin input { font: 400 12.5px/20px var(--font-mono); }
.rh-pin input::placeholder { font-family: var(--font-sans); }
.rh-hint { margin-top: -4px; font: 400 11px/16px var(--font-sans); color: var(--ink-3); }
.rh-cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.rh-group { background: var(--fill-1); border-radius: 14px; padding: 12px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.rh-gh { display: flex; align-items: center; justify-content: space-between; padding: 0 2px; }
.rh-gh b { font: 500 12px/16px var(--font-sans); color: var(--ink); }
.rh-gh span { font: 400 11px/1 var(--font-mono); color: var(--ink-3); }
.rh-list { position: relative; display: flex; flex-direction: column; gap: 8px; }
.rh-empty { padding: 18px; border-radius: 12px; background: var(--solid); font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); text-align: center; }
.rhl-move, .rhl-enter-active { transition: transform var(--duration-base) var(--ease-out), opacity var(--duration-base) var(--ease-out); }
.rhl-leave-active { position: absolute; left: 0; right: 0; transition: opacity var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out); }
.rhl-enter-from { opacity: 0; transform: translateY(-6px); }
.rhl-leave-to { opacity: 0; transform: scale(.98); }
.hint-enter-active, .hint-leave-active { transition: opacity var(--duration-fast) var(--ease-out); }
.hint-enter-from, .hint-leave-to { opacity: 0; }
@media (max-width: 860px) { .rh-cols { grid-template-columns: 1fr; } }
</style>
