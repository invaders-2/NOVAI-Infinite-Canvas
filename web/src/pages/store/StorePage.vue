<script setup>
// 应用市场列表（1:1）：最新上线轮播 → 官方技能 → 热门用例 → 全部条目（搜索 + 类型/分类筛选）。
// 数据只来自 GET /api/store/catalog（市场的 83 条），详情在 StoreDetail.vue。
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import StoreCover from './StoreCover.vue';
import StoreDetail from './StoreDetail.vue';
import { buildCounts, fetchCatalog, fetchItemDetail, filterItems, itemKey, normalizeItem } from './storeData.js';

const catalog = ref({ items: [], categories: [], featured: [], trending: [] });
const loading = ref(true);
const error = ref('');
const query = ref('');
const kindFilter = ref('all');
const categoryFilter = ref('');
const detailTarget = ref(null);
const activeSlide = ref(0);
const carouselHover = ref(false);
const allSectionRef = ref(null);
const detailCache = reactive({});

let carouselTimer = 0;

const visibleItems = computed(() => catalog.value.items.filter(item => item.storeVisible));
const counts = computed(() => buildCounts(visibleItems.value, catalog.value.categories));
const chips = computed(() => ([
    { key: 'all', label: '全部', count: counts.value.all },
    { key: 'skill', label: '技能', count: counts.value.skill },
    { key: 'app', label: '智能体', count: counts.value.app },
].filter(chip => chip.key !== 'app' || chip.count > 0))
    .concat(counts.value.categories.map(cat => ({ key: 'cat:' + cat.id, label: cat.label, count: cat.count, categoryId: cat.id }))));

const filtered = computed(() => filterItems(visibleItems.value, {
    query: query.value,
    kind: kindFilter.value,
    category: categoryFilter.value,
}));

const slides = computed(() => catalog.value.featured.filter(item => item.coverUrl || item.coverVideoUrl));
const currentSlide = computed(() => slides.value[activeSlide.value] || null);

const officialSkills = computed(() => {
    const featuredSkills = catalog.value.featured.filter(item => item.kind === 'skill');
    const rest = visibleItems.value.filter(item => item.kind === 'skill');
    const seen = new Set();
    const list = [];
    for (const item of featuredSkills.concat(rest)) {
        const key = itemKey(item.kind, item.name);
        if (seen.has(key)) continue;
        seen.add(key);
        list.push(item);
        if (list.length >= 10) break;
    }
    return list;
});

const trending = computed(() => catalog.value.trending.slice(0, 12));

function detailFor(item) {
    return detailCache[itemKey(item.kind, item.name)] || null;
}
function iconFor(item) {
    const detail = detailFor(item);
    return item.iconUrl || (detail && detail.iconUrl) || '';
}
function modelNameFor(item) {
    const detail = detailFor(item);
    return detail && detail.recommendedModel ? detail.recommendedModel.displayName : '';
}
function presetMedia(item) {
    if (!item) return { kind: 'image', src: '', poster: '' };
    if (item.coverVideoUrl) return { kind: 'video', src: item.coverVideoUrl, poster: item.coverUrl };
    return { kind: 'image', src: item.coverUrl, poster: '' };
}

