<script setup>
// 应用市场详情（整页，1:1）：preset_gallery → influencer_studio → collection → app → generic 五种分支。
// 数据一律来自 GET /api/store/items/{kind}/{name}；只有市场的 83 条，不混入 NOVAI 自己的技能/智能体。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import StoreCover from './StoreCover.vue';
import StoreBriefModal from './StoreBriefModal.vue';
import StoreStudioHub from './StoreStudioHub.vue';
import StoreStudioBuilder from './StoreStudioBuilder.vue';
import { fetchItemDetail } from './storeData.js';

const props = defineProps({
    item: { type: Object, required: true },
});
const emit = defineEmits(['back', 'open-item', 'installed']);

const detail = ref(null);
const loading = ref(true);
const error = ref('');
const briefState = ref(null);
const presetTab = ref('all');
const marqueePaused = ref(false);
const hoveredPreset = ref('');
const installing = ref(false);

const view = computed(() => detail.value || props.item || {});
const isApp = computed(() => view.value.kind === 'app');
const presetGallery = computed(() => view.value.presetGallery || null);
const studio = computed(() => view.value.influencerStudio || null);
const collection = computed(() => view.value.collection || null);
const guide = computed(() => view.value.guide || {});
const detailUnavailable = computed(() => !!view.value.detailUnavailable);
const unavailableReason = computed(() => view.value.detailUnavailableReason || '该应用详情由上游暂不提供');
const isInstalled = ref(false);
watch(() => view.value.installed, value => { isInstalled.value = !!value; }, { immediate: true });

const branch = computed(() => {
    if (presetGallery.value) return 'preset';
    if (studio.value) return 'studio';
    if (collection.value) return 'collection';
    if (isApp.value) return 'app';
    return 'generic';
});

const presetCategories = computed(() => {
    const cats = (presetGallery.value && presetGallery.value.categories) || [];
    return [{ id: 'all', label: '全部' }].concat(cats);
});
const filteredPresets = computed(() => {
    const presets = (presetGallery.value && presetGallery.value.presets) || [];
    if (presetTab.value === 'all') return presets;
    return presets.filter(preset => preset.category === presetTab.value);
});
const marqueeItems = computed(() => {
    const presets = (presetGallery.value && presetGallery.value.presets) || [];
    return presets.map(preset => preset.title).filter(Boolean);
});
const marqueeLoop = computed(() => marqueeItems.value.concat(marqueeItems.value));

const collectionGroups = computed(() => {
    if (!collection.value) return [];
    const cats = collection.value.categories || [];
    const entries = collection.value.entries || [];
    if (!cats.length) return [{ id: 'all', label: '', entries }];
    return cats.map(cat => ({ ...cat, entries: entries.filter(entry => entry.category === cat.id) })).filter(group => group.entries.length);
});

const sections = computed(() => {
    const g = guide.value;
    const aboutText = String(view.value.description || g.summary || '');
    const whatYouGet = isApp.value
        ? (view.value.capabilities || []).map(entry => entry.title || entry.description).filter(Boolean)
        : (g.outputs || []);
    return [
        { id: 'about', title: 'About', paragraphs: aboutText ? [aboutText] : [] },
        { id: 'whatYouGet', title: 'What you get', items: whatYouGet },
        { id: 'howItWorks', title: 'How it works', steps: g.steps || [] },
        { id: 'requiredContext', title: 'Required context', items: (g.requiredContext || []).map(entry => entry.description ? entry.title + '：' + entry.description : entry.title), connectors: view.value.connectors || [] },
        { id: 'scopeAndLimits', title: 'Scope & limits', items: g.boundaries || [] },
    ];
});

const categoryLabel = computed(() => {
    const scenario = String(view.value.businessScenario || '');
    const found = (presetGallery.value && presetGallery.value.categories || []).find(cat => cat.id === scenario);
    return found ? found.label : String(view.value.category || '');
});

function presetCategoryLabel(id) {
    if (!presetGallery.value) return '';
    const found = presetGallery.value.categories.find(cat => cat.id === id);
    return found ? found.label : '';
}

