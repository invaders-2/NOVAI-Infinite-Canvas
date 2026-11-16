<script setup>
// 社区（局域网版，M3）：本周精选 3D 轮播 + 分类 / 排序 + 画布网格 + 技能 / 提示词卡片。
// 数据全部来自真实接口：/api/community/feed（本机 + 在线节点 + 离线缓存）与 /api/community/featured。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import { closeCommunityDetail, openCommunityDetail, openCommunityPublish, state, toast, bumpCommunity } from '../../lib/store.js';
import { ago, authorInitial, avatarImage, avatarText, communityApi, coverUrl, describeCloneResult, fmtCount, kindMeta } from '../../lib/community.js';
import { openCanvasUrl } from '../../lib/bridge.js';

const TABS = [
    { id: 'discover', label: '发现' },
    { id: 'canvas', label: '画布', kind: 'canvas' },
    { id: 'skill', label: '技能', kind: 'skill' },
    { id: 'prompt', label: '提示词', kind: 'prompt' },
];
const SORTS = [
    { id: 'latest', label: '最新' },
    { id: 'hot', label: '最热' },
    { id: 'clones', label: '最多克隆' },
];

const tab = ref('discover');
const sort = ref('latest');
const q = ref('');
const loading = ref(true);
const failed = ref('');
const items = ref([]);
const counts = ref({ all: 0, canvas: 0, skill: 0, prompt: 0 });
const creators = ref(0);
const featured = ref([]);
const cloning = ref('');

const filtering = computed(() => !!q.value.trim());
const canvasItems = computed(() => items.value.filter(it => it.kind === 'canvas'));
const skillItems = computed(() => items.value.filter(it => it.kind === 'skill'));
const promptItems = computed(() => items.value.filter(it => it.kind === 'prompt'));
const isEmpty = computed(() => !loading.value && !items.value.length);
const emptyTitle = computed(() => {
    if (filtering.value) return '没有找到「' + q.value.trim() + '」';
    if (sort.value === 'hot' || sort.value === 'clones') return '还没有人点赞或克隆';
    return '社区里还没有作品';
});
const emptyHint = computed(() => {
    if (filtering.value) return '换个关键词试试，或者自己发布一个作品';
    if (creators.value > 1) return '同一网络里有人在线，作品发布后这里就能看到';
    return '把画布、技能或提示词发布出来，同一网络里的同事就能看到并克隆';
});

function countOf(kind) { return (counts.value && counts.value[kind]) || 0; }

async function load() {
    loading.value = true;
    failed.value = '';
    try {
        const kind = TABS.find(t => t.id === tab.value)?.kind || '';
        const params = new URLSearchParams();
        if (kind) params.set('kind', kind);
        if (sort.value) params.set('sort', sort.value);
        if (q.value.trim()) params.set('q', q.value.trim());
        const [feed, hot] = await Promise.all([
            communityApi('/feed?' + params.toString()),
            communityApi('/featured').catch(() => ({ items: [] })),
        ]);
        items.value = Array.isArray(feed.items) ? feed.items : [];
        counts.value = feed.counts || counts.value;
        creators.value = Number(feed.creators_online) || 0;
        featured.value = Array.isArray(hot.items) ? hot.items : [];
        if (!featured.value.length) featured.value = items.value.slice(0, 5);
    } catch (e) {
        failed.value = e.message || '社区加载失败';
        items.value = [];
    } finally {
        loading.value = false;
    }
}

let searchTimer = 0;
watch(q, () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 260);
});
watch([tab, sort], load);
watch(() => state.communityRefresh, load);
function onFocus(event) { if (event.detail && event.detail.id === 'community') load(); }

/* ── 本周精选轮播（复用应用市场那套 3D coverflow） ── */
const cf = ref(0);
let cfTimer = 0;
const cfCards = computed(() => featured.value.slice(0, 5));
function cfGo(index) {
    const total = cfCards.value.length;
    if (total) cf.value = (index + total) % total;
}
function cfStyle(index) {
    const total = cfCards.value.length;
    let d = index - cf.value;
    if (d > total / 2) d -= total;
    if (d < -total / 2) d += total;
    const a = Math.abs(d);
    return {
        transform: 'translateX(calc(-50% + ' + d + ' * var(--cf-step))) translateZ(' + (a ? 'var(--cf-z)' : '0px') + ') rotateY(calc(' + (-d) + ' * var(--cf-tilt))) scale(' + (a ? 'var(--cf-scale)' : 1) + ')',
        zIndex: 10 - a,
        filter: a ? 'brightness(.72)' : 'none',
        '--cf-o': a > 1 ? 0 : 1,
        '--cf-pe': a > 1 ? 'none' : 'auto',
    };
}
const hovering = ref(false);
function autoplay() {
    clearInterval(cfTimer);
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    cfTimer = setInterval(() => {
        if (state.active === 'community' && tab.value === 'discover' && !filtering.value && !document.hidden && !hovering.value) cfGo(cf.value + 1);
    }, 5000);
}
function onCardClick(item) { openCommunityDetail(item.id); }

