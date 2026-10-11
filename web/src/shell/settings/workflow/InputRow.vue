<script setup>
// 节点的一个可配置输入：勾选暴露 / 显示名称 / 类型（9 种）/ min max step 默认值 随机数 / 下拉选项
import { computed } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import WfSelect from './WfSelect.vue';
import { t } from '../../../lib/store.js';
import { inputLabel, typeOptions } from './nodeInfo.js';
import { fieldFor, toggleField, updateField, addDropdownOption, removeDropdownOption, updateDropdownOption } from './wfStore.js';

const props = defineProps({ nodeId: { type: String, required: true }, inputKey: { type: String, required: true }, rawValue: { default: null }, solid: Boolean });
const f = computed(() => fieldFor(props.nodeId, props.inputKey));
const active = computed(() => !!f.value);
const friendly = computed(() => inputLabel(props.inputKey));
const showOrig = computed(() => friendly.value !== props.inputKey);
const kind = computed(() => typeof props.rawValue);
const strPreview = computed(() => { const s = String(props.rawValue); return s.length > 50 ? s.slice(0, 50) + '…' : s; });
const numExtras = computed(() => active.value && (f.value.type === 'slider' || f.value.type === 'number'));
const ddExtras = computed(() => active.value && f.value.type === 'dropdown');

function num(key, e) { const v = e.target.value; updateField(f.value.id, key, v === '' ? null : parseFloat(v)); }
function looksNumber(o) { return String(o).trim() !== '' && !isNaN(Number(o)); }
</script>

<template>
    <div class="ir" :class="{ on: active, solid }">
        <button type="button" class="chk" :class="{ on: active }" role="checkbox" :aria-checked="active" :aria-label="(active ? '取消暴露 ' : '暴露 ') + friendly" @click="toggleField(nodeId, inputKey)"><NvIcon v-if="active" name="check" /></button>
        <div class="k">
            <b>{{ friendly }}<small v-if="showOrig">{{ inputKey }}</small></b>
            <span class="dv">{{ t('comfy.defaultValue', '默认值：') }}<template v-if="kind === 'string'">"{{ strPreview }}"</template><template v-else-if="kind === 'boolean'">{{ rawValue ? 'true' : 'false' }}</template><template v-else>{{ String(rawValue) }}</template></span>
        </div>
        <input class="inp" type="text" :placeholder="t('comfy.displayName', '显示名称')" :value="active ? f.name : friendly" :disabled="!active" :aria-label="t('comfy.displayName', '显示名称')" @input="updateField(f.id, 'name', $event.target.value)" />
        <WfSelect size="sm" :model-value="active ? f.type : 'text'" :options="typeOptions()" :disabled="!active" label="字段类型" @update:model-value="updateField(f.id, 'type', $event)" />
        <div v-if="numExtras" class="ex">
            <label>min<input class="inp mono" type="number" :value="f.min ?? ''" @input="num('min', $event)" /></label>
            <label>max<input class="inp mono" type="number" :value="f.max ?? ''" @input="num('max', $event)" /></label>
            <label>step<input class="inp mono" type="number" :value="f.step ?? ''" @input="num('step', $event)" /></label>
            <label>{{ t('comfy.defaultValue', '默认值：').replace(/[：:]\s*$/, '') }}<input class="inp mono" type="number" :value="f.default ?? ''" @input="num('default', $event)" /></label>
            <label v-if="f.type === 'number'" class="rnd" @click.stop>
                <button type="button" class="chk sm" :class="{ on: f.random_enabled === true }" role="checkbox" :aria-checked="f.random_enabled === true" @click="updateField(f.id, 'random_enabled', !(f.random_enabled === true))"><NvIcon v-if="f.random_enabled === true" name="check" /></button>随机数
            </label>
        </div>
        <div v-else-if="ddExtras" class="ex dd">
            <div class="dd-h">下拉选项 <span>· 数字形式自动作为数值传给 ComfyUI</span></div>
            <div class="ops">
                <div v-for="(o, i) in (f.options || [])" :key="i" class="op">
                    <span class="idx">{{ i + 1 }}</span>
                    <input class="inp" type="text" :placeholder="'选项 ' + (i + 1)" :value="o" @mousedown.stop @click.stop @input="updateDropdownOption(f, i, $event.target.value)" />
                    <span class="tg" :class="{ num: looksNumber(o) }">{{ looksNumber(o) ? '数字' : '文本' }}</span>
                    <button type="button" class="x" title="删除" aria-label="删除选项" @click.stop="removeDropdownOption(f, i)"><NvIcon name="x" /></button>
                </div>
            </div>
            <button type="button" class="add" @click.stop="addDropdownOption(f)"><NvIcon name="plus" />添加选项</button>
        </div>
    </div>
