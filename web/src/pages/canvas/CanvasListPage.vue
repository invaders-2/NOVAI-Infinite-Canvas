<script setup>
// 画布列表（替换旧 canvas-list.html）。功能一一对应：
//   顶部介绍 + 开始创作 / 继续上次 + 三张轮播（图像 / 视频 / 节点）；搜索、排序（记在本机）、新建画布；
//   卡片（1–4 张缩略图铺满、智能/画布标记、打开、更多：重命名 / 复制画布 / 删除）；
//   回收站（角标、恢复、彻底删除二次确认、清空）；新建选择器（普通 / 智能）；空状态 / 无搜索结果。
// 改进：删除改为「立即删除 + 5 秒撤销」；复制画布会连同节点和连线一起复制（旧版只建了同名空画布）。
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import { state, toast } from '../../lib/store.js';
import { openCanvasUrl } from '../../lib/bridge.js';
import { assetPreviewUrl } from '../assets/lib/util.js';

const SORT_KEY = 'novai_canvas_list_sort';
const THUMB_W = 480;          // 卡片缩略图长边；原图只在打开画布/大图预览时用
const FIRST_BATCH = 12;       // 首屏渲染卡片数
const BATCH = 12;             // 每次「继续加载」追加数
const SORTS = [
    { id: 'updated', label: '最近更新' },
    { id: 'created', label: '最近创建' },
    { id: 'name', label: '按名称' },
];

const canvases = ref([]);
const trash = ref([]);
const loaded = ref(false);
const query = ref('');
const sort = ref((() => { try { const v = localStorage.getItem(SORT_KEY); return SORTS.some(s => s.id === v) ? v : 'updated'; } catch (e) { return 'updated'; } })());
const sortOpen = ref(false);
const menuFor = ref('');          // 哪张卡片的「更多」菜单开着
const pickerOpen = ref(false);
const trashOpen = ref(false);
const confirm = ref(null);        // { title, desc, ok, run }
const confirmBusy = ref(false);
const rename = ref(null);         // { id, value }
const renameEl = ref(null);
const undo = ref(null);           // { id, title, timer }
const creating = ref('');

/* ───────── 数据 ───────── */
async function getJSON(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
}
async function loadAll() {
    try { const d = await getJSON('/api/canvases'); canvases.value = d.canvases || []; } catch (e) { /* 服务没起来时保留旧数据 */ }
    loaded.value = true;
    loadTrash();
}
async function loadTrash() {
    try { const d = await getJSON('/api/canvases/trash'); trash.value = d.canvases || []; } catch (e) {}
}

const shown = computed(() => {
    const q = query.value.trim().toLowerCase();
    const list = canvases.value.filter(c => !q || String(c.title || '').toLowerCase().includes(q));
    const mode = sort.value;
    return list.slice().sort((a, b) => {
        if (mode === 'name') return String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN', { numeric: true });
        if (mode === 'created') return (b.created_at || 0) - (a.created_at || 0);
        return (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0);
    });
});
const renderLimit = ref(FIRST_BATCH);
const renderList = computed(() => shown.value.slice(0, renderLimit.value));
const restCount = computed(() => Math.max(0, shown.value.length - renderLimit.value));
function renderMore() { renderLimit.value = Math.min(shown.value.length, renderLimit.value + BATCH); }
watch([query, sort, canvases], () => { renderLimit.value = FIRST_BATCH; });

const label = computed(() => (query.value.trim()
    ? `找到 ${shown.value.length} 个 · 共 ${canvases.value.length} 个画布`
    : `所有画布 · ${canvases.value.length} 个`));
const sortLabel = computed(() => (SORTS.find(s => s.id === sort.value) || SORTS[0]).label);
function pickSort(id) {
    sort.value = id; sortOpen.value = false;
    try { localStorage.setItem(SORT_KEY, id); } catch (e) {}
}

