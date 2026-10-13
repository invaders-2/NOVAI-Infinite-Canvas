<script setup>
// ModelScope LoRA 管理：LoRA ID / 绑定模型 / 默认强度 / 删除
import { computed, inject } from 'vue';
import AIcon from './AIcon.vue';
import { t } from '../../../../lib/store.js';
import { MS_BUILTIN_IMAGE_MODELS } from '../core/constants.js';
import { unique, normalizeLoraStrength } from '../core/helpers.js';

const store = inject('apiStore');
const it = store.item;
const loras = computed(() => {
    const p = it.value;
    return p && Array.isArray(p.ms_loras) ? p.ms_loras : [];
});
function targetOf(l) { return l.target_model || l.model || MS_BUILTIN_IMAGE_MODELS[0]; }
function strengthOf(l) { return normalizeLoraStrength(l.strength ?? l.default_strength ?? 0.8); }
function targets(selected) { return unique([selected, ...MS_BUILTIN_IMAGE_MODELS, ...((it.value && it.value.image_models) || [])]).filter(Boolean); }
</script>

<template>
    <section class="lblk">
        <div class="hd">
            <div class="tx">
                <b>{{ t('api.loraManager', 'LoRA 管理') }}</b>
                <span>{{ t('api.loraManagerDesc', '为 ModelScope 生图模型绑定可用 LoRA。无限画布 MS 节点会按当前模型自动筛选。') }}</span>
                <span class="links">{{ t('api.msCnModels', '中文模型库：') }}<a href="https://www.modelscope.cn/aigc/models" target="_blank" rel="noopener">modelscope.cn/aigc/models</a>
                    · {{ t('api.msEnModels', '英文模型库：') }}<a href="https://www.modelscope.ai/civision/models" target="_blank" rel="noopener">modelscope.ai/civision/models</a></span>
            </div>
            <button type="button" class="nv-btn sm ghost add" @click="store.addLora()"><AIcon name="plus" />LoRA</button>
        </div>
        <TransitionGroup tag="div" name="lrow" class="rows">
            <div v-for="(l, i) in loras" :key="i" class="lrow">
                <label class="f"><span>{{ t('api.loraId', 'LoRA ID') }}</span>
                    <input class="inp mono" :value="l.id || ''" :placeholder="t('api.loraIdPlaceholder', '例如 Daniel8152/Klein-enhance')" spellcheck="false" @input="store.updateLora(i, 'id', $event.target.value)">
                </label>
                <label class="f"><span>{{ t('api.loraTargetModel', '绑定模型') }}</span>
                    <span class="sel"><select class="inp" :value="targetOf(l)" @change="store.updateLora(i, 'target_model', $event.target.value)">
                        <option v-for="m in targets(targetOf(l))" :key="m" :value="m">{{ m }}</option>
                    </select><AIcon name="chev" /></span>
                </label>
                <label class="f num"><span>{{ t('api.loraDefaultStrength', '默认强度') }}</span>
                    <input class="inp mono" type="number" min="0" max="2" step="0.05" :value="strengthOf(l)" @input="store.updateLora(i, 'strength', $event.target.value)">
                </label>
                <button type="button" class="del" :title="t('common.delete', '删除')" :aria-label="t('common.delete', '删除')" @click="store.removeLora(i)"><AIcon name="trash" /></button>
            </div>
        </TransitionGroup>
        <div v-if="!loras.length" class="empty">{{ t('api.loraEmpty', '暂无 LoRA，点击右上角添加。添加后会按绑定模型显示在无限画布 MS 节点里。') }}</div>
    </section>
</template>

<style scoped>
.lblk { background: var(--fill-1); border-radius: 14px; padding: 12px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.hd { display: flex; align-items: flex-start; gap: 8px; padding: 2px 2px 6px; }
.tx { flex: 1; min-width: 0; }
.tx b { display: block; font: 500 13px/18px var(--font-sans); }
.tx span { display: block; font: 400 11px/16px var(--font-sans); color: var(--ink-3); }
.links { margin-top: 2px; }
.links a { color: var(--ink-2); font-family: var(--font-mono); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--ink-4); }
.add { height: 26px; padding: 0 8px; flex: none; }
.rows { display: flex; flex-direction: column; gap: 6px; }
.lrow { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) 84px 24px; gap: 8px; align-items: end; padding: 8px 8px 8px 10px; border-radius: 10px; background: var(--solid); }
.f { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.f > span:first-child { font: 400 10.5px/14px var(--font-sans); color: var(--ink-3); }
.inp { width: 100%; height: 30px; padding: 0 9px; border: 0; outline: 0; border-radius: 7px; background: var(--fill-1); font: 400 12px/1 var(--font-sans); color: var(--ink); min-width: 0; }
.inp.mono { font-family: var(--font-mono); font-size: 11.5px; }
.inp:focus { background: var(--fill-2); }
.sel { position: relative; display: flex; align-items: center; }
.sel select { appearance: none; -webkit-appearance: none; padding-right: 24px; cursor: pointer; text-overflow: ellipsis; }
.sel .nv-i { position: absolute; right: 8px; width: 11px; height: 11px; color: var(--ink-3); pointer-events: none; }
.del { width: 24px; height: 30px; border: 0; padding: 0; border-radius: 6px; background: transparent; color: var(--ink-3); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.del:hover { background: var(--danger-fill); color: var(--danger); }
.del .nv-i { width: 13px; height: 13px; }
.empty { padding: 14px 10px; border-radius: 9px; background: var(--solid); font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); text-align: center; }
.lrow-enter-active, .lrow-leave-active { transition: opacity 180ms var(--ease-out), transform 180ms var(--ease-out); }
.lrow-enter-from, .lrow-leave-to { opacity: 0; transform: translateY(-4px); }
</style>