</template>

<style scoped>
.ir { display: grid; grid-template-columns: 16px minmax(0, 1fr) 96px 76px; gap: 8px; align-items: center; padding: 8px; border-radius: 10px; transition: background var(--duration-fast) var(--ease-out); }
.ir.on { background: var(--fill-1); }
.ir.on.solid { background: var(--solid); }
.chk { width: 16px; height: 16px; padding: 0; border: 0; border-radius: 5px; background: transparent; box-shadow: inset 0 0 0 1.5px var(--ink-4); display: inline-flex; align-items: center; justify-content: center; color: var(--on-accent); cursor: pointer; flex: none; transition: background var(--duration-fast), box-shadow var(--duration-fast); }
.chk:hover { box-shadow: inset 0 0 0 1.5px var(--ink-3); }
.chk.on { background: var(--accent); box-shadow: none; }
.chk .nv-i { width: 11px; height: 11px; stroke-width: 2; }
.chk.sm { width: 14px; height: 14px; border-radius: 4px; }
.chk.sm .nv-i { width: 10px; height: 10px; }
.k { min-width: 0; }
.k b { display: block; font: 500 12px/16px var(--font-sans); color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.k b small { margin-left: 4px; font: 400 11px/1 var(--font-mono); color: var(--ink-4); }
.k .dv { display: block; font: 400 10.5px/14px var(--font-mono); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.inp { width: 100%; min-width: 0; height: 26px; padding: 0 8px; border: 0; outline: 0; border-radius: 7px; background: var(--solid); color: var(--ink); font: 400 11.5px/1 var(--font-sans); transition: background var(--duration-fast); }
.ir.solid .inp, .ir.on.solid .ex .inp { background: var(--fill-1); }
.inp:hover:not(:disabled), .inp:focus { background: var(--fill-2); }
.inp:disabled { background: var(--fill-1); color: var(--ink-4); }
.inp.mono { font-family: var(--font-mono); }
.ir :deep(.wsel:disabled) { background: var(--fill-1); }
.ir.on.solid :deep(.wsel) { background: var(--fill-1); }
.ex { grid-column: 2 / 5; display: flex; gap: 6px 8px; align-items: center; flex-wrap: wrap; }
.ex label { display: inline-flex; align-items: center; gap: 4px; font: 400 10.5px/1 var(--font-mono); color: var(--ink-3); }
.ex label .inp { width: 58px; height: 24px; }
.ex .rnd { font-family: var(--font-sans); color: var(--ink-2); cursor: pointer; gap: 6px; }
.dd { flex-direction: column; align-items: stretch; gap: 6px; }
.dd-h { font: 400 11px/16px var(--font-sans); color: var(--ink-2); }
.dd-h span { color: var(--ink-3); }
.ops { position: relative; display: flex; flex-direction: column; gap: 4px; }
.op { display: grid; grid-template-columns: 14px 1fr auto 20px; gap: 6px; align-items: center; }
.op .idx { font: 400 10.5px/1 var(--font-mono); color: var(--ink-3); text-align: center; }
.tg { height: 18px; padding: 0 6px; border-radius: 5px; background: var(--fill-2); font: 400 11px/18px var(--font-sans); color: var(--ink-3); }
.tg.num { background: var(--accent); color: var(--on-accent); }
.x { width: 20px; height: 20px; padding: 0; border: 0; border-radius: 6px; background: transparent; display: inline-flex; align-items: center; justify-content: center; color: var(--ink-3); cursor: pointer; }
.x:hover { background: var(--fill-2); color: var(--ink); }
.x .nv-i { width: 11px; height: 11px; }
.add { align-self: flex-start; display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border: 0; border-radius: 7px; background: transparent; color: var(--ink-2); font: 400 11.5px/1 var(--font-sans); cursor: pointer; }
.add:hover { background: var(--fill-2); color: var(--ink); }
.add .nv-i { width: 12px; height: 12px; }
</style>