function isChipActive(chip) {
    if (chip.categoryId) return categoryFilter.value === chip.categoryId;
    return kindFilter.value === chip.key && !categoryFilter.value;
}
function pickChip(chip) {
    if (chip.categoryId) {
        categoryFilter.value = categoryFilter.value === chip.categoryId ? '' : chip.categoryId;
        kindFilter.value = 'all';
    } else {
        kindFilter.value = chip.key;
        categoryFilter.value = '';
    }
}
function clearFilters() {
    query.value = '';
    kindFilter.value = 'all';
    categoryFilter.value = '';
}
function openDetail(item) {
    if (!item) return;
    detailTarget.value = item;
    const page = document.querySelector('.store');
    if (page) page.scrollTop = 0;
}
function openCollectionItem(ref) {
    openDetail(normalizeItem({ kind: ref.kind, name: ref.name }));
}
function viewAllSkills() {
    kindFilter.value = 'skill';
    categoryFilter.value = '';
    const el = allSectionRef.value;
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function onInstalled({ kind, name, installed }) {
    catalog.value.items = catalog.value.items.map(item => (item.kind === kind && item.name === name) ? { ...item, installed } : item);
    if (detailTarget.value && detailTarget.value.kind === kind && detailTarget.value.name === name) {
        detailTarget.value = { ...detailTarget.value, installed };
    }
}

function nextSlide() {
    if (!slides.value.length) return;
    activeSlide.value = (activeSlide.value + 1) % slides.value.length;
}
function prevSlide() {
    if (!slides.value.length) return;
    activeSlide.value = (activeSlide.value - 1 + slides.value.length) % slides.value.length;
}
function goSlide(index) { activeSlide.value = index; }

function startCarousel() {
    stopCarousel();
    carouselTimer = setInterval(() => {
        if (!carouselHover.value && !detailTarget.value) nextSlide();
    }, 6000);
}
function stopCarousel() {
    if (carouselTimer) clearInterval(carouselTimer);
    carouselTimer = 0;
}

async function enrich(items) {
    const queue = items.filter(Boolean).filter(item => !detailCache[itemKey(item.kind, item.name)]);
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length) {
            const item = queue.shift();
            try {
                const detail = await fetchItemDetail(item.kind, item.name);
                detailCache[itemKey(item.kind, item.name)] = detail;
            } catch (e) {
                detailCache[itemKey(item.kind, item.name)] = { failed: true };
            }
        }
    });
    await Promise.all(workers);
}

async function loadCatalog() {
    loading.value = true;
    error.value = '';
    stopCarousel();
    try {
        const data = await fetchCatalog();
        catalog.value = data;
        activeSlide.value = 0;
        loading.value = false;
        startCarousel();
        // 只补齐首屏需要的详情（轮播模型名 / 官方技能图标 / 热门用例图标 / 全部区首屏图标），其余用渐变方块兜底
        const firstGrid = visibleItems.value.slice(0, 12);
        enrich(data.featured.concat(officialSkills.value, data.trending.map(useCase => useCase.item), firstGrid));
    } catch (e) {
        loading.value = false;
        error.value = '加载失败';
        catalog.value = { items: [], categories: [], featured: [], trending: [] };
    }
}

onMounted(loadCatalog);
onBeforeUnmount(stopCarousel);
</script>