async function load() {
    loading.value = true;
    error.value = '';
    try {
        const data = await fetchItemDetail(props.item.kind, props.item.name);
        detail.value = data;
        isInstalled.value = !!data.installed;
    } catch (e) {
        detail.value = null;
        error.value = '详情加载失败';
    } finally {
        loading.value = false;
    }
}

function openBrief(preset) {
    briefState.value = preset ? { preset } : { preset: null };
}

async function toggleInstall() {
    if (installing.value) return;
    installing.value = true;
    const next = !isInstalled.value;
    try {
        const res = await fetch(
            '/api/store/items/' + encodeURIComponent(props.item.kind) + '/' + encodeURIComponent(props.item.name) + '/install',
            { method: next ? 'POST' : 'DELETE', headers: { Accept: 'application/json' } }
        );
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json().catch(() => ({}));
        isInstalled.value = typeof data.installed === 'boolean' ? data.installed : next;
        emit('installed', { kind: props.item.kind, name: props.item.name, installed: isInstalled.value });
    } catch (e) {
        /* 失败保持原状态，用户可以再点一次 */
    } finally {
        installing.value = false;
    }
}

function openCollectionEntry(entry) {
    if (entry && entry.item && entry.item.name) emit('open-item', entry.item);
}
function openBuilder(context) {
    const target = (view.value.influencerStudio && view.value.influencerStudio.studio && view.value.influencerStudio.studio.name) || 'ai-influencer-builder';
    try { sessionStorage.setItem('novai_forge_context', JSON.stringify(context || {})); } catch (e) {}
    emit('open-item', { kind: 'skill', name: target });
}

function onKey(event) {
    if (event.key !== 'Escape') return;
    if (document.querySelector('.pick-root, .brief-root')) return;
    event.stopPropagation();
    emit('back');
}
onMounted(() => {
    load();
    document.addEventListener('keydown', onKey, true);
});
onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true));
// 多来源分别比较：父组件回写 installed 时不能因为「新数组引用」重新拉详情，把刚装上的状态冲掉
watch([() => props.item.kind, () => props.item.name], load);
</script>

