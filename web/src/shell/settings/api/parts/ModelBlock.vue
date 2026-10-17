<script setup>
// 单个模型分组（生图 / 聊天 / 视频）：可编辑模型 ID、单模型协议覆盖、视频厂商标签、删除（可撤销）、搜索过滤
import { computed, inject, nextTick, ref } from 'vue';
import AIcon from './AIcon.vue';
import { t } from '../../../../lib/store.js';
import { modelListKey } from '../core/constants.js';
import { modelDisplayName, providerSupportsModelProtocol, inferredModelProtocol, inferVideoVendor } from '../core/helpers.js';

const props = defineProps({ kind: String, title: String, hint: String });
const store = inject('apiStore');
const S = store.S;
const it = store.item;

const rootEl = ref(null);

const rows = computed(() => {
    const p = it.value; if (!p) return [];
    const list = p[modelListKey(props.kind)] || [];
    const keys = store.rowKeys(p, props.kind);
    const q = S.modelSearch.trim().toLowerCase();
    const map = (p.model_protocols && typeof p.model_protocols === 'object') ? p.model_protocols : {};
    return list.map((model, index) => {
        const label = modelDisplayName(model, p, S.fetched.names);
        const raw = String(model || '').trim();
        // 保存时 unique() 会丢掉空行、重复项只留第一个：提前标出来，别让用户填完才发现没存上
        const dup = !!raw && list.findIndex(x => String(x || '').trim() === raw) !== index;
        const current = String(map[raw] || '').toLowerCase();
        const auto = current ? '' : inferredModelProtocol(props.kind, model);
        return {
            key: keys[index], index, model, raw, dup, label: label && label !== model ? label : '',
            hit: !q || `${model} ${label}`.toLowerCase().includes(q),
            proto: current,
            defaultLabel: auto ? `自动（${auto === 'gemini' ? 'Gemini' : 'OpenAI'}）` : '默认',
            vendor: inferVideoVendor(model) || '自动',
        };
    });
});
const showProtocol = computed(() => providerSupportsModelProtocol(it.value));
const searchEmpty = computed(() => S.modelSearch.trim() && rows.value.length && !rows.value.some(r => r.hit));

// 手填模型：加一行并把光标放进去，少一次点击
function add() {
    store.addModel(props.kind);
    nextTick(() => {
        const inputs = rootEl.value ? rootEl.value.querySelectorAll('.mrow .id input') : [];
        const last = inputs[inputs.length - 1];
        if (last) last.focus();
    });
}
</script>

<template>
    <section ref="rootEl" class="mblk">
        <div class="hd">
            <div class="tx"><b>{{ title }}</b><span>{{ hint }}</span>
                <span v-if="kind === 'image' && it && it.id === 'modelscope'" class="ex">{{ t('api.msModelExample', '模型名称示意：') }}<code>Tongyi-MAI/Z-Image-Turbo</code></span>
            </div>
            <button type="button" class="nv-btn sm ghost add" title="手动填写模型 ID，不依赖上游拉取" @click="add"><AIcon name="plus" />{{ t('api.customModel', '自定义模型') }}</button>
        </div>
        <TransitionGroup tag="div" name="mrow" class="rows">
            <div v-for="r in rows" v-show="r.hit" :key="r.key" class="mrow">
                <label class="id">
                    <i v-if="r.label">{{ r.label }}</i>
                    <input :value="r.model" spellcheck="false" :aria-label="title + ' ID'" placeholder="手动填写模型 ID" @input="store.updateModel(kind, r.index, $event.target.value)">
                </label>
                <span v-if="!r.raw" class="tag wait" title="保存时会丢掉空行">待填写</span>
                <span v-else-if="r.dup" class="tag dup" title="与列表里靠前的模型重复，保存时只保留第一个">重复</span>
                <template v-if="showProtocol">
                    <span v-if="kind === 'video'" class="vtag" title="视频按模型名自动分发到对应厂商接口，无需配置协议">{{ r.vendor }}</span>
                    <span v-else class="sel" title="该模型使用的协议，默认跟随平台全局协议">
                        <select :value="r.proto" @change="store.updateModelProtocol(kind, r.index, $event.target.value)">
                            <option value="">{{ r.defaultLabel }}</option>
                            <option value="openai">OpenAI</option>
                            <option value="gemini">Gemini</option>
                        </select>
                        <AIcon name="chev" />
                    </span>
                </template>
                <button type="button" class="del" title="删除" aria-label="删除" @click="store.removeModel(kind, r.index)"><AIcon name="trash" /></button>
            </div>
        </TransitionGroup>
        <div v-if="!rows.length" class="empty">{{ t('api.noModels', '暂无模型') }}</div>
        <div v-else-if="searchEmpty" class="empty">没有匹配「{{ S.modelSearch.trim() }}」的模型</div>
    </section>
