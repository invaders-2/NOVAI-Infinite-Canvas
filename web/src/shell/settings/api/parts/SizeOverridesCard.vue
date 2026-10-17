<script setup>
// 能力覆盖（provider.size_overrides）：给该平台的模型声明实际能出的比例 / 档位 / 尺寸上限。
// 字段与合并规则见 server/protocols/SIZE_OVERRIDES.md；留空 = 不覆盖（后端按未声明处理）。
// 比例 / 档位词表来自在线生图页的官方集合（core/sizeOverrides.js），这里只负责可视化编辑。
// 下拉只列生图模型：后端只展开 image_models，视频模型的覆盖不生效；已有的视频覆盖原样保留（可删）。
import { computed, inject } from 'vue';
import AIcon from './AIcon.vue';
import { t, toast } from '../../../../lib/store.js';
import {
    SIZE_RATIOS, SIZE_LEVELS, modelChoices, nextOverrideModel, matchesRatio, matchesLevel,
    toggleRatio, toggleLevel, extraRatios, extraLevels, parseLimit,
} from '../core/sizeOverrides.js';

const store = inject('apiStore');
const it = store.item;

const entries = computed(() => {
    const src = (it.value && it.value.size_overrides) || {};
    return Object.keys(src).map(model => {
        const entry = src[model] || {};
        return {
            model,
            ratios: Array.isArray(entry.ratios) ? entry.ratios : [],
            resolutions: Array.isArray(entry.resolutions) ? entry.resolutions : [],
            maxEdge: entry.maxEdge,
            maxPixels: entry.maxPixels,
        };
    });
});
const choices = computed(() => modelChoices(it.value));
const canAdd = computed(() => !!nextOverrideModel(it.value));

function entryOf(model) {
    const src = (it.value && it.value.size_overrides) || {};
    return src[model] || {};
}
function knownModel(model) {
    return choices.value.image.indexOf(model) >= 0;
}
function add() {
    const provider = it.value;
    if (!provider) return;
    const model = nextOverrideModel(provider);
    if (!model) { toast(t('api.sizeOverridesNeedModel', '先在模型列表里添加模型'), { danger: true, icon: 'alert' }); return; }
    if (!provider.size_overrides || typeof provider.size_overrides !== 'object') provider.size_overrides = {};
    provider.size_overrides[model] = {};
}
function remove(model) {
    const provider = it.value;
    if (!provider || !provider.size_overrides) return;
    delete provider.size_overrides[model];
}
// 换模型 = 换 size_overrides 的键；保持行位置，目标已有覆盖时拒绝并回弹下拉
function rename(oldModel, event) {
    const provider = it.value;
    const model = String(event.target.value || '');
    if (!provider || !model || model === oldModel) { event.target.value = oldModel; return; }
    const src = provider.size_overrides || {};
    if (Object.prototype.hasOwnProperty.call(src, model)) {
        event.target.value = oldModel;
        toast(t('api.sizeOverridesDuplicate', '这个模型已经有一条覆盖了'), { danger: true, icon: 'alert' });
        return;
    }
    const next = {};
    Object.keys(src).forEach(key => { if (key === oldModel) next[model] = src[key]; else next[key] = src[key]; });
    provider.size_overrides = next;
}
function pickRatio(model, option) {
    const entry = entryOf(model);
    entry.ratios = toggleRatio(entry.ratios, option);
}
function pickLevel(model, level) {
    const entry = entryOf(model);
    entry.resolutions = toggleLevel(entry.resolutions, level);
}
function dropValue(model, field, value) {
    const entry = entryOf(model);
    const list = Array.isArray(entry[field]) ? entry[field] : [];
    entry[field] = list.filter(item => item !== value);
}
function limitText(model, field) {
    const value = entryOf(model)[field];
    return value === undefined || value === null || value === '' ? '' : String(value);
}
function setLimit(model, field, raw) {
    const entry = entryOf(model);
    const number = parseLimit(raw);
    if (number > 0) entry[field] = number;
    else delete entry[field];
}
// 输入框回显规范化（去空格 / 去前导 0；清空或 0 就还原成占位符）
function tidyLimit(event) {
    const number = parseLimit(event.target.value);
    const next = number > 0 ? String(number) : '';
    if (event.target.value !== next) event.target.value = next;
}
</script>

