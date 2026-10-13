<script setup>
// 编辑器里单个字段的配置：勾选暴露、保留原设置、显示名、类型、图片排序/必选、随机数范围、下拉选项
import { computed } from 'vue';
import NvIcon from '../../../../components/NvIcon.vue';
import KSelect from '../kit/KSelect.vue';
import { rhWorkflowFieldKind, rhWorkflowFieldTypeLabel, RH_FIELD_TYPES } from './rh-utils.js';

const props = defineProps({ field: Object, mode: String });
const emit = defineEmits(['toggle', 'update']);

const f = computed(() => props.field || {});
const kind = computed(() => rhWorkflowFieldKind(f.value));
const typeValue = computed(() => String(f.value.fieldType || kind.value).toUpperCase());
const optionsText = computed(() => (Array.isArray(f.value.options) ? f.value.options.join('\n') : String(f.value.options || '')));
const keepOriginal = computed(() => f.value.sourceFromUpstream === false);
const randomOn = computed(() => f.value.random_enabled === true);
const typeOptions = RH_FIELD_TYPES.map(o => ({ value: o, label: rhWorkflowFieldTypeLabel(o) }));
function up(prop, value) { emit('update', prop, value); }
</script>

<template>
    <div class="fe" :class="{ on: f.enabled === true }">
        <div class="fe-top">
            <button type="button" class="fe-chk" :class="{ on: f.enabled === true }" role="checkbox" :aria-checked="f.enabled === true" :aria-label="'暴露 ' + (f.label || f.fieldName)" @click="emit('toggle')">
                <NvIcon v-if="f.enabled === true" name="check" />
            </button>
            <div class="fe-k">
                <b>{{ f.label || f.fieldName }}</b>
                <span>{{ f.fieldName }} · {{ kind }}</span>
            </div>
        </div>
        <div class="fe-body">
            <button type="button" class="fe-tog" :class="{ on: keepOriginal }" @click="up('sourceFromUpstream', keepOriginal)">
                <i></i>{{ keepOriginal ? '保留工作流原设置' : '暴露并覆盖参数' }}
            </button>
            <div class="fe-g2">
                <input class="fe-inp" :value="f.label || ''" placeholder="显示名称" aria-label="显示名称" @input="up('label', $event.target.value)">
                <KSelect class="fe-sel" size="sm" :model-value="typeValue" :options="typeOptions" label="类型" @update:model-value="up('fieldType', $event)" />
            </div>
            <div v-if="mode === 'workflow' && kind === 'IMAGE'" class="fe-slot">
                <label><span>排序</span><input class="fe-inp" type="number" min="1" step="1" :value="f.imageOrder || ''" @input="up('imageOrder', $event.target.value)"></label>
                <button type="button" class="fe-tog" :class="{ on: f.required === true }" @click="up('required', f.required !== true)"><i></i>{{ f.required === true ? '必选' : '可选' }}</button>
            </div>
            <div class="fe-g3">
                <button type="button" class="fe-tog" :class="{ on: randomOn }" @click="up('random_enabled', !randomOn)"><NvIcon name="dice" />随机数</button>
                <input class="fe-inp" type="number" :value="f.min ?? ''" placeholder="最小" aria-label="最小" @input="up('min', $event.target.value)">
                <input class="fe-inp" type="number" :value="f.max ?? ''" placeholder="最大" aria-label="最大" @input="up('max', $event.target.value)">
                <input class="fe-inp" type="number" :value="f.step ?? ''" placeholder="步长" aria-label="步长" @input="up('step', $event.target.value)">
            </div>
            <textarea class="fe-inp fe-txa" rows="2" :value="optionsText" placeholder="下拉选项：每行一个，例如 1024x1024" aria-label="下拉选项" @input="up('options', $event.target.value)"></textarea>
        </div>
    </div>
</template>

<style scoped>
.fe { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 12px; transition: background var(--duration-fast) var(--ease-out); }
.fe.on { background: var(--fill-1); }
.fe-top { display: flex; align-items: flex-start; gap: 10px; }
.fe-chk { width: 16px; height: 16px; margin-top: 1px; flex: none; border: 0; padding: 0; border-radius: 5px; background: transparent; box-shadow: inset 0 0 0 1.2px var(--ink-4); color: var(--on-accent); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: background var(--duration-fast), box-shadow var(--duration-fast); }
.fe-chk.on { background: var(--accent); box-shadow: none; }
.fe-chk .nv-i { width: 11px; height: 11px; stroke-width: 2; }
.fe-k { min-width: 0; }
.fe-k b { display: block; font: 500 12px/16px var(--font-sans); color: var(--ink); overflow-wrap: anywhere; }
.fe-k span { display: block; font: 400 10.5px/14px var(--font-mono); color: var(--ink-3); overflow-wrap: anywhere; }
.fe-body { display: flex; flex-direction: column; gap: 6px; padding-left: 26px; }
.fe-tog { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px; border: 0; border-radius: 99px; background: var(--solid); font: 400 11px/1 var(--font-sans); color: var(--ink-2); align-self: flex-start; cursor: pointer; white-space: nowrap; transition: background var(--duration-fast), color var(--duration-fast); }
.fe-tog i { width: 8px; height: 8px; border-radius: 50%; box-shadow: inset 0 0 0 1.2px var(--ink-3); }
.fe-tog .nv-i { width: 12px; height: 12px; }
.fe-tog.on { background: var(--accent); color: var(--on-accent); }
.fe-tog.on i { background: var(--on-accent); box-shadow: none; }
.fe:not(.on) .fe-tog { background: var(--fill-1); }
.fe:not(.on) .fe-tog.on { background: var(--accent); }
.fe-inp { height: 26px; min-width: 0; border: 0; outline: 0; border-radius: 7px; padding: 0 8px; background: var(--solid); color: var(--ink); font: 400 11.5px/1 var(--font-sans); transition: box-shadow var(--duration-fast); }
.fe:not(.on) .fe-inp { background: var(--fill-1); }
.fe-inp::placeholder { color: var(--ink-4); }
.fe-inp:focus { background: var(--fill-2); box-shadow: none; }
.fe-g2 :deep(.fe-sel) { width: 100%; background: var(--solid); }
.fe:not(.on) .fe-g2 :deep(.fe-sel) { background: var(--fill-1); }
.fe-g2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.fe-g3 { display: grid; grid-template-columns: auto 1fr 1fr 1fr; gap: 6px; align-items: center; }
.fe-slot { display: flex; align-items: center; gap: 8px; }
.fe-slot label { display: inline-flex; align-items: center; gap: 6px; font: 400 11px/1 var(--font-sans); color: var(--ink-3); }
.fe-slot .fe-inp { width: 64px; }
.fe-txa { height: auto; min-height: 44px; padding: 6px 8px; line-height: 16px; resize: vertical; font-family: var(--font-mono); font-size: 11px; }
</style>