/* ── 克隆 ── */
async function cloneItem(item, event) {
    if (event) event.stopPropagation();
    if (cloning.value) return;
    cloning.value = item.id;
    try {
        const body = await communityApi('/items/' + encodeURIComponent(item.id) + '/clone', { method: 'POST' });
        const described = describeCloneResult(body);
        bumpCommunity();
        toast(described.text, described.canvasUrl ? {
            onClick: () => openCanvasUrl(described.canvasUrl),
        } : {});
    } catch (e) {
        toast(e.message || '克隆失败', { danger: true });
    } finally {
        cloning.value = '';
    }
}

/* ── 卡片小工具 ── */
const coverOf = item => coverUrl(item);
const aImg = item => (item.avatarBroken ? '' : avatarImage(item.author || {}));
const aText = item => avatarText(item.author || {}) || authorInitial(item.author || {});
async function avatarError(item) { item.avatarBroken = true; }
const meta = item => kindMeta(item.kind);
const publish = () => openCommunityPublish({});

onMounted(() => {
    load();
    autoplay();
    window.addEventListener('novai-page-focus', onFocus);
});
onBeforeUnmount(() => {
    clearInterval(cfTimer);
    clearTimeout(searchTimer);
    window.removeEventListener('novai-page-focus', onFocus);
});
</script>