function formatTime(value) {
    if (!value) return '--';
    const raw = Number(value);
    const d = new Date(raw < 1e10 ? raw * 1000 : raw);
    if (Number.isNaN(d.getTime())) return '--';
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function thumbsOf(c) { return (c.thumbnails || []).filter(Boolean).slice(0, 4); }
const failedPreview = ref(new Set());   // 缩略图接口失败的图回落原图；原图也失败才移除
function thumbSrc(u) { return failedPreview.value.has(u) ? u : assetPreviewUrl(u, THUMB_W); }
function onThumbError(c, u) {
    const proxied = assetPreviewUrl(u, THUMB_W) !== u;
    if (proxied && !failedPreview.value.has(u)) {
        const next = new Set(failedPreview.value);
        next.add(u);
        failedPreview.value = next;
        return;
    }
    c.thumbnails = (c.thumbnails || []).filter(x => x !== u);
}

/* ───────── 打开 / 新建 ───────── */
function canvasUrl(c) {
    const enc = encodeURIComponent(c.id);
    const project = encodeURIComponent(c.project || 'default');
    return (c.kind === 'smart' ? '/static/smart-canvas.html' : '/static/canvas.html') + '?id=' + enc + '&project=' + project;
}
function open(c) { closeMenus(); openCanvasUrl(canvasUrl(c)); }
function continueLast() {
    const latest = canvases.value.slice().sort((a, b) => (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0))[0];
    if (latest) open(latest); else pickerOpen.value = true;
}
async function create(kind) {
    if (creating.value) return;
    creating.value = kind;
    const smart = kind === 'smart';
    const title = (smart ? '智能画布' : '画布') + ' ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    try {
        const d = await getJSON('/api/canvases', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, icon: smart ? 'sparkles' : '🧩', kind: smart ? 'smart' : 'classic', project: 'default', board_x: 40, board_y: 40 }),
        });
        if (!d.canvas) throw new Error('no canvas');
        if (d.canvas.project == null) d.canvas.project = 'default';
        canvases.value = canvases.value.concat(d.canvas);
        pickerOpen.value = false;
        open(d.canvas);
    } catch (e) {
        toast('创建画布失败，请检查服务是否在运行', { danger: true, icon: 'alert' });
    } finally {
        creating.value = '';
    }
}

/* ───────── 卡片菜单 ───────── */
function toggleMenu(id) { menuFor.value = menuFor.value === id ? '' : id; sortOpen.value = false; }
function closeMenus() { menuFor.value = ''; sortOpen.value = false; }

function startRename(c) {
    closeMenus();
    rename.value = { id: c.id, value: c.title || '' };
    nextTick(() => { const el = renameEl.value; if (el) { el.focus(); el.select(); } });
}
async function commitRename() {
    const r = rename.value; if (!r) return;
    const name = r.value.trim();
    const c = canvases.value.find(x => x.id === r.id);
    rename.value = null;
    if (!c || !name || name === c.title) return;
    const old = c.title;
    c.title = name;
    try {
        await getJSON(`/api/canvases/${encodeURIComponent(c.id)}/meta`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: name }) });
    } catch (e) {
        c.title = old;
        toast('重命名失败', { danger: true, icon: 'alert' });
    }
}

async function duplicate(c) {
    closeMenus();
    try {
        const src = (await getJSON(`/api/canvases/${encodeURIComponent(c.id)}`)).canvas || c;
        const made = (await getJSON('/api/canvases', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: (c.title || '画布') + ' 副本', icon: src.icon || c.icon || '🧩', kind: src.kind || c.kind || 'classic', project: c.project || 'default', board_x: 40, board_y: 40 }),
        })).canvas;
        if (!made) throw new Error('no canvas');
        if (Array.isArray(src.nodes) && src.nodes.length) {
            await getJSON(`/api/canvases/${encodeURIComponent(made.id)}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: made.title, icon: made.icon, nodes: src.nodes || [], connections: src.connections || [], viewport: src.viewport || null, logs: [], settings: src.settings || {} }),
            });
        }
        toast('已复制「' + (c.title || '未命名画布') + '」', { icon: 'copy' });
        loadAll();
    } catch (e) {
        toast('复制失败', { danger: true, icon: 'alert' });
    }
}

async function remove(c) {
    closeMenus();
    const idx = canvases.value.findIndex(x => x.id === c.id);
    if (idx < 0) return;
    canvases.value = canvases.value.filter(x => x.id !== c.id);
    try {
        await getJSON(`/api/canvases/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
        showUndo(c);
        loadTrash();
    } catch (e) {
        toast('删除失败', { danger: true, icon: 'alert' });
        loadAll();
    }
}
function showUndo(c) {
    if (undo.value) clearTimeout(undo.value.timer);
    const entry = { id: c.id, title: c.title || '未命名画布', key: Date.now(), timer: 0 };
    entry.timer = setTimeout(() => { if (undo.value && undo.value.key === entry.key) undo.value = null; }, 5000);
    undo.value = entry;
}
function pauseUndo() { if (undo.value) clearTimeout(undo.value.timer); }
function resumeUndo() {
    const u = undo.value; if (!u) return;
    u.timer = setTimeout(() => { if (undo.value && undo.value.key === u.key) undo.value = null; }, 2000);
}
async function doUndo() {
    const u = undo.value; if (!u) return;
    clearTimeout(u.timer); undo.value = null;
    await restore(u.id, true);
}

