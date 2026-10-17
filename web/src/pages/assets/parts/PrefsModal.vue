<script setup>
// 偏好设置弹窗（旧 storageSettingsOverlay）：
//   偏好设置 —— 反推 / 分类默认平台与模型、反推提示词、智能分类追加要求与分类规则（可恢复内置规则）
//   素材管理 —— 三类保存目录（上传 / 生成 / 本地），目录文件浏览（分页滚动加载）、全选、删除磁盘文件
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import MenuSelect from './MenuSelect.vue';
import { S, setStatus, fail, ask, captionProviders, captionModels, setCaptionProvider, setCaptionModel, writeCaptionSettings, normalizeCaption } from '../lib/state.js';
import { apiJson, jsonBody, formatFileSize } from '../lib/util.js';

const KIND_LABELS = { upload: '上传素材', generated: '生成素材', local: '本地素材' };
const tab = ref('prefs');
const editor = ref('');
const dirs = reactive({ upload: '', generated: '', local: '' });
const defaults = ref({});
const draft = reactive({ prompt: '', classifyPrompt: '', rule: '' });
const defaultRule = ref('');
const files = reactive({ kind: 'generated', items: [], selected: new Set(), loading: false, loadingMore: false, offset: 0, total: 0, hasMore: false });
const saving = ref('');
const grid = ref(null);
const providerOpts = computed(() => captionProviders().map(p => ({ value: p.id, label: p.name || p.id })));
const modelOpts = computed(() => captionModels().map(m => ({ value: m, label: m })));

watch(() => S.prefsOpen, open => { if (open) load(); });
async function load() {
    files.selected = new Set();
    normalizeCaption();
    draft.prompt = S.caption.prompt || '描述图片';
    draft.classifyPrompt = S.caption.classifyPrompt || '';
    try {
        const [data, promptData] = await Promise.all([apiJson('/api/storage-settings'), apiJson('/api/asset-classification-prompt')]);
        Object.assign(dirs, { upload: '', generated: '', local: '' }, data.dirs || {});
        defaults.value = data.defaults || {};
        defaultRule.value = promptData.default_prompt || '';
        draft.rule = promptData.prompt || defaultRule.value || '';
        await loadFiles(files.kind || 'generated');
    } catch (err) { fail(err, '加载存储设置失败'); }
}
function close() { S.prefsOpen = false; editor.value = ''; }
function onKey(e) { if (e.key === 'Escape' && S.prefsOpen && !S.ask && !S.preview) close(); }
onMounted(() => document.addEventListener('keydown', onKey));
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
function toggleEditor(id) { editor.value = editor.value === id ? '' : id; }

async function saveEditor(which) {
    saving.value = which;
    try {
        S.caption.prompt = draft.prompt || '描述图片';
        S.caption.classifyPrompt = draft.classifyPrompt || '';
        writeCaptionSettings();
        if (which === 'classify') {
            const d = await apiJson('/api/asset-classification-prompt', jsonBody('PATCH', { prompt: draft.rule || '' }));
            draft.rule = d.prompt || draft.rule;
        }
        editor.value = '';
        setStatus('偏好设置已保存');
    } catch (err) { fail(err, '保存偏好设置失败'); } finally { saving.value = ''; }
}
async function saveDirs() {
    saving.value = 'dirs';
    try {
        const d = await apiJson('/api/storage-settings', jsonBody('PATCH', { upload: dirs.upload.trim(), generated: dirs.generated.trim(), local: dirs.local.trim() }));
        Object.assign(dirs, d.dirs || {});
        await loadFiles(files.kind);
        setStatus('偏好设置已保存');
    } catch (err) { fail(err, '保存存储设置失败'); } finally { saving.value = ''; }
}

