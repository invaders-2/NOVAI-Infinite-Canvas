<script setup>
// 通用：窗口行为 / 启动 / 数据目录 / 存储与缓存 / 视频口播转写 / 更新
// 视频口播转写是本次新增卡（旧外壳 /legacy 的设置弹窗没有这一项）
import { ref, reactive, computed, onMounted } from 'vue';
import SetCard from './SetCard.vue';
import SetRow from './SetRow.vue';
import NvSwitch from '../../components/NvSwitch.vue';
import NvPills from '../../components/NvPills.vue';
import NvIcon from '../../components/NvIcon.vue';
import { toast } from '../../lib/store.js';
import { pyApi, getGeneralSettings } from '../../lib/env.js';
import { upd, setSource } from '../../lib/update.js';
import { formatBytes } from '../../lib/format.js';

const KEY = 'studio_general_settings';
const g = reactive({ closeToTray: true, showTray: true, autoStart: false, restoreWindow: true, autoCheckUpdate: true });
function load() {
    const s = getGeneralSettings();
    g.closeToTray = s.closeToTray !== false;
    g.showTray = s.showTray !== false;
    g.autoStart = s.autoStart === true;
    g.restoreWindow = s.restoreWindow !== false;
    g.autoCheckUpdate = s.autoCheckUpdate !== false;
}
function save(key, value) {
    g[key] = value;
    const s = getGeneralSettings();
    s[key] = value;
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {}
    if (key === 'autoStart') { const a = pyApi(); if (a && a.set_auto_start) a.set_auto_start(value).catch(() => {}); }
}

const dataDir = ref('%APPDATA%\\NOVAI');
function openDataFolder() { const a = pyApi(); if (a && a.open_data_dir) a.open_data_dir().catch(() => {}); else toast('网页模式下请在本机文件管理器里打开数据目录'); }

