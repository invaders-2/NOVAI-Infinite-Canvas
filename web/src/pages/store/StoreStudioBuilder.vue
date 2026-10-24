<script setup>
// Forge Builder：选角色 → 改第一条视频拍什么 → 开始制作（launch + 自动发送）。
import { computed, nextTick, onMounted, ref } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import { buildLaunchBody, launchStoreItem, openStoreCanvas, uploadReferences } from './storeData.js';

const props = defineProps({
    detail: { type: Object, required: true },
});
const emit = defineEmits(['close']);

const studio = computed(() => props.detail.influencerStudio || {});
const personas = computed(() => studio.value.personas || []);
const traits = computed(() => studio.value.traits || []);
const formats = computed(() => studio.value.formats || []);
const fields = computed(() => studio.value.fields || []);
const references = computed(() => studio.value.references || { min: 0, max: 2, roles: [] });
const note = computed(() => studio.value.note || { maxLength: 500 });

const tab = ref('quick');
const personaIndex = ref(0);
const topic = ref('');
const nameValue = ref('');
const formatId = ref('');
const selected = ref({});
const refFiles = ref([]);
const uploading = ref(false);
const submitting = ref(false);
const error = ref('');
const uploadHint = ref(false);
const fileInput = ref(null);
const context = ref(readContext());