<template>
    <div class="store">
        <!-- 列表视图常驻，进详情用整页覆盖，返回时列表状态/滚动都不丢 -->
        <div v-show="!detailTarget" class="store-list">
            <div v-if="loading" class="store-skeleton" aria-busy="true" aria-label="加载中">
                <div class="nv-skel sk-hero"></div>
                <div class="sk-row">
                    <div v-for="n in 5" :key="n" class="nv-skel sk-card"></div>
                </div>
                <div class="sk-row">
                    <div v-for="n in 5" :key="n" class="nv-skel sk-card sm"></div>
                </div>
            </div>

            <div v-else-if="error" class="store-state">
                <p class="state-title">加载失败</p>
                <p class="state-sub">应用市场暂时连不上，等一下再试。</p>
                <button type="button" class="nv-btn sm" @click="loadCatalog"><NvIcon name="refresh" />重试</button>
            </div>

            <template v-else>
                <!-- 1. 最新上线 -->
                <section v-if="slides.length" class="latest" @mouseenter="carouselHover = true" @mouseleave="carouselHover = false">
                    <div class="latest-head">
                        <h2>最新上线</h2>
                        <span class="latest-count">{{ activeSlide + 1 }} / {{ slides.length }}</span>
                    </div>
                    <div class="hero">
                        <div v-for="(item, index) in slides" :key="itemKey(item.kind, item.name)" class="hero-slide"
                             :class="{ 'is-active': index === activeSlide }" :aria-hidden="index !== activeSlide">
                            <StoreCover :src="presetMedia(item).src" :poster="presetMedia(item).poster" :type="presetMedia(item).kind"
                                        :alt="item.displayName" :label="item.displayName" :autoplay="index === activeSlide" />
                            <div class="hero-scrim"></div>
                            <div class="hero-copy">
                                <span class="hero-kicker">{{ item.kind === 'app' ? '智能体' : '技能' }}<template v-if="item.category"> · {{ item.category }}</template></span>
                                <h3 class="hero-title">{{ item.displayName }}</h3>
                                <p class="hero-line">{{ item.marketingLine || item.description }}</p>
                                <button type="button" class="hero-cta" @click="openDetail(item)">查看详情 <NvIcon name="arrowr" /></button>
                            </div>
                            <span v-if="modelNameFor(item)" class="hero-model">{{ modelNameFor(item) }}</span>
                        </div>
                        <button type="button" class="hero-arrow left" title="上一个" aria-label="上一个" @click.stop="prevSlide"><NvIcon name="chevl" /></button>
                        <button type="button" class="hero-arrow right" title="下一个" aria-label="下一个" @click.stop="nextSlide"><NvIcon name="chevr" /></button>
                        <div class="hero-dots" role="tablist" aria-label="最新上线">
                            <button v-for="(item, index) in slides" :key="itemKey(item.kind, item.name)" type="button" class="hero-dot"
                                    :class="{ 'is-on': index === activeSlide }" :aria-label="item.displayName" @click.stop="goSlide(index)"></button>
                        </div>
                    </div>
                </section>

                <!-- 2. 官方技能 -->
                <section class="block">
                    <div class="block-head">
                        <h2>官方技能</h2>
                        <button type="button" class="block-more" @click="viewAllSkills">查看全部 <NvIcon name="chevr" /></button>
                    </div>
                    <div class="skill-grid">
                        <button v-for="item in officialSkills" :key="itemKey(item.kind, item.name)" type="button" class="skill-card" @click="openDetail(item)">
                            <span class="skill-icon">
                                <StoreCover v-if="iconFor(item)" :src="iconFor(item)" type="image" :alt="item.displayName" :label="item.displayName" />
                                <template v-else>{{ String(item.displayName || '·').slice(0, 1).toUpperCase() }}</template>
                            </span>
                            <span class="skill-arrow"><NvIcon name="arrowdr" /></span>
                            <span class="skill-name">{{ item.displayName }}</span>
                            <span class="skill-desc">{{ item.description }}</span>
                        </button>
                    </div>
                </section>

                <!-- 3. 热门用例 -->
                <section v-if="trending.length" class="block">
                    <div class="block-head"><h2>热门用例</h2></div>
                    <div class="trend-row">
                        <button v-for="useCase in trending" :key="useCase.id || useCase.title" type="button" class="trend-card" @click="openDetail(useCase.item)">
                            <span class="trend-icon">
                                <StoreCover v-if="iconFor(useCase.item)" :src="iconFor(useCase.item)" type="image" :alt="useCase.item.displayName" :label="useCase.item.displayName" />
                                <template v-else>{{ String(useCase.item.displayName || '·').slice(0, 1).toUpperCase() }}</template>
                            </span>
                            <span class="trend-title">{{ useCase.title }}</span>
                            <span class="trend-prompt">{{ useCase.prompt }}</span>
                            <span class="trend-meta">{{ useCase.context || useCase.item.displayName }}</span>
                        </button>
                    </div>
                </section>

                <!-- 4. 全部条目 -->
                <section ref="allSectionRef" class="block all-block">
                    <div class="block-head">
                        <h2>全部应用</h2>
                        <label class="store-search">
                            <NvIcon name="search" />
                            <input v-model="query" type="search" placeholder="搜索技能或智能体" aria-label="搜索技能或智能体" />
                            <button v-if="query" type="button" class="search-clear" title="清空搜索" aria-label="清空搜索" @click="query = ''">
                                <NvIcon name="close" />
                            </button>
                        </label>
                    </div>
                    <div class="store-chips" role="group" aria-label="筛选">
                        <button v-for="chip in chips" :key="chip.key" type="button" class="nv-chip"
                                :class="{ 'is-on': isChipActive(chip) }" :aria-pressed="isChipActive(chip)" @click="pickChip(chip)">
                            {{ chip.label }}<em class="chip-count">{{ chip.count }}</em>
                        </button>
                    </div>

                    <div v-if="!filtered.length" class="store-state inline">
                        <p class="state-title">没有匹配结果</p>
                        <p class="state-sub">换一个关键词，或者清掉筛选看看全部。</p>
                        <button type="button" class="nv-btn sm" @click="clearFilters"><NvIcon name="close" />清除筛选</button>
                    </div>
                    <div v-else class="all-grid">
                        <button v-for="item in filtered" :key="itemKey(item.kind, item.name)" type="button" class="all-card" @click="openDetail(item)">
                            <span class="all-icon">
                                <StoreCover v-if="iconFor(item)" :src="iconFor(item)" type="image" :alt="item.displayName" :label="item.displayName" />
                                <template v-else>{{ String(item.displayName || '·').slice(0, 1).toUpperCase() }}</template>
                            </span>
                            <span class="all-body">
                                <span class="all-name">{{ item.displayName }}<i v-if="item.installed" class="all-dot" title="已添加"></i></span>
                                <span class="all-desc">{{ item.description }}</span>
                            </span>
                            <span class="all-arrow"><NvIcon name="arrowdr" /></span>
                        </button>
                    </div>
                </section>
            </template>
        </div>

        <StoreDetail v-if="detailTarget" :item="detailTarget" @back="detailTarget = null"
                     @open-item="openCollectionItem" @installed="onInstalled" />
    </div>