async function loadFiles(kind, append = false) {
    if (files.loading || files.loadingMore) return;
    files.kind = kind || 'generated';
    if (append) {
        if (!files.hasMore) return;
        files.loadingMore = true;
    } else {
        Object.assign(files, { items: [], offset: 0, total: 0, hasMore: false, selected: new Set(), loading: true });
    }
    try {
        const offset = append ? files.offset : 0;
        const data = await apiJson(`/api/storage-files?kind=${encodeURIComponent(files.kind)}&offset=${encodeURIComponent(offset)}&limit=80`);
        const items = data.items || [];
        files.items = append ? [...files.items, ...items] : items;
        files.offset = offset + items.length;
        files.total = Number(data.total || files.items.length || 0);
        files.hasMore = Boolean(data.has_more);
        files.selected = new Set([...files.selected].filter(id => files.items.some(i => i.id === id)));
    } catch (err) { fail(err, append ? '加载更多图片失败' : '读取目录失败'); } finally { files.loading = false; files.loadingMore = false; }
}
function onGridScroll() {
    const g = grid.value;
    if (!g || files.loading || files.loadingMore || !files.hasMore) return;
    if (g.scrollTop + g.clientHeight >= g.scrollHeight - 260) loadFiles(files.kind, true);
}
function toggleFile(id) { if (files.selected.has(id)) files.selected.delete(id); else files.selected.add(id); }
async function deleteFiles() {
    const selected = files.items.filter(i => files.selected.has(i.id));
    if (!selected.length) return;
    if (!(await ask({ title: '删除磁盘文件', desc: `确认删除 ${selected.length} 张图片？此操作会删除磁盘文件。`, ok: '删除', danger: true }))) return;
    try {
        const data = await apiJson('/api/storage-files/delete', jsonBody('POST', { kind: files.kind, items: selected.map(i => i.rel) }));
        files.selected.clear();
        await loadFiles(files.kind);
        setStatus(`已删除 ${data.removed || 0} 个文件`);
    } catch (err) { fail(err, '删除文件失败'); }
}
</script>