/* ───────── 回收站 ───────── */
async function restore(id, quiet) {
    try {
        await getJSON(`/api/canvases/${encodeURIComponent(id)}/restore`, { method: 'POST' });
        trash.value = trash.value.filter(c => c.id !== id);
        await loadAll();
        if (!quiet) toast('已恢复', { icon: 'undo' });
    } catch (e) {
        toast('恢复失败', { danger: true, icon: 'alert' });
    }
}
function askPurge(c) {
    confirm.value = {
        title: '彻底删除后无法恢复，确定删除？',
        desc: '「' + (c.title || '未命名') + '」将被永久删除。',
        ok: '彻底删除',
        run: async () => {
            await getJSON(`/api/canvases/${encodeURIComponent(c.id)}/purge`, { method: 'DELETE' });
            trash.value = trash.value.filter(x => x.id !== c.id);
        },
    };
}
function askClear() {
    const n = trash.value.length; if (!n) return;
    confirm.value = {
        title: '清空回收站后无法恢复，确定清空？',
        desc: '共 ' + n + ' 个画布将被永久删除。',
        ok: '清空',
        run: async () => {
            const ids = trash.value.map(c => c.id);
            const rs = await Promise.all(ids.map(id => fetch(`/api/canvases/${encodeURIComponent(id)}/purge`, { method: 'DELETE' })));
            if (rs.some(r => !r.ok)) { await loadTrash(); throw new Error('purge failed'); }
            trash.value = [];
        },
    };
}
async function runConfirm() {
    const c = confirm.value; if (!c || confirmBusy.value) return;
    confirmBusy.value = true;
    try { await c.run(); confirm.value = null; }
    catch (e) { confirm.value = null; toast('彻底删除失败', { danger: true, icon: 'alert' }); }
    finally { confirmBusy.value = false; }
}

/* ───────── 轮播 ───────── */
const SLIDES = [
    { type: 'img', src: '/static/images/concept/carousel-image-generation.jpg', title: '文生图创作', sub: '输入提示词，快速生成高质量概念图', tag: '图像生成' },
    { type: 'video', src: '/static/images/concept/pinterest_carousel.mp4', title: 'AI 视频生成', sub: '静图转动态，一键生成流畅视频片段', tag: '视频生成' },
    { type: 'img', src: '/static/images/concept/carousel-node-workflow.jpg', title: '节点工作流', sub: '自由串联图像、视频、LLM 节点', tag: '节点画布' },
];
const slide = ref(0);
const videoEls = ref([]);
let slideTimer = 0;
function go(i) {
    slide.value = (i + SLIDES.length) % SLIDES.length;
    restartSlides();
    nextTick(() => {
        videoEls.value.forEach(v => { if (!v) return; if (Number(v.dataset.i) === slide.value) { v.currentTime = 0; v.play().catch(() => {}); } else v.pause(); });
    });
}
function pauseSlides() { clearInterval(slideTimer); }
function restartSlides() { clearInterval(slideTimer); slideTimer = setInterval(() => go(slide.value + 1), 5000); }

/* ───────── 生命周期 ───────── */
const visible = computed(() => state.active === 'canvas' && !state.canvasOpen);
watch(visible, v => { if (v) { loadAll(); restartSlides(); } else clearInterval(slideTimer); });

// 滚到底部附近自动加载下一批（沿用素材库 ProgressiveMore 的哨兵思路）
const moreEl = ref(null);
let moreIO = null;
watch(moreEl, el => {
    if (!moreIO) return;
    moreIO.disconnect();
    if (el) moreIO.observe(el);
});

function onKey(e) {
    if (!visible.value || e.key !== 'Escape') return;
    if (confirm.value) { if (!confirmBusy.value) confirm.value = null; return; }
    if (rename.value) { rename.value = null; return; }
    if (pickerOpen.value) { pickerOpen.value = false; return; }
    if (trashOpen.value) { trashOpen.value = false; return; }
    closeMenus();
}
function onDocClick(e) {
    if (!e.target.closest || (!e.target.closest('.cl-more-wrap') && !e.target.closest('.cl-sort'))) closeMenus();
}
// 别的页面（首页导入、素材库定位）要求打开某张画布
async function onOpenId(e) {
    const id = e.detail && e.detail.canvasId; if (!id) return;
    try { const d = await getJSON('/api/canvases/' + encodeURIComponent(id)); if (d.canvas) open(d.canvas); } catch (err) {}
}
onMounted(() => {
    loadAll();
    if (visible.value) restartSlides();
    if (typeof IntersectionObserver === 'function') {
        moreIO = new IntersectionObserver(entries => {
            if (entries.some(e => e.isIntersecting)) requestAnimationFrame(renderMore);
        }, { rootMargin: '0px 0px 600px 0px' });
        if (moreEl.value) moreIO.observe(moreEl.value);
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onDocClick);
    window.addEventListener('novai-open-canvas-id', onOpenId);
    window.addEventListener('novai-canvas-focus', loadAll);
});
onBeforeUnmount(() => {
    clearInterval(slideTimer);
    if (moreIO) { moreIO.disconnect(); moreIO = null; }
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('click', onDocClick);
    window.removeEventListener('novai-open-canvas-id', onOpenId);
    window.removeEventListener('novai-canvas-focus', loadAll);
});
</script>

