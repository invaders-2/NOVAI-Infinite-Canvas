<script setup>
// 「从上游拉取的模型清单」弹窗：每个模型只归一类（已配置 > 上游建议 > 默认聊天），勾选 = 纳入该分类；应用后覆盖三组模型列表
import { ref, reactive, computed, inject, watch } from 'vue';
import AIcon from './AIcon.vue';
import ApiModal from './ApiModal.vue';
import { modelDisplayName, modelBadge } from '../core/helpers.js';

const store = inject('apiStore');
const S = store.S;
const it = store.item;
const st = reactive({ category: {}, selected: {} });
const filter = ref('');
const cat = ref('all');

watch(() => S.pickerOpen, open => {
    if (!open) return;
    const p = it.value; if (!p) return;
    const ex = { image: new Set(p.image_models || []), chat: new Set(p.chat_models || []), video: new Set(p.video_models || []) };
    const sug = S.fetched.suggestion || {};
    const all = new Set([...S.fetched.all, ...(p.image_models || []), ...(p.chat_models || []), ...(p.video_models || [])]);
    const category = {}, selected = {};
    all.forEach(id => {
        category[id] = ex.image.has(id) ? 'image' : ex.video.has(id) ? 'video' : ex.chat.has(id) ? 'chat'
            : (sug.image && sug.image.has(id)) ? 'image' : (sug.video && sug.video.has(id)) ? 'video' : 'chat';
        // 已在配置里的默认勾选；新拉的不勾选，让用户主动选
        selected[id] = ex.image.has(id) || ex.chat.has(id) || ex.video.has(id);
    });
    st.category = category; st.selected = selected;
    filter.value = ''; cat.value = 'all';
});

const ids = computed(() => Object.keys(st.category).sort());
const stats = computed(() => {
    const totals = { all: ids.value.length, image: 0, chat: 0, video: 0 };
    const sel = { all: 0, image: 0, chat: 0, video: 0 };
    ids.value.forEach(id => { const c = st.category[id]; totals[c]++; if (st.selected[id]) { sel[c]++; sel.all++; } });
    return { totals, sel };
});
const list = computed(() => {
    const p = it.value;
    const q = filter.value.trim().toLowerCase();
    return ids.value.map(id => {
        const label = modelDisplayName(id, p, S.fetched.names);
        return { id, label: label || id, sub: label && label !== id ? id : '', badge: modelBadge(id, label, p) };
    }).filter(r => (!q || r.id.toLowerCase().includes(q) || r.label.toLowerCase().includes(q)) && (cat.value === 'all' || st.category[r.id] === cat.value));
});
const TABS = [{ k: 'all', label: '全部' }, { k: 'image', label: '生图' }, { k: 'chat', label: 'LLM' }, { k: 'video', label: '视频' }];
function toggle(id) { st.selected[id] = !st.selected[id]; }
function close() { S.pickerOpen = false; }
function apply() {
    const p = it.value; if (!p) return;
    const image = [], chat = [], video = [], names = {};
    Object.entries(st.selected).forEach(([id, on]) => {
        if (!on) return;
        const c = st.category[id];
        if (c === 'image') image.push(id); else if (c === 'video') video.push(id); else chat.push(id);
        const label = modelDisplayName(id, p, S.fetched.names);
        if (label && label !== id) names[id] = label;
    });
    store.applyPicker(image, chat, video, names);
}
</script>

