<script setup>
// 发布到社区（M2）：宽 720 的磨砂弹窗，画布 / 技能 / 提示词共用同一个。
// 入口：画布分享菜单（经桥接消息）、技能管理、提示词库、社区页与「我的」页的「发布作品」。
// request: { kind, sourceId, itemId?, title? }；没有 sourceId 时先走「选类型 + 选来源」那一步。
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import NvIcon from '../NvIcon.vue';
import { toast } from '../../lib/store.js';
import { ago, CATEGORIES, communityApi, fmtSize, KINDS, kindMeta } from '../../lib/community.js';

const props = defineProps({ request: { type: Object, required: true } });
const emit = defineEmits(['close', 'done']);

const step = ref(props.request && props.request.sourceId ? 'form' : 'pick');
const kind = ref(props.request && props.request.kind ? props.request.kind : 'canvas');
const sourceId = ref((props.request && props.request.sourceId) || '');
const itemId = ref((props.request && props.request.itemId) || '');
const editMode = computed(() => !!itemId.value);

const loading = ref(false);
const saving = ref(false);
const error = ref('');
const visible = ref(true);
const source = ref(null);
const form = reactive({
    title: '', desc: '', category: '', tags: [], cover: '',
    allow_clone: true, include_media: true,
});
const tagInput = ref('');
const tagOpen = ref(false);
const catOpen = ref(false);

const pick = reactive({ kind: 'canvas', q: '', loading: false, items: [] });
const fileInput = ref(null);
let pickRequest = 0;