<template>
    <div class="cl">
        <div class="cl-in nv-enter">
            <!-- 顶部 -->
            <section class="cl-hero">
                <div class="cl-intro">
                    <h1 class="display">无限画布</h1>
                    <p class="p">自由布局的 AI 创作空间。在无限画布上串联图像、视频、对话节点，构建你的创意工作流。</p>
                    <div class="cl-acts">
                        <button type="button" class="nv-btn primary" @click="pickerOpen = true"><NvIcon name="plus" />开始创作</button>
                        <button type="button" class="nv-btn" @click="continueLast"><NvIcon name="clock" />继续上次</button>
                    </div>
                </div>
                <div class="cl-carousel" @mouseenter="pauseSlides" @mouseleave="restartSlides">
                    <div v-for="(s, i) in SLIDES" :key="s.src" class="cl-slide" :class="{ on: i === slide }" :aria-hidden="i !== slide">
                        <video v-if="s.type === 'video'" :ref="el => (videoEls[i] = el)" :data-i="i" class="cl-media" :src="s.src" muted loop playsinline preload="auto" :autoplay="i === slide"></video>
                        <img v-else class="cl-media" :src="s.src" :alt="s.title" :loading="i === 0 ? 'eager' : 'lazy'" decoding="async">
                        <span class="nv-badge on-image cl-tag">{{ s.tag }}</span>
                        <div class="cl-cap"><b>{{ s.title }}</b><span>{{ s.sub }}</span></div>
                    </div>
                    <div class="cl-dots" role="tablist" aria-label="轮播">
                        <button v-for="(s, i) in SLIDES" :key="i" type="button" role="tab" :aria-selected="i === slide" :aria-label="s.title" :class="{ on: i === slide }" @click="go(i)"><i></i></button>
                    </div>
                </div>
            </section>

            <!-- 工具条 -->
            <div class="cl-bar">
                <span class="eyebrow">{{ label }}</span>
                <span class="grow"></span>
                <label class="nv-field cl-search"><NvIcon name="search" /><input v-model="query" type="search" placeholder="搜索画布名称" aria-label="搜索画布" autocomplete="off" spellcheck="false"></label>
                <div class="cl-sort">
                    <button type="button" class="nv-btn ghost" :aria-expanded="sortOpen" @click.stop="sortOpen = !sortOpen; menuFor = ''">{{ sortLabel }}<NvIcon name="chev" class="caret" :class="{ up: sortOpen }" /></button>
                    <Transition name="pop">
                        <div v-if="sortOpen" class="nv-menu cl-pop" role="menu">
                            <button v-for="s in SORTS" :key="s.id" type="button" class="nv-menu-item" :class="{ 'is-on': s.id === sort }" role="menuitemradio" :aria-checked="s.id === sort" @click="pickSort(s.id)">
                                {{ s.label }}<NvIcon v-if="s.id === sort" name="check" class="tick" />
                            </button>
                        </div>
                    </Transition>
                </div>
                <button type="button" class="nv-btn primary" @click="pickerOpen = true"><NvIcon name="plus" />新建画布</button>
            </div>

            <!-- 卡片 -->
            <div v-if="!loaded" class="cl-grid">
                <div v-for="i in 8" :key="i" class="cl-skel"><span class="nv-skel"></span><span class="nv-skel l"></span><span class="nv-skel s"></span></div>
            </div>
            <div v-else-if="!canvases.length" class="cl-empty">
                <span class="ic"><NvIcon name="grid9" :size="22" /></span>
                <h2 class="t2">暂无画布</h2>
                <p class="p">点击「新建画布」开始你的第一个创作</p>
                <button type="button" class="nv-btn primary" @click="pickerOpen = true"><NvIcon name="plus" />新建画布</button>
            </div>
            <div v-else-if="!shown.length" class="cl-empty">
                <span class="ic"><NvIcon name="search" :size="22" /></span>
                <h2 class="t2">没有匹配的画布</h2>
                <p class="p">换个关键词试试</p>
            </div>
            <TransitionGroup v-else tag="div" name="card" class="cl-grid">
                <article v-for="(c, i) in renderList" :key="c.id" class="cl-card" :class="{ 'menu-open': menuFor === c.id }" :style="{ '--d': Math.min(i, 12) * 24 + 'ms' }">
                    <button type="button" class="cl-prev" :data-n="thumbsOf(c).length" :aria-label="'打开 ' + (c.title || '未命名画布')" @click="open(c)">
                        <img v-for="(u, k) in thumbsOf(c)" :key="k" :src="thumbSrc(u)" alt="" loading="lazy" decoding="async" fetchpriority="low" width="480" height="300" @error="onThumbError(c, u)">
                        <span v-if="!thumbsOf(c).length" class="cl-blank"><NvIcon name="grid9" :size="22" /></span>
                        <span class="nv-badge" :class="c.kind === 'smart' ? 'strong' : 'on-image'">{{ c.kind === 'smart' ? '智能' : '画布' }}</span>
                    </button>
                    <div class="cl-more-wrap">
                        <button type="button" class="cl-more" aria-label="更多操作" :aria-expanded="menuFor === c.id" @click.stop="toggleMenu(c.id)"><NvIcon name="more" /></button>
                        <Transition name="pop">
                            <div v-if="menuFor === c.id" class="nv-menu cl-pop right" role="menu">
                                <button type="button" class="nv-menu-item" role="menuitem" @click="startRename(c)"><NvIcon name="pencil" />重命名</button>
                                <button type="button" class="nv-menu-item" role="menuitem" @click="duplicate(c)"><NvIcon name="copy" />复制画布</button>
                                <div class="nv-menu-sep"></div>
                                <button type="button" class="nv-menu-item danger" role="menuitem" @click="remove(c)"><NvIcon name="trash" />删除</button>
                            </div>
                        </Transition>
                    </div>
                    <div class="cl-body" @click="rename && rename.id === c.id ? null : open(c)">
                        <input v-if="rename && rename.id === c.id" ref="renameEl" v-model="rename.value" class="cl-rename" aria-label="画布名称" maxlength="80"
                               @click.stop @keydown.enter.prevent="commitRename" @keydown.esc.stop.prevent="rename = null" @blur="commitRename">
                        <div v-else class="cl-title"><span>{{ c.title || '未命名画布' }}</span><NvIcon name="arrow" class="arr" /></div>
                        <div class="cl-meta">更新于 {{ formatTime(c.updated_at || c.created_at) }}</div>
                    </div>
                </article>
            </TransitionGroup>
            <div v-if="restCount > 0" ref="moreEl" class="cl-more-row">
                <button type="button" class="nv-btn sm" @click="renderMore"><NvIcon name="chev" />继续加载（还有 {{ restCount }} 个）</button>
            </div>
        </div>

        <!-- 回收站入口 -->
        <button type="button" class="cl-fab nv-glass-strong" title="回收站" aria-label="回收站" @click="trashOpen = true; loadTrash()">
            <NvIcon name="trash" />
            <Transition name="pop"><span v-if="trash.length" class="cnt">{{ trash.length }}</span></Transition>
        </button>

        <!-- 删除撤销 -->
        <Transition name="undo">
            <div v-if="undo" :key="undo.key" class="cl-undo" @mouseenter="pauseUndo" @mouseleave="resumeUndo">
                <div class="undo-pill">
                    <svg class="ring" viewBox="0 0 18 18"><circle class="bg" cx="9" cy="9" r="7" /><circle class="fg" cx="9" cy="9" r="7" /></svg>
                    <span>已删除「{{ undo.title }}」</span>
                    <button type="button" @click="doUndo">撤销</button>
                </div>
            </div>
        </Transition>

        <!-- 新建选择器 -->
        <Transition name="sheet">
            <div v-if="pickerOpen" class="nv-scrim cl-scrim" @click.self="pickerOpen = false">
                <div class="cl-modal" role="dialog" aria-modal="true" aria-label="新建画布">
                    <div class="cl-mhead"><h3>新建画布</h3><button type="button" class="nv-icon-btn sm" aria-label="关闭" @click="pickerOpen = false"><NvIcon name="x" /></button></div>
                    <div class="cl-picks">
                        <button type="button" class="cl-pick" :disabled="!!creating" @click="create('classic')">
                            <span class="ic"><NvIcon name="grid9" /></span>
                            <span class="tx"><b>普通画布</b><span>经典无限画布，自由拖拽布局图像与节点</span></span>
                            <span v-if="creating === 'classic'" class="spin"></span><NvIcon v-else name="arrowr" class="go" />
                        </button>
                        <button type="button" class="cl-pick" :disabled="!!creating" @click="create('smart')">
                            <span class="ic"><NvIcon name="sparkles" /></span>
                            <span class="tx"><b>智能画布</b><span>AI 驱动的智能工作流，自动编排生成管线</span></span>
                            <span v-if="creating === 'smart'" class="spin"></span><NvIcon v-else name="arrowr" class="go" />
                        </button>
                    </div>
                </div>
            </div>
        </Transition>

        <!-- 回收站 -->
        <Transition name="sheet">
            <div v-if="trashOpen" class="nv-scrim cl-scrim" @click.self="trashOpen = false">
                <div class="cl-modal wide" role="dialog" aria-modal="true" aria-label="回收站">
                    <div class="cl-mhead">
                        <h3>回收站</h3><span class="grow"></span>
                        <button type="button" class="nv-btn sm ghost danger-t" :disabled="!trash.length" @click="askClear">清空回收站</button>
                        <button type="button" class="nv-icon-btn sm" aria-label="关闭" @click="trashOpen = false"><NvIcon name="x" /></button>
                    </div>
                    <div class="cl-mbody">
                        <div class="cl-note"><NvIcon name="clock" />回收站中的画布会在 30 天后自动清理。</div>
                        <div v-if="!trash.length" class="cl-tempty">回收站为空</div>
                        <TransitionGroup v-else tag="div" name="row" class="cl-trows">
                            <div v-for="c in trash" :key="c.id" class="cl-trow">
                                <span class="tx"><b>{{ c.title || '未命名' }}</b><span>删除于 {{ formatTime(c.deleted_at || c.updated_at) }}</span></span>
                                <button type="button" class="nv-btn sm ghost danger-t" @click="askPurge(c)">彻底删除</button>
                                <button type="button" class="nv-btn sm" @click="restore(c.id)"><NvIcon name="undo" />恢复</button>
                            </div>
                        </TransitionGroup>
                    </div>
                </div>
            </div>
        </Transition>

        <!-- 彻底删除二次确认 -->
        <Transition name="sheet">
            <div v-if="confirm" class="nv-scrim cl-scrim top" @click.self="!confirmBusy && (confirm = null)">
                <div class="nv-dialog" role="alertdialog" aria-modal="true">
                    <h2 class="nv-dialog-title">{{ confirm.title }}</h2>
                    <p v-if="confirm.desc" class="nv-dialog-body">{{ confirm.desc }}</p>
                    <div class="nv-dialog-actions">
                        <button type="button" class="nv-btn ghost" :disabled="confirmBusy" @click="confirm = null">取消</button>
                        <button type="button" class="nv-btn danger" :disabled="confirmBusy" @click="runConfirm"><span v-if="confirmBusy" class="spin"></span>{{ confirm.ok }}</button>
                    </div>
                </div>
            </div>
        </Transition>
    </div>
