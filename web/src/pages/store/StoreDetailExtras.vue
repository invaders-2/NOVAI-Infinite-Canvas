<script setup>
// 市场详情的四块上游内容：作品展示 / 创作团队 / 模板 / 技能说明。
// 只在上游字段存在时渲染；点击模板复用 launch + openStoreCanvas 走画布自动发送。
import { computed, ref } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import StoreCover from './StoreCover.vue';
import { buildLaunchBody, launchStoreItem, openStoreCanvas } from './storeData.js';

const props = defineProps({
    view: { type: Object, required: true },
});
const emit = defineEmits(['open-item']);

const showcases = computed(() => props.view.introShowcase || []);
const presentation = computed(() => {
    const item = props.view.presentation;
    if (!item || item.variant !== 'creator-cinematic' || !item.series) return null;
    return item;
});
const library = computed(() => props.view.library || null);
const publicContent = computed(() => String(props.view.publicContent || '').trim());

const activeFamily = ref('');
const publicOpen = ref(false);
const launching = ref('');
const launchError = ref('');

const families = computed(() => (library.value && library.value.families) || []);
const templates = computed(() => {
    const all = (library.value && library.value.templates) || [];
    if (!activeFamily.value) return all;
    return all.filter(template => template.family === activeFamily.value);
});
const publicHtml = computed(() => renderMarkdown(stripFrontmatter(publicContent.value)));

function familyLabel(id) {
    const family = families.value.find(item => item.id === id);
    return family ? family.label : '';
}
function panelColumns(count) {
    if (count <= 2) return 2;
    return 3;
}
function panelStyle(block) {
    return { gridTemplateColumns: 'repeat(' + panelColumns((block.panels || []).length) + ', minmax(0, 1fr))' };
}
function creatorInitial(name) {
    return String(name || '·').trim().slice(0, 1).toUpperCase() || '·';
}
function openSeries() {
    const collection = presentation.value && presentation.value.series && presentation.value.series.collection;
    if (!collection || !collection.name) return;
    emit('open-item', { kind: collection.kind || 'skill', name: collection.name });
}
async function launchTemplate(template) {
    if (launching.value || !template) return;
    launching.value = template.id;
    launchError.value = '';
    const family = familyLabel(template.family);
    const fallback = [props.view.starterPrompt, template.name, family].filter(Boolean).join(' · ');
    const prompt = String(template.starter || '').trim() || fallback;
    try {
        const body = buildLaunchBody({
            kind: props.view.kind || 'app',
            name: props.view.name,
            presetId: '',
            prompt: prompt,
            fields: {
                '模板': template.name,
                ...(family ? { '模板分类': family } : {}),
            },
            references: [],
        });
        const result = await launchStoreItem(props.view.kind || 'app', props.view.name, body);
        const opened = openStoreCanvas(result.canvasId, result.prompt || prompt, result.project, { autoSend: true, skillRef: result.skillRef });
        if (!opened) throw new Error('没有拿到画布 id');
    } catch (e) {
        launchError.value = (e && e.message) || '启动失败，请重试';
    } finally {
        launching.value = '';
    }
}