<template>
    <Teleport to="#nv-layer">
        <Transition name="am-sheet">
            <div v-if="S.prefsOpen" class="am-pscrim" @click.self="close">
                <div class="am-pm" :class="{ wide: tab === 'manage' }" role="dialog" aria-modal="true" aria-label="偏好设置">
                    <div class="mh">
                        <div class="tt"><h3>偏好设置</h3><p>分开管理默认反推设置和素材目录文件。</p></div>
                        <button type="button" class="nv-icon-btn sm round" aria-label="关闭" @click="close"><NvIcon name="x" /></button>
                    </div>
                    <div class="mt">
                        <div class="nv-seg static">
                            <button type="button" :class="{ 'is-on': tab === 'prefs' }" @click="tab = 'prefs'; editor = ''"><NvIcon name="settings" />偏好设置</button>
                            <button type="button" :class="{ 'is-on': tab === 'manage' }" @click="tab = 'manage'; editor = ''"><NvIcon name="image" />素材管理</button>
                        </div>
                    </div>
                    <div class="mb">
                        <template v-if="tab === 'prefs'">
                            <section class="ps">
                                <b><NvIcon name="wand2" />基础偏好</b>
                                <div class="g2">
                                    <div class="fld"><span>平台</span><MenuSelect :model-value="S.caption.provider" :options="providerOpts" placeholder="暂无聊天平台" variant="block" @update:model-value="setCaptionProvider" /></div>
                                    <div class="fld"><span>模型</span><MenuSelect :model-value="S.caption.model" :options="modelOpts" placeholder="暂无模型" variant="block" @update:model-value="setCaptionModel" /></div>
                                </div>
                            </section>
                            <section class="ps">
                                <button type="button" class="fold" :aria-expanded="editor === 'caption'" @click="toggleEditor('caption')">
                                    <NvIcon name="msg" /><b>反推提示词</b><em>{{ S.caption.prompt || '描述图片' }}</em><NvIcon :name="editor === 'caption' ? 'chevu' : 'chev'" class="cv" />
                                </button>
                                <div v-if="editor === 'caption'" class="fed">
                                    <label class="fld"><span>反推提示词</span><textarea v-model="draft.prompt" class="am-txa" placeholder="描述图片"></textarea></label>
                                    <div class="act"><button type="button" class="nv-btn sm primary" :disabled="saving === 'caption'" @click="saveEditor('caption')"><span v-if="saving === 'caption'" class="am-spin"></span><NvIcon v-else name="save" />保存</button></div>
                                </div>
                                <div class="gap"></div>
                                <button type="button" class="fold" :aria-expanded="editor === 'classify'" @click="toggleEditor('classify')">
                                    <NvIcon name="tag" /><b>智能分类提示词</b><em>编辑分类规则和追加要求</em><NvIcon :name="editor === 'classify' ? 'chevu' : 'chev'" class="cv" />
                                </button>
                                <div v-if="editor === 'classify'" class="fed">
                                    <label class="fld"><span>智能分类追加要求</span><textarea v-model="draft.classifyPrompt" class="am-txa" placeholder="可追加分类要求，例如：增加家装风格、镜头焦段、商业用途、人物年龄段、产品材质。"></textarea></label>
                                    <div class="fld">
                                        <span>智能分类规则<button type="button" class="lnk" @click="draft.rule = defaultRule">恢复内置规则</button></span>
                                        <textarea v-model="draft.rule" class="am-txa rule" placeholder="这里显示内置分类提示词，可按你的素材体系编辑后保存。" aria-label="智能分类规则"></textarea>
                                    </div>
                                    <div class="act"><button type="button" class="nv-btn sm primary" :disabled="saving === 'classify'" @click="saveEditor('classify')"><span v-if="saving === 'classify'" class="am-spin"></span><NvIcon v-else name="save" />保存</button></div>
                                </div>
                            </section>
                        </template>
                        <template v-else>
                            <section class="ps">
                                <b><NvIcon name="folder" />保存目录</b>
                                <div class="dirs">
                                    <label v-for="k in ['upload', 'generated', 'local']" :key="k" class="dir"><span>{{ KIND_LABELS[k] }}</span><input v-model="dirs[k]" class="am-inp mono" type="text" :placeholder="defaults[k] || ''"></label>
                                </div>
                                <div class="act"><button type="button" class="nv-btn sm primary" :disabled="saving === 'dirs'" @click="saveDirs"><span v-if="saving === 'dirs'" class="am-spin"></span><NvIcon v-else name="save" />保存目录</button></div>
                            </section>
                            <div class="fhd">
                                <div class="nv-seg static">
                                    <button v-for="k in ['generated', 'upload', 'local']" :key="k" type="button" :class="{ 'is-on': files.kind === k }" @click="loadFiles(k)">{{ KIND_LABELS[k] }}</button>
                                </div>
                                <span class="am-grow"></span>
                                <button type="button" class="nv-btn sm" :disabled="!files.items.length" @click="files.items.forEach(i => files.selected.add(i.id))"><NvIcon name="check" />全选</button>
                                <button type="button" class="nv-btn sm danger" :disabled="!files.selected.size" @click="deleteFiles"><NvIcon name="trash" />删除 {{ files.selected.size || '' }}</button>
                            </div>
                            <div ref="grid" class="fgrid" @scroll.passive="onGridScroll">
                                <div v-if="files.loading" class="fmore">正在读取目录...</div>
                                <template v-else-if="files.items.length">
                                    <button v-for="it in files.items" :key="it.id" type="button" class="fc" :class="{ on: files.selected.has(it.id) }" @click="toggleFile(it.id)">
                                        <span class="im"><img :src="it.url" alt="" loading="lazy"><span class="am-ck" :class="{ on: files.selected.has(it.id) }"><NvIcon v-if="files.selected.has(it.id)" name="check" /></span></span>
                                        <b :title="it.name">{{ it.name }}</b>
                                        <em>{{ formatFileSize(it.size) }}{{ it.width ? ` · ${it.width}×${it.height}` : '' }}</em>
                                    </button>
                                    <div class="fmore">{{ files.hasMore || files.loadingMore ? (files.loadingMore ? '继续加载中...' : `已加载 ${files.items.length} / ${files.total || files.items.length}，向下滚动继续`) : `已加载全部 ${files.items.length} 张` }}</div>
                                </template>
                                <div v-else class="fmore">这个目录里暂时没有图片</div>
                            </div>
                        </template>
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.am-pscrim { position: fixed; inset: 0; z-index: 2300; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); display: flex; align-items: center; justify-content: center; padding: 24px; }
.am-pm { width: 600px; max-width: 100%; max-height: calc(100vh - 48px); display: flex; flex-direction: column; background: var(--solid); border-radius: 20px; box-shadow: var(--shadow-dialog); overflow: hidden; color: var(--ink); transition: width 240ms var(--ease-out); }
.am-pm.wide { width: 640px; }
.mh { display: flex; align-items: flex-start; gap: 10px; padding: 22px 20px 12px 24px; }
.tt { flex: 1; min-width: 0; }
h3 { margin: 0; font: 500 16px/24px var(--font-sans); letter-spacing: -.01em; }
.tt p { margin: 2px 0 0; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.mt { padding: 0 24px 14px; }
.nv-seg button { display: inline-flex; align-items: center; gap: 6px; }
.nv-seg .nv-i { width: 13px; height: 13px; }
.mb { flex: 1; min-height: 0; overflow-y: auto; padding: 0 24px 24px; display: flex; flex-direction: column; gap: 14px; }
.ps { border-radius: 14px; background: var(--fill-1); padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.ps > b { display: flex; align-items: center; gap: 8px; font: 500 13px/18px var(--font-sans); }
.ps > b .nv-i { width: 14px; height: 14px; color: var(--ink-2); }
.g2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.fld { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.fld > span { font: 400 11.5px/16px var(--font-sans); color: var(--ink-3); display: flex; align-items: center; justify-content: space-between; }
.lnk { border: 0; background: none; padding: 0; cursor: pointer; font: 400 11.5px/1 var(--font-sans); color: var(--ink); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--ink-4); }
.rule { min-height: 120px; }
.fold { display: flex; align-items: center; gap: 10px; width: 100%; height: 40px; padding: 0 2px; border: 0; background: none; color: var(--ink); cursor: pointer; text-align: left; }
.fold .nv-i { width: 14px; height: 14px; color: var(--ink-2); flex: none; }
.fold b { font: 500 12.5px/1 var(--font-sans); white-space: nowrap; }
.fold em { flex: 1; min-width: 0; font: 400 11.5px/1 var(--font-sans); font-style: normal; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fold .cv { width: 12px; height: 12px; color: var(--ink-3); }
.gap { height: 2px; }
.fed { display: flex; flex-direction: column; gap: 10px; padding: 4px 0 4px; }
.act { display: flex; justify-content: flex-end; }
.dirs { display: flex; flex-direction: column; gap: 8px; }
.dir { display: grid; grid-template-columns: 64px 1fr; align-items: center; gap: 10px; }
.dir span { font: 400 12px/1 var(--font-sans); color: var(--ink-2); }
.dir .am-inp { height: 32px; background: var(--solid); }
.mono { font-family: var(--font-mono); font-size: 11.5px; }
.fhd { display: flex; align-items: center; gap: 6px; }
.fgrid { max-height: 360px; overflow-y: auto; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; padding: 4px; margin: -4px; }
.fc { display: flex; flex-direction: column; gap: 4px; min-width: 0; padding: 0; border: 0; background: none; color: var(--ink); text-align: left; cursor: pointer; }
.fc .im { position: relative; aspect-ratio: 1; border-radius: 10px; overflow: hidden; background: var(--fill-1); transition: box-shadow var(--duration-fast); }
.fc .im img { width: 100%; height: 100%; object-fit: cover; display: block; }
.fc.on .im { box-shadow: var(--shadow-lift); }
.fc .am-ck { left: 6px; top: 6px; }
.fc b { font: 400 11px/15px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fc em { font: 400 11px/13px var(--font-mono); font-style: normal; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fmore { grid-column: 1 / -1; text-align: center; padding: 10px 0 4px; font: 400 11px/16px var(--font-sans); color: var(--ink-3); }
.am-sheet-enter-active { transition: opacity 200ms var(--ease-out); }
.am-sheet-leave-active { transition: opacity 160ms var(--ease-out); }
.am-sheet-enter-from, .am-sheet-leave-to { opacity: 0; }
.am-sheet-enter-active .am-pm { transition: transform 320ms var(--ease-sheet), opacity 200ms var(--ease-out); }
.am-sheet-enter-from .am-pm { transform: translateY(10px) scale(.98); opacity: 0; }
.am-sheet-leave-to .am-pm { transform: scale(.98); opacity: 0; }
@media (max-width: 640px) { .g2 { grid-template-columns: 1fr; } .fgrid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
</style>