</template>

<style scoped>
.store { height: 100%; overflow: auto; box-sizing: border-box; padding: var(--space-7) var(--space-8) var(--space-9); color: var(--ink); scrollbar-width: thin; }
.store-list { display: flex; flex-direction: column; gap: var(--space-7); max-width: 1240px; margin: 0 auto; }
.store-state { display: flex; flex-direction: column; align-items: center; gap: var(--space-3); padding: var(--space-9) 0 var(--space-8); text-align: center; }
.store-state.inline { padding: var(--space-8) 0 var(--space-7); }
.state-title { margin: 0; color: var(--ink); font: 500 15px/22px var(--font-sans); }
.state-sub { margin: 0 0 var(--space-4); color: var(--ink-3); font: 400 12.5px/18px var(--font-sans); }
.store-skeleton { display: flex; flex-direction: column; gap: var(--space-6); }
.sk-hero { height: 300px; border-radius: var(--radius-2xl); }
.sk-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: var(--space-5); }
.sk-card { height: 150px; border-radius: var(--radius-xl); }
.sk-card.sm { height: 110px; }
.latest-head { display: flex; align-items: baseline; justify-content: space-between; padding: 0 var(--space-1) var(--space-4); }
.latest-head h2 { margin: 0; color: var(--ink); font: 500 17px/22px var(--font-sans); letter-spacing: -0.01em; }
.latest-count { color: var(--ink-4); font: 400 11px/1 var(--font-mono); }
.hero { position: relative; height: clamp(260px, 34vw, 380px); border-radius: var(--radius-xl); overflow: hidden; background: var(--glass); backdrop-filter: var(--material-regular); -webkit-backdrop-filter: var(--material-regular); box-shadow: var(--shadow-float); }
.hero-slide { position: absolute; inset: 0; opacity: 0; visibility: hidden; transition: opacity var(--duration-slow) var(--ease-out), visibility var(--duration-slow) var(--ease-out); }
.hero-slide.is-active { opacity: 1; visibility: visible; z-index: 1; }
.hero-slide .store-cover { position: absolute; inset: 0; }
.hero-scrim { position: absolute; inset: 0; background: linear-gradient(to right, color-mix(in srgb, var(--ink) 82%, transparent) 0%, color-mix(in srgb, var(--ink) 55%, transparent) 34%, color-mix(in srgb, var(--ink) 8%, transparent) 68%, transparent 100%); }
.hero-copy { position: absolute; left: var(--space-8); bottom: var(--space-8); max-width: 54%; color: var(--on-accent); display: flex; flex-direction: column; gap: var(--space-4); }
.hero-kicker { color: color-mix(in srgb, var(--on-accent) 72%, transparent); font: 500 10.5px/16px var(--font-sans); letter-spacing: .06em; text-transform: uppercase; }
.hero-title { margin: 0; color: var(--on-accent); font: 500 clamp(22px, 2.6vw, 34px)/1.14 var(--font-sans); letter-spacing: -0.02em; }
.hero-line { margin: 0; color: color-mix(in srgb, var(--on-accent) 82%, transparent); font: 400 12.5px/19px var(--font-sans); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.hero-cta { align-self: flex-start; margin-top: var(--space-1); border: 0; height: var(--control-md); padding: 0 13px; border-radius: var(--radius-pill); background: var(--accent); color: var(--on-accent); font: 500 12px/1 var(--font-sans); display: inline-flex; align-items: center; gap: var(--space-2); cursor: pointer; transition: box-shadow var(--duration-base) var(--ease-out); }
.hero-cta:hover { box-shadow: var(--shadow-lift); }
.hero-cta .nv-i { width: 12px; height: 12px; }
.hero-model { position: absolute; right: var(--space-6); bottom: var(--space-6); color: var(--on-accent); background: color-mix(in srgb, var(--ink) 55%, transparent); border-radius: var(--radius-pill); padding: 6px 10px; backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); font: 500 10.5px/1 var(--font-sans); }
.hero-arrow { position: absolute; top: 50%; transform: translateY(-50%); z-index: 2; width: var(--control-md); height: var(--control-md); border: 0; border-radius: 50%; background: color-mix(in srgb, var(--ink) 42%, transparent); color: var(--on-accent); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); transition: background var(--duration-base) var(--ease-out); }
.hero-arrow:hover { background: color-mix(in srgb, var(--ink) 58%, transparent); }
.hero-arrow.left { left: var(--space-5); }
.hero-arrow.right { right: var(--space-5); }
.hero-arrow .nv-i { width: 16px; height: 16px; }
.hero-dots { position: absolute; right: var(--space-6); top: var(--space-5); z-index: 2; display: flex; align-items: center; gap: 5px; max-width: 46%; flex-wrap: wrap; justify-content: flex-end; }
.hero-dot { width: 6px; height: 6px; padding: 0; border: 0; border-radius: 50%; background: color-mix(in srgb, var(--on-accent) 40%, transparent); cursor: pointer; transition: width var(--duration-base) var(--ease-out), background var(--duration-base) var(--ease-out); }
.hero-dot.is-on { width: 16px; border-radius: 3px; background: var(--on-accent); }
.block { display: flex; flex-direction: column; gap: var(--space-5); }
.block-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-6); }
.block-head h2 { margin: 0; color: var(--ink); font: 500 17px/22px var(--font-sans); letter-spacing: -0.01em; }
.block-more { border: 0; background: transparent; color: var(--ink-3); font: 500 12px/1 var(--font-sans); display: inline-flex; align-items: center; gap: 2px; cursor: pointer; padding: var(--space-3) var(--space-1); transition: color var(--duration-base) var(--ease-out); }
.block-more:hover { color: var(--ink); }
.block-more .nv-i { width: 13px; height: 13px; }
.skill-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--space-5); }
.skill-card { position: relative; border: 0; text-align: left; display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-6) var(--space-6) var(--space-5); border-radius: var(--radius-xl); background: var(--glass); backdrop-filter: var(--material-regular); -webkit-backdrop-filter: var(--material-regular); box-shadow: var(--shadow-float); color: var(--ink); font: inherit; cursor: pointer; animation: card-in 480ms var(--ease-out) both; transition: transform var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out), background var(--duration-base) var(--ease-out); }
.skill-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); background: var(--glass-strong); }
.skill-icon { width: 38px; height: 38px; border-radius: var(--radius-md); overflow: hidden; background: var(--fill-2); display: inline-flex; align-items: center; justify-content: center; color: var(--ink-3); font: 500 15px/1 var(--font-sans); }
.skill-arrow { position: absolute; right: var(--space-6); top: var(--space-6); color: var(--ink-4); }
.skill-arrow .nv-i { width: 14px; height: 14px; }
.skill-name { color: var(--ink); font: 500 13.5px/19px var(--font-sans); margin-top: var(--space-1); }
.skill-desc { color: var(--ink-3); font: 400 11.5px/17px var(--font-sans); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.trend-row { display: flex; gap: var(--space-5); overflow-x: auto; padding: var(--space-1) var(--space-1) var(--space-4); scrollbar-width: thin; scroll-snap-type: x proximity; }
.trend-card { flex: 0 0 300px; scroll-snap-align: start; border: 0; text-align: left; display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-6); border-radius: var(--radius-xl); background: var(--glass); backdrop-filter: var(--material-regular); -webkit-backdrop-filter: var(--material-regular); box-shadow: var(--shadow-float); color: var(--ink); font: inherit; cursor: pointer; animation: card-in 480ms var(--ease-out) both; transition: transform var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out); }
.trend-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
.trend-icon { width: var(--control-md); height: var(--control-md); border-radius: var(--radius-md); overflow: hidden; background: var(--fill-2); display: inline-flex; align-items: center; justify-content: center; color: var(--ink-3); font: 500 13px/1 var(--font-sans); }
.trend-title { color: var(--ink); font: 500 13px/18px var(--font-sans); }
.trend-prompt { color: var(--ink-3); font: 400 11px/16px var(--font-sans); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.trend-meta { color: var(--ink-4); font: 400 10.5px/15px var(--font-sans); margin-top: auto; }
.store-search { display: flex; align-items: center; gap: var(--space-4); height: var(--control-md); padding: 0 var(--space-5); border-radius: var(--radius-lg); background: var(--fill-1); color: var(--ink-3); min-width: 260px; transition: background var(--duration-base) var(--ease-out); }
.store-search:focus-within { background: var(--fill-2); }
.store-search .nv-i { width: 14px; height: 14px; flex-shrink: 0; }
.store-search input { flex: 1; min-width: 0; height: 100%; border: 0; outline: none; background: transparent; color: var(--ink); font: 400 12.5px/1 var(--font-sans); }
.store-search input::placeholder { color: var(--ink-4); }
.search-clear { width: 20px; height: 20px; border: 0; border-radius: 50%; background: var(--fill-2); color: var(--ink-3); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.search-clear .nv-i { width: 10px; height: 10px; }
.store-chips { display: flex; flex-wrap: wrap; gap: var(--space-3); }
.chip-count { font: 500 10px/1 var(--font-mono); opacity: .66; }
.all-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--space-4); }
.all-card { border: 0; text-align: left; display: flex; align-items: center; gap: var(--space-5); padding: var(--space-5); border-radius: var(--radius-lg); background: var(--fill-1); color: var(--ink); font: inherit; cursor: pointer; animation: card-in 480ms var(--ease-out) both; transition: background var(--duration-base) var(--ease-out), transform var(--duration-base) var(--ease-out); }
.all-card:hover { background: var(--fill-2); transform: translateY(-1px); }
.all-icon { width: 36px; height: 36px; flex-shrink: 0; border-radius: var(--radius-md); overflow: hidden; background: var(--fill-2); display: inline-flex; align-items: center; justify-content: center; color: var(--ink-3); font: 500 14px/1 var(--font-sans); }
.all-body { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; flex: 1; }
.all-name { color: var(--ink); font: 500 12.5px/17px var(--font-sans); display: inline-flex; align-items: center; gap: var(--space-2); }
.all-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }
.all-desc { color: var(--ink-3); font: 400 11px/16px var(--font-sans); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.all-arrow { color: var(--ink-4); flex-shrink: 0; }
.all-arrow .nv-i { width: 13px; height: 13px; }
@keyframes card-in { from { opacity: 0; transform: translateY(8px); filter: blur(3px); } }
@media (max-width: 760px) {
    .store { padding: var(--space-6) var(--space-6) var(--space-8); }
    .hero { height: 240px; }
    .hero-copy { left: var(--space-6); right: var(--space-6); bottom: var(--space-7); max-width: none; }
    .hero-dots { display: none; }
    .store-search { min-width: 0; width: 100%; }
    .block-head { flex-wrap: wrap; }
    .trend-card { flex-basis: 260px; }
}
</style>