function stripFrontmatter(text) {
    return String(text || '').replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, '');
}
function escapeHtml(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function inline(text) {
    return escapeHtml(text)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}
function renderMarkdown(text) {
    if (!text) return '';
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let paragraph = [];
    let list = [];
    let code = [];
    let inCode = false;
    const flushParagraph = () => {
        if (!paragraph.length) return;
        out.push('<p>' + inline(paragraph.join(' ')) + '</p>');
        paragraph = [];
    };
    const flushList = () => {
        if (!list.length) return;
        out.push('<ul>' + list.map(line => '<li>' + inline(line) + '</li>').join('') + '</ul>');
        list = [];
    };
    for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');
        if (/^```/.test(line.trim())) {
            if (inCode) {
                out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
                code = [];
                inCode = false;
            } else {
                flushParagraph(); flushList();
                inCode = true;
            }
            continue;
        }
        if (inCode) { code.push(raw); continue; }
        if (!line.trim()) { flushParagraph(); flushList(); continue; }
        const heading = /^(#{1,4})\s+(.*)$/.exec(line.trim());
        if (heading) {
            flushParagraph(); flushList();
            const level = Math.min(4, heading[1].length + 1);
            out.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>');
            continue;
        }
        const bullet = /^[-*+]\s+(.*)$/.exec(line.trim());
        if (bullet) { flushParagraph(); list.push(bullet[1]); continue; }
        const ordered = /^\d+[.)]\s+(.*)$/.exec(line.trim());
        if (ordered) { flushParagraph(); list.push(ordered[1]); continue; }
        flushList();
        paragraph.push(line.trim());
    }
    if (inCode && code.length) out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
    flushParagraph(); flushList();
    return out.join('');
}
</script>

<template>
    <div class="store-extras">
        <section v-if="showcases.length" class="extra-sec">
            <h2 class="section-title">作品展示</h2>
            <div v-for="(block, blockIndex) in showcases" :key="blockIndex" class="showcase-block" :class="'is-' + (block.layout || 'even')">
                <figure v-if="block.hero" class="showcase-hero">
                    <div class="showcase-media showcase-hero-media">
                        <StoreCover :src="block.hero.media && block.hero.media.src" :poster="block.hero.media && block.hero.media.poster"
                                    :type="block.hero.media && block.hero.media.kind" :alt="block.hero.alt" :label="block.caption || block.hero.alt"
                                    :autoplay="!!(block.hero.media && block.hero.media.kind === 'video')" :object-position="block.hero.media && block.hero.media.objectPosition" />
                    </div>
                    <figcaption v-if="block.eyebrow || block.caption" class="showcase-caption">
                        <span v-if="block.eyebrow" class="showcase-eyebrow">{{ block.eyebrow }}</span>
                        <p v-if="block.caption" class="showcase-title">{{ block.caption }}</p>
                    </figcaption>
                </figure>
                <div v-if="(block.panels || []).length" class="showcase-panels" :style="panelStyle(block)">
                    <figure v-for="(panel, panelIndex) in block.panels" :key="panelIndex" class="showcase-panel">
                        <div class="showcase-media">
                            <StoreCover :src="panel.media && panel.media.src" :poster="panel.media && panel.media.poster"
                                        :type="panel.media && panel.media.kind" :alt="panel.alt" :label="panel.alt || block.caption"
                                        :object-position="panel.media && panel.media.objectPosition" />
                        </div>
                        <figcaption v-if="panel.alt" class="panel-alt">{{ panel.alt }}</figcaption>
                    </figure>
                </div>
            </div>
        </section>

        <section v-if="presentation" class="extra-sec">
            <h2 class="section-title">创作团队</h2>
            <div class="creator-work">
                <p v-if="presentation.series.workTitle" class="work-title">{{ presentation.series.workTitle }}</p>
                <template v-if="presentation.series.collection && presentation.series.collection.name">
                    <button type="button" class="series-link" @click="openSeries">{{ presentation.series.title || presentation.series.collection.name }}</button>
                </template>
                <p v-else-if="presentation.series.title" class="series-title">{{ presentation.series.title }}</p>
            </div>
            <div v-if="presentation.series.creators.length" class="creator-list">
                <div v-for="person in presentation.series.creators" :key="person.name" class="creator">
                    <span class="creator-avatar">
                        <img v-if="person.avatar" :src="person.avatar" :alt="person.name" loading="lazy" />
                        <span v-else>{{ creatorInitial(person.name) }}</span>
                    </span>
                    <span class="creator-name">{{ person.name }}</span>
                </div>
            </div>
        </section>

        <section v-if="library && (families.length || templates.length)" class="extra-sec">
            <h2 class="section-title">模板</h2>
            <div v-if="families.length" class="family-chips" role="tablist" aria-label="模板分类">
                <button type="button" class="family-chip" :class="{ 'is-on': !activeFamily }" @click="activeFamily = ''">全部</button>
                <button v-for="family in families" :key="family.id" type="button" class="family-chip"
                        :class="{ 'is-on': activeFamily === family.id }" @click="activeFamily = activeFamily === family.id ? '' : family.id">{{ family.label }}</button>
            </div>
            <div v-if="templates.length" class="template-grid">
                <button v-for="template in templates" :key="template.id" type="button" class="template-card"
                        :disabled="!!launching" @click="launchTemplate(template)">
                    <span class="template-cover">
                        <StoreCover :src="template.cover && template.cover.src" :type="template.cover && template.cover.kind"
                                    :alt="template.name" :label="template.name" />
                        <em v-if="launching === template.id" class="template-busy">启动中…</em>
                    </span>
                    <span class="template-text">
                        <b>{{ template.name }}</b>
                        <span v-if="template.description">{{ template.description }}</span>
                        <em v-if="familyLabel(template.family)">{{ familyLabel(template.family) }}</em>
                    </span>
                </button>
            </div>
            <p v-else class="extra-empty">该分类暂无模板</p>
            <p v-if="launchError" class="extra-error">{{ launchError }}</p>
        </section>

        <section v-if="publicContent" class="extra-sec public-sec">
            <button type="button" class="public-toggle" :aria-expanded="publicOpen" @click="publicOpen = !publicOpen">
                <h2 class="section-title">技能说明</h2>
                <NvIcon name="chev" class="public-caret" :class="{ 'is-open': publicOpen }" />
            </button>
            <div v-if="publicOpen" class="markdown-body" v-html="publicHtml"></div>
        </section>
    </div>
</template>

<style scoped>
.store-extras { display: flex; flex-direction: column; gap: var(--space-8); max-width: 900px; margin-top: var(--space-8); }
.extra-sec { display: flex; flex-direction: column; gap: var(--space-5); }
.section-title { margin: 0; color: var(--ink); font: 500 14px/20px var(--font-sans); }
.showcase-block { display: flex; flex-direction: column; gap: var(--space-5); }
.showcase-hero { margin: 0; display: flex; flex-direction: column; gap: var(--space-4); }
.showcase-media { position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: var(--radius-xl); overflow: hidden; background: var(--fill-2); }
.showcase-hero-media { aspect-ratio: 16 / 8.4; max-height: 460px; }
.showcase-hero-media :deep(.store-cover) { height: 100%; }
.showcase-caption { display: flex; flex-direction: column; gap: 4px; }
.showcase-eyebrow { color: var(--ink-4); font: 500 10.5px/15px var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }
.showcase-title { margin: 0; color: var(--ink); font: 500 clamp(16px, 1.8vw, 22px)/1.35 var(--font-sans); letter-spacing: -0.01em; }
.showcase-panels { display: grid; gap: var(--space-5); }
.showcase-panel { margin: 0; display: flex; flex-direction: column; gap: var(--space-3); }
.showcase-panel .showcase-media { aspect-ratio: 4 / 3; border-radius: var(--radius-lg); }
.panel-alt { color: var(--ink-3); font: 400 11px/16px var(--font-sans); }
.creator-work { display: flex; flex-direction: column; gap: 2px; }
.work-title { margin: 0; color: var(--ink); font: 500 clamp(20px, 2.2vw, 28px)/1.2 var(--font-sans); letter-spacing: -0.02em; }
.series-link { align-self: flex-start; border: 0; padding: 0; background: transparent; color: var(--ink-3); font: 400 12px/18px var(--font-sans); cursor: pointer; text-align: left; }
.series-link:hover { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
.series-title { margin: 0; color: var(--ink-3); font: 400 12px/18px var(--font-sans); }
.creator-list { display: flex; flex-wrap: wrap; gap: var(--space-5) var(--space-6); }
.creator { display: inline-flex; align-items: center; gap: var(--space-4); min-width: 0; }
.creator-avatar { width: 34px; height: 34px; flex: 0 0 34px; border-radius: 50%; overflow: hidden; background: var(--fill-2); color: var(--ink-2); display: inline-flex; align-items: center; justify-content: center; font: 500 12px/1 var(--font-sans); }
.creator-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.creator-name { color: var(--ink-2); font: 400 12.5px/18px var(--font-sans); }
.family-chips { display: flex; flex-wrap: wrap; gap: var(--space-3); }
.family-chip { border: 0; height: var(--control-sm); padding: 0 12px; border-radius: var(--radius-pill); background: var(--fill-1); color: var(--ink-3); font: 500 11.5px/1 var(--font-sans); cursor: pointer; transition: background var(--duration-base) var(--ease-out), color var(--duration-base) var(--ease-out); }
.family-chip:hover { background: var(--fill-2); color: var(--ink); }
.family-chip.is-on { background: var(--accent); color: var(--on-accent); }
.template-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: var(--space-5); }
.template-card { border: 0; padding: 0; background: transparent; color: var(--ink); text-align: left; font: inherit; cursor: pointer; display: flex; flex-direction: column; gap: var(--space-3); transition: transform var(--duration-base) var(--ease-out); }
.template-card:hover:not(:disabled) { transform: translateY(-2px); }
.template-card:disabled { cursor: default; }
.template-cover { position: relative; width: 100%; aspect-ratio: 4 / 3; border-radius: var(--radius-lg); overflow: hidden; background: var(--fill-2); }
.template-cover :deep(.store-cover) { height: 100%; }
.template-busy { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--solid) 74%, transparent); color: var(--ink); font: 500 11.5px/1 var(--font-sans); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); }
.template-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.template-text b { color: var(--ink); font: 500 12.5px/18px var(--font-sans); }
.template-text span { color: var(--ink-3); font: 400 11px/16px var(--font-sans); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.template-text em { color: var(--ink-4); font: 400 10px/14px var(--font-sans); font-style: normal; }
.extra-empty { margin: 0; color: var(--ink-4); font: 400 12px/18px var(--font-sans); }
.extra-error { margin: 0; color: var(--danger); font: 400 12px/18px var(--font-sans); }
.public-toggle { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); width: 100%; border: 0; padding: 0; background: transparent; color: var(--ink); cursor: pointer; text-align: left; }
.public-caret { width: 14px; height: 14px; color: var(--ink-3); flex: 0 0 auto; transition: transform var(--duration-base) var(--ease-out); }
.public-caret.is-open { transform: rotate(180deg); }
.markdown-body { max-height: 340px; overflow: auto; padding: var(--space-6); border-radius: var(--radius-lg); background: var(--fill-1); color: var(--ink-2); font: 400 12.5px/20px var(--font-sans); }
.markdown-body :deep(h2), .markdown-body :deep(h3), .markdown-body :deep(h4) { margin: 0 0 var(--space-3); color: var(--ink); font: 500 13px/20px var(--font-sans); }
.markdown-body :deep(h2):not(:first-child), .markdown-body :deep(h3):not(:first-child), .markdown-body :deep(h4):not(:first-child) { margin-top: var(--space-6); }
.markdown-body :deep(p) { margin: 0 0 var(--space-3); }
.markdown-body :deep(ul) { margin: 0 0 var(--space-3); padding-left: var(--space-6); display: flex; flex-direction: column; gap: 2px; }
.markdown-body :deep(strong) { color: var(--ink); font-weight: 600; }
.markdown-body :deep(code) { padding: 1px 5px; border-radius: var(--radius-xs); background: var(--fill-2); color: var(--ink); font: 400 11.5px/18px var(--font-mono); }
.markdown-body :deep(pre) { margin: 0 0 var(--space-4); padding: var(--space-4) var(--space-5); border-radius: var(--radius-md); background: var(--fill-2); overflow-x: auto; }
.markdown-body :deep(pre code) { padding: 0; background: transparent; font: 400 11px/18px var(--font-mono); }
@media (max-width: 760px) {
    .showcase-panels { grid-template-columns: minmax(0, 1fr) !important; }
    .template-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