<template>
    <div class="cm">
        <div class="cm-in">
            <header class="cm-head">
                <div class="ttl">
                    <h1>社区</h1>
                    <p>看看同一网络里的大家在做什么，喜欢就克隆到自己的画布</p>
                </div>
                <span class="sp"></span>
                <label class="cm-search"><NvIcon name="search" /><input v-model="q" type="search" placeholder="搜索画布、技能、提示词" autocomplete="off" aria-label="搜索社区"></label>
                <button type="button" class="cm-pub" @click="publish"><NvIcon name="upload" />发布作品</button>
            </header>

            <!-- 本周精选轮播 -->
            <section v-if="cfCards.length && tab === 'discover' && !filtering" class="cm-hero">
                <div class="cf" @mouseenter="hovering = true" @mouseleave="hovering = false">
                    <div v-for="(it, i) in cfCards" :key="it.id" class="cf-card" :class="{ on: i === cf }" :style="cfStyle(i)" role="button" :tabindex="i === cf ? 0 : -1" :aria-label="it.title" @click="onCardClick(it)" @keydown.enter="onCardClick(it)">
                        <img v-if="coverOf(it)" :src="coverOf(it)" alt="" loading="lazy" decoding="async" />
                        <span v-else class="cf-ph"><NvIcon :name="meta(it).icon" /></span>
                        <span class="t">
                            <span class="k">{{ meta(it).label }}</span>
                            <b>{{ it.title }}</b>
                            <small>{{ it.desc || '来自 ' + ((it.author || {}).nickname || '局域网用户') }}</small>
                            <span class="au"><span class="av">{{ aText(it) }}</span>{{ (it.author || {}).nickname || '局域网用户' }}<span class="st mono"><NvIcon name="heart" />{{ fmtCount((it.stats || {}).likes) }}<i></i><NvIcon name="copy" />{{ fmtCount((it.stats || {}).clones) }}</span></span>
                        </span>
                        <button type="button" class="cfb" @click="cloneItem(it, $event)"><NvIcon name="copy" />克隆</button>
                    </div>
                </div>
                <div class="cf-nav">
                    <button type="button" class="ar" aria-label="上一张" @click="cfGo(cf - 1); autoplay()"><NvIcon name="chevl" /></button>
                    <span class="dots"><button v-for="(it, i) in cfCards" :key="it.id" type="button" :class="{ on: i === cf }" :aria-label="'第 ' + (i + 1) + ' 张'" @click="cfGo(i); autoplay()"></button></span>
                    <button type="button" class="ar" aria-label="下一张" @click="cfGo(cf + 1); autoplay()"><NvIcon name="chevr" /></button>
                </div>
            </section>

            <!-- 分类 + 排序 -->
            <div class="cm-bar">
                <nav class="cm-tabs" aria-label="社区分类">
                    <button v-for="t in TABS" :key="t.id" type="button" :class="{ on: tab === t.id }" :aria-pressed="tab === t.id" @click="tab = t.id">
                        {{ t.label }}<em v-if="t.kind">{{ countOf(t.kind) }}</em>
                    </button>
                </nav>
                <span class="sp"></span>
                <div class="cm-seg" role="group" aria-label="排序">
                    <button v-for="s in SORTS" :key="s.id" type="button" :class="{ on: sort === s.id }" @click="sort = s.id">{{ s.label }}</button>
                </div>
            </div>

            <div v-if="loading" class="cm-skel">
                <div class="nv-skel big"></div>
                <div class="row"><div class="nv-skel"></div><div class="nv-skel"></div><div class="nv-skel"></div><div class="nv-skel"></div></div>
            </div>
            <div v-else-if="failed" class="cm-empty"><b>{{ failed }}</b><span>请确认 NOVAI 服务正在运行</span><button type="button" class="nv-btn sm" @click="load">重试</button></div>
            <div v-else-if="isEmpty" class="cm-empty">
                <b>{{ emptyTitle }}</b>
                <span>{{ emptyHint }}</span>
                <button type="button" class="nv-btn primary sm" @click="publish">发布作品</button>
            </div>
            <template v-else>
                <!-- 画布 / 工作流 -->
                <section v-if="(tab === 'discover' || tab === 'canvas') && canvasItems.length" class="cm-sec">
                    <div class="cm-sh"><h2>画布 / 工作流</h2><button v-if="tab === 'discover'" type="button" class="more" @click="tab = 'canvas'">查看全部<NvIcon name="chevr" /></button></div>
                    <div class="cm-grid">
                        <button v-for="it in (tab === 'discover' ? canvasItems.slice(0, 8) : canvasItems)" :key="it.id" type="button" class="tile" :class="{ off: !it.online }" @click="onCardClick(it)">
                            <span class="cv">
                                <img v-if="coverOf(it)" :src="coverOf(it)" alt="" loading="lazy" decoding="async" />
                                <span v-else class="ph"><NvIcon :name="meta(it).icon" /></span>
                                <span class="kind"><NvIcon :name="meta(it).icon" />{{ meta(it).label }}</span>
                                <span v-if="!it.online" class="offb">作者离线</span>
                                <span v-if="it.allow_clone !== false" class="hov"><NvIcon name="copy" />克隆</span>
                            </span>
                            <b>{{ it.title }}</b>
                            <span class="meta">
                                <span class="au"><span class="av"><img v-if="aImg(it)" :src="aImg(it)" alt="" @error="avatarError(it)" /><template v-else>{{ aText(it) }}</template></span>{{ (it.author || {}).nickname || '局域网用户' }}</span>
                                <span class="st mono"><NvIcon name="heart" />{{ fmtCount((it.stats || {}).likes) }}<i></i><NvIcon name="copy" />{{ fmtCount((it.stats || {}).clones) }}</span>
                            </span>
                        </button>
                    </div>
                </section>

                <!-- 技能 -->
                <section v-if="(tab === 'discover' || tab === 'skill') && skillItems.length" class="cm-sec">
                    <div class="cm-sh"><h2>技能</h2><button v-if="tab === 'discover'" type="button" class="more" @click="tab = 'skill'">查看全部<NvIcon name="chevr" /></button></div>
                    <div class="cm-skills">
                        <button v-for="it in (tab === 'discover' ? skillItems.slice(0, 6) : skillItems)" :key="it.id" type="button" class="sk" :class="{ off: !it.online }" @click="onCardClick(it)">
                            <span class="skc">
                                <img v-if="coverOf(it)" :src="coverOf(it)" alt="" loading="lazy" />
                                <span v-else class="ph"></span>
                                <span class="ico"><NvIcon name="wand2" /></span>
                            </span>
                            <span class="skb">
                                <b>{{ it.title }}</b>
                                <small>{{ it.desc || '点开看技能说明' }}</small>
                                <span class="sku">
                                    <span class="au"><span class="av"><img v-if="aImg(it)" :src="aImg(it)" alt="" @error="avatarError(it)" /><template v-else>{{ aText(it) }}</template></span>{{ (it.author || {}).nickname || '局域网用户' }}</span>
                                    <span class="cl"><NvIcon name="copy" />克隆 <em class="mono">{{ fmtCount((it.stats || {}).clones) }}</em></span>
                                </span>
                            </span>
                        </button>
                    </div>
                </section>

                <!-- 提示词 -->
                <section v-if="(tab === 'discover' || tab === 'prompt') && promptItems.length" class="cm-sec">
                    <div class="cm-sh"><h2>提示词</h2><button v-if="tab === 'discover'" type="button" class="more" @click="tab = 'prompt'">查看全部<NvIcon name="chevr" /></button></div>
                    <div class="cm-prompts">
                        <button v-for="it in (tab === 'discover' ? promptItems.slice(0, 6) : promptItems)" :key="it.id" type="button" class="pr" :class="{ off: !it.online }" @click="onCardClick(it)">
                            <span class="pri">
                                <img v-if="coverOf(it)" :src="coverOf(it)" alt="" loading="lazy" />
                                <span v-else class="ph"><NvIcon name="type" /></span>
                            </span>
                            <span class="prb">
                                <span class="lab"><NvIcon name="type" /> 提示词</span>
                                <b>{{ it.title }}</b>
                                <p>{{ it.desc || '点开看完整提示词' }}</p>
                                <span class="pf">
                                    <span class="au"><span class="av"><img v-if="aImg(it)" :src="aImg(it)" alt="" @error="avatarError(it)" /><template v-else>{{ aText(it) }}</template></span>{{ (it.author || {}).nickname || '局域网用户' }}</span>
                                    <span class="cl"><NvIcon name="copy" />克隆 <em class="mono">{{ fmtCount((it.stats || {}).clones) }}</em></span>
                                </span>
                            </span>
                        </button>
                    </div>
                </section>

                <!-- 当前分类没有作品 -->
                <div v-if="!(tab === 'canvas' ? canvasItems.length : tab === 'skill' ? skillItems.length : tab === 'prompt' ? promptItems.length : canvasItems.length + skillItems.length + promptItems.length)" class="cm-empty">
                    <b>{{ emptyTitle }}</b>
                    <span>{{ emptyHint }}</span>
                    <button type="button" class="nv-btn primary sm" @click="publish">发布作品</button>
                </div>
            </template>
        </div>
    </div>
