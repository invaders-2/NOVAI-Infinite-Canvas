<script setup>
// 推荐 API 卡片：已添加（去配置）/ 未添加（一键添加）/ 已存在但没 Key（填写 Key）；展开为 3 步设置
import { ref, computed, inject, watch, nextTick } from 'vue';
import AIcon from './AIcon.vue';
import { t } from '../../../../lib/store.js';
import { toast } from '../../../../lib/store.js';
import { RECOMMEND_CAPS } from '../core/constants.js';
import { hostOfUrl } from '../core/helpers.js';

const props = defineProps({ api: Object, index: Number });
const store = inject('apiStore');
const S = store.S;
const key = ref('');
const inputEl = ref(null);
const cardEl = ref(null);
const busy = ref(false);

const existing = computed(() => store.existingProviderForApi(props.api));
const added = computed(() => !!(existing.value && (existing.value.has_key || existing.value.has_wallet_key)));
const open = computed(() => S.recommendOpen === props.index);
const perks = computed(() => (props.api.perks || []).map(p => ({ text: t(p.key, p.label), free: !!p.free })));
const caps = computed(() => {
    const list = (props.api.icons || []).map(c => RECOMMEND_CAPS[c]).filter(Boolean);
    if ((props.api.tagKeys || []).includes('api.tagSeedance')) list.push(['film', 'Seedance']);
    return list;
});
function toggle() { S.recommendOpen = open.value ? -1 : props.index; }
watch(open, v => {
    if (!v) { key.value = ''; return; }
    nextTick(() => {
        if (inputEl.value) inputEl.value.focus({ preventScroll: true });
        if (cardEl.value) cardEl.value.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
});
async function paste() {
    try { key.value = String(await navigator.clipboard.readText() || '').trim(); }
    catch (e) { toast('无法读取剪贴板，请直接按 ⌘/Ctrl + V 粘贴', { danger: true, icon: 'alert' }); }
    if (inputEl.value) inputEl.value.focus();
}
async function save() {
    if (busy.value) return;
    busy.value = true;
    try { if (await store.saveRecommendedApi(props.index, key.value)) key.value = ''; }
    finally { busy.value = false; }
}
</script>

<template>
    <section ref="cardEl" class="rc" :class="{ open }" :style="{ '--i': index }">
        <div class="top">
            <span class="tile">{{ String(api.name || '?').slice(0, 1) }}</span>
            <div class="nm"><b>{{ api.name }}</b><small>{{ hostOfUrl(api.base_url) }}</small></div>
            <div v-if="perks.length" class="perks"><span v-for="p in perks" :key="p.text" class="perk">{{ p.text }}</span></div>
        </div>
        <p>{{ t(api.summaryKey, api.summary) }}</p>
        <div class="caps"><span v-for="c in caps" :key="c[1]"><AIcon :name="c[0]" />{{ c[1] }}</span></div>

        <div v-if="open" class="setup">
            <div class="steps"><b>1</b>注册并复制 Key<i></i><b>2</b>粘贴到这里<i></i><b>3</b>自动添加并保存</div>
            <div class="row">
                <label class="inp"><AIcon name="key" />
                    <input ref="inputEl" v-model="key" type="password" autocomplete="off" spellcheck="false" :placeholder="t('api.recommendKeyPlaceholder', '粘贴 {name} API Key').replaceAll('{name}', api.name)" @keydown.enter="save">
                    <button type="button" class="ib" title="从剪贴板粘贴" @click="paste"><AIcon name="paste" /></button>
                </label>
                <button type="button" class="nv-btn sm primary" :disabled="busy" @click="save"><span v-if="busy" class="spin xs"></span><AIcon v-else name="check" />保存并添加</button>
            </div>
            <div v-if="api.keyHint" class="khint">{{ api.keyHint }}</div>
            <div class="row links">
                <template v-if="api.register_url_cn">
                    <a class="nv-btn sm lk" :href="api.register_url" target="_blank" rel="noopener noreferrer"><AIcon name="ext" />{{ t('api.getKeyGlobal', '获取 Key · 国外') }}</a>
                    <a class="nv-btn sm lk" :href="api.register_url_cn" target="_blank" rel="noopener noreferrer"><AIcon name="ext" />{{ t('api.getKeyCn', '获取 Key · 国内') }}</a>
                </template>
                <a v-else class="nv-btn sm lk" :href="api.register_url" target="_blank" rel="noopener noreferrer"><AIcon name="ext" />{{ t('api.getKey', '获取 Key') }}</a>
                <button type="button" class="nv-btn sm ghost fold" @click="toggle">收起</button>
            </div>
        </div>
        <div v-else class="acts">
            <span v-if="added" class="added"><i></i>已添加</span>
            <span class="r">
                <a v-if="api.register_url" class="nv-btn sm lk" :href="api.register_url" target="_blank" rel="noopener noreferrer"><AIcon name="ext" />获取 Key</a>
                <button v-if="added" type="button" class="nv-btn sm lk" @click="store.select(existing.id)">去配置<AIcon name="arrowr" /></button>
                <button v-else type="button" class="nv-btn sm primary" @click="toggle"><AIcon name="plus" />{{ existing ? '填写 Key' : '一键添加' }}</button>
            </span>
        </div>
    </section>
</template>

<style scoped>
.rc { background: var(--fill-1); border-radius: 16px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; min-width: 0; transition: background 200ms, box-shadow 200ms; animation: rcin 320ms var(--ease-out) both; animation-delay: calc(var(--i) * 24ms); }
@keyframes rcin { from { opacity: 0; transform: translateY(6px); } }
.rc.open { background: var(--solid); box-shadow: var(--shadow-lift); }
.top { display: flex; align-items: center; gap: 10px; }
.tile { width: 34px; height: 34px; border-radius: 10px; background: var(--solid); display: inline-flex; align-items: center; justify-content: center; font: 500 14px/1 var(--font-sans); box-shadow: 0 1px 3px rgba(0,0,0,.06); flex: none; }
.rc.open .tile { background: var(--fill-1); box-shadow: none; }
.nm { flex: 1; min-width: 0; }
.nm b { display: block; font: 500 13px/18px var(--font-sans); }
.nm small { display: block; font: 400 11px/14px var(--font-mono); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.perks { display: flex; gap: 4px; flex: none; }
.perk { height: 18px; padding: 0 7px; border-radius: 99px; background: var(--accent); color: var(--on-accent); font: 400 10.5px/18px var(--font-sans); }
p { margin: 0; font: 400 12px/18px var(--font-sans); color: var(--ink-2); }
.caps { display: flex; flex-wrap: wrap; gap: 4px; }
.caps span { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border-radius: 6px; background: var(--solid); font: 400 11px/1 var(--font-sans); color: var(--ink-2); }
.rc.open .caps span { background: var(--fill-1); }
.caps .nv-i { width: 12px; height: 12px; color: var(--ink-3); }
.acts { display: flex; align-items: center; gap: 6px; margin-top: auto; }
.acts .r { margin-left: auto; display: flex; gap: 6px; }
.added { display: inline-flex; align-items: center; gap: 6px; font: 500 12px/1 var(--font-sans); }
.added i { width: 6px; height: 6px; border-radius: 50%; background: var(--ink); }
.lk { background: var(--solid); color: var(--ink); text-decoration: none; }
.rc.open .lk { background: var(--fill-1); }
.lk:hover { background: var(--fill-2); }
.lk .nv-i { width: 13px; height: 13px; }
.setup { display: flex; flex-direction: column; gap: 10px; animation: sin 220ms var(--ease-out); }
@keyframes sin { from { opacity: 0; transform: translateY(-4px); } }
.steps { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font: 400 11.5px/1 var(--font-sans); color: var(--ink-2); }
.steps b { width: 18px; height: 18px; border-radius: 50%; background: var(--accent); color: var(--on-accent); font: 500 10.5px/18px var(--font-mono); text-align: center; }
.steps i { width: 14px; height: 1px; background: var(--ink-4); }
.row { display: flex; align-items: center; gap: 6px; }
.inp { flex: 1; min-width: 0; height: 32px; display: flex; align-items: center; gap: 6px; padding: 0 4px 0 10px; border-radius: 8px; background: var(--fill-1); color: var(--ink-3); transition: background 160ms; }
.inp:focus-within { background: var(--fill-2); }
.inp > .nv-i { width: 13px; height: 13px; flex: none; }
.inp input { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; font: 400 12px/1 var(--font-mono); color: var(--ink); }
.inp input::placeholder { font-family: var(--font-sans); color: var(--ink-4); }
.ib { width: 24px; height: 24px; border: 0; padding: 0; border-radius: 6px; background: transparent; color: var(--ink-3); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.ib:hover { background: var(--solid); color: var(--ink); }
.ib .nv-i { width: 13px; height: 13px; }
.khint { font: 400 11px/15px var(--font-sans); color: var(--ink-3); }
.links { flex-wrap: wrap; }
.fold { margin-left: auto; }
.spin.xs { width: 12px; height: 12px; border-width: 1.2px; }
@media (prefers-reduced-motion: reduce) { .rc, .setup { animation: none; } }
</style>