/* ───────── 来源候选（先选类型和来源） ───────── */
async function loadPicker() {
    const seq = ++pickRequest;
    pick.loading = true;
    pick.items = [];
    try {
        if (pick.kind === 'canvas') {
            const r = await fetch('/api/canvases', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
            const data = await r.json();
            const list = (Array.isArray(data && data.canvases) ? data.canvases : []).filter(c => c && !c.deleted_at);
            if (seq === pickRequest) {
                pick.items = list.map(c => ({
                    id: c.id, title: c.title || '未命名画布',
                    sub: (c.node_count || 0) + ' 个节点 · ' + ago(c.updated_at || c.created_at),
                    kind: 'canvas',
                }));
            }
        } else if (pick.kind === 'skill') {
            const r = await fetch('/api/skills', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
            const data = await r.json();
            const list = Array.isArray(data && data.skills) ? data.skills : [];
            if (seq === pickRequest) {
                pick.items = list.map(s => ({
                    id: s.id, title: s.name || s.id, sub: s.description || s.category || '技能', kind: 'skill',
                }));
            }
        } else {
            const r = await fetch('/api/prompt-libraries', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
            const data = await r.json();
            const libraries = (data && data.library && data.library.libraries) || [];
            const items = [];
            libraries.forEach(lib => {
                (lib.items || []).forEach(it => {
                    items.push({ id: it.id, title: it.name || '提示词', sub: String(it.positive || '').slice(0, 60), kind: 'prompt' });
                });
            });
            if (seq === pickRequest) pick.items = items;
        }
    } catch (e) {
        if (seq === pickRequest) pick.items = [];
    } finally {
        if (seq === pickRequest) pick.loading = false;
    }
}
const pickFiltered = computed(() => {
    const q = pick.q.trim().toLowerCase();
    if (!q) return pick.items.slice(0, 200);
    return pick.items.filter(it => (it.title + ' ' + (it.sub || '')).toLowerCase().includes(q)).slice(0, 200);
});
function chooseSource(it) {
    kind.value = it.kind;
    sourceId.value = it.id;
    step.value = 'form';
}
watch(() => pick.kind, loadPicker);

/* ───────── 来源条 + 表单初值 ───────── */
const thumb = url => (url && /^\/(output|assets)\//.test(url)) ? '/api/media-preview?url=' + encodeURIComponent(url) + '&w=240' : (url || '');

async function loadSource() {
    if (!sourceId.value) return;
    loading.value = true;
    error.value = '';
    try {
        const data = await communityApi('/source?kind=' + encodeURIComponent(kind.value) + '&source_id=' + encodeURIComponent(sourceId.value));
        source.value = data.source || null;
        const s = source.value || {};
        form.title = String(props.request.title || s.title || '').slice(0, 60);
        form.desc = String(s.desc || '').slice(0, 400);
        form.cover = (s.covers && s.covers[0]) || '';
        if (itemId.value) await loadExisting();
    } catch (e) {
        error.value = e.message || '读不到来源信息';
    } finally {
        loading.value = false;
    }
}

async function loadExisting() {
    try {
        const data = await communityApi('/mine');
        const item = (data.items || []).find(it => it.id === itemId.value);
        if (!item) return;
        if (!source.value) source.value = { title: item.title, nodes: (item.meta || {}).nodes || 0, media: (item.meta || {}).media || 0, size_bytes: (item.meta || {}).size_bytes || 0 };
        form.title = item.title || form.title;
        form.desc = item.desc || '';
        form.category = item.category || '';
        form.tags = Array.isArray(item.tags) ? [...item.tags] : [];
        form.allow_clone = item.allow_clone !== false;
        form.include_media = item.include_media !== false;
        if (item.cover) form.cover = '@package';
    } catch (e) { /* 编辑信息读不到就让用户重填 */ }
}

async function loadSettings() {
    try {
        const data = await communityApi('/settings');
        visible.value = data.visible !== false;
    } catch (e) { visible.value = true; }
}

async function toggleVisible() {
    const next = !visible.value;
    try {
        const data = await communityApi('/settings', { method: 'PUT', body: { visible: next } });
        visible.value = data.visible !== false;
        toast(visible.value ? '已开启局域网社区可见' : '已关闭局域网社区可见，别人看不到你的作品');
    } catch (e) {
        toast(e.message || '切换失败', { danger: true });
    }
}

/* ───────── 标签 / 分类 / 封面 ───────── */
function addTag() {
    const text = tagInput.value.trim().slice(0, 16);
    if (!text) return;
    if (form.tags.length >= 8) { toast('标签最多 8 个'); return; }
    if (!form.tags.includes(text)) form.tags.push(text);
    tagInput.value = '';
}
function removeTag(tag) { form.tags = form.tags.filter(t => t !== tag); }
function toggleTagInput() { tagOpen.value = !tagOpen.value; if (tagOpen.value) catOpen.value = false; }
function pickCategory(name) { form.category = name; catOpen.value = false; }
function pickCover(url) { form.cover = url; }
function uploadCover() { if (fileInput.value) fileInput.value.click(); }
async function onCoverFile(event) {
    const file = (event.target.files || [])[0];
    event.target.value = '';
    if (!file) return;
    const body = new FormData();
    body.append('files', file);
    try {
        const r = await fetch('/api/local-assets/upload', { method: 'POST', body, credentials: 'same-origin' });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((data && data.detail) || '上传失败');
        const first = (data.files || [])[0];
        if (first && first.url) form.cover = first.url;
    } catch (e) {
        toast(e.message || '封面上传失败', { danger: true });
    }
}

/* ───────── 提交 ───────── */
async function submit() {
    if (saving.value) return;
    if (!form.title.trim()) { toast('给作品起个名字', { danger: true }); return; }
    saving.value = true;
    error.value = '';
    try {
        const body = {
            kind: kind.value,
            source_id: sourceId.value,
            title: form.title.trim(),
            desc: form.desc.trim(),
            tags: form.tags,
            category: form.category,
            cover: form.cover === '@package' ? '' : form.cover,
            allow_clone: form.allow_clone,
            include_media: form.include_media,
        };
        if (editMode.value) {
            const data = await communityApi('/mine/' + encodeURIComponent(itemId.value), { method: 'PATCH', body });
            toast('发布信息已更新');
            emit('done', data.item || null);
        } else {
            const data = await communityApi('/publish', { method: 'POST', body });
            visible.value = data.visible !== false;
            toast('已发布到社区');
            emit('done', data.item || null);
        }
    } catch (e) {
        error.value = e.message || '发布失败';
    } finally {
        saving.value = false;
    }
}

function onKey(event) { if (event.key === 'Escape') emit('close'); }
function onDocDown(event) {
    if (!event.target.closest || !event.target.closest('.pd-pop, .pd-dd')) {
        tagOpen.value = false;
        catOpen.value = false;
    }
}

const kindLabel = computed(() => kindMeta(kind.value).label);
const mediaText = computed(() => {
    const s = source.value || {};
    if (kind.value !== 'canvas') return '';
    const nodes = Number(s.nodes) || 0;
    const media = Number(s.media) || 0;
    return kindLabel.value + ' · ' + nodes + ' 个节点 · ' + media + ' 张生成结果';
});

onMounted(() => {
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDocDown, true);
    loadSettings();
    if (step.value === 'form') loadSource();
    else loadPicker();
    nextTick(() => { if (fileInput.value) fileInput.value.value = ''; });
});
onBeforeUnmount(() => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('mousedown', onDocDown, true);
});
</script>

<template>
    <Teleport to="#nv-layer">
        <div class="pd-scrim" @click="emit('close')"></div>
        <div class="pd" role="dialog" aria-modal="true" aria-label="发布到社区">
            <header class="pd-h">
                <h2>{{ editMode ? '编辑发布信息' : '发布到社区' }}</h2>
                <span class="sp"></span>
                <button type="button" class="pd-x" aria-label="关闭" @click="emit('close')"><NvIcon name="x" /></button>
            </header>

            <!-- 第一步：选类型和来源 -->
            <div v-if="step === 'pick'" class="pd-body">
                <div class="pd-kinds">
                    <button v-for="k in KINDS" :key="k" type="button" :class="{ on: pick.kind === k }" @click="pick.kind = k">
                        <NvIcon :name="kindMeta(k).icon" />{{ kindMeta(k).label }}
                    </button>
                </div>
                <label class="pd-field pd-search">
                    <NvIcon name="search" />
                    <input v-model="pick.q" type="search" :placeholder="'搜索' + kindMeta(pick.kind).label" autocomplete="off" />
                </label>
                <div class="pd-picks">
                    <div v-if="pick.loading" class="pd-empty">正在读取…</div>
                    <div v-else-if="!pickFiltered.length" class="pd-empty">{{ kindMeta(pick.kind).label }}还是空的，先去创建一个</div>
                    <button v-for="it in pickFiltered" :key="it.id" type="button" class="pd-pick" @click="chooseSource(it)">
                        <NvIcon :name="kindMeta(it.kind).icon" />
                        <span class="tx"><b>{{ it.title }}</b><small>{{ it.sub }}</small></span>
                        <NvIcon name="chevr" />
                    </button>
                </div>
            </div>

            <!-- 第二步：填写发布信息 -->
            <div v-else class="pd-body">
                <div v-if="loading" class="pd-empty">正在读取来源…</div>
                <template v-else>
                    <div class="pd-src">
                        <span class="cv">
                            <img v-if="form.cover && form.cover !== '@package'" :src="thumb(form.cover)" alt="" />
                            <img v-else-if="form.cover === '@package' && source" :src="'/api/community/cover/' + itemId" alt="" />
                            <NvIcon v-else :name="kindMeta(kind).icon" />
                        </span>
                        <div class="tx">
                            <b>{{ (source && source.title) || form.title || '未命名' }}</b>
                            <small>{{ mediaText || kindLabel }}</small>
                        </div>
                    </div>

                    <div v-if="kind === 'canvas'" class="pd-row">
                        <span class="pd-label">封面</span>
                        <div class="pd-covers">
                            <button v-for="url in (source && source.covers) || []" :key="url" type="button" class="pd-cv" :class="{ on: form.cover === url }" @click="pickCover(url)">
                                <img :src="thumb(url)" alt="" />
                                <span v-if="form.cover === url" class="ck"><NvIcon name="check" /></span>
                            </button>
                            <button type="button" class="pd-cv up" @click="uploadCover"><NvIcon name="upload" /><span>本地上传</span></button>
                            <input ref="fileInput" type="file" accept="image/*" hidden @change="onCoverFile" />
                        </div>
                    </div>

                    <label class="pd-row">
                        <span class="pd-label">标题</span>
                        <input v-model="form.title" class="pd-input" maxlength="60" placeholder="给作品起个名字" />
                    </label>
                    <label class="pd-row">
                        <span class="pd-label">简介</span>
                        <textarea v-model="form.desc" class="pd-input pd-area" rows="3" maxlength="400" placeholder="说说它做什么、怎么用"></textarea>
                    </label>

                    <div class="pd-two">
                        <div class="pd-row pd-col">
                            <span class="pd-label">分类</span>
                            <div class="pd-dd">
                                <button type="button" class="pd-input pd-select" @click="catOpen = !catOpen">
                                    <span>{{ form.category || '选择分类' }}</span><NvIcon name="chev" />
                                </button>
                                <Transition name="pd-pop">
                                    <div v-if="catOpen" class="pd-pop">
                                        <button v-for="c in CATEGORIES" :key="c" type="button" class="pd-item" :class="{ on: form.category === c }" @click="pickCategory(c)">{{ c }}</button>
                                    </div>
                                </Transition>
                            </div>
                        </div>
                        <div class="pd-row pd-col">
                            <span class="pd-label">标签</span>
                            <div class="pd-tags">
                                <span v-for="tag in form.tags" :key="tag" class="pd-tag">{{ tag }}<button type="button" :aria-label="'删除标签 ' + tag" @click="removeTag(tag)"><NvIcon name="x" /></button></span>
                                <button type="button" class="pd-tag add" @click="toggleTagInput"><NvIcon name="plus" />添加</button>
                            </div>
                            <Transition name="pd-pop">
                                <div v-if="tagOpen" class="pd-pop pd-tagpad">
                                    <input v-model="tagInput" class="pd-input" maxlength="16" placeholder="输入标签，回车添加" @keydown.enter.prevent="addTag" />
                                    <button type="button" class="nv-btn sm" @click="addTag">加上</button>
                                </div>
                            </Transition>
                        </div>
                    </div>

                    <div class="pd-opts">
                        <div class="pd-opt">
                            <div><b>允许克隆</b><small>关闭后别人只能查看，不能复制到自己的画布</small></div>
                            <button type="button" class="nv-switch" :class="{ 'is-on': form.allow_clone }" :aria-pressed="form.allow_clone" aria-label="允许克隆" @click="form.allow_clone = !form.allow_clone"></button>
                        </div>
                        <div v-if="kind === 'canvas'" class="pd-opt">
                            <div><b>包含生成结果</b><small>把图片和视频一起放进发布包，（约 {{ fmtSize((source && source.size_bytes) || 0) }}）</small></div>
                            <button type="button" class="nv-switch" :class="{ 'is-on': form.include_media }" :aria-pressed="form.include_media" aria-label="包含生成结果" @click="form.include_media = !form.include_media"></button>
                        </div>
                    </div>

                    <div v-if="visible" class="pd-vis"><span class="dot" aria-hidden="true"></span>局域网可见已开启 · 同一网络里打开 NOVAI 的人能在社区看到它。API Key 和本机路径不会被发布。</div>
                    <div v-else class="pd-vis off">
                        <span class="dot" aria-hidden="true"></span>
                        <span class="tx">现在别人看不到你的作品。打开「在局域网社区中可见」后，社区里的同事才能看到并克隆。</span>
                        <button type="button" class="nv-btn sm" @click="toggleVisible">{{ '开启' }}</button>
                    </div>

                    <div v-if="error" class="pd-err" role="alert">{{ error }}</div>
                </template>
            </div>

            <footer class="pd-f">
                <button v-if="step === 'form' && !props.request.sourceId" type="button" class="nv-btn" @click="step = 'pick'">返回</button>
                <span class="sp"></span>
                <button type="button" class="nv-btn" @click="emit('close')">取消</button>
                <button v-if="step === 'form'" type="button" class="nv-btn primary" :disabled="saving || loading" @click="submit">{{ saving ? '发布中…' : (editMode ? '保存' : '发布') }}</button>
            </footer>
        </div>
    </Teleport>
</template>

<style scoped>
/* 宽 720 磨砂弹窗：底色保证模糊失效也能读，无描边 */
.pd-scrim { position: fixed; inset: 0; z-index: 80; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); animation: pdFade .2s ease; }
.pd { position: fixed; left: 50%; top: 50%; z-index: 81; transform: translate(-50%, -50%); width: min(720px, calc(100vw - 32px)); max-height: min(760px, calc(100vh - 64px));
    display: flex; flex-direction: column; border-radius: 20px; overflow: hidden; color: var(--ink); font-family: var(--font-sans);
    background: color-mix(in srgb, var(--solid) 88%, transparent); backdrop-filter: blur(44px) saturate(190%); -webkit-backdrop-filter: blur(44px) saturate(190%);
    box-shadow: var(--shadow-dialog); animation: pdIn .24s var(--ease-out); }
@keyframes pdIn { from { opacity: 0; transform: translate(-50%, -48%) scale(.98); } }
@keyframes pdFade { from { opacity: 0; } }
html.theme-dark .pd { background: color-mix(in srgb, #1a1a1a 90%, transparent); }
.pd-h { display: flex; align-items: center; gap: 10px; padding: 14px 14px 12px 20px; }
.pd-h h2 { margin: 0; font: 600 16px/22px var(--font-sans); letter-spacing: -.01em; }
.sp { flex: 1; }
.pd-x { width: 30px; height: 30px; border: 0; border-radius: 15px; background: transparent; color: var(--ink-3); display: flex; align-items: center; justify-content: center; cursor: pointer; }
.pd-x:hover { background: var(--fill-1); color: var(--ink); }
.pd-x .nv-i { width: 16px; height: 16px; }
.pd-body { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 20px 8px; display: flex; flex-direction: column; gap: 14px; }
.pd-f { display: flex; align-items: center; gap: 8px; padding: 14px 20px 18px; }
.pd-f .nv-btn { height: 34px; border-radius: 17px; padding: 0 18px; }

/* 选来源 */
.pd-kinds { display: flex; gap: 4px; }
.pd-kinds button { height: 30px; padding: 0 12px; border: 0; border-radius: 15px; background: var(--fill-1); color: var(--ink-3); font: 500 12.5px/1 var(--font-sans); display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.pd-kinds button .nv-i { width: 13px; height: 13px; }
.pd-kinds button.on { background: var(--fill-2); color: var(--ink); }
.pd-search { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px; border-radius: 17px; background: var(--fill-1); color: var(--ink-3); }
.pd-search .nv-i { width: 14px; height: 14px; }
.pd-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--ink); font: 400 12.5px/1 var(--font-sans); }
.pd-search input::-webkit-search-cancel-button { display: none; }
.pd-picks { display: flex; flex-direction: column; gap: 2px; min-height: 160px; }
.pd-pick { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px; border: 0; border-radius: 12px; background: transparent; color: var(--ink); text-align: left; cursor: pointer; }
.pd-pick:hover { background: var(--fill-1); }
.pd-pick > .nv-i { width: 15px; height: 15px; color: var(--ink-3); flex: none; }
.pd-pick .tx { flex: 1; min-width: 0; }
.pd-pick b { display: block; font: 500 13px/18px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pd-pick small { display: block; margin-top: 1px; font: 400 11.5px/16px var(--font-sans); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* 来源条 */
.pd-src { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 14px; background: var(--fill-1); }
.pd-src .cv { width: 46px; height: 46px; flex: none; border-radius: 11px; overflow: hidden; background: var(--fill-2); display: flex; align-items: center; justify-content: center; color: var(--ink-3); }
.pd-src .cv img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pd-src .cv .nv-i { width: 18px; height: 18px; }
.pd-src .tx { min-width: 0; }
.pd-src b { display: block; font: 500 13px/18px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pd-src small { display: block; margin-top: 2px; font: 400 11.5px/16px var(--font-sans); color: var(--ink-3); }

/* 表单 */
.pd-row { display: flex; align-items: flex-start; gap: 12px; }
.pd-label { width: 44px; flex: none; padding-top: 7px; font: 500 12px/18px var(--font-sans); color: var(--ink-3); }
.pd-input { flex: 1; min-width: 0; border: 0; outline: 0; box-shadow: none; border-radius: 10px; background: var(--fill-1); color: var(--ink); font: 400 13px/20px var(--font-sans); padding: 8px 12px; }
.pd-input:focus, .pd-input:focus-visible { outline: none; box-shadow: none; background: var(--fill-2); }
.pd-area { resize: vertical; min-height: 64px; max-height: 180px; }
.pd-covers { flex: 1; display: flex; gap: 8px; flex-wrap: wrap; }
.pd-cv { position: relative; width: 78px; height: 58px; border: 0; padding: 0; border-radius: 10px; overflow: hidden; background: var(--fill-1); cursor: pointer; }
.pd-cv img { width: 100%; height: 100%; object-fit: cover; display: block; }
/* 唯一允许的选中描边：1.5px 墨色 + 2px 间距 */
.pd-cv.on { box-shadow: 0 0 0 2px var(--solid), 0 0 0 3.5px var(--ink); }
.pd-cv .ck { position: absolute; right: 4px; bottom: 4px; width: 18px; height: 18px; border-radius: 50%; background: var(--accent); color: var(--on-accent); display: flex; align-items: center; justify-content: center; }
.pd-cv .ck .nv-i { width: 11px; height: 11px; }
.pd-cv.up { width: 78px; height: 58px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; color: var(--ink-3); font: 400 10.5px/1 var(--font-sans); }
.pd-cv.up .nv-i { width: 14px; height: 14px; }
.pd-cv.up:hover { background: var(--fill-2); color: var(--ink); }
.pd-two { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 16px; }
.pd-col { flex-direction: column; gap: 0; }
.pd-col .pd-label { width: auto; padding-top: 0; margin-bottom: 6px; }
.pd-dd { position: relative; }
.pd-select { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 6px; cursor: pointer; text-align: left; }
.pd-select .nv-i { width: 12px; height: 12px; color: var(--ink-3); }
.pd-pop { position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 3; padding: 4px; border-radius: 12px; background: var(--solid); box-shadow: var(--shadow-pop); animation: pdPop .14s ease both; }
@keyframes pdPop { from { opacity: 0; transform: translateY(-4px); } }
.pd-item { display: block; width: 100%; height: 28px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; color: var(--ink); font: 400 12.5px/1 var(--font-sans); text-align: left; cursor: pointer; }
.pd-item:hover, .pd-item.on { background: var(--fill-1); }
.pd-tags { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; position: relative; }
.pd-tag { display: inline-flex; align-items: center; gap: 3px; height: 26px; padding: 0 6px 0 10px; border: 0; border-radius: 13px; background: var(--fill-1); font: 400 12px/1 var(--font-sans); color: var(--ink-2); }
.pd-tag button { width: 16px; height: 16px; border: 0; border-radius: 8px; background: transparent; color: var(--ink-4); display: flex; align-items: center; justify-content: center; cursor: pointer; }
.pd-tag button:hover { background: var(--fill-2); color: var(--ink); }
.pd-tag button .nv-i { width: 10px; height: 10px; }
.pd-tag.add { background: var(--fill-1); color: var(--ink-3); padding: 0 8px; cursor: pointer; gap: 3px; }
.pd-tag.add:hover { background: var(--fill-2); color: var(--ink); }
.pd-tag.add .nv-i { width: 12px; height: 12px; }
.pd-tagpad { left: auto; right: 0; width: 240px; display: flex; gap: 6px; padding: 8px; }
.pd-tagpad input { flex: 1; }

/* 开关组 */
.pd-opts { display: flex; flex-direction: column; gap: 2px; }
.pd-opt { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 12px; background: var(--fill-1); }
.pd-opt > div { flex: 1; min-width: 0; }
.pd-opt b { display: block; font: 500 13px/18px var(--font-sans); }
.pd-opt small { display: block; margin-top: 2px; font: 400 11.5px/16px var(--font-sans); color: var(--ink-3); }
.pd-vis { display: flex; align-items: center; gap: 8px; padding: 0 2px; font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); }
.pd-vis .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--success); flex: none; }
.pd-vis.off { align-items: center; padding: 10px 12px; border-radius: 12px; background: var(--fill-1); color: var(--ink-2); }
.pd-vis.off .dot { background: var(--ink-4); }
.pd-vis.off .tx { flex: 1; }
.pd-err { padding: 8px 12px; border-radius: 10px; background: var(--danger-fill); color: var(--danger); font: 400 12px/18px var(--font-sans); }
.pd-empty { padding: 28px 0; text-align: center; color: var(--ink-4); font: 400 12px/18px var(--font-sans); }
.pd-pop-enter-active, .pd-pop-leave-active { transition: opacity .14s ease, transform .14s ease; }
.pd-pop-enter-from, .pd-pop-leave-to { opacity: 0; transform: translateY(-4px); }
@media (max-width: 720px) { .pd-two { grid-template-columns: minmax(0, 1fr); } .pd-label { width: 36px; } }
</style>