<template>
    <div class="detail" :class="{ 'is-studio': branch === 'studio' }">
        <div class="detail-bar">
            <button type="button" class="detail-back" title="返回应用市场" @click="emit('back')">
                <NvIcon name="back" /><span>应用市场</span>
            </button>
        </div>

        <div v-if="loading" class="detail-loading">
            <div class="nv-skel sk-hero"></div>
            <div class="nv-skel sk-line w40"></div>
            <div class="nv-skel sk-line"></div>
            <div class="nv-skel sk-line w70"></div>
        </div>

        <div v-else-if="error" class="detail-state">
            <p class="state-title">{{ error }}</p>
            <p class="state-sub">这条应用可能暂时不可用。</p>
            <button type="button" class="nv-btn sm" @click="load"><NvIcon name="refresh" />重试</button>
        </div>

        <template v-else>
            <section v-if="detailUnavailable" class="unavailable">
                <div class="unavailable-head">
                    <span class="detail-icon"><StoreCover :src="view.iconUrl" type="image" :label="view.displayName" /></span>
                    <div class="detail-heading">
                        <h1 class="detail-title">{{ view.displayName || view.name }}</h1>
                        <p class="detail-line">{{ view.marketingLine || view.description }}</p>
                    </div>
                </div>
                <div class="unavailable-card">
                    <p>{{ unavailableReason }}</p>
                    <button type="button" class="nv-btn primary" @click="emit('back')">回到市场</button>
                </div>
            </section>

            <template v-else>
            <header v-if="branch !== 'studio'" class="detail-head">
                <span class="detail-icon">
                    <StoreCover :src="view.iconUrl" type="image" :label="view.displayName" />
                </span>
                <div class="detail-heading">
                    <h1 class="detail-title">{{ view.displayName || view.name }}</h1>
                    <p class="detail-line">{{ view.marketingLine || view.description }}</p>
                    <div class="detail-meta">
                        <span class="detail-tag">{{ isApp ? '智能体' : '技能' }}</span>
                        <span v-if="categoryLabel" class="detail-tag">{{ categoryLabel }}</span>
                        <span v-if="view.recommendedModel && view.recommendedModel.displayName" class="detail-model">
                            <NvIcon name="sparkles" />{{ view.recommendedModel.displayName }}
                        </span>
                        <span v-if="isInstalled" class="detail-installed"><NvIcon name="check" />已添加</span>
                    </div>
                </div>
            </header>

            <!-- 预设墙（跑马灯 + 分类 tabs + 竖版预设网格） -->
            <section v-if="branch === 'preset'" class="preset-wall">
                <div class="marquee" :class="{ paused: marqueePaused }" @mouseenter="marqueePaused = true" @mouseleave="marqueePaused = false">
                    <div class="marquee-track">
                        <span v-for="(title, index) in marqueeLoop" :key="title + index" class="marquee-item">{{ title }}</span>
                    </div>
                </div>
                <div class="preset-tabs" role="tablist" aria-label="预设分类">
                    <button v-for="cat in presetCategories" :key="cat.id" type="button" class="preset-tab"
                            :class="{ 'is-on': presetTab === cat.id }" role="tab" :aria-selected="presetTab === cat.id"
                            @click="presetTab = cat.id">{{ cat.label }}</button>
                </div>
                <div class="preset-grid">
                    <button v-for="(preset, index) in filteredPresets" :key="preset.id || preset.title" type="button" class="preset-card"
                            @mouseenter="hoveredPreset = preset.id || preset.title" @mouseleave="hoveredPreset = ''"
                            @click="openBrief(preset)">
                        <div class="preset-cover" :style="{ aspectRatio: (preset.aspect || '9/16').replace('/', ' / ') }">
                            <StoreCover :src="preset.cover && preset.cover.src" :poster="preset.cover && preset.cover.poster"
                                        :type="preset.cover && preset.cover.kind" :alt="preset.title" :label="preset.title"
                                        :autoplay="hoveredPreset === (preset.id || preset.title)" />
                            <span class="preset-num">{{ String(index + 1).padStart(2, '0') }}</span>
                            <span v-if="preset.isNew" class="preset-new">NEW</span>
                            <span class="preset-cat">{{ presetCategoryLabel(preset.category) }}</span>
                            <span class="preset-cta">一键做同款</span>
                        </div>
                        <div class="preset-text">
                            <b>{{ preset.title }}</b>
                            <span>{{ preset.description }}</span>
                        </div>
                    </button>
                </div>
            </section>

            <!-- 两个 studio：hub（Forge 1.0）与 builder（Forge Builder） -->
            <template v-else-if="branch === 'studio'">
                <StoreStudioHub v-if="view.influencerStudio && view.influencerStudio.view === 'hub'" :detail="view" @open-builder="openBuilder" />
                <StoreStudioBuilder v-else :detail="view" />
            </template>
            <!-- 合集 -->
            <section v-else-if="branch === 'collection'" class="collection">
                <p v-if="guide.summary" class="collection-summary">{{ guide.summary }}</p>
                <div v-for="group in collectionGroups" :key="group.id" class="collection-group">
                    <h2 v-if="group.label" class="section-title">{{ group.label }}</h2>
                    <div class="collection-grid">
                        <button v-for="(entry, index) in group.entries" :key="entry.title + index" type="button" class="collection-card"
                                :disabled="!entry.item" @click="openCollectionEntry(entry)">
                            <div class="collection-cover">
                                <StoreCover :src="entry.cover && entry.cover.src" :poster="entry.cover && entry.cover.poster"
                                            :type="entry.cover && entry.cover.kind" :alt="entry.title" :label="entry.title" />
                            </div>
                            <div class="collection-text">
                                <b>{{ entry.title }}</b>
                                <span>{{ entry.description }}</span>
                                <em v-if="(entry.tags || []).length">{{ (entry.tags || []).join(' · ') }}</em>
                            </div>
                        </button>
                    </div>
                </div>
            </section>

            <!-- App / 通用技能：五段说明 -->
            <template v-else>
                <div class="detail-sections">
                    <section v-for="sec in sections" :key="sec.id" class="detail-sec">
                        <h2 class="section-title">{{ sec.title }}</h2>
                        <div v-if="sec.id === 'howItWorks' && sec.steps.length" class="step-list">
                            <div v-for="(step, index) in sec.steps" :key="index" class="step-row">
                                <span class="step-num">{{ index + 1 }}</span>
                                <div><b>{{ step.title }}</b><span>{{ step.description }}</span></div>
                            </div>
                        </div>
                        <template v-else>
                            <p v-for="(para, index) in (sec.paragraphs || [])" :key="'p' + index" class="sec-para">{{ para }}</p>
                            <ul v-if="(sec.items || sec.connectors || []).length" class="sec-list">
                                <li v-for="(line, index) in (sec.items || [])" :key="'i' + index">{{ line }}</li>
                                <li v-for="(line, index) in (sec.connectors || [])" :key="'c' + index">
                                    {{ line.title || line.description }}<template v-if="line.description && line.title">：{{ line.description }}</template>
                                </li>
                            </ul>
                            <p v-if="!(sec.paragraphs || []).length && !(sec.items || []).length && !(sec.connectors || []).length && !(sec.steps || []).length" class="sec-empty">暂无说明</p>
                        </template>
                        <p v-if="sec.id === 'scopeAndLimits' && view.skillBodySource === 'generated'" class="sec-source">执行手册由公开信息整理，非官方原文</p>
                    </section>
                </div>

                <footer class="detail-foot">
                    <template v-if="isApp">
                        <button type="button" class="nv-btn primary" :disabled="installing || view.enabled === false" @click="toggleInstall">
                            <NvIcon :name="isInstalled ? 'check' : 'plus'" />{{ installing ? '处理中…' : (isInstalled ? '已添加到助手' : '添加到助手') }}
                        </button>
                    </template>
                    <template v-else>
                        <button type="button" class="nv-btn primary" :disabled="view.enabled === false" @click="openBrief(null)">
                            <NvIcon name="play" />用这个开始
                        </button>
                    </template>
                </footer>
            </template>
            </template>
        </template>

        <StoreBriefModal v-if="briefState" :item="view" :detail="detail" :preset="briefState.preset" @close="briefState = null" />
    </div>