</template>

<style scoped>
.cm { position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden; color: var(--ink); }
.cm-in { width: min(1240px, calc(100% - 96px)); margin: 0 auto; padding: calc(var(--tbh, 0px) + 26px) 0 96px; }
.cm-head { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
.cm-head .ttl h1 { margin: 0; font: 600 22px/30px var(--font-sans); letter-spacing: -.015em; }
.cm-head .ttl p { margin: 3px 0 0; font: 400 12px/17px var(--font-sans); color: var(--ink-3); }
.sp { flex: 1; }
.cm-search { display: flex; align-items: center; gap: 8px; width: 240px; height: 34px; padding: 0 12px; border-radius: 17px; background: var(--fill-1); color: var(--ink-3); }
.cm-search .nv-i { width: 14px; height: 14px; }
.cm-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--ink); font: 400 12.5px/1 var(--font-sans); }
.cm-search input::placeholder { color: var(--ink-4); }
.cm-search input::-webkit-search-cancel-button { display: none; }
.cm-pub { height: 34px; padding: 0 16px; border: 0; border-radius: 17px; background: var(--accent); color: var(--on-accent); font: 500 12.5px/1 var(--font-sans); display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.cm-pub:hover { opacity: .9; }
.cm-pub .nv-i { width: 13px; height: 13px; }

/* 轮播：与应用市场同一套参数（宽 36.3%、步长 103.6%、后倾 12deg、缩放 .91） */
.cm-hero { margin-top: 24px; }
.cf { position: relative; aspect-ratio: 4.9; perspective: 1000px; --cf-step: 103.6%; --cf-z: -120px; --cf-tilt: 12deg; --cf-scale: .91; }
.cf-card { position: absolute; top: 0; left: 50%; width: 36.3%; height: 100%; border: 0; padding: 0; border-radius: 16px; overflow: hidden; background: var(--fill-1); cursor: pointer; text-align: left;
    box-shadow: var(--shadow-float); opacity: var(--cf-o, 1); pointer-events: var(--cf-pe, auto); transition: transform .55s cubic-bezier(.2,.8,.2,1), opacity .55s, filter .55s; will-change: transform; }
.cf-card img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cf-card .cf-ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--ink-4); background: var(--fill-1); }
.cf-card .cf-ph .nv-i { width: 34px; height: 34px; }
.cf-card::after { content: ""; position: absolute; inset: 30% 0 0; background: linear-gradient(transparent, rgba(0,0,0,.74)); pointer-events: none; }
.cf-card .t { position: absolute; left: 18px; right: 108px; bottom: 16px; z-index: 1; color: #fff; }
.cf-card .t .k { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; margin-bottom: 7px; border-radius: 10px; background: rgba(255,255,255,.18); backdrop-filter: blur(12px); font: 400 10.5px/1 var(--font-sans); }
.cf-card .t b { display: block; font: 600 16px/22px var(--font-sans); letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cf-card .t small { display: block; margin-top: 4px; font: 400 11.5px/16px var(--font-sans); opacity: .82; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cf-card .t .au { display: flex; align-items: center; gap: 6px; margin-top: 9px; font: 400 11.5px/1 var(--font-sans); opacity: .94; }
.cf-card .t .au .av { width: 20px; height: 20px; border-radius: 50%; background: rgba(255,255,255,.22); display: inline-flex; align-items: center; justify-content: center; font: 500 10px/1 var(--font-sans); overflow: hidden; }
.cf-card .t .au .st { display: inline-flex; align-items: center; gap: 3px; margin-left: 8px; font: 400 11px/1 var(--font-mono); opacity: .85; }
.cf-card .t .au .st .nv-i { width: 11px; height: 11px; }
.cf-card .t .au .st i { width: 6px; height: 1px; background: currentColor; opacity: .5; display: inline-block; }
.cf-card .cfb { position: absolute; right: 14px; bottom: 16px; z-index: 2; height: 30px; padding: 0 12px; border: 0; border-radius: 15px; background: #fff; color: #0a0a0a; font: 500 12px/1 var(--font-sans); display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.cf-card .cfb .nv-i { width: 12px; height: 12px; }
.cf-card .cfb:hover { box-shadow: var(--shadow-pop); }
.cf-nav { display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 16px; }
.cf-nav .ar { width: 30px; height: 30px; border: 0; border-radius: 15px; background: var(--fill-1); color: var(--ink-3); display: flex; align-items: center; justify-content: center; cursor: pointer; }
.cf-nav .ar:hover { background: var(--fill-2); color: var(--ink); }
.cf-nav .ar .nv-i { width: 15px; height: 15px; }
.cf-nav .dots { display: flex; gap: 5px; }
.cf-nav .dots button { width: 5px; height: 5px; padding: 0; border: 0; border-radius: 3px; background: var(--fill-3); cursor: pointer; transition: width .3s, background .3s; }
.cf-nav .dots button.on { width: 18px; background: var(--ink); }

/* 分类 + 排序 */
.cm-bar { display: flex; align-items: center; gap: 12px; margin-top: 26px; flex-wrap: wrap; }
.cm-tabs { display: flex; gap: 2px; flex-wrap: wrap; }
.cm-tabs button { height: 30px; padding: 0 14px; border: 0; border-radius: 15px; background: transparent; color: var(--ink-3); font: 500 13px/1 var(--font-sans); cursor: pointer; transition: background var(--duration-fast), color var(--duration-fast); }
.cm-tabs button:hover { color: var(--ink); }
.cm-tabs button.on { background: var(--fill-2); color: var(--ink); }
.cm-tabs em { font-style: normal; margin-left: 5px; font-variant-numeric: tabular-nums; color: var(--ink-4); }
.cm-tabs button.on em { color: var(--ink-3); }
.cm-seg { display: inline-flex; padding: 2px; border-radius: 999px; background: var(--fill-1); }
.cm-seg button { height: 26px; padding: 0 12px; border: 0; border-radius: 999px; background: transparent; color: var(--ink-3); font: 500 12px/1 var(--font-sans); cursor: pointer; transition: background var(--duration-fast), color var(--duration-fast); }
.cm-seg button:hover { color: var(--ink-2); }
.cm-seg button.on { background: var(--solid); color: var(--ink); box-shadow: 0 1px 3px rgba(0,0,0,.08); }

.cm-sec { margin-top: 30px; }
.cm-sh { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.cm-sh h2 { margin: 0; font: 600 16px/22px var(--font-sans); letter-spacing: -.01em; }
.more { display: inline-flex; align-items: center; gap: 2px; height: 28px; padding: 0 6px; border: 0; border-radius: 8px; background: transparent; color: var(--ink-3); font: 400 12px/1 var(--font-sans); cursor: pointer; }
.more:hover { color: var(--ink); }
.more .nv-i { width: 13px; height: 13px; }

/* 画布网格：4 列 4:5 */
.cm-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 26px 18px; }
.tile { display: flex; flex-direction: column; gap: 0; border: 0; padding: 0; background: none; text-align: left; color: var(--ink); cursor: pointer; min-width: 0; }
.tile .cv { position: relative; display: block; aspect-ratio: 4 / 5; border-radius: 14px; overflow: hidden; background: var(--fill-1); transition: transform var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out); }
.tile .cv img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 600ms var(--ease-out); }
.tile .cv .ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--ink-4); }
.tile .cv .ph .nv-i { width: 30px; height: 30px; }
.tile:hover .cv { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
.tile:hover .cv img { transform: scale(1.03); }
.tile .kind { position: absolute; left: 10px; top: 10px; z-index: 2; height: 22px; padding: 0 9px; border-radius: 11px; background: rgba(0,0,0,.38); backdrop-filter: blur(12px); color: #fff; font: 400 11px/22px var(--font-sans); display: inline-flex; align-items: center; gap: 4px; }
.tile .kind .nv-i { width: 11px; height: 11px; }
.tile .offb { position: absolute; right: 10px; top: 10px; z-index: 2; height: 22px; padding: 0 9px; border-radius: 11px; background: rgba(0,0,0,.5); backdrop-filter: blur(10px); color: #fff; font: 400 11px/22px var(--font-sans); }
.tile .hov { position: absolute; right: 10px; bottom: 10px; z-index: 2; height: 28px; padding: 0 11px; border-radius: 14px; background: rgba(255,255,255,.92); color: #0a0a0a; font: 500 11.5px/1 var(--font-sans); display: inline-flex; align-items: center; gap: 4px; opacity: 0; transform: translateY(4px); transition: opacity .16s, transform .16s; }
.tile .hov .nv-i { width: 12px; height: 12px; }
.tile:hover .hov { opacity: 1; transform: none; }
.tile b { display: block; margin-top: 10px; font: 500 13px/18px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tile .meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 5px; }
.tile .au { display: inline-flex; align-items: center; gap: 5px; min-width: 0; font: 400 11.5px/1 var(--font-sans); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tile .av { width: 18px; height: 18px; flex: none; border-radius: 50%; background: var(--fill-2); color: var(--ink-2); display: inline-flex; align-items: center; justify-content: center; font: 500 9.5px/1 var(--font-sans); overflow: hidden; }
.tile .av img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tile .st { display: inline-flex; align-items: center; gap: 3px; flex: none; font: 400 11px/1 var(--font-mono); color: var(--ink-3); }
.tile .st .nv-i { width: 12px; height: 12px; }
.tile .st i { width: 7px; height: 1px; background: var(--ink-4); display: inline-block; }
.tile.off .cv { filter: grayscale(1); opacity: .55; }

/* 离线作者整体降饱和（在线卡不受影响） */
.sk.off .skc, .pr.off .pri { filter: grayscale(1); opacity: .55; }

/* 技能：3 列，封面条 + 压在下沿的图标块 */
.cm-skills { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.sk { display: flex; flex-direction: column; border: 0; padding: 0; background: var(--solid); border-radius: 16px; overflow: hidden; text-align: left; color: var(--ink); cursor: pointer; box-shadow: var(--shadow-float); transition: transform var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out); }
.sk:hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
.sk .skc { position: relative; display: block; height: 92px; background: var(--fill-1); overflow: hidden; }
.sk .skc img { width: 100%; height: 100%; object-fit: cover; display: block; }
.sk .skc .ph { position: absolute; inset: 0; background: linear-gradient(120deg, var(--fill-1), var(--fill-2)); }
.sk .skc .ico { position: absolute; left: 14px; bottom: -18px; width: 40px; height: 40px; border-radius: 12px; background: var(--solid); color: var(--ink); display: flex; align-items: center; justify-content: center; box-shadow: var(--shadow-float); }
.sk .skc .ico .nv-i { width: 18px; height: 18px; }
.sk .skb { display: block; padding: 24px 14px 12px; }
.sk .skb b { display: block; font: 600 14px/19px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sk .skb small { display: block; margin-top: 4px; font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.sk .sku { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; }
.sk .au { display: inline-flex; align-items: center; gap: 5px; min-width: 0; font: 400 11.5px/1 var(--font-sans); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sk .av { width: 18px; height: 18px; flex: none; border-radius: 50%; background: var(--fill-2); color: var(--ink-2); display: inline-flex; align-items: center; justify-content: center; font: 500 9.5px/1 var(--font-sans); overflow: hidden; }
.sk .av img { width: 100%; height: 100%; object-fit: cover; display: block; }
.sk .cl { display: inline-flex; align-items: center; gap: 3px; flex: none; font: 500 11.5px/1 var(--font-sans); color: var(--ink-2); }
.sk .cl .nv-i { width: 12px; height: 12px; }
.sk .cl em { font-style: normal; color: var(--ink-3); }

/* 提示词：3 列，左侧 84×112 效果图 */
.cm-prompts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.pr { display: flex; gap: 12px; border: 0; padding: 12px; background: var(--solid); border-radius: 16px; box-shadow: var(--shadow-float); text-align: left; color: var(--ink); cursor: pointer; transition: transform var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out); }
.pr:hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
.pr .pri { width: 84px; height: 112px; flex: none; border-radius: 10px; overflow: hidden; background: var(--fill-1); display: flex; align-items: center; justify-content: center; color: var(--ink-4); }
.pr .pri img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pr .pri .nv-i { width: 22px; height: 22px; }
.pr .prb { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.pr .lab { display: inline-flex; align-items: center; gap: 4px; font: 400 10.5px/1 var(--font-mono); letter-spacing: .05em; color: var(--ink-3); }
.pr .lab .nv-i { width: 11px; height: 11px; }
.pr b { display: block; margin-top: 6px; font: 600 13.5px/18px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pr p { margin: 5px 0 0; font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.pr .pf { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; padding-top: 8px; }
.pr .au { display: inline-flex; align-items: center; gap: 5px; min-width: 0; font: 400 11.5px/1 var(--font-sans); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pr .av { width: 18px; height: 18px; flex: none; border-radius: 50%; background: var(--fill-2); color: var(--ink-2); display: inline-flex; align-items: center; justify-content: center; font: 500 9.5px/1 var(--font-sans); overflow: hidden; }
.pr .av img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pr .cl { display: inline-flex; align-items: center; gap: 3px; flex: none; font: 500 11.5px/1 var(--font-sans); color: var(--ink-2); }
.pr .cl .nv-i { width: 12px; height: 12px; }
.pr .cl em { font-style: normal; color: var(--ink-3); }

.cm-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 72px 0 40px; text-align: center; color: var(--ink-3); font: 400 12.5px/19px var(--font-sans); }
.cm-empty b { font: 500 15px/21px var(--font-sans); color: var(--ink); }
.cm-empty .nv-btn { margin-top: 10px; }
.cm-skel { margin-top: 30px; display: flex; flex-direction: column; gap: 22px; }
.cm-skel .big { height: 300px; border-radius: 18px; }
.cm-skel .row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; }
.cm-skel .row .nv-skel { aspect-ratio: 4 / 5; border-radius: 14px; }

@media (max-width: 1100px) {
    .cm-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .cm-skills, .cm-prompts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 860px) {
    .cm-in { width: calc(100% - 32px); }
    .cm-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .cm-skills, .cm-prompts { grid-template-columns: minmax(0, 1fr); }
    .cm-search { width: 100%; order: 3; }
    .cf { aspect-ratio: 1.75; perspective: none; --cf-step: 0%; --cf-z: 0px; --cf-tilt: 0deg; --cf-scale: 1; }
    .cf-card { width: 100%; opacity: 0; pointer-events: none; }
    .cf-card.on { opacity: 1; pointer-events: auto; }
}
@media (prefers-reduced-motion: reduce) { .cf-card { transition: none; } }
</style>
