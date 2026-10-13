<script setup>
// 模型列表：拉取模型 / 选择模型、拉取结果提示、分类页签（带滑块）+ 搜索、生图 / 聊天 / 视频三组，ModelScope 附 LoRA 管理
import { computed, inject, ref, watch, nextTick, onMounted } from 'vue';
import AIcon from './AIcon.vue';
import ModelBlock from './ModelBlock.vue';
import LoraBlock from './LoraBlock.vue';
import { t } from '../../../../lib/store.js';
import { MODEL_KINDS } from '../core/constants.js';
import { useGlide } from '../../../../lib/glide.js';

const store = inject('apiStore');
const S = store.S;
const it = store.item;
const fl = store.flags;
const tabsEl = ref(null);
const glide = useGlide(tabsEl, 'button');

const counts = computed(() => {
    const p = it.value || {};
    const c = { image: (p.image_models || []).length, chat: (p.chat_models || []).length, video: (p.video_models || []).length };
    c.all = c.image + c.chat + c.video;
    return c;
});
const TABS = [{ k: 'all', label: '全部' }, { k: 'image', label: '图像' }, { k: 'chat', label: '对话' }, { k: 'video', label: '视频' }];
const blocks = computed(() => MODEL_KINDS.filter(b => S.modelGroup === 'all' || S.modelGroup === b.kind));
function pickTab(k) { S.modelGroup = k; }
watch(() => [S.modelGroup, counts.value.all], () => nextTick(glide.refresh));
onMounted(() => nextTick(glide.refresh));
</script>

<template>
    <section class="models">
        <div class="tb">
            <div class="tt">
                <b>{{ t('api.modelsTitle', '模型列表') }}</b>
                <span>{{ t('api.modelsDesc', '从上游 API 自动拉取所有可用模型并按类型分类（image / chat / video）') }}</span>
            </div>
            <div class="ta">
                <button type="button" class="nv-btn sm primary" :disabled="fl.isLovart || S.fetching" :title="fl.isLovart ? 'Lovart 使用内置工具清单，不支持拉取模型' : ''" @click="store.fetchModels()">
                    <span v-if="S.fetching" class="spin xs"></span><AIcon v-else name="cloudown" />{{ S.fetching ? t('api.fetchingModels', '拉取中...') : t('api.fetchModels', '拉取模型') }}
                </button>
                <button type="button" class="nv-btn sm" :disabled="!S.pickerReady" @click="store.openPicker()"><AIcon name="listcheck" />{{ t('api.selectModels', '选择模型') }}</button>
            </div>
        </div>
        <Transition name="hint">
            <div v-if="S.fetchHint" class="hint" :class="S.fetchHint.kind"><AIcon :name="S.fetchHint.kind === 'error' ? 'alert' : 'check'" /><span>{{ S.fetchHint.text }}</span></div>
        </Transition>
        <div class="fr">
            <div ref="tabsEl" class="cats nv-seg" role="tablist" aria-label="模型分类" data-glide>
                <span class="thumb-slide" data-glide-pill></span>
                <button v-for="x in TABS" :key="x.k" type="button" role="tab" :class="{ 'is-on': S.modelGroup === x.k }" :aria-selected="S.modelGroup === x.k" @click="pickTab(x.k)">{{ x.label }}<em>{{ counts[x.k] }}</em></button>
            </div>
            <label class="search" :class="{ q: S.modelSearch.trim() }" title="按模型 ID 或显示名筛选">
                <AIcon name="search" /><input v-model="S.modelSearch" type="search" placeholder="搜索模型" autocomplete="off" spellcheck="false">
            </label>
        </div>
        <div class="grid" :class="{ single: S.modelGroup !== 'all' }">
            <ModelBlock v-for="b in blocks" :key="b.kind" :kind="b.kind" :title="t(b.titleKey, b.title)" :hint="t(b.hintKey, b.hint)" />
        </div>
        <LoraBlock v-if="fl.isMs" />
    </section>
</template>

<style scoped>
.models { display: flex; flex-direction: column; gap: 10px; }
.tb { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
.tt b { display: block; font: 500 13px/19px var(--font-sans); }
.tt span { display: block; font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); }
.ta { display: flex; gap: 6px; flex: none; }
.spin.xs { width: 12px; height: 12px; border-width: 1.2px; }
.hint { display: flex; align-items: flex-start; gap: 8px; padding: 8px 12px; border-radius: 10px; background: var(--fill-1); font: 400 12px/17px var(--font-sans); color: var(--ink-2); }
.hint .nv-i { width: 14px; height: 14px; margin-top: 1.5px; flex: none; }
.hint.error { background: var(--danger-fill); color: var(--danger); }
.hint-enter-active, .hint-leave-active { transition: opacity 180ms var(--ease-out), transform 180ms var(--ease-out); }
.hint-enter-from, .hint-leave-to { opacity: 0; transform: translateY(-4px); }
.fr { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.cats { border-radius: 10px; }
.cats .thumb-slide { border-radius: 8px; }
.cats button { height: 28px; padding: 0 12px; border-radius: 8px; gap: 0; font-weight: 400; font-size: 12px; }
.cats button em { font: normal 400 10.5px/1 var(--font-mono); color: var(--ink-4); margin-left: 6px; }
.cats button.is-on { font-weight: 500; }
.cats button.is-on em { color: var(--ink-3); }
.search { display: flex; align-items: center; gap: 8px; width: 220px; height: 32px; padding: 0 10px; border-radius: 9px; background: var(--fill-1); color: var(--ink-3); transition: background 160ms; }
.search.q, .search:focus-within { background: var(--fill-2); }
.search .nv-i { width: 14px; height: 14px; flex: none; }
.search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; font: 400 12.5px/1 var(--font-sans); color: var(--ink); }
.search input::placeholder { color: var(--ink-4); }
.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; align-items: start; }
.grid.single { grid-template-columns: minmax(0, 1fr); }
@media (max-width: 1000px) { .grid { grid-template-columns: minmax(0, 1fr); } }
</style>
