<script setup>
// 数据备份：创建（素材范围 / 含 Key / 含历史版本）→ 已有备份（显示 / 下载 / 恢复 / 删除）→ 从备份恢复（上传或选已有 → 合并预览 → 开始恢复）
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import SetCard from './SetCard.vue';
import SetRow from './SetRow.vue';
import NvSwitch from '../../components/NvSwitch.vue';
import NvPills from '../../components/NvPills.vue';
import NvIcon from '../../components/NvIcon.vue';
import NvProgress from '../../components/NvProgress.vue';
import { toast } from '../../lib/store.js';
import { pyApi } from '../../lib/env.js';
import { formatBytes, fmtTime } from '../../lib/format.js';

const summary = ref(null);
const loadError = ref('');
const mode = ref('referenced');
const includeKeys = ref(false);
const includeVersions = ref(false);
const busy = ref(false);
const exportProg = ref(null);     // { percent, stage, error }
const uploadProg = ref(null);
const createHint = ref('');
const preview = ref(null);        // { token, p, label }
const overwrite = ref(false);
const done = ref(null);           // 恢复完成结果
const deleteArm = ref('');
const fileEl = ref(null);
const previewEl = ref(null);
let pollTimer = 0, armTimer = 0;
const local = computed(() => !!pyApi());