function readContext() {
    try {
        const raw = sessionStorage.getItem('novai_forge_context');
        sessionStorage.removeItem('novai_forge_context');
        return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
}

const persona = computed(() => personas.value[personaIndex.value] || null);
const format = computed(() => formats.value.find(item => item.id === formatId.value) || formats.value[0] || null);
const postField = computed(() => fields.value.find(field => field.section === 'post') || null);
const traitLabels = computed(() => {
    const table = {};
    traits.value.forEach(trait => {
        (trait.options || []).forEach(option => { table[trait.id + ':' + option.id] = option.label; });
    });
    return table;
});
const badge = computed(() => {
    if (!persona.value) return '';
    const exaggerated = (persona.value.traits && persona.value.traits.exaggerate) || [];
    for (const id of exaggerated) {
        if (traitLabels.value['exaggerate:' + id]) return traitLabels.value['exaggerate:' + id];
    }
    const all = selectedSummaryParts();
    return all.length ? all[0] : '';
});
const traitSummary = computed(() => {
    const parts = selectedSummaryParts();
    return parts.length ? parts.join('、') : badge.value;
});
const refCount = computed(() => refFiles.value.filter(file => file.url).length);

function selectedSummaryParts() {
    const parts = [];
    const value = selected.value || {};
    for (const trait of traits.value) {
        const ids = value[trait.id] || [];
        const labels = ids.map(id => traitLabels.value[trait.id + ':' + id]).filter(Boolean);
        if (labels.length) parts.push(labels.join(' / '));
    }
    return parts;
}
function initTraits(target) {
    const next = {};
    traits.value.forEach(trait => {
        const fromPersona = target && target.traits && target.traits[trait.id];
        const ids = (fromPersona && fromPersona.length ? fromPersona : trait.defaults) || [];
        next[trait.id] = ids.filter(id => trait.options.some(option => option.id === id));
    });
    selected.value = next;
}
function traitSelected(trait, optionId) {
    return (selected.value[trait.id] || []).indexOf(optionId) >= 0;
}
function toggleTrait(trait, optionId) {
    const current = (selected.value[trait.id] || []).slice();
    if (trait.select === 'single') {
        selected.value = { ...selected.value, [trait.id]: [optionId] };
        return;
    }
    const index = current.indexOf(optionId);
    if (index >= 0) current.splice(index, 1);
    else {
        if (trait.max > 0 && current.length >= trait.max) current.shift();
        current.push(optionId);
    }
    selected.value = { ...selected.value, [trait.id]: current };
}

function buildTopic(targetPersona = persona.value, targetFormat = format.value) {
    const name = (targetPersona && targetPersona.name) || '我';
    const feature = badge.value || '标志特征';
    const base = targetFormat && (targetFormat.idea || targetFormat.hook) ? (targetFormat.idea || targetFormat.hook) : '';
    if (!base) return '用「' + ((targetFormat && targetFormat.title) || '视频') + '」模板，帮我做这个角色的第一条视频。';
    return base.replace(/\{\{name\}\}/g, name).replace(/\{\{feature\}\}/g, feature);
}
function applyPersona(index) {
    personaIndex.value = (index + personas.value.length) % personas.value.length;
    initTraits(persona.value);
    formatId.value = (persona.value && persona.value.format) || (format.value && format.value.id) || '';
    nameValue.value = (persona.value && persona.value.name) || '';
    topic.value = buildTopic();
}
function nextPersona() { applyPersona(personaIndex.value + 1); }
function randomTraits() {
    const next = {};
    traits.value.forEach(trait => {
        const pool = trait.options || [];
        if (!pool.length) { next[trait.id] = []; return; }
        if (trait.select === 'single') {
            next[trait.id] = [pool[Math.floor(Math.random() * pool.length)].id];
        } else {
            const max = Math.max(1, Math.min(trait.max || 2, pool.length));
            const shuffled = pool.slice().sort(() => Math.random() - 0.5);
            next[trait.id] = shuffled.slice(0, 1 + Math.floor(Math.random() * max)).map(option => option.id);
        }
    });
    selected.value = next;
}
function randomTopic() {
    if (!formats.value.length) return;
    const pool = formats.value.filter(item => item.id !== (format.value && format.value.id));
    const picked = pool.length && Math.random() > 0.35 ? pool[Math.floor(Math.random() * pool.length)] : format.value;
    if (!picked) return;
    formatId.value = picked.id;
    topic.value = buildTopic(persona.value, picked);
}
function openCustom() {
    tab.value = 'custom';
}
function pickPhoto() {
    if (fileInput.value) fileInput.value.click();
}
function pickFiles(event) {
    const files = Array.from((event.target && event.target.files) || []);
    event.target.value = '';
    addFiles(files);
}
function addFiles(files) {
    error.value = '';
    const max = references.value.max || 0;
    for (const file of files) {
        if (max > 0 && refFiles.value.length >= max) { error.value = '最多只能添加 ' + max + ' 张照片'; break; }
        if (!/^image\/(jpeg|png|webp|gif)$/i.test(file.type)) { error.value = '只支持 JPEG / PNG / WebP / GIF'; continue; }
        if (file.size > 20 * 1024 * 1024) { error.value = '单张照片不能超过 20MB'; continue; }
        const entry = { name: file.name, preview: '', url: '', uploading: true };
        refFiles.value.push(entry);
        const reader = new FileReader();
        reader.onload = event => { entry.preview = String((event.target && event.target.result) || ''); };
        reader.readAsDataURL(file);
        uploadReferences([file]).then(list => {
            const uploaded = list[0];
            if (!uploaded || !uploaded.url) throw new Error('upload failed');
            entry.url = uploaded.url;
            entry.uploading = false;
        }).catch(() => {
            entry.uploading = false;
            refFiles.value = refFiles.value.filter(item => item !== entry);
            error.value = (file.name || '照片') + ' 上传失败，请重试';
        }).finally(() => { uploading.value = refFiles.value.some(item => item.uploading); });
    }
}
function removeRef(index) {
    refFiles.value.splice(index, 1);
    uploading.value = refFiles.value.some(item => item.uploading);
}

function composeInputs() {
    const inputs = {};
    if (postField.value && topic.value.trim()) inputs[postField.value.id] = topic.value.trim();
    if (nameValue.value.trim()) inputs.name = nameValue.value.trim();
    if (persona.value) {
        inputs['主演'] = persona.value.name + (persona.value.handle ? '（@' + persona.value.handle + '）' : '');
        inputs['角色设定'] = [persona.value.bio, traitSummary.value].filter(Boolean).join('；');
    }
    if (format.value) inputs['参考格式'] = format.value.title + (format.value.hook ? '（' + format.value.hook + '）' : '');
    const supplement = [];
    if (persona.value) supplement.push('角色：' + persona.value.name + '（@' + persona.value.handle + '）');
    if (traitSummary.value) supplement.push('夸张设定：' + traitSummary.value);
    if (format.value) supplement.push('参考格式：' + format.value.title + (format.value.description ? '，' + format.value.description : ''));
    if (studio.value.clipPrompt) supplement.push('参考视频要求：' + studio.value.clipPrompt);
    if (supplement.length) inputs['补充说明'] = supplement.join('\n');
    return inputs;
}

async function start() {
    if (submitting.value || uploading.value) return;
    if (refFiles.value.some(file => file.uploading || !file.url) && refFiles.value.length) { error.value = '照片还没上传完，稍等一下'; return; }
    submitting.value = true;
    error.value = '';
    try {
        const body = buildLaunchBody({
            kind: 'skill',
            name: 'ai-influencer-builder',
            presetId: '',
            prompt: '',
            fields: composeInputs(),
            references: refFiles.value.filter(file => file.url).map(file => ({ name: file.name, url: file.url, kind: 'image' })),
        });
        const result = await launchStoreItem('skill', 'ai-influencer-builder', body);
        const opened = openStoreCanvas(result.canvasId, result.prompt, result.project, { autoSend: true, skillRef: result.skillRef });
        if (!opened) throw new Error('没有拿到画布 id');
    } catch (e) {
        error.value = (e && e.message) || '启动失败，请重试';
    } finally {
        submitting.value = false;
    }
}

onMounted(async () => {
    const wanted = personas.value.findIndex(item => item.id === (context.value && context.value.persona));
    applyPersona(wanted >= 0 ? wanted : 0);
    if (context.value && context.value.format) {
        formatId.value = context.value.format;
        topic.value = buildTopic();
    } else {
        topic.value = buildTopic();
    }
    if (context.value && (context.value.wantsUpload || context.value.highlightUpload)) {
        await nextTick();
        uploadHint.value = true;
        setTimeout(() => { uploadHint.value = false; }, 6000);
    }
});
</script>

<template>
    <div class="builder">
        <header class="builder-head">
            <h1 class="builder-title">{{ detail.displayName || 'Forge Builder' }}</h1>
            <p class="builder-sub">选一个角色 → 改你想改的 → 其余交给画布生成</p>
            <div class="builder-tabs" role="tablist" aria-label="编辑模式">
                <button type="button" class="builder-tab" :class="{ 'is-on': tab === 'quick' }" role="tab" :aria-selected="tab === 'quick'" @click="tab = 'quick'">
                    <NvIcon name="bolt" />快速开始
                </button>
                <button type="button" class="builder-tab" :class="{ 'is-on': tab === 'custom' }" role="tab" :aria-selected="tab === 'custom'" @click="tab = 'custom'">
                    <NvIcon name="settings" />自定义
                </button>
            </div>
        </header>

        <div v-if="tab === 'quick'" class="quick-row">
            <button type="button" class="quick-random" @click="randomTraits"><NvIcon name="dice" />随机换一个</button>
            <span class="quick-hint">其余细节交给画布生成，想全改就切「自定义」</span>
        </div>

        <section v-if="tab === 'custom'" class="trait-panel">
            <div v-for="trait in traits" :key="trait.id" class="trait-group">
                <div class="trait-label">
                    {{ trait.label }}
                    <span v-if="trait.select === 'multi' && trait.max">最多 {{ trait.max }} 个</span>
                </div>
                <div class="trait-options">
                    <button v-for="option in trait.options" :key="option.id" type="button" class="trait-chip"
                            :class="{ 'is-on': traitSelected(trait, option.id) }" @click="toggleTrait(trait, option.id)">
                        {{ option.label }}
                    </button>
                </div>
            </div>
        </section>

        <div class="builder-main">
            <section class="persona-card">
                <div class="persona-photo" :style="persona && persona.images.base ? { backgroundImage: 'url(' + persona.images.base + ')' } : null">
                    <img v-if="persona && (persona.images.caricature || persona.images.base)" :src="persona.images.caricature || persona.images.base" :alt="persona.name" loading="eager" decoding="async" />
                    <span v-if="badge" class="persona-badge">{{ badge }}</span>
                    <div v-if="persona && persona.images.base" class="persona-original">
                        <img :src="persona.images.base" alt="原图" />
                        <span>原图</span>
                    </div>
                </div>
                <div class="persona-info">
                    <div class="persona-name-row">
                        <b>{{ persona ? persona.name : '' }}</b>
                        <span v-if="persona && persona.handle">@{{ persona.handle }}</span>
                    </div>
                    <p class="persona-bio">{{ persona ? persona.bio : '' }}</p>
                    <button type="button" class="persona-swap" @click="nextPersona"><NvIcon name="refresh" />换一个</button>
                </div>
            </section>

            <section class="post-card">
                <div class="post-label">
                    <label :for="'forge-topic'">{{ postField ? postField.label : '第一条视频拍什么' }}</label>
                    <button type="button" class="post-random" @click="randomTopic"><NvIcon name="dice" />随机一个</button>
                </div>
                <textarea id="forge-topic" v-model="topic" class="post-input" :maxlength="postField && postField.maxLength ? postField.maxLength : 500"
                          :placeholder="postField ? postField.placeholder : '例如：把便利店甜品挨个锐评一遍'"></textarea>

                <div class="cast-row">
                    <div class="cast-info">
                        <span class="cast-label">主演</span>
                        <b>{{ persona ? persona.name : '' }}<template v-if="badge"> · {{ badge }}</template></b>
                    </div>
                    <button type="button" class="cast-upload" :class="{ 'is-highlight': uploadHint }" @click="pickPhoto"><NvIcon name="image" />用我的照片</button>
                    <input ref="fileInput" type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden @change="pickFiles" />
                </div>
                <p class="cast-warning">可选。仅限你有权使用的照片，不能是真实公众人物。<template v-if="references.max">（最多 {{ references.max }} 张）</template></p>
                <p v-if="uploadHint" class="upload-hint">先上传你的照片</p>
                <div v-if="refFiles.length" class="ref-row">
                    <div v-for="(file, index) in refFiles" :key="file.name + index" class="ref-thumb">
                        <img v-if="file.preview" :src="file.preview" :alt="file.name" />
                        <span v-if="file.uploading" class="ref-mask">上传中</span>
                        <button type="button" class="ref-x" aria-label="移除" @click.stop="removeRef(index)"><NvIcon name="close" /></button>
                    </div>
                </div>

                <button type="button" class="start-btn" :disabled="submitting || uploading" @click="start">
                    {{ submitting ? '正在创建画布…' : '开始制作' }}
                </button>
                <p class="start-note">由{{ persona ? persona.name : '你' }}出演，在新画布上生成。</p>
                <p v-if="error" class="start-error">{{ error }}</p>
                <button type="button" class="detail-link" @click="openCustom"><NvIcon name="settings" />自定义所有细节</button>
            </section>
        </div>
    </div>
</template>

<style scoped>
.builder { color: var(--ink); padding: var(--space-2) var(--space-2) var(--space-8); max-width: 1320px; margin: 0 auto; }
.builder-head { position: relative; padding: var(--space-3) var(--space-2) 0; }
.builder-title {
    margin: 0; width: fit-content;
    font: 500 clamp(28px, 3.4vw, 38px)/1.14 var(--font-sans); letter-spacing: -0.03em;
    background: linear-gradient(100deg, var(--ink) 0%, var(--ink-3) 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
}
.builder-sub { margin: var(--space-4) 0 0; color: var(--ink-3); font: 400 13px/20px var(--font-sans); }
.builder-tabs { position: absolute; right: var(--space-2); bottom: 0; display: flex; gap: var(--space-1); padding: 2px; border-radius: var(--radius-pill); background: var(--fill-1); }
.builder-tab { border: 0; height: var(--control-md); padding: 0 14px; border-radius: var(--radius-pill); background: transparent; color: var(--ink-3); display: inline-flex; align-items: center; gap: var(--space-2); font: 500 12px/1 var(--font-sans); cursor: pointer; transition: background var(--duration-base) var(--ease-out), color var(--duration-base) var(--ease-out); }
.builder-tab:hover { color: var(--ink-2); }
.builder-tab .nv-i { width: 13px; height: 13px; }
.builder-tab.is-on { background: var(--accent); color: var(--on-accent); }
.quick-row { display: flex; align-items: center; gap: var(--space-5); margin-top: var(--space-6); padding: 0 var(--space-1); }
.quick-random { border: 0; height: var(--control-md); padding: 0 12px; border-radius: var(--radius-pill); background: var(--fill-1); color: var(--ink-2); display: inline-flex; align-items: center; gap: var(--space-2); font: 500 11.5px/1 var(--font-sans); cursor: pointer; transition: background var(--duration-base) var(--ease-out), color var(--duration-base) var(--ease-out); }
.quick-random:hover { background: var(--fill-2); color: var(--ink); }
.quick-random .nv-i { width: 13px; height: 13px; }
.quick-hint { color: var(--ink-4); font: 400 11px/16px var(--font-sans); }
.trait-panel { margin-top: var(--space-6); padding: var(--space-6); border-radius: var(--radius-xl); background: var(--canvas); display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--space-6) var(--space-7); max-height: 300px; overflow: auto; animation: card-in 320ms var(--ease-out) both; }
.trait-group { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }
.trait-label { display: flex; align-items: baseline; justify-content: space-between; color: var(--ink-2); font: 500 12px/16px var(--font-sans); }
.trait-label span { color: var(--ink-4); font: 400 10px/14px var(--font-sans); }
.trait-options { display: flex; flex-wrap: wrap; gap: var(--space-3); }
.trait-chip { border: 0; height: 26px; padding: 0 10px; border-radius: var(--radius-pill); background: var(--fill-1); color: var(--ink-2); font: 400 11px/1 var(--font-sans); cursor: pointer; transition: background var(--duration-base) var(--ease-out), color var(--duration-base) var(--ease-out); }
.trait-chip:hover { background: var(--fill-2); color: var(--ink); }
.trait-chip.is-on { background: var(--accent); color: var(--on-accent); }
.builder-main { display: grid; grid-template-columns: minmax(280px, 390px) minmax(0, 1fr); gap: var(--space-7); margin-top: var(--space-7); align-items: start; }
.persona-card { display: flex; flex-direction: column; gap: var(--space-5); animation: card-in 480ms var(--ease-out) both; }
.persona-photo { position: relative; width: 100%; aspect-ratio: 4 / 5; border-radius: var(--radius-xl); overflow: hidden; background-color: var(--fill-2); background-size: cover; background-position: center; }
.persona-photo > img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: 8% center; display: block; }
.persona-badge { position: absolute; left: var(--space-5); top: var(--space-5); padding: 5px 10px; border-radius: var(--radius-pill); background: var(--accent); color: var(--on-accent); font: 500 11px/1 var(--font-sans); box-shadow: var(--shadow-float); }
.persona-original { position: absolute; right: var(--space-4); bottom: var(--space-4); width: 104px; border-radius: var(--radius-lg); overflow: hidden; background: var(--solid); box-shadow: var(--shadow-pop); }
.persona-original img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; }
.persona-original span { display: block; padding: var(--space-2) var(--space-3); color: var(--ink-3); text-align: center; font: 400 9.5px/1 var(--font-sans); }
.persona-info { display: flex; flex-direction: column; gap: var(--space-3); padding: 0 var(--space-1); }
.persona-name-row { display: flex; align-items: baseline; gap: var(--space-4); }
.persona-name-row b { color: var(--ink); font: 500 16px/22px var(--font-sans); }
.persona-name-row span { color: var(--ink-3); font: 400 11.5px/16px var(--font-sans); }
.persona-bio { margin: 0; color: var(--ink-3); font: 400 12px/18px var(--font-sans); }
.persona-swap { align-self: flex-end; border: 0; height: var(--control-md); padding: 0 13px; border-radius: var(--radius-pill); background: var(--fill-1); color: var(--ink-2); display: inline-flex; align-items: center; gap: var(--space-2); font: 500 11.5px/1 var(--font-sans); cursor: pointer; transition: background var(--duration-base) var(--ease-out), color var(--duration-base) var(--ease-out); }
.persona-swap:hover { background: var(--fill-2); color: var(--ink); }
.persona-swap .nv-i { width: 13px; height: 13px; }
.post-card { padding: var(--space-7); border-radius: var(--radius-xl); background: var(--glass); backdrop-filter: var(--material-regular); -webkit-backdrop-filter: var(--material-regular); box-shadow: var(--shadow-float); display: flex; flex-direction: column; gap: var(--space-5); animation: card-in 480ms var(--ease-out) 60ms both; }
.post-label { display: flex; align-items: center; justify-content: space-between; color: var(--ink-2); font: 500 12px/17px var(--font-sans); }
.post-random { border: 0; background: transparent; color: var(--ink-3); display: inline-flex; align-items: center; gap: var(--space-2); font: 400 11px/1 var(--font-sans); cursor: pointer; }
.post-random:hover { color: var(--ink); }
.post-random .nv-i { width: 12px; height: 12px; }
.post-input { width: 100%; box-sizing: border-box; min-height: 150px; padding: var(--space-6); border: 0; border-radius: var(--radius-lg); background: var(--fill-1); color: var(--ink); font: 400 13px/22px var(--font-sans); outline: none; resize: vertical; transition: background var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out); }
.post-input:focus { background: var(--fill-2); box-shadow: inset 0 1px 2px color-mix(in srgb, var(--ink) 8%, transparent); }
.post-input::placeholder { color: var(--ink-4); }
.cast-row { display: flex; align-items: center; gap: var(--space-5); padding-top: var(--space-2); }
.cast-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--space-1); }
.cast-label { color: var(--ink-3); font: 400 10.5px/14px var(--font-sans); }
.cast-info b { color: var(--ink); font: 500 12.5px/18px var(--font-sans); }
.cast-upload { border: 0; height: var(--control-md); padding: 0 13px; border-radius: var(--radius-md); background: var(--fill-1); color: var(--ink-2); display: inline-flex; align-items: center; gap: var(--space-2); font: 500 11.5px/1 var(--font-sans); cursor: pointer; transition: background var(--duration-base) var(--ease-out), color var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out); }
.cast-upload:hover { background: var(--fill-2); color: var(--ink); }
.cast-upload .nv-i { width: 13px; height: 13px; }
.cast-upload.is-highlight { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--ink); animation: cast-pulse 1.6s var(--ease-out) 2; }
@keyframes cast-pulse { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 28%, transparent); } 50% { box-shadow: 0 0 0 8px transparent; } }
.cast-warning { margin: calc(var(--space-2) * -1) 0 0; color: var(--ink-4); font: 400 10.5px/16px var(--font-sans); }
.upload-hint { margin: calc(var(--space-1) * -1) 0 0; color: var(--ink-2); font: 500 10.5px/15px var(--font-sans); }
.ref-row { display: flex; gap: var(--space-3); flex-wrap: wrap; }
.ref-thumb { position: relative; width: 58px; height: 58px; border-radius: var(--radius-md); overflow: hidden; background: var(--fill-2); }
.ref-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ref-mask { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--ink) 55%, transparent); color: var(--on-accent); font: 500 9px/1 var(--font-sans); }
.ref-x { position: absolute; right: 2px; top: 2px; width: 16px; height: 16px; border: 0; border-radius: 50%; background: color-mix(in srgb, var(--ink) 55%, transparent); color: var(--on-accent); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.ref-x .nv-i { width: 9px; height: 9px; }
.start-btn { border: 0; height: var(--control-lg); border-radius: var(--radius-pill); background: var(--accent); color: var(--on-accent); font: 500 13.5px/1 var(--font-sans); cursor: pointer; transition: transform var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out), opacity var(--duration-base) var(--ease-out); }
.start-btn:hover { transform: translateY(-1px); box-shadow: var(--shadow-lift); }
.start-btn:disabled { opacity: .55; cursor: default; transform: none; box-shadow: none; }
.start-note { margin: calc(var(--space-2) * -1) 0 0; text-align: center; color: var(--ink-4); font: 400 10.5px/15px var(--font-sans); }
.start-error { margin: 0; text-align: center; color: var(--danger); font: 400 11px/16px var(--font-sans); }
.detail-link { align-self: flex-end; border: 0; background: transparent; color: var(--ink-3); display: inline-flex; align-items: center; gap: var(--space-2); font: 400 11px/1 var(--font-sans); cursor: pointer; padding: var(--space-2) 0; }
.detail-link:hover { color: var(--ink); }
.detail-link .nv-i { width: 12px; height: 12px; }
@keyframes card-in { from { opacity: 0; transform: translateY(8px); filter: blur(3px); } }
@media (max-width: 900px) {
    .builder-tabs { position: static; margin-top: var(--space-5); width: fit-content; }
    .builder-main { grid-template-columns: 1fr; }
    .persona-photo { aspect-ratio: 16 / 10; }
}
</style>
