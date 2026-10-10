<script setup>
// 一个暴露字段在画布 Comfy 节点上的控件（右侧预览 & 测试画布 Comfy 卡共用）
import { computed } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import NvSwitch from '../../../components/NvSwitch.vue';
import WfSelect from './WfSelect.vue';
import MediaView from './MediaView.vue';
import { t } from '../../../lib/store.js';
import { isMediaField, fieldKind, fieldSupportsRandom } from './nodeInfo.js';
import { previewValue, setPreviewValue, isPreviewRandomActive, togglePreviewRandom, mediaDisplayUrl, pickImage } from './wfStore.js';

const props = defineProps({ field: { type: Object, required: true }, compact: Boolean });
const f = computed(() => props.field);
const v = computed(() => previewValue(f.value));
const label = computed(() => f.value.name || f.value.input);
const random = computed(() => fieldSupportsRandom(f.value));
const randomOn = computed(() => isPreviewRandomActive(f.value.id));
const opts = computed(() => (f.value.options || []).map(o => ({ value: o, label: String(o) })));
const sl = computed(() => ({ min: f.value.min ?? 0, max: f.value.max ?? 10, step: f.value.step ?? 1 }));
const pct = computed(() => {
    const { min, max } = sl.value; const n = Number(v.value);
    return max > min && Number.isFinite(n) ? Math.max(0, Math.min(100, ((n - min) / (max - min)) * 100)) : 0;
});
</script>

<template>
    <div class="pf" :class="{ compact }">
        <span class="pf-l">{{ label }}</span>
        <textarea v-if="f.type === 'textarea'" class="pf-in pf-ta" :value="v" @input="setPreviewValue(f.id, $event.target.value)"></textarea>
        <div v-else-if="f.type === 'number'" class="pf-rr">
            <input class="pf-in mono" type="number" :value="v" @input="setPreviewValue(f.id, parseFloat($event.target.value) || 0)" />
            <button v-if="random" type="button" class="pf-dice" :class="{ on: randomOn }" :title="randomOn ? '随机已开启，点击关闭' : '随机已关闭，点击开启'" :aria-pressed="randomOn" @click="togglePreviewRandom(f)"><NvIcon name="dice" /></button>
        </div>
        <div v-else-if="f.type === 'slider'" class="pf-sl">
            <input type="range" :min="sl.min" :max="sl.max" :step="sl.step" :value="v" :style="{ '--p': pct + '%' }" @input="setPreviewValue(f.id, parseFloat($event.target.value))" />
            <span class="pf-num">{{ v }}</span>
        </div>
        <WfSelect v-else-if="f.type === 'dropdown'" :model-value="v" :options="opts" :placeholder="t('comfy.noOptions', '(无选项)')" :size="compact ? 'sm' : 'md'" :label="label" @update:model-value="setPreviewValue(f.id, $event)" />
        <MediaView v-else-if="isMediaField(f)" :kind="fieldKind(f)" :url="mediaDisplayUrl(f)" :name="String(v || '')" :compact="compact" @pick="pickImage(f.id)" />
        <div v-else-if="f.type === 'boolean'" class="pf-bool"><NvSwitch :model-value="!!v" :label="label" @update:model-value="setPreviewValue(f.id, $event)" /></div>
        <input v-else class="pf-in" type="text" :value="v" @input="setPreviewValue(f.id, $event.target.value)" />
    </div>
</template>

<style scoped>
.pf { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.pf-l { font: 400 11px/14px var(--font-sans); color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pf-in { width: 100%; min-width: 0; height: 32px; padding: 0 10px; border: 0; outline: 0; border-radius: var(--radius-md); background: var(--solid); color: var(--ink); font: 400 12.5px/1 var(--font-sans); transition: background var(--duration-fast), box-shadow var(--duration-fast); }
.pf-in.mono { font-family: var(--font-mono); font-size: 12px; }
.pf-in:hover { background: var(--fill-2); }
.pf-in:focus { background: var(--fill-2); box-shadow: none; }
.pf-ta { height: auto; min-height: 64px; padding: 9px 11px; resize: vertical; font: 400 12.5px/19px var(--font-sans); }
.compact .pf-in { height: 28px; font-size: 12px; background: var(--fill-1); }
.compact .pf-ta { height: auto; min-height: 56px; }
.compact .pf-in:focus { background: var(--solid); }
.pf-rr { display: flex; gap: 6px; }
.pf-dice { width: 32px; height: 32px; flex: none; border: 0; border-radius: var(--radius-md); background: var(--solid); color: var(--ink-3); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: background var(--duration-fast), color var(--duration-fast), transform var(--duration-instant); }
.pf-dice:hover { color: var(--ink); background: var(--fill-2); }
.pf-dice:active { transform: scale(.94); }
.pf-dice.on { background: var(--accent); color: var(--on-accent); }
.pf-dice .nv-i { width: 14px; height: 14px; }
.compact .pf-dice { width: 28px; height: 28px; }
.pf-sl { display: flex; align-items: center; gap: 10px; height: 24px; }
.pf-sl input { flex: 1; min-width: 0; height: 18px; margin: 0; background: transparent; -webkit-appearance: none; appearance: none; cursor: pointer; }
.pf-sl input::-webkit-slider-runnable-track { height: 3px; border-radius: 3px; background: linear-gradient(to right, var(--accent) var(--p), var(--fill-2) var(--p)); }
.pf-sl input::-moz-range-track { height: 3px; border-radius: 3px; background: linear-gradient(to right, var(--accent) var(--p), var(--fill-2) var(--p)); }
.pf-sl input::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; margin-top: -5.5px; border-radius: 50%; background: var(--solid); box-shadow: 0 1px 3px rgba(0,0,0,.3), 0 0 1px rgba(0,0,0,.25); }
.pf-sl input::-moz-range-thumb { width: 14px; height: 14px; border: 0; border-radius: 50%; background: var(--solid); box-shadow: 0 1px 3px rgba(0,0,0,.3), 0 0 1px rgba(0,0,0,.25); }
.pf-num { min-width: 28px; text-align: right; font: 400 11px/1 var(--font-mono); color: var(--ink-3); }
.pf-bool { height: 24px; display: flex; align-items: center; }
</style>