<template>
    <ApiModal :open="S.pickerOpen" :width="560" label="从上游拉取的模型清单" @close="close">
        <div class="pk">
            <div class="hd">
                <div><h3>从上游拉取的模型清单</h3><p>共 {{ stats.totals.all }} 个模型 · 当前显示 {{ list.length }} 个</p></div>
                <button type="button" class="nv-icon-btn sm round x" title="关闭" aria-label="关闭" @click="close"><AIcon name="x" /></button>
            </div>
            <div class="tools">
                <label class="search"><AIcon name="search" /><input v-model="filter" type="text" placeholder="按名称搜索模型…" spellcheck="false"></label>
                <div class="tabs" role="tablist">
                    <button v-for="x in TABS" :key="x.k" type="button" role="tab" :class="{ on: cat === x.k }" :aria-selected="cat === x.k" @click="cat = x.k">{{ x.label }}<em>{{ stats.sel[x.k] }}/{{ stats.totals[x.k] }}</em></button>
                </div>
            </div>
            <div class="body">
                <button v-for="r in list" :key="r.id" type="button" class="row" :class="{ on: st.selected[r.id] }" :title="r.id" @click="toggle(r.id)">
                    <span class="ck" :class="{ on: st.selected[r.id] }"><AIcon v-if="st.selected[r.id]" name="check" /></span>
                    <span class="bdg">{{ r.badge }}</span>
                    <span class="nm"><b>{{ r.label }}</b><span v-if="r.sub">{{ r.sub }}</span></span>
                </button>
                <div v-if="!list.length" class="none">无匹配</div>
            </div>
            <div class="sum">
                <span class="lbl">将应用：</span>
                <span class="chip" :class="{ empty: !stats.sel.image }">生图 {{ stats.sel.image }}</span>
                <span class="chip" :class="{ empty: !stats.sel.chat }">LLM {{ stats.sel.chat }}</span>
                <span class="chip" :class="{ empty: !stats.sel.video }">视频 {{ stats.sel.video }}</span>
                <span class="un">未选 {{ stats.totals.all - stats.sel.all }}</span>
            </div>
            <div class="ft">
                <button type="button" class="nv-btn sm ghost" @click="close">取消</button>
                <button type="button" class="nv-btn sm primary" @click="apply">应用到模型列表</button>
            </div>
        </div>
    </ApiModal>
</template>

<style scoped>
.pk { display: flex; flex-direction: column; min-height: 0; max-height: min(720px, calc(100vh - 48px)); }
.hd { display: flex; align-items: flex-start; gap: 12px; padding: 20px 20px 12px 24px; }
.hd > div { flex: 1; min-width: 0; }
h3 { margin: 0; font: 500 15px/22px var(--font-sans); }
.hd p { margin: 2px 0 0; font: 400 11.5px/16px var(--font-sans); color: var(--ink-3); }
.x { background: var(--fill-1); }
.tools { display: flex; flex-direction: column; gap: 10px; padding: 0 24px 10px; }
.search { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px; border-radius: 10px; background: var(--fill-1); color: var(--ink-3); }
.search .nv-i { width: 14px; height: 14px; }
.search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; font: 400 12.5px/1 var(--font-sans); color: var(--ink); }
.tabs { display: inline-flex; align-self: flex-start; gap: 2px; padding: 2px; border-radius: 10px; background: var(--fill-1); }
.tabs button { height: 28px; padding: 0 12px; border: 0; border-radius: 8px; background: transparent; font: 400 12px/1 var(--font-sans); color: var(--ink-3); cursor: pointer; transition: background 140ms, color 140ms; }
.tabs button em { font: normal 400 10.5px/1 var(--font-mono); color: var(--ink-4); margin-left: 6px; }
.tabs button:hover { color: var(--ink); }
.tabs button.on { background: var(--solid); color: var(--ink); font-weight: 500; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.tabs button.on em { color: var(--ink-3); }
.body { flex: 1; min-height: 120px; overflow-y: auto; padding: 0 24px; display: flex; flex-direction: column; gap: 4px; overscroll-behavior: contain; }
.row { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 12px; border: 0; border-radius: 10px; background: transparent; text-align: left; cursor: pointer; color: var(--ink); flex: none; transition: background 120ms; }
.row:hover { background: var(--fill-1); }
.row.on { background: var(--fill-1); }
.ck { width: 16px; height: 16px; border-radius: 5px; box-shadow: inset 0 0 0 1.5px var(--ink-4); display: inline-flex; align-items: center; justify-content: center; flex: none; transition: background 120ms, box-shadow 120ms; }
.ck.on { background: var(--accent); color: var(--on-accent); box-shadow: none; }
.ck .nv-i { width: 11px; height: 11px; stroke-width: 2.2; }
.bdg { min-width: 44px; height: 20px; padding: 0 6px; border-radius: 6px; background: var(--fill-2); font: 400 11px/20px var(--font-mono); text-align: center; color: var(--ink-2); flex: none; }
.nm { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.nm b { font: 500 12.5px/16px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nm span { font: 400 10.5px/14px var(--font-mono); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.none { padding: 32px; text-align: center; color: var(--ink-4); font: 400 12px/1 var(--font-sans); }
.sum { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 10px 16px 0; padding: 10px 8px 0; font: 400 11.5px/1 var(--font-sans); color: var(--ink-3); }
.chip { height: 22px; padding: 0 8px; border-radius: 99px; background: var(--accent); color: var(--on-accent); font: 400 11px/22px var(--font-sans); }
.chip.empty { background: var(--fill-2); color: var(--ink-3); }
.un { margin-left: auto; color: var(--ink-4); }
.ft { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 24px 20px; }
</style>
