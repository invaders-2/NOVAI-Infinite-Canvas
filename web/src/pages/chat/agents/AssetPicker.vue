<script setup>
// 「选择资产库文件」弹层：合并两类来源——素材库既有条目（/api/asset-library + /api/local-assets）
// 与智能体/技能产物（/api/asset-library/agent-artifacts，只读）。展示/排序沿用 assets/lib/util.js 的
// assetKind / shortDate / formatFileSize / zhCompare，按 created_at 倒序，不按类型过滤；
// 选中后交给 Composer 挂成附件，HTML / Excel 产物复用 chat/agents/artifacts.js 的打开方式预览。
import { ref, onMounted, onBeforeUnmount, computed } from 'vue';
import ChIcon from '../ChIcon.vue';
import { apiJson, assetKind, shortDate, formatFileSize, assetPreviewUrl, zhCompare } from '../../assets/lib/util.js';
import { isDoc, isSheet, openArtifact } from './artifacts.js';

const emit = defineEmits(['pick', 'close']);
const loading = ref(true);
const error = ref('');
const items = ref([]);

const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)(\?|#|$)/i;
// 产物类型 -> 图标：以接口返回的 kind 为准，未命中的沿用 util.js 的 assetKind
const KIND_ICON = {
    html: 'doc', htm: 'doc', pdf: 'doc', doc: 'doc', docx: 'doc',
    markdown: 'doc', text: 'doc',
    xlsx: 'table', xls: 'table', xlsm: 'table', csv: 'table',
    json: 'code', zip: 'box',
};

function isImage(item) { return assetKind(item) === 'image' && IMAGE_RE.test(String(item.url || item.name || '')); }
function iconOf(item) {
    const raw = String((item && item.kind) || '').toLowerCase();
    if (KIND_ICON[raw]) return KIND_ICON[raw];
    const kind = assetKind(item);
    if (kind === 'video') return 'video';
    if (kind === 'audio') return 'music';
    if (kind === 'text') return 'doc';
    return 'file';
}
// 文档 / 表格产物可预览：HTML 渲染打开、Excel 走下载，与能力消息里的产物行为一致
function canPreview(item) { return isDoc(item) || isSheet(item); }
function previewLabel(item) { return isSheet(item) ? '下载' : '打开'; }
function flattenLibrary(lib) {
    const out = [];
    const libraries = (lib && Array.isArray(lib.libraries) && lib.libraries.length) ? lib.libraries : [{ name: '资产库', categories: (lib && lib.categories) || [] }];
    libraries.forEach(l => (l.categories || []).forEach(c => (c.items || []).forEach(it => {
        out.push(Object.assign({}, it, { source: l.name || '资产库', category: c.name || '' }));
    })));
    return out;
}
async function load() {
    loading.value = true;
    error.value = '';
    try {
        const [lib, local, generated] = await Promise.all([
            apiJson('/api/asset-library').catch(() => ({ libraries: [] })),
            apiJson('/api/local-assets').catch(() => ({ items: [] })),
            apiJson('/api/asset-library/agent-artifacts').catch(() => ({ items: [] })),
        ]);
        const list = flattenLibrary((lib && lib.library) || lib)
            .concat((local.items || []).map(it => Object.assign({}, it, { source: '本地上传' })))
            .concat(generated.items || []);
        list.sort((a, b) => (Number(b.created_at) || 0) - (Number(a.created_at) || 0) || zhCompare(a.name, b.name));
        items.value = list;
    } catch (err) {
        error.value = (err && err.message) || '素材库加载失败';
    } finally {
        loading.value = false;
    }
}
function pick(item) { if (item && item.url) emit('pick', item); }
function preview(item, event) { event.stopPropagation(); openArtifact(item); }
function onKey(e) { if (e.key === 'Escape') emit('close'); }
onMounted(() => { load(); window.addEventListener('keydown', onKey); });
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

const total = computed(() => items.value.length);
</script>

<template>
    <div class="ap-scrim" @click.self="emit('close')">
        <div class="ap" role="dialog" aria-modal="true" aria-label="选择资产库文件">
            <header class="ap-hd">
                <span class="tt">
                    <b>选择资产库文件</b>
                    <em>{{ loading ? '加载中…' : total + ' 个文件' }}</em>
                </span>
                <button type="button" class="nv-icon-btn sm round" title="关闭" aria-label="关闭" @click="emit('close')"><ChIcon name="x" /></button>
            </header>
            <div class="ap-body">
                <div v-if="loading" class="ap-state"><span class="spin"></span><p>正在读取素材库…</p></div>
                <div v-else-if="error" class="ap-state err"><ChIcon name="alert" /><p>{{ error }}</p>
                    <button type="button" class="nv-btn sm" @click="load">重试</button>
                </div>
                <div v-else-if="!items.length" class="ap-state"><ChIcon name="library" /><p>素材库还没有文件</p><span class="sub">上传文件或图片后会出现在这里</span></div>
                <div v-else class="ap-grid">
                    <div v-for="it in items" :key="it.url" class="ap-cell">
                        <button type="button" class="ap-card" :title="it.name" @click="pick(it)">
                            <span class="th">
                                <img v-if="isImage(it)" :src="assetPreviewUrl(it.url, 200)" alt="" loading="lazy" />
                                <ChIcon v-else :name="iconOf(it)" />
                            </span>
                            <span class="nm">{{ it.name || it.url }}</span>
                            <span class="mt"><em>{{ it.source }}</em><span>{{ shortDate(it.created_at) }}</span><span v-if="it.size">{{ formatFileSize(it.size) }}</span></span>
                        </button>
                        <button v-if="canPreview(it)" type="button" class="ap-open" :title="previewLabel(it)" :aria-label="previewLabel(it)" @click="preview(it, $event)"><ChIcon name="eye" /></button>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.ap-scrim { position: fixed; inset: 0; z-index: 2400; background: var(--scrim); backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); display: flex; align-items: center; justify-content: center; padding: 24px; }