</template>

<style scoped>
.mblk { background: var(--fill-1); border-radius: 14px; padding: 12px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.hd { display: flex; align-items: flex-start; gap: 8px; padding: 2px 2px 6px; }
.tx { flex: 1; min-width: 0; }
.tx b { display: block; font: 500 13px/18px var(--font-sans); }
.tx span { display: block; font: 400 11px/15px var(--font-sans); color: var(--ink-3); }
.tx .ex { margin-top: 2px; }
.ex code { font: 400 10.5px/1 var(--font-mono); color: var(--ink-2); }
.add { height: 26px; padding: 0 8px; flex: none; }
.rows { position: relative; display: flex; flex-direction: column; gap: 6px; }
.mrow { display: flex; align-items: center; gap: 6px; padding: 4px 4px 4px 10px; border-radius: 9px; background: var(--solid); min-width: 0; min-height: 36px; }
.id { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; cursor: text; }
.id i { font: normal 400 10.5px/13px var(--font-sans); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.id input { width: 100%; height: 20px; border: 0; outline: 0; padding: 0; background: transparent; font: 400 11.5px/20px var(--font-mono); color: var(--ink); text-overflow: ellipsis; }
.sel { position: relative; flex: none; display: inline-flex; align-items: center; }
.sel select { appearance: none; -webkit-appearance: none; height: 24px; max-width: 120px; padding: 0 22px 0 8px; border: 0; outline: 0; border-radius: 7px; background: var(--fill-1); font: 400 11px/24px var(--font-sans); color: var(--ink-2); cursor: pointer; text-overflow: ellipsis; }
.sel select:hover, .sel select:focus-visible { background: var(--fill-2); color: var(--ink); }
.sel .nv-i { position: absolute; right: 6px; width: 11px; height: 11px; color: var(--ink-3); pointer-events: none; }
.vtag { height: 20px; padding: 0 7px; border-radius: 6px; background: var(--fill-1); font: 400 10.5px/20px var(--font-mono); color: var(--ink-2); flex: none; white-space: nowrap; }
.tag { height: 20px; padding: 0 7px; border-radius: 6px; font: 400 10.5px/20px var(--font-sans); flex: none; white-space: nowrap; }
.tag.wait { background: var(--fill-1); color: var(--ink-4); }
.tag.dup { background: var(--danger-fill); color: var(--danger); }
.del { width: 24px; height: 24px; border: 0; padding: 0; border-radius: 6px; background: transparent; color: var(--ink-3); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; flex: none; transition: background 120ms, color 120ms; }
.del:hover { background: var(--danger-fill); color: var(--danger); }
.del .nv-i { width: 13px; height: 13px; }
.empty { padding: 14px 10px; border-radius: 9px; background: var(--solid); font: 400 11.5px/16px var(--font-sans); color: var(--ink-3); text-align: center; }
.mrow-move { transition: transform 220ms var(--ease-out); }
.mrow-enter-active { transition: opacity 200ms var(--ease-out), transform 200ms var(--ease-out); }
.mrow-enter-from { opacity: 0; transform: translateY(-4px); }
.mrow-leave-active { transition: opacity 160ms var(--ease-out), transform 160ms var(--ease-out); position: absolute; left: 0; right: 0; }
.mrow-leave-to { opacity: 0; transform: scale(.98); }
@media (prefers-reduced-motion: reduce) { .mrow-move, .mrow-enter-active, .mrow-leave-active { transition: none; } }
</style>