</template>

<style scoped>
.cl { position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden; }
.cl-in { width: min(1180px, calc(100% - 96px)); margin: 0 auto; padding: 40px 0 96px; display: flex; flex-direction: column; gap: 32px; }
.grow { flex: 1; }

/* 顶部 */
.cl-hero { display: flex; gap: 40px; align-items: stretch; }
.cl-intro { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 12px; }
.cl-intro .display { font-size: 28px; line-height: 34px; }
.cl-intro .p { max-width: 440px; color: var(--ink-3); }
.cl-acts { display: flex; gap: 8px; margin-top: 8px; }
.cl-carousel { position: relative; width: min(560px, 48%); aspect-ratio: 560 / 224; border-radius: var(--radius-2xl); overflow: hidden; background: var(--fill-1); flex: none; }
.cl-slide { position: absolute; inset: 0; opacity: 0; transform: scale(1.02); transition: opacity 600ms var(--ease-out), transform 1200ms var(--ease-out); }
.cl-slide.on { opacity: 1; transform: none; }
.cl-media { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; filter: grayscale(.15); }
.cl-slide::after { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, transparent 45%, rgba(0,0,0,.5) 100%); }
.cl-tag { position: absolute; left: 16px; top: 16px; z-index: 1; }
.cl-cap { position: absolute; left: 0; right: 0; bottom: 0; padding: 16px 18px; z-index: 1; background: rgba(0,0,0,.45); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-radius: 0; outline: 1px solid rgba(255,255,255,.14); outline-offset: -1px; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; color: #fff; transform: translateY(6px); opacity: 0; transition: transform 500ms var(--ease-out) 120ms, opacity 400ms var(--ease-out) 120ms; }
.cl-slide.on .cl-cap { transform: none; opacity: 1; }
.cl-cap b { font: 500 14px/20px var(--font-sans); } .cl-cap span { font: 400 12px/16px var(--font-sans); opacity: .8; }
.cl-dots { position: absolute; right: 14px; bottom: 14px; z-index: 2; display: flex; gap: 2px; }
.cl-dots button { width: 18px; height: 18px; border: 0; padding: 0; background: none; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.cl-dots i { width: 5px; height: 5px; border-radius: 3px; background: rgba(255,255,255,.5); transition: width var(--duration-base) var(--ease-out), background var(--duration-base); }
.cl-dots button.on i { width: 14px; background: #fff; }

/* 工具条 */
.cl-bar { position: relative; z-index: 10; display: flex; align-items: center; gap: 8px; }
.cl-search { width: 240px; }
.cl-search input::-webkit-search-cancel-button { display: none; }
.cl-sort { position: relative; }
.caret { width: 12px; height: 12px; transition: transform var(--duration-fast) var(--ease-out); }
.caret.up { transform: rotate(180deg); }
.cl-pop { position: absolute; top: calc(100% + 6px); left: 0; z-index: 30; min-width: 148px; transform-origin: top left; }
.cl-pop.right { left: auto; right: 0; transform-origin: top right; }
.tick { margin-left: auto; width: 14px; height: 14px; color: var(--ink) !important; }

/* 卡片 */
.cl-more-row { display: flex; justify-content: center; padding: 4px 0 0; }
.cl-grid { position: relative; display: grid; grid-template-columns: repeat(auto-fill, minmax(232px, 1fr)); gap: 28px 20px; }
.cl-card { position: relative; display: flex; flex-direction: column; gap: 10px; min-width: 0; animation: card-in 480ms var(--ease-out) var(--d) both; }
.cl-card.menu-open { z-index: 5; }
@keyframes card-in { from { opacity: 0; transform: translateY(8px); filter: blur(3px); } }
.cl-prev { position: relative; aspect-ratio: 16 / 10; border: 0; padding: 0; cursor: pointer; border-radius: var(--radius-lg); overflow: hidden; background: var(--fill-1); display: grid; gap: 2px;
    transition: box-shadow var(--duration-base) var(--ease-out), transform var(--duration-base) var(--ease-out); }
.cl-prev[data-n="2"] { grid-template-columns: 1fr 1fr; }
.cl-prev[data-n="3"] { grid-template-columns: 2fr 1fr; grid-template-rows: 1fr 1fr; }
.cl-prev[data-n="3"] img:first-child { grid-row: 1 / 3; }
.cl-prev[data-n="4"] { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
.cl-prev img { width: 100%; height: 100%; min-height: 0; object-fit: cover; display: block; transition: transform 600ms var(--ease-out); }
.cl-card:hover .cl-prev { box-shadow: var(--shadow-lift); transform: translateY(-2px); }
.cl-card:hover .cl-prev img { transform: scale(1.03); }
.cl-prev:active { transform: scale(.99) !important; }
.cl-blank { display: flex; align-items: center; justify-content: center; color: var(--ink-4); }
.cl-prev .nv-badge { position: absolute; left: 10px; top: 10px; }
.cl-more-wrap { position: absolute; right: 8px; top: 8px; z-index: 2; }
.cl-more { width: 28px; height: 28px; border: 0; border-radius: 8px; cursor: pointer; display: flex; align-items: center; justify-content: center; color: #fff; background: rgba(10,10,10,.36);
    backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); opacity: 0; transform: scale(.92); transition: opacity var(--duration-fast) var(--ease-out), transform var(--duration-base) var(--ease-out), background var(--duration-fast); }
.cl-more .nv-i { width: 16px; height: 16px; }
.cl-card:hover .cl-more, .cl-card.menu-open .cl-more, .cl-more:focus-visible { opacity: 1; transform: none; }
.cl-more:hover { background: rgba(10,10,10,.55); }
.cl-body { cursor: pointer; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.cl-title { display: flex; align-items: center; gap: 6px; font: 500 13px/18px var(--font-sans); color: var(--ink); min-width: 0; }
.cl-title span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cl-title .arr { width: 14px; height: 14px; flex: none; color: var(--ink-3); opacity: 0; transform: translateX(-4px); transition: opacity var(--duration-fast), transform var(--duration-base) var(--ease-out); }
.cl-card:hover .arr { opacity: 1; transform: none; }
.cl-meta { font: 400 11px/16px var(--font-sans); color: var(--ink-3); }
.cl-rename { height: 26px; margin: -4px 0 -4px -6px; padding: 0 6px; border: 0; border-radius: 6px; outline: 0; background: var(--fill-2); box-shadow: none; color: var(--ink); font: 500 13px/18px var(--font-sans); }
.card-move { transition: transform 400ms var(--ease-out); }
.card-leave-active { position: absolute; transition: opacity 200ms var(--ease-out), transform 200ms var(--ease-out); }
.card-leave-to { opacity: 0; transform: scale(.96); }
.cl-skel { display: flex; flex-direction: column; gap: 10px; }
.cl-skel .nv-skel { aspect-ratio: 16 / 10; border-radius: var(--radius-lg); }
.cl-skel .nv-skel.l { aspect-ratio: auto; height: 12px; width: 60%; border-radius: 4px; }
.cl-skel .nv-skel.s { aspect-ratio: auto; height: 10px; width: 36%; border-radius: 4px; margin-top: -4px; }

.cl-empty { padding: 96px 0 64px; display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; }
.cl-empty .ic { width: 56px; height: 56px; border-radius: 16px; background: var(--fill-1); color: var(--ink-3); display: flex; align-items: center; justify-content: center; }
.cl-empty .p { color: var(--ink-3); }
.cl-empty .nv-btn { margin-top: 8px; }

/* 回收站入口 */
.cl-fab { position: fixed; right: 28px; bottom: 28px; z-index: 20; width: 44px; height: 44px; border: 0; border-radius: 50%; cursor: pointer; color: var(--ink-2); display: flex; align-items: center; justify-content: center;
    transition: transform var(--duration-base) var(--ease-out), color var(--duration-fast); }
.cl-fab:hover { color: var(--ink); transform: translateY(-2px); }
.cl-fab .nv-i { width: 18px; height: 18px; }
.cl-fab .cnt { position: absolute; right: -2px; top: -2px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--accent); color: var(--on-accent); font: 500 11px/18px var(--font-mono); }
.cl-undo { position: fixed; left: 50%; bottom: 28px; z-index: 40; transform: translateX(-50%); }
.undo-enter-active { transition: opacity 320ms var(--ease-sheet), transform 400ms var(--ease-sheet); }
.undo-leave-active { transition: opacity 180ms var(--ease-out), transform 180ms var(--ease-out); }
.undo-enter-from { opacity: 0; transform: translate(-50%, 12px) scale(.96); }
.undo-leave-to { opacity: 0; transform: translate(-50%, 6px); }

/* 弹窗 */
.cl-scrim { position: fixed; z-index: 70; }
.cl-scrim.top { z-index: 75; }
.cl-modal { width: 460px; max-width: calc(100vw - 48px); background: var(--solid); border-radius: 20px; box-shadow: var(--shadow-dialog); overflow: hidden; }
.cl-modal.wide { width: 520px; }
.cl-mhead { display: flex; align-items: center; gap: 6px; padding: 20px 20px 12px 24px; }
.cl-mhead h3 { margin: 0; flex: 1; font: 500 16px/24px var(--font-sans); letter-spacing: -.01em; }
.cl-mhead .grow + .nv-btn { margin-right: 2px; }
.cl-mhead h3 + .grow { display: none; }
.cl-picks { padding: 0 20px 20px; display: flex; flex-direction: column; gap: 8px; }
.cl-pick { display: flex; align-items: center; gap: 14px; padding: 14px 14px; border: 0; border-radius: 14px; background: var(--fill-1); cursor: pointer; text-align: left; color: var(--ink); transition: background var(--duration-fast), transform var(--duration-base) var(--ease-out); }
.cl-pick:hover { background: var(--fill-2); }
.cl-pick:active { transform: scale(.99); }
.cl-pick:disabled { cursor: default; opacity: .7; }
.cl-pick .ic { width: 40px; height: 40px; flex: none; border-radius: 12px; background: var(--solid); box-shadow: var(--shadow-float); display: flex; align-items: center; justify-content: center; }
.cl-pick .tx { flex: 1; display: flex; flex-direction: column; gap: 3px; }
.cl-pick b { font: 500 13px/18px var(--font-sans); } .cl-pick .tx span { font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.cl-pick .go { width: 16px; height: 16px; color: var(--ink-3); transition: transform var(--duration-base) var(--ease-out); }
.cl-pick:hover .go { transform: translateX(3px); color: var(--ink); }
.cl-mbody { padding: 0 24px 20px; }
.cl-note { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 10px; background: var(--fill-1); font: 400 12px/16px var(--font-sans); color: var(--ink-3); }
.cl-note .nv-i { width: 14px; height: 14px; }
.cl-tempty { padding: 40px 0 24px; text-align: center; font: 400 13px/20px var(--font-sans); color: var(--ink-3); }
.cl-trows { position: relative; max-height: 52vh; overflow-y: auto; margin-top: 6px; }
.cl-trow { display: flex; align-items: center; gap: 8px; padding: 12px 0; box-shadow: inset 0 -1px 0 var(--separator); }
.cl-trow:last-child { box-shadow: none; }
.cl-trow .tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.cl-trow b { font: 500 13px/18px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .cl-trow .tx span { font: 400 11px/16px var(--font-sans); color: var(--ink-3); }
.danger-t { color: var(--danger) !important; }
.danger-t:disabled { color: var(--ink-4) !important; }
.row-leave-active { transition: opacity 200ms var(--ease-out), transform 200ms var(--ease-out); }
.row-leave-to { opacity: 0; transform: translateX(8px); }
.row-move { transition: transform 300ms var(--ease-out); }

.pop-enter-active { transition: opacity 140ms ease, transform 200ms var(--ease-out); }
.pop-leave-active { transition: opacity 100ms ease, transform 100ms ease; }
.pop-enter-from, .pop-leave-to { opacity: 0; transform: translateY(-4px) scale(.98); }
.sheet-enter-active { transition: opacity 200ms var(--ease-out); }
.sheet-leave-active { transition: opacity 160ms var(--ease-out); }
.sheet-enter-from, .sheet-leave-to { opacity: 0; }
.sheet-enter-active > *, .sheet-leave-active > * { transition: transform 320ms var(--ease-sheet), opacity 200ms var(--ease-out); }
.sheet-enter-from > * { transform: translateY(10px) scale(.98); opacity: 0; }
.sheet-leave-to > * { transform: scale(.98); opacity: 0; }

@media (max-width: 900px) { .cl-hero { flex-direction: column; } .cl-carousel { width: 100%; } .cl-bar { flex-wrap: wrap; } .cl-search { width: 100%; order: 5; } }
@media (prefers-reduced-motion: reduce) { .cl-card { animation: none; } .cl-slide { transition: opacity 200ms; transform: none; } }
</style>