<template>
    <section class="sover">
        <div class="tb">
            <div class="tt">
                <b>{{ t('api.sizeOverridesTitle', '能力覆盖') }}</b>
                <span>{{ t('api.sizeOverridesDesc', '声明该平台的模型实际只能出哪些比例、档位与尺寸上限；留空 = 不覆盖。') }}</span>
            </div>
            <div class="ta">
                <button type="button" class="nv-btn sm" :disabled="!canAdd" :title="canAdd ? '' : t('api.sizeOverridesNeedModel', '先在模型列表里添加模型')" @click="add">
                    <AIcon name="plus" />{{ t('api.sizeOverridesAdd', '添加模型') }}
                </button>
            </div>
        </div>

        <div v-if="entries.length" class="rows">
            <div v-for="row in entries" :key="row.model" class="row" :data-model="row.model">
                <div class="rh">
                    <span class="mk" aria-hidden="true"><AIcon name="ruler" /></span>
                    <label class="msel">
                        <select :value="row.model" :aria-label="t('api.sizeOverridesModel', '模型')" @change="rename(row.model, $event)">
                            <optgroup v-if="choices.image.length" :label="t('api.imageModels', '生图模型')">
                                <option v-for="model in choices.image" :key="'i-' + model" :value="model">{{ model }}</option>
                            </optgroup>
                            <option v-if="!knownModel(row.model)" :value="row.model">{{ row.model }}</option>
                        </select>
                        <AIcon name="chev" />
                    </label>
                    <button type="button" class="del" :title="t('api.delete', '删除')" :aria-label="t('api.delete', '删除')" @click="remove(row.model)"><AIcon name="trash" /></button>
                </div>

                <div class="grp">
                    <span class="gl" :title="t('api.sizeOverridesRatioHint', '不勾选 = 不按比例收窄')">{{ t('api.sizeOverridesRatios', '允许比例') }}</span>
                    <div class="chips">
                        <button v-for="option in SIZE_RATIOS" :key="option.key" type="button" class="chip" :class="{ on: row.ratios.some(value => matchesRatio(value, option)) }" :data-ratio="option.label" :title="option.label" @click="pickRatio(row.model, option)">{{ option.label }}</button>
                        <button v-for="value in extraRatios(row.ratios)" :key="'x-' + value" type="button" class="chip on alien" :title="t('api.sizeOverridesCustomValue', '写在 size_overrides 里的自定义值')" @click="dropValue(row.model, 'ratios', value)">{{ value }}</button>
                    </div>
                </div>

                <div class="grp">
                    <span class="gl" :title="t('api.sizeOverridesLevelHint', '不勾选 = 不按档位收窄')">{{ t('api.sizeOverridesLevels', '允许档位') }}</span>
                    <div class="chips">
                        <button v-for="level in SIZE_LEVELS" :key="level" type="button" class="chip" :class="{ on: row.resolutions.some(value => matchesLevel(value, level)) }" :data-level="level" :title="level" @click="pickLevel(row.model, level)">{{ level.toUpperCase() }}</button>
                        <button v-for="value in extraLevels(row.resolutions)" :key="'x-' + value" type="button" class="chip on alien" :title="t('api.sizeOverridesCustomValue', '写在 size_overrides 里的自定义值')" @click="dropValue(row.model, 'resolutions', value)">{{ value }}</button>
                    </div>
                </div>

                <div class="grp">
                    <span class="gl">{{ t('api.sizeOverridesLimits', '尺寸上限') }}</span>
                    <div class="nums">
                        <label class="numf" :title="t('api.sizeOverridesEmptyLimit', '留空 = 不限制')">
                            <span>{{ t('api.sizeOverridesMaxEdge', '最长边') }}</span>
                            <input class="num" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" :value="limitText(row.model, 'maxEdge')" :placeholder="t('api.sizeOverridesNoLimit', '不限')" :aria-label="t('api.sizeOverridesMaxEdge', '最长边')" @input="setLimit(row.model, 'maxEdge', $event.target.value)" @change="tidyLimit($event)">
                            <i>{{ t('api.sizeOverridesPixels', '像素') }}</i>
                        </label>
                        <label class="numf" :title="t('api.sizeOverridesEmptyLimit', '留空 = 不限制')">
                            <span>{{ t('api.sizeOverridesMaxPixels', '面积') }}</span>
                            <input class="num" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" :value="limitText(row.model, 'maxPixels')" :placeholder="t('api.sizeOverridesNoLimit', '不限')" :aria-label="t('api.sizeOverridesMaxPixels', '面积')" @input="setLimit(row.model, 'maxPixels', $event.target.value)" @change="tidyLimit($event)">
                            <i>{{ t('api.sizeOverridesPixels', '像素') }}</i>
                        </label>
                    </div>
                </div>
            </div>
        </div>
        <div v-else class="empty">{{ t('api.sizeOverridesEmpty', '还没有覆盖项。点「添加模型」后勾选该模型实际支持的比例 / 档位，尺寸上限可留空。') }}</div>

        <p v-if="entries.length" class="foot">{{ t('api.sizeOverridesFoot', '不勾选的比例 / 档位不参与收窄，数字留空表示不限制；保存后立即生效。') }}</p>
    </section>