</template>

<style scoped>
.detail { height: 100%; overflow: auto; box-sizing: border-box; padding: var(--space-6) var(--space-8) var(--space-9); color: var(--ink); scrollbar-width: thin; }
.detail.is-studio { background: var(--bg); color: var(--ink); padding: 0 var(--space-8) var(--space-8); }
.detail-bar { position: sticky; top: 0; z-index: 4; display: flex; align-items: center; padding: var(--space-1) 0 var(--space-4); background: color-mix(in srgb, var(--bg) 82%, transparent); backdrop-filter: var(--material-regular); -webkit-backdrop-filter: var(--material-regular); }
.detail-back { border: 0; background: transparent; color: var(--ink-2); display: inline-flex; align-items: center; gap: var(--space-3); height: var(--control-sm); padding: 0 var(--space-4) 0 var(--space-1); border-radius: var(--radius-md); font: 500 12.5px/1 var(--font-sans); cursor: pointer; transition: background var(--duration-base) var(--ease-out), color var(--duration-base) var(--ease-out); }
.detail-back:hover { background: var(--fill-1); color: var(--ink); }
.detail-back .nv-i { width: 15px; height: 15px; }
.detail-loading { display: flex; flex-direction: column; gap: var(--space-5); padding-top: var(--space-5); }
.sk-hero { height: 150px; border-radius: var(--radius-xl); }
.sk-line { height: 14px; border-radius: var(--radius-sm); }
.sk-line.w40 { width: 40%; }
.sk-line.w70 { width: 70%; }
.detail-state { display: flex; flex-direction: column; align-items: center; gap: var(--space-3); padding: var(--space-11) 0; text-align: center; }
.state-title { margin: 0; color: var(--ink); font: 500 15px/22px var(--font-sans); }
.state-sub { margin: 0 0 var(--space-4); color: var(--ink-3); font: 400 12.5px/18px var(--font-sans); }
.detail-head { display: flex; align-items: flex-start; gap: var(--space-6); padding: var(--space-4) 0 var(--space-7); }
.detail-icon { width: 64px; height: 64px; border-radius: var(--radius-xl); overflow: hidden; flex-shrink: 0; background: var(--fill-2); }
.detail-heading { min-width: 0; flex: 1; }
.detail-title { margin: 0; color: var(--ink); font: 500 clamp(24px, 3vw, 34px)/1.15 var(--font-sans); letter-spacing: -0.02em; }
.detail-line { margin: var(--space-4) 0 0; color: var(--ink-3); font: 400 13px/20px var(--font-sans); max-width: 720px; }
.detail-meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-4); margin-top: var(--space-4); color: var(--ink-3); font: 400 11px/16px var(--font-sans); }
.detail-tag { background: var(--fill-1); border-radius: var(--radius-pill); padding: 2px 9px; }
.detail-model, .detail-installed { display: inline-flex; align-items: center; gap: var(--space-2); background: var(--fill-1); border-radius: var(--radius-pill); padding: 2px 9px; color: var(--ink-2); }
.detail-model .nv-i, .detail-installed .nv-i { width: 11px; height: 11px; }
.marquee { overflow: hidden; padding: var(--space-3) 0 var(--space-6); mask-image: linear-gradient(to right, transparent, var(--ink) 5%, var(--ink) 95%, transparent); -webkit-mask-image: linear-gradient(to right, transparent, var(--ink) 5%, var(--ink) 95%, transparent); }
.marquee-track { display: inline-flex; gap: var(--space-7); white-space: nowrap; animation: marquee 40s linear infinite; }
.marquee.paused .marquee-track { animation-play-state: paused; }
.marquee-item { color: var(--ink-3); font: 500 12px/18px var(--font-sans); transition: color var(--duration-base) var(--ease-out); }
.marquee-item:hover { color: var(--ink); }
.marquee-item::after { content: ""; display: inline-block; width: 4px; height: 4px; margin-left: var(--space-7); border-radius: 50%; background: var(--ink-4); vertical-align: middle; }
@keyframes marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
.preset-tabs { display: flex; flex-wrap: wrap; gap: var(--space-4); margin: var(--space-1) 0 var(--space-6); }
.preset-tab { border: 0; height: var(--control-sm); padding: 0 12px; border-radius: var(--radius-pill); background: var(--fill-1); color: var(--ink-3); font: 500 12px/1 var(--font-sans); cursor: pointer; transition: background var(--duration-base) var(--ease-out), color var(--duration-base) var(--ease-out); }
.preset-tab:hover { background: var(--fill-2); color: var(--ink); }
.preset-tab.is-on { background: var(--accent); color: var(--on-accent); }
.preset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--space-6); }
.preset-card { border: 0; padding: 0; background: transparent; text-align: left; cursor: pointer; display: flex; flex-direction: column; gap: var(--space-4); color: var(--ink); font: inherit; animation: card-in 480ms var(--ease-out) both; }
.preset-cover { position: relative; width: 100%; border-radius: var(--radius-lg); overflow: hidden; background: var(--fill-2); transition: transform var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out); }
.preset-card:hover .preset-cover { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
.preset-num { position: absolute; left: var(--space-4); top: var(--space-4); color: var(--on-accent); background: color-mix(in srgb, var(--ink) 55%, transparent); border-radius: var(--radius-sm); padding: 3px 5px; backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); font: 500 11px/1 var(--font-mono); }
.preset-new { position: absolute; right: var(--space-4); top: var(--space-4); color: var(--on-accent); background: var(--accent); border-radius: var(--radius-sm); padding: 3px 5px; font: 500 9px/1 var(--font-mono); letter-spacing: .06em; }
.preset-cat { position: absolute; left: var(--space-4); bottom: var(--space-4); color: var(--on-accent); background: color-mix(in srgb, var(--ink) 55%, transparent); border-radius: var(--radius-pill); padding: 3px 7px; backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); font: 500 10px/1 var(--font-sans); }
.preset-cta { position: absolute; left: 50%; bottom: var(--space-5); transform: translate(-50%, 6px); opacity: 0; height: var(--control-sm); padding: 0 12px; border-radius: var(--radius-pill); background: var(--solid); color: var(--ink); font: 500 11.5px/1 var(--font-sans); display: inline-flex; align-items: center; white-space: nowrap; transition: opacity var(--duration-base) var(--ease-out), transform var(--duration-base) var(--ease-out); box-shadow: var(--shadow-float); }
.preset-card:hover .preset-cta { opacity: 1; transform: translate(-50%, 0); }
.preset-text { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
.preset-text b { color: var(--ink); font: 500 13px/18px var(--font-sans); }
.preset-text span { color: var(--ink-3); font: 400 11.5px/17px var(--font-sans); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.collection-summary { margin: 0 0 var(--space-6); color: var(--ink-3); font: 400 13px/20px var(--font-sans); max-width: 760px; }
.collection-group { margin-bottom: var(--space-7); }
.collection-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: var(--space-6); }
.collection-card { border: 0; padding: 0; background: transparent; text-align: left; color: var(--ink); font: inherit; cursor: pointer; display: flex; flex-direction: column; gap: var(--space-4); animation: card-in 480ms var(--ease-out) both; }
.collection-card:disabled { cursor: default; }
.collection-cover { position: relative; aspect-ratio: 4 / 3; border-radius: var(--radius-lg); overflow: hidden; background: var(--fill-2); }
.collection-text { display: flex; flex-direction: column; gap: var(--space-1); }
.collection-text b { color: var(--ink); font: 500 13px/18px var(--font-sans); }
.collection-text span { color: var(--ink-3); font: 400 11.5px/17px var(--font-sans); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.collection-text em { color: var(--ink-4); font: 400 10.5px/15px var(--font-sans); font-style: normal; }
.detail-sections { display: flex; flex-direction: column; gap: var(--space-7); max-width: 900px; }
.detail-sec { display: flex; flex-direction: column; gap: var(--space-4); }
.section-title { margin: 0; color: var(--ink); font: 500 14px/20px var(--font-sans); }
.sec-para { margin: 0; color: var(--ink-2); font: 400 13px/21px var(--font-sans); }
.sec-list { margin: 0; padding-left: var(--space-6); display: flex; flex-direction: column; gap: var(--space-3); color: var(--ink-2); font: 400 12.5px/20px var(--font-sans); }
.sec-empty { margin: 0; color: var(--ink-4); font: 400 12px/18px var(--font-sans); }
.sec-source { margin: var(--space-1) 0 0; color: var(--ink-4); font: 400 10.5px/16px var(--font-sans); }
.step-list { display: flex; flex-direction: column; gap: var(--space-5); }
.step-row { display: flex; gap: var(--space-5); align-items: flex-start; }
.step-num { width: 22px; height: 22px; flex: 0 0 22px; border-radius: 50%; background: var(--fill-1); color: var(--ink-2); display: inline-flex; align-items: center; justify-content: center; font: 500 10.5px/1 var(--font-mono); }
.step-row > div { display: flex; flex-direction: column; gap: 2px; }
.step-row b { color: var(--ink); font: 500 12.5px/18px var(--font-sans); }
.step-row span { color: var(--ink-3); font: 400 12px/18px var(--font-sans); }
.detail-foot { margin-top: var(--space-7); padding: var(--space-6) 0 var(--space-3); display: flex; justify-content: flex-end; gap: var(--space-5); }
.detail-foot .nv-btn { border: 0; height: var(--control-lg); padding: 0 18px; }
.unavailable { display: flex; flex-direction: column; gap: var(--space-7); max-width: 760px; padding: var(--space-5) 0 var(--space-8); }
.unavailable-head { display: flex; align-items: flex-start; gap: var(--space-6); }
.unavailable-head .detail-heading { min-width: 0; }
.unavailable .detail-title { font-size: clamp(26px, 3.2vw, 36px); }
.unavailable-card { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-6); padding: var(--space-7); border-radius: var(--radius-xl); background: var(--fill-1); box-shadow: var(--shadow-float); }
.unavailable-card p { margin: 0; color: var(--ink-2); font: 400 13.5px/21px var(--font-sans); }
.unavailable-card .nv-btn { border: 0; }
@keyframes card-in { from { opacity: 0; transform: translateY(8px); filter: blur(3px); } }
@media (max-width: 760px) {
    .detail { padding: var(--space-5) var(--space-6) var(--space-8); }
    .detail.is-studio { padding: 0 var(--space-6) var(--space-8); }
    .detail-title { font-size: 24px; }
}
</style>