/* 存储与缓存 */
const FILE_CHOICES = [500, 2000, 5000, 10000];
const VERSION_CHOICES = [5, 10, 20, 50];
const storage = ref(null);
const pruning = ref(false);
function pills(choices, current) {
    const v = Number(current);
    if (!Number.isFinite(v)) return [];
    const known = choices.includes(v);
    return (known ? choices : choices.concat([v])).map(c => ({ value: c, label: known || c !== v ? String(c) : '自定义 ' + c }));
}
const filePills = computed(() => pills(FILE_CHOICES, storage.value && storage.value.preview_cache && storage.value.preview_cache.limit_files));
const versionPills = computed(() => pills(VERSION_CHOICES, storage.value && storage.value.canvas_versions && storage.value.canvas_versions.limit));
const previewText = computed(() => { const c = storage.value && storage.value.preview_cache; return c ? `${Number(c.files) || 0} 个文件 · ${formatBytes(c.bytes)}` : '—'; });
const outputDir = computed(() => (storage.value && storage.value.output_dir && storage.value.output_dir.effective) || '—');
async function refreshStorage() {
    try {
        const r = await fetch('/api/settings/storage');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        storage.value = (await r.json()) || {};
    } catch (e) { storage.value = null; }
}
async function putStorage(payload, okText) {
    try {
        const r = await fetch('/api/settings/storage', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        toast(okText, { icon: 'check' });
    } catch (e) { toast('保存失败，已保留原设置', { danger: true, icon: 'alert' }); }
    refreshStorage();
}
async function prune() {
    pruning.value = true;
    try {
        const r = await fetch('/api/maintenance/prune-previews', { method: 'POST' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json().catch(() => ({}));
        const n = Number((d && (d.removed_files ?? d.removed ?? d.deleted)) || 0);
        toast(n ? `已清理 ${n} 个预览文件` : '预览缓存无需清理', { icon: 'check' });
        refreshStorage();
    } catch (e) { toast('清理失败：' + ((e && e.message) || '接口不可用'), { danger: true, icon: 'alert' }); }
    pruning.value = false;
}
// 桌面壳只有「打开数据目录」这个桥；生成目录在数据目录下时复用它，自定义到别处时提示去 API 设置里打开
function openOutput() {
    const a = pyApi();
    const dir = String((storage.value && storage.value.output_dir && storage.value.output_dir.effective) || '');
    const data = String((storage.value && storage.value.data && storage.value.data.dir) || '');
    const inside = !!(dir && data) && (dir === data || dir.startsWith(data + '/') || dir.startsWith(data + '\\'));
    if (a && a.open_data_dir && inside) { a.open_data_dir().catch(() => {}); return; }
    toast('自定义目录请在「API 设置 → 存储设置」里用「浏览」打开');
}
async function resetOutput() {
    try {
        const r = await fetch('/api/settings/output-dir', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ output_dir: '' }) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        toast('已恢复默认输出目录', { icon: 'check' });
        refreshStorage();
    } catch (e) { toast('恢复失败：' + ((e && e.message) || ''), { danger: true, icon: 'alert' }); }
}

/* 视频口播转写（ASR）：平台与模型都由用户选，不写死；选中即保存 */
const asr = reactive({ provider: '', model: '', source: 'none' });
const asrProviders = ref([]);
const asrReady = ref(false);
const asrSaving = ref(false);
const asrPlatforms = computed(() => asrProviders.value
    .filter(p => p && p.enabled !== false && (p.chat_models || []).length)
    .map(p => ({ id: p.id, name: p.name || p.id, chat_models: p.chat_models || [] })));
const asrModelOptions = computed(() => {
    const p = asrPlatforms.value.find(x => x.id === asr.provider);
    const list = p ? p.chat_models.slice() : [];
    if (asr.model && !list.includes(asr.model)) list.unshift(asr.model);
    return list;
});
const ASR_SOURCE = {
    env: { label: '环境变量', text: '当前由环境变量 NOVAI_ASR_PROVIDER / NOVAI_ASR_MODEL 覆盖，这里的界面选择暂不生效。' },
    user: { label: '界面设置', text: '当前使用这里选择的平台与模型。' },
    config: { label: '配置文件', text: '当前由 config/capability_inputs.json 的 video.asr 指定。' },
    none: { label: '未启用', text: '当前未启用：视频口播转写会如实报告不可用。' },
};
const asrSource = computed(() => ASR_SOURCE[asr.source] || ASR_SOURCE.none);
async function refreshAsr() {
    try {
        const [s, p] = await Promise.all([
            fetch('/api/settings/asr').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
            fetch('/api/providers').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
        ]);
        asr.provider = String((s && s.provider) || '');
        asr.model = String((s && s.model) || '');
        asr.source = String((s && s.source) || 'none');
        asrProviders.value = (p && p.providers) || [];
        asrReady.value = true;
    } catch (e) { asrReady.value = false; }
}
async function saveAsr(provider, model) {
    asrSaving.value = true;
    try {
        const r = await fetch('/api/settings/asr', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, model }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((d && d.detail) || ('HTTP ' + r.status));
        asr.provider = String((d && d.provider) || '');
        asr.model = String((d && d.model) || '');
        asr.source = String((d && d.source) || 'none');
        toast(provider && model ? '已保存视频口播转写平台与模型' : '已关闭视频口播转写', { icon: 'check' });
    } catch (e) {
        toast('保存失败：' + ((e && e.message) || '接口不可用'), { danger: true, icon: 'alert' });
        refreshAsr();
    }
    asrSaving.value = false;
}
function pickAsrPlatform(id) {
    if (!id) { saveAsr('', ''); return; }
    const p = asrPlatforms.value.find(x => x.id === id);
    const model = (p && p.chat_models.includes(asr.model) && asr.model) || (p && p.chat_models[0]) || '';
    saveAsr(id, model);
}
function pickAsrModel(model) { if (asr.provider && model) saveAsr(asr.provider, model); }

const SOURCES = [{ value: 'github', label: 'GitHub' }, { value: 'gitee', label: 'Gitee' }, { value: 'modelscope', label: '国内镜像' }];

onMounted(() => {
    load();
    refreshStorage();
    refreshAsr();
    const a = pyApi();
    if (a && a.get_data_dir) a.get_data_dir().then(p => { if (p) dataDir.value = p; }).catch(() => {});
});
</script>

<template>
    <div>
        <SetCard title="窗口行为" desc="控制窗口关闭与启动时的行为。">
            <SetRow label="关闭时最小化到系统托盘" desc="点击关闭按钮后隐藏到托盘而非退出"><NvSwitch :model-value="g.closeToTray" label="关闭时最小化到系统托盘" @update:model-value="save('closeToTray', $event)" /></SetRow>
            <SetRow label="显示系统托盘图标" desc="在任务栏托盘区显示 NOVAI 图标"><NvSwitch :model-value="g.showTray" label="显示系统托盘图标" @update:model-value="save('showTray', $event)" /></SetRow>
        </SetCard>
        <SetCard title="启动" desc="控制软件启动时的行为。">
            <SetRow label="开机自启动" desc="系统启动时自动运行 NOVAI"><NvSwitch :model-value="g.autoStart" label="开机自启动" @update:model-value="save('autoStart', $event)" /></SetRow>
            <SetRow label="恢复上次窗口状态" desc="启动时恢复上次关闭时的窗口大小和位置"><NvSwitch :model-value="g.restoreWindow" label="恢复上次窗口状态" @update:model-value="save('restoreWindow', $event)" /></SetRow>
        </SetCard>
        <SetCard title="数据目录" desc="NOVAI 的用户数据存储位置。">
            <div class="path-row"><span class="path">{{ dataDir }}</span><button type="button" class="nv-btn sm ghost" @click="openDataFolder"><NvIcon name="folder" />打开</button></div>
        </SetCard>
        <SetCard title="存储与缓存" desc="预览缓存占用、历史上限与生成文件的存放位置。">
            <SetRow label="预览缓存" :desc="previewText">
                <button type="button" class="nv-btn sm ghost" :disabled="!storage || pruning" title="按下面的上限清理预览缓存" @click="prune"><span v-if="pruning" class="spin sm"></span><NvIcon v-else name="trash" />立即清理</button>
            </SetRow>
            <SetRow label="缓存上限" desc="超过上限时自动清理最旧的预览文件">
                <NvPills v-if="filePills.length" :model-value="storage?.preview_cache?.limit_files" :options="filePills" label="预览缓存文件数上限" @update:model-value="v => putStorage({ preview_limit_files: v }, '已保存：预览缓存上限 ' + v + ' 个文件')" />
                <span v-else class="muted">—</span>
            </SetRow>
            <SetRow label="画布版本保留" desc="每个画布最多保留多少个历史版本快照，超出自动删最旧的">
                <NvPills v-if="versionPills.length" :model-value="storage?.canvas_versions?.limit" :options="versionPills" label="画布版本保留数量" @update:model-value="v => putStorage({ canvas_version_limit: v }, '已保存：每个画布保留 ' + v + ' 个版本')" />
                <span v-else class="muted">—</span>
            </SetRow>
            <SetRow label="生成文件目录" desc="生成的图片、视频保存位置；自定义路径在「API 设置 → 存储设置」里修改" stack>
                <div class="path-row wide"><span class="path">{{ outputDir }}</span>
                    <button type="button" class="nv-btn sm ghost" :disabled="!storage" @click="openOutput"><NvIcon name="folder" />打开</button>
                    <button type="button" class="nv-btn sm ghost" :disabled="!storage" @click="resetOutput"><NvIcon name="refresh" />恢复默认</button>
                </div>
            </SetRow>
        </SetCard>
        <SetCard title="视频口播转写" desc="视频能力运行时用哪个平台与模型把口播转成文字；不启用则如实报告不可用。">
            <SetRow label="转写平台" desc="只列出已配置且含对话模型的平台">
                <span class="asr-sel">
                    <select :value="asr.provider" :disabled="!asrReady || asrSaving" aria-label="视频口播转写平台" @change="pickAsrPlatform($event.target.value)">
                        <option value="">不启用</option>
                        <option v-for="p in asrPlatforms" :key="p.id" :value="p.id">{{ p.name }}</option>
                    </select>
                    <NvIcon name="chev" />
                </span>
            </SetRow>
            <SetRow label="转写模型" desc="该平台的对话模型；换平台时自动切到第一个可用模型">
                <span class="asr-sel">
                    <select :value="asr.model" :disabled="!asr.provider || !asrReady || asrSaving" aria-label="视频口播转写模型" @change="pickAsrModel($event.target.value)">
                        <option value="" disabled>请选择模型</option>
                        <option v-for="m in asrModelOptions" :key="m" :value="m">{{ m }}</option>
                    </select>
                    <NvIcon name="chev" />
                </span>
            </SetRow>
            <SetRow label="当前生效" :desc="asrSource.text">
                <span class="asr-badge" :class="asr.source">{{ asrSource.label }}</span>
            </SetRow>
        </SetCard>
        <SetCard title="更新" desc="启动时是否检查新版本，以及从哪个源下载更新。">
            <SetRow label="启动时自动检查更新" desc="关闭后启动不再自动检查；「关于」里的手动检查不受影响"><NvSwitch :model-value="g.autoCheckUpdate" label="启动时自动检查更新" @update:model-value="save('autoCheckUpdate', $event)" /></SetRow>
            <SetRow label="更新源" desc="与更新弹窗里的来源选择保持同步"><NvPills :model-value="upd.source" :options="SOURCES" label="更新源" @update:model-value="setSource" /></SetRow>
        </SetCard>
    </div>
</template>

<style scoped>
.path-row { display: flex; align-items: center; gap: 8px; padding: 12px 0; }
.path-row.wide { padding: 0; width: 100%; }
.path { flex: 1; min-width: 0; height: 32px; padding: 0 12px; border-radius: var(--radius-md); background: var(--solid); display: flex; align-items: center; font: 400 12px/1 var(--font-mono); color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.muted { color: var(--ink-4); font-size: 12px; }
.spin.sm { width: 12px; height: 12px; }
.asr-sel { position: relative; display: inline-flex; align-items: center; min-width: 200px; }
.asr-sel select { width: 100%; height: 32px; padding: 0 26px 0 12px; border: 0; outline: 0; border-radius: var(--radius-md); background: var(--solid); appearance: none; -webkit-appearance: none; font: 400 12.5px/32px var(--font-sans); color: var(--ink); cursor: pointer; text-overflow: ellipsis; transition: background var(--duration-fast) var(--ease-out); }
.asr-sel select:hover:not(:disabled), .asr-sel select:focus-visible { background: var(--fill-2); }
.asr-sel select:disabled { color: var(--ink-4); cursor: default; }
.asr-sel .nv-i { position: absolute; right: 9px; width: 12px; height: 12px; color: var(--ink-3); pointer-events: none; }
.asr-badge { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 8px; background: var(--solid); font: 400 11.5px/1 var(--font-sans); color: var(--ink-2); }
.asr-badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--ink-4); }
.asr-badge.user::before { background: var(--accent); }
.asr-badge.env::before { background: var(--danger); }
.asr-badge.config::before { background: var(--ink-3); }
</style>