async function j(res) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.detail) || ('HTTP ' + res.status));
    return data;
}
const modeOptions = computed(() => {
    const d = summary.value || {};
    return [
        { value: 'referenced', label: '画布用到的', sub: d.referenced_bytes != null ? formatBytes(d.referenced_bytes) : '' },
        { value: 'all', label: '全部素材', sub: d.all_assets_bytes != null ? formatBytes(d.all_assets_bytes) : '' },
        { value: 'none', label: '不含素材' },
    ];
});
const assetStat = computed(() => {
    const d = summary.value || {};
    if (mode.value === 'all') return { n: formatBytes(d.all_assets_bytes), l: '全部素材' };
    if (mode.value === 'none') return { n: '—', l: '不含素材' };
    return { n: formatBytes(d.referenced_bytes), l: (d.referenced_assets || 0) + ' 个画布用到的素材' };
});
async function refresh() {
    try {
        const d = await j(await fetch('/api/backup/summary'));
        summary.value = d; loadError.value = '';
        if ((d.job || {}).status === 'running') poll();
    } catch (e) { loadError.value = '读取备份信息失败：' + e.message; }
}
function tags(b) {
    const o = b.options || {}, t = [];
    if (b.kind === 'pre-restore') t.push('恢复前自动备份');
    if (o.include_keys) t.push('含 Key');
    if (o.assets === 'all') t.push('全部素材'); else if (o.assets === 'none') t.push('不含素材');
    return t;
}
function meta(b) {
    const c = b.counts || {};
    const m = [formatBytes(b.size), (c.canvases || 0) + ' 个画布'];
    if (c.assets) m.push(c.assets + ' 个素材');
    return m.join(' · ');
}
async function startExport() {
    createHint.value = ''; busy.value = true; exportProg.value = { percent: 0, stage: '准备中' };
    try {
        await j(await fetch('/api/backup/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assets: mode.value, include_keys: includeKeys.value, include_versions: includeVersions.value }) }));
        poll();
    } catch (e) { busy.value = false; exportProg.value = { percent: 100, stage: '备份失败：' + e.message, error: true }; }
}
function poll() {
    if (pollTimer) return;
    busy.value = true;
    const tick = async () => {
        try {
            const job = await j(await fetch('/api/backup/progress'));
            const target = job.kind === 'import' ? uploadProg : exportProg;
            if (job.status === 'running') { target.value = { percent: job.percent, stage: job.message }; pollTimer = setTimeout(tick, 600); return; }
            pollTimer = 0; busy.value = false;
            if (job.status === 'error') { target.value = { percent: 100, stage: (job.kind === 'import' ? '恢复失败：' : '备份失败：') + (job.error || ''), error: true }; return; }
            if (job.status === 'done' && job.kind === 'export') {
                exportProg.value = { percent: 100, stage: '备份完成' };
                createHint.value = '已生成 ' + formatBytes((job.result || {}).size) + ' 的备份，在下面的列表里';
                setTimeout(() => { exportProg.value = null; }, 1600);
            }
            if (job.status === 'done' && job.kind === 'import') showDone(job.result || {});
            refresh();
        } catch (e) { pollTimer = setTimeout(tick, 1500); }
    };
    tick();
}
async function reveal(name) {
    try { await j(await fetch('/api/backup/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name || '' }) })); }
    catch (e) { toast('打开文件夹失败：' + e.message, { danger: true, icon: 'alert' }); }
}
function download(name) { window.open('/api/backup/download/' + encodeURIComponent(name), '_blank'); }
async function del(name) {
    if (deleteArm.value !== name) {
        deleteArm.value = name; clearTimeout(armTimer);
        armTimer = setTimeout(() => { if (deleteArm.value === name) deleteArm.value = ''; }, 3000);
        return;
    }
    deleteArm.value = '';
    try { const d = await j(await fetch('/api/backup/' + encodeURIComponent(name), { method: 'DELETE' })); summary.value = { ...(summary.value || {}), backups: d.backups || [] }; }
    catch (e) { toast('删除失败：' + e.message, { danger: true, icon: 'alert' }); }
}
function clearPreview() { preview.value = null; }
function showPreview(token, p, label) {
    done.value = null;
    preview.value = { token, p: p || {}, label };
    overwrite.value = !(p && p.local_canvases);
    nextTick(() => previewEl.value && previewEl.value.scrollIntoView && previewEl.value.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}
const pv = computed(() => {
    if (!preview.value) return null;
    const p = preview.value.p, m = p.manifest || {};
    const canv = [], assets = [];
    if (p.canvases_new) canv.push('新增 ' + p.canvases_new + ' 个');
    if (p.canvases_same) canv.push(p.canvases_same + ' 个本机已有、内容相同（跳过）');
    if (p.canvases_conflict) canv.push(p.canvases_conflict + ' 个两边都改过（另存为副本）');
    if (p.assets_new) assets.push('新增 ' + p.assets_new + ' 个（' + formatBytes(p.assets_new_bytes) + '）');
    if (p.assets_existing) assets.push(p.assets_existing + ' 个本机已有（保留本机）');
    const files = (p.settings_files || []).length, missing = (p.settings_missing || []).length;
    const settingsText = files ? (missing ? '本机缺的 ' + missing + ' 个会补上' : '本机都已有') + (files - missing ? '，其余 ' + (files - missing) + ' 个默认保留本机' : '') : '备份里没有';
    return {
        note: '备份于 ' + fmtTime(m.created_at) + (m.app_version ? ' · 版本 ' + m.app_version : '') + (p.has_keys ? ' · 含 API Key' : ''),
        lines: [['画布', canv.join('，') || '没有'], ['素材', assets.join('，') || '没有'], ['设置与库', settingsText]],
        canOverwrite: files - missing > 0, hasKeys: !!p.has_keys,
    };
});
function upload(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    clearPreview(); done.value = null; busy.value = true;
    uploadProg.value = { percent: 0, stage: '正在读取 ' + file.name };
    const form = new FormData(); form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/backup/import/upload');
    xhr.upload.onprogress = ev => { if (ev.lengthComputable) uploadProg.value = { percent: ev.loaded / ev.total * 96, stage: ev.loaded < ev.total ? '正在读取 ' + file.name : '正在检查备份内容' }; };
    xhr.onload = () => {
        busy.value = false;
        let d = {}; try { d = JSON.parse(xhr.responseText || '{}'); } catch (err) {}
        if (xhr.status >= 400) { uploadProg.value = { percent: 100, stage: '无法读取：' + (d.detail || ('HTTP ' + xhr.status)), error: true }; return; }
        uploadProg.value = null;
        showPreview(d.token, d.preview || {}, file.name);
    };
    xhr.onerror = () => { busy.value = false; uploadProg.value = { percent: 100, stage: '上传中断，请重试', error: true }; };
    xhr.send(form);
}
async function restoreExisting(name) {
    clearPreview();
    try { const d = await j(await fetch('/api/backup/import/existing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })); showPreview(d.token, d.preview || {}, name); }
    catch (e) { toast('读取备份失败：' + e.message, { danger: true, icon: 'alert' }); }
}
async function apply() {
    if (!preview.value) return;
    const body = { token: preview.value.token, overwrite_settings: pv.value.canOverwrite && overwrite.value };
    busy.value = true; preview.value = null;
    uploadProg.value = { percent: 0, stage: '准备恢复' };
    try { await j(await fetch('/api/backup/import/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })); poll(); }
    catch (e) { busy.value = false; uploadProg.value = { percent: 100, stage: '恢复失败：' + e.message, error: true }; }
}
function showDone(r) {
    uploadProg.value = null;
    const parts = [];
    if (r.canvases_added) parts.push('新增 ' + r.canvases_added + ' 个画布');
    if (r.canvases_copied) parts.push(r.canvases_copied + ' 个画布另存为副本');
    if (r.assets_added) parts.push('补上 ' + r.assets_added + ' 个素材');
    if (r.files_added || r.files_replaced) parts.push('设置与库 ' + ((r.files_added || 0) + (r.files_replaced || 0)) + ' 个文件');
    done.value = (parts.join('，') || '没有需要导入的新内容') + '。刷新页面后生效。';
}
function reload() { location.reload(); }
onMounted(refresh);
onBeforeUnmount(() => { clearTimeout(pollTimer); clearTimeout(armTimer); });
</script>

<template>
    <div>
        <SetCard title="创建备份" desc="把画布、素材、提示词库和设置打成一个 zip。换电脑或重装后，在「从备份恢复」里选这个文件就能全部导回。">
            <div class="stats">
                <div class="stat"><b>{{ summary && summary.canvases != null ? summary.canvases : '—' }}</b><span>个画布</span></div>
                <div class="stat"><b>{{ summary ? assetStat.n : '—' }}</b><span>{{ assetStat.l }}</span></div>
                <div class="stat"><b>{{ summary ? formatBytes(summary.data_bytes) : '—' }}</b><span>设置与各类库</span></div>
            </div>
            <SetRow label="素材" desc="「画布用到的」只带画布、素材库和历史记录里引用到的图片视频；本地抠图 / 高清模型不进备份，用到时会重新下载" stack>
                <NvPills v-model="mode" :options="modeOptions" label="备份哪些素材" />
            </SetRow>
            <SetRow label="包含 API Key" desc="换电脑时不用重新填 Key；备份文件里会有明文 Key，别发给别人"><NvSwitch v-model="includeKeys" label="包含 API Key" /></SetRow>
            <SetRow label="包含画布历史版本" :desc="'每个画布自动保存的旧版本快照' + (summary && summary.versions_bytes ? '（' + formatBytes(summary.versions_bytes) + '）' : '')"><NvSwitch v-model="includeVersions" label="包含画布历史版本" /></SetRow>
            <div class="acts">
                <button type="button" class="nv-btn primary sm" :disabled="busy" @click="startExport"><NvIcon name="download" />创建备份</button>
                <span v-if="createHint" class="hint ok">{{ createHint }}</span>
            </div>
            <NvProgress v-if="exportProg" class="prog" :stage="exportProg.stage" :percent="exportProg.percent" :error="exportProg.error" />
        </SetCard>

        <SetCard title="已有备份" desc="存放在数据目录的 backups 文件夹里；恢复前自动做的备份也在这里。">
            <template #action><button type="button" class="nv-btn sm ghost" @click="reveal('')"><NvIcon name="folder" />打开文件夹</button></template>
            <div v-if="loadError" class="empty err">{{ loadError }}</div>
            <div v-else-if="!summary || !(summary.backups || []).length" class="empty">还没有备份</div>
            <template v-else>
            <div v-for="b in summary.backups" :key="b.name" class="bk">
                <div class="bk-m">
                    <div class="bk-t"><span class="mono">{{ fmtTime(b.created_at) }}</span><span v-for="t in tags(b)" :key="t" class="tag">{{ t }}</span></div>
                    <div class="bk-d">{{ meta(b) }}</div>
                </div>
                <div class="bk-a">
                    <button v-if="local" type="button" class="nv-btn sm ghost" @click="reveal(b.name)"><NvIcon name="folder" />在文件夹中显示</button>
                    <button v-else type="button" class="nv-btn sm ghost" @click="download(b.name)"><NvIcon name="download" />下载</button>
                    <button type="button" class="nv-btn sm" :disabled="busy" @click="restoreExisting(b.name)">恢复</button>
                    <button type="button" class="nv-btn sm danger" :disabled="busy" @click="del(b.name)">{{ deleteArm === b.name ? '确认删除' : '删除' }}</button>
                </div>
            </div>
            </template>
        </SetCard>

        <SetCard title="从备份恢复" desc="把备份合并进本机：本机已有的素材保留不动；同一个画布两边都改过时，备份里的那份另存为副本，不会覆盖。">
            <div class="acts">
                <button type="button" class="nv-btn sm" :disabled="busy" @click="fileEl.click()"><NvIcon name="upload" />选择备份文件（.zip）</button>
                <input ref="fileEl" type="file" accept=".zip,application/zip" hidden @change="upload">
            </div>
            <NvProgress v-if="uploadProg" class="prog" :stage="uploadProg.stage" :percent="uploadProg.percent" :error="uploadProg.error" />
            <div v-if="pv" ref="previewEl" class="pv">
                <div class="pv-h">{{ preview.label }}</div>
                <div class="note">{{ pv.note }}</div>
                <div class="lines"><div v-for="l in pv.lines" :key="l[0]" class="ln"><span>{{ l[0] }}</span><span>{{ l[1] }}</span></div></div>
                <SetRow v-if="pv.canOverwrite" label="用备份里的设置和库覆盖本机" :desc="'提示词库、人设、素材库记录、设置' + (pv.hasKeys ? '、API Key' : '') + '都换成备份里的版本'"><NvSwitch v-model="overwrite" label="覆盖本机设置" /></SetRow>
                <div class="note">开始前会自动给本机数据（不含素材）做一份「恢复前自动备份」，恢复结果不满意可以再用它导回。</div>
                <div class="acts"><button type="button" class="nv-btn primary sm" :disabled="busy" @click="apply">开始恢复</button><button type="button" class="nv-btn sm ghost" @click="clearPreview">取消</button></div>
            </div>
            <div v-if="done" class="pv">
                <div class="pv-h">恢复完成</div>
                <div class="note">{{ done }}</div>
                <div class="acts"><button type="button" class="nv-btn primary sm" @click="reload">刷新页面</button></div>
            </div>
        </SetCard>
    </div>
</template>

<style scoped>
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 12px 0 6px; }
.stat { padding: 14px; border-radius: 12px; background: var(--solid); display: flex; flex-direction: column; gap: 4px; }
.stat b { font: 500 20px/24px var(--font-sans); letter-spacing: -.01em; font-variant-numeric: tabular-nums; }
.stat span { font: 400 11px/16px var(--font-sans); color: var(--ink-3); }
.acts { display: flex; align-items: center; gap: 10px; padding: 12px 0; }
.hint { font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.prog { margin-bottom: 12px; }
.empty { padding: 22px 0; text-align: center; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.empty.err { color: var(--danger); }
.bk { display: flex; align-items: center; gap: 12px; padding: 12px 0; }
.bk + .bk { box-shadow: 0 -1px 0 var(--separator); }
.bk-m { flex: 1; min-width: 0; }
.bk-t { display: flex; align-items: center; gap: 6px; font: 400 13px/18px var(--font-sans); }
.bk-t .mono { font-family: var(--font-mono); font-size: 12.5px; }
.tag { height: 18px; padding: 0 6px; border-radius: 5px; background: var(--solid); font: 400 10.5px/18px var(--font-sans); color: var(--ink-3); }
.bk-d { margin-top: 2px; font: 400 11.5px/16px var(--font-sans); color: var(--ink-3); }
.bk-a { display: flex; gap: 6px; flex: none; }
.pv { margin: 0 0 12px; padding: 16px 18px; border-radius: 12px; background: var(--solid); }
.pv-h { font: 500 13.5px/20px var(--font-sans); }
.note { margin-top: 4px; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.lines { margin: 12px 0 6px; display: flex; flex-direction: column; gap: 6px; }
.ln { display: flex; gap: 12px; font: 400 12.5px/18px var(--font-sans); }
.ln span:first-child { width: 72px; flex: none; color: var(--ink-3); }
.pv :deep(.sr) { padding-left: 0; }
</style>
