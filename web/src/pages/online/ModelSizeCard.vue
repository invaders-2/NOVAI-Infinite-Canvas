<script setup>
// 「模型」卡片内容：平台 / 模型（RunningHub 为 模型 API·工作流·应用）、质量（仅 OpenAI 系）、数量（RunningHub 隐藏）、
// 尺寸档位（含自定义尺寸 + 适配图片）、比例（含比例为空 / 自定义比例）、换档提示
import { computed } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import OnSelect from './OnSelect.vue';
import { t } from '../../lib/store.js';
import { S, badge, isRunningHub, showQuality, providerOptions, modelOptions, ratioOptions, resOptions, firstRefDim, setProvider, setModel, setQuality, setCount, setRatio, setResolution, setCustomSize, setCustomRatio, fitToImage, } from './useOnline.js';

const qualityOptions = computed(() => [
    { value: 'auto', label: t('online.qualityAuto', '自动') },
    { value: 'low', label: t('online.qualityLow', '低') },
    { value: 'medium', label: t('online.qualityMedium', '中') },
    { value: 'high', label: t('online.qualityHigh', '高') },
]);
const countOptions = [1, 2, 3, 4].map(n => ({ value: n, label: '×' + n }));
</script>

<template>
    <div class="oms">
        <div class="lbl"><NvIcon name="settings" />{{ t('online.model', '模型') }}<span class="nv-badge">{{ badge }}</span></div>
        <div class="g2">
            <OnSelect :model-value="S.provider" :options="providerOptions" label="平台" @update:model-value="setProvider" />
            <OnSelect :model-value="S.model" :options="modelOptions" label="模型" :placeholder="isRunningHub ? t('online.rhNoEntries', '未配置工作流 / 应用') : ''" @update:model-value="setModel" />
        </div>
        <div v-if="showQuality || !isRunningHub" class="g2">
            <OnSelect v-if="showQuality" :model-value="S.quality" :options="qualityOptions" :prefix="t('online.quality', '质量')" @update:model-value="setQuality" />
            <OnSelect v-if="!isRunningHub" :model-value="S.count" :options="countOptions" :prefix="t('online.count', '数量')" @update:model-value="setCount" />
        </div>

        <div class="lbl"><NvIcon name="ruler" />{{ t('online.size', '尺寸') }}</div>
        <div class="g2">
            <OnSelect :model-value="S.resolution" :options="resOptions" label="分辨率" @update:model-value="setResolution" />
            <OnSelect :model-value="S.ratio" :options="ratioOptions" label="比例" :disabled="S.resolution === 'custom'" @update:model-value="v => setRatio(v)" />
        </div>
        <div v-if="S.resolution === 'custom'" class="pair">
            <input class="inp" type="number" min="64" step="64" :placeholder="t('online.width', '宽度')" :value="S.customWidth" @input="setCustomSize($event.target.value, S.customHeight)" />
            <NvIcon name="x" class="op" />
            <input class="inp" type="number" min="64" step="64" :placeholder="t('online.height', '高度')" :value="S.customHeight" @input="setCustomSize(S.customWidth, $event.target.value)" />
            <button type="button" class="fit" :disabled="!firstRefDim" :title="firstRefDim ? `使用参考图尺寸 ${firstRefDim.width}×${firstRefDim.height}` : '先添加参考图'" @click="fitToImage">适配图片</button>
        </div>
        <div v-if="S.ratio === 'custom'" class="pair">
            <input class="inp" type="number" min="1" step="1" :placeholder="t('online.ratioWidth', '宽')" :value="S.customRatioWidth" @input="setCustomRatio($event.target.value, S.customRatioHeight)" />
            <span class="op colon">:</span>
            <input class="inp" type="number" min="1" step="1" :placeholder="t('online.ratioHeight', '高')" :value="S.customRatioHeight" @input="setCustomRatio(S.customRatioWidth, $event.target.value)" />
        </div>
        <Transition name="oms-n"><p v-if="S.notice" class="notice">{{ S.notice }}</p></Transition>
    </div>
</template>

<style scoped>
.oms { display: flex; flex-direction: column; gap: 10px; }
.lbl { display: flex; align-items: center; gap: 6px; font: 400 11.5px/1 var(--font-sans); color: var(--ink-3); }
.lbl .nv-i { width: 13px; height: 13px; }
.lbl .nv-badge { margin-left: auto; }
.g2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
.pair { display: flex; align-items: center; gap: 6px; }
.inp { flex: 1; min-width: 0; height: 34px; padding: 0 10px; border: 0; border-radius: 10px; background: var(--fill-1); color: var(--ink); font: 400 12px/1 var(--font-mono); outline: none; transition: background var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out); -moz-appearance: textfield; }
.inp::-webkit-inner-spin-button, .inp::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.inp::placeholder { color: var(--ink-4); font-family: var(--font-sans); }
.inp:hover { background: var(--fill-2); }
.inp:focus { background: var(--fill-2); box-shadow: none; }
.op { width: 12px; height: 12px; color: var(--ink-3); flex: none; }
.op.colon { width: auto; text-align: center; font: 400 12px/1 var(--font-mono); }
.fit { height: 34px; padding: 0 12px; border: 0; border-radius: 10px; background: var(--fill-1); color: var(--ink); font: 500 12px/1 var(--font-sans); white-space: nowrap; cursor: pointer; flex: none; }
.fit:hover:not(:disabled) { background: var(--fill-2); }
.fit:disabled { color: var(--ink-4); cursor: not-allowed; }
.notice { margin: 0; font: 400 11px/16px var(--font-sans); color: var(--danger); }
.oms-n-enter-active, .oms-n-leave-active { transition: opacity .16s ease; }
.oms-n-enter-from, .oms-n-leave-to { opacity: 0; }
@media (max-width: 640px) { .g2 { grid-template-columns: 1fr; } }
</style>