.ap { width: min(760px, 100%); max-height: min(640px, 84vh); display: flex; flex-direction: column; gap: 10px; padding: 16px; border-radius: 20px;
    background: var(--glass-strong); backdrop-filter: blur(44px) saturate(190%); -webkit-backdrop-filter: blur(44px) saturate(190%);
    box-shadow: var(--shadow-rim), var(--shadow-dialog); }
.ap-hd { flex: none; display: flex; align-items: center; gap: 10px; }
.ap-hd .tt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ap-hd .tt b { font: 500 15px/20px var(--font-sans); color: var(--ink); }
.ap-hd .tt em { font: 400 11px/1 var(--font-mono); font-style: normal; letter-spacing: .03em; color: var(--ink-4); }
.ap-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.ap-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.ap-cell { position: relative; display: flex; min-width: 0; }
.ap-open { position: absolute; top: 10px; right: 10px; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 8px; cursor: pointer; background: var(--solid); color: var(--ink-3); display: inline-flex; align-items: center; justify-content: center; box-shadow: var(--shadow-float); transition: background var(--duration-fast), color var(--duration-fast); }
.ap-open:hover { background: var(--fill-2); color: var(--ink); }
.ap-open .nv-i { width: 14px; height: 14px; }
.ap-card { flex: 1; display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 0; border-radius: 14px; background: var(--fill-1); color: var(--ink); cursor: pointer; text-align: left;
    transition: background var(--duration-fast), transform var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out); }
.ap-card:hover { background: var(--fill-2); transform: translateY(-1px); box-shadow: var(--shadow-float); }
.ap-card .th { width: 100%; aspect-ratio: 4 / 3; border-radius: 10px; background: var(--glass-strong); color: var(--ink-3); display: flex; align-items: center; justify-content: center; overflow: hidden; }
.ap-card .th img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ap-card .th .nv-i { width: 22px; height: 22px; }
.ap-card .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 12px/16px var(--font-sans); color: var(--ink); }
.ap-card .mt { display: flex; align-items: center; gap: 6px; min-width: 0; font: 400 10.5px/1 var(--font-sans); color: var(--ink-4); }
.ap-card .mt em { font-style: normal; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ap-card .mt span { flex: none; }
.ap-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 9px; min-height: 220px; text-align: center; }
.ap-state .nv-i { width: 22px; height: 22px; color: var(--ink-4); }
.ap-state p { margin: 0; font: 400 13px/20px var(--font-sans); color: var(--ink-2); }
.ap-state .sub { font: 400 11.5px/17px var(--font-sans); color: var(--ink-4); }
.ap-state.err p { color: var(--danger); }
@media (max-width: 720px) { .ap-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 520px) { .ap-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