</template>

<style scoped>
.sover { display: flex; flex-direction: column; gap: 10px; }
.tb { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
.tt b { display: block; font: 500 13px/19px var(--font-sans); }
.tt span { display: block; font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); }
.ta { display: flex; gap: 6px; flex: none; }
.rows { display: flex; flex-direction: column; gap: 10px; }
.row { display: flex; flex-direction: column; gap: 12px; padding: 12px 14px; border-radius: 14px; background: var(--fill-1); min-width: 0; }
.rh { display: flex; align-items: center; gap: 8px; min-width: 0; }
.mk { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 7px; background: var(--fill-2); color: var(--ink-3); flex: none; }
.mk .nv-i { width: 13px; height: 13px; }
.msel { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; }
.msel select { appearance: none; -webkit-appearance: none; width: 100%; height: 28px; padding: 0 26px 0 10px; border: 0; outline: 0; border-radius: 8px; background: var(--solid); box-shadow: 0 1px 2px rgba(0, 0, 0, .05); font: 400 12px/28px var(--font-mono); color: var(--ink); cursor: pointer; text-overflow: ellipsis; transition: box-shadow 160ms var(--ease-out); }
.msel select:hover, .msel select:focus-visible { box-shadow: 0 2px 8px -2px rgba(0, 0, 0, .12); }
.msel .nv-i { position: absolute; right: 9px; width: 12px; height: 12px; color: var(--ink-3); pointer-events: none; }
.del { width: 26px; height: 26px; border: 0; padding: 0; border-radius: 7px; background: transparent; color: var(--ink-3); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; flex: none; transition: background 120ms, color 120ms; }
.del:hover { background: var(--danger-fill); color: var(--danger); }
.del .nv-i { width: 13px; height: 13px; }
.grp { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 10px; align-items: start; }
.gl { font: 400 11px/24px var(--font-sans); color: var(--ink-3); cursor: default; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { height: 24px; padding: 0 8px; border: 0; border-radius: 7px; background: var(--fill-2); font: 400 11px/24px var(--font-mono); color: var(--ink-2); cursor: pointer; white-space: nowrap; transition: background 140ms var(--ease-out), color 140ms var(--ease-out), box-shadow 140ms var(--ease-out); }
.chip:hover { background: var(--fill-3); color: var(--ink); }
.chip.on { background: var(--solid); color: var(--ink); font-weight: 500; box-shadow: 0 1px 2px rgba(0, 0, 0, .06), 0 3px 8px -4px rgba(0, 0, 0, .12); }
.chip.alien { font-family: var(--font-sans); }
.nums { display: flex; flex-wrap: wrap; gap: 6px; }
.numf { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 9px; border-radius: 8px; background: var(--solid); box-shadow: 0 1px 2px rgba(0, 0, 0, .04); min-width: 0; }
.numf > span { font: 400 11px/1 var(--font-sans); color: var(--ink-3); white-space: nowrap; }
.numf > i { font: normal 400 10px/1 var(--font-mono); color: var(--ink-4); }
.num { width: 76px; height: 20px; border: 0; outline: 0; padding: 0; background: transparent; font: 400 11.5px/20px var(--font-mono); color: var(--ink); text-align: right; }
.num::placeholder { color: var(--ink-4); text-align: right; }
.empty { padding: 18px 16px; border-radius: 14px; background: var(--fill-1); font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); text-align: center; }
.foot { margin: 0; font: 400 11px/16px var(--font-sans); color: var(--ink-3); }
@media (max-width: 860px) { .grp { grid-template-columns: minmax(0, 1fr); gap: 4px; } .gl { line-height: 16px; } }
</style>
