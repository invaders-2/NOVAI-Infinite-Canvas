<script setup>
// 平台切换下拉（旧左侧平台栏）：搜索、分组列表（自定义 / CLI 可拖拽排序）、新增平台（类型菜单）、推荐 API、CLI 快捷添加、存储设置入口、设为首选
import { ref, computed, inject, watch, nextTick, onMounted } from 'vue';
import AIcon from './AIcon.vue';
import { t } from '../../../../lib/store.js';
import { isFixedProvider, hasUsableKey } from '../core/helpers.js';
import { providerGroupOf } from '../core/useApiStore.js';

const store = inject('apiStore');
const S = store.S;
const emit = defineEmits(['close']);
const q = ref('');
const searchEl = ref(null);
const addOpen = ref(false);
const cliEl = ref(null);
const flash = ref(false);

const GROUP_LABEL = { builtin: '内置平台', custom: '自定义', cli: '本机 CLI' };
const FIXED_PILL = { modelscope: 'OpenAI', runninghub: 'RH', volcengine: 'Ark' };
function pill(p) { return FIXED_PILL[p.id] || (p.id === 'runninghub' ? 'RH' : String(p.protocol || 'openai').toUpperCase()); }
function meta(p) {
    const n = (p.image_models || []).length + (p.chat_models || []).length + (p.video_models || []).length;
    if (!hasUsableKey(p)) return '未配置 Key';
    return n ? `${n} 个模型` : '尚无模型';
}
// 绿点 = 已填 Key 可用；空心 = 没填 Key（生成面板里也不会出现）；淡 = 已停用
function statusText(p) { return p.enabled === false ? '已停用' : hasUsableKey(p) ? '已配置 Key' : '未配置 Key'; }
function stateClass(p) { return p.enabled === false ? 'off' : hasUsableKey(p) ? 'ok' : 'miss'; }
const groups = computed(() => {
    const ordered = store.sortedProviders();
    const needle = q.value.trim().toLowerCase();
    return ['builtin', 'custom', 'cli'].map(g => ({
        key: g,
        label: GROUP_LABEL[g],
        items: ordered.filter(p => providerGroupOf(p) === g)
            .filter(p => !needle || `${p.name || ''} ${p.id} ${meta(p)} ${pill(p)}`.toLowerCase().includes(needle)),
    })).filter(g => g.items.length);
});
function pick(id) { store.select(id); emit('close'); }
function onEnter() { const first = groups.value[0] && groups.value[0].items[0]; if (first) pick(first.id); }

/* 拖拽排序（只在非内置平台之间） */
const dragId = ref('');
const overId = ref('');
function dragStart(e, p) {
    if (isFixedProvider(p)) { e.preventDefault(); return; }
    dragId.value = p.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', p.id);
}
function dragOver(e, p) {
    if (!dragId.value || dragId.value === p.id || isFixedProvider(p)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    overId.value = p.id;
}
function drop(e, p) {
    e.preventDefault();
    const src = dragId.value || e.dataTransfer.getData('text/plain');
    dragId.value = ''; overId.value = '';
    store.moveProvider(src, p.id);
}
function dragEnd() { dragId.value = ''; overId.value = ''; }

function choose(kind) { addOpen.value = false; store.chooseAddProvider(kind); if (kind !== 'cli') emit('close'); }
function onMenuDown(e) { if (addOpen.value && !e.target.closest('.addmenu, .addbtn')) addOpen.value = false; }
function onKey(e) { if (e.key === 'Escape' && addOpen.value) { e.stopPropagation(); addOpen.value = false; } }

watch(() => S.cliFlash, () => {
    flash.value = false;
    nextTick(() => {
        if (cliEl.value) cliEl.value.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        requestAnimationFrame(() => { flash.value = true; setTimeout(() => { flash.value = false; }, 1200); });
    });
});
onMounted(() => { setTimeout(() => searchEl.value && searchEl.value.focus({ preventScroll: true }), 30); });
</script>

<template>
    <div class="sw nv-root nv-glass-pop" data-glide=".prow, .opt" role="dialog" aria-label="切换平台" @mousedown="onMenuDown" @keydown="onKey">
        <label class="search"><AIcon name="search" /><input ref="searchEl" v-model="q" type="search" placeholder="搜索平台" autocomplete="off" @keydown.enter.prevent="onEnter"></label>
        <div class="list">
            <template v-for="g in groups" :key="g.key">
                <div class="plabel">{{ g.label }}</div>
                <TransitionGroup tag="div" name="prow" class="rows">
                    <div v-for="p in g.items" :key="p.id" class="prow" role="button" tabindex="0"
                         :class="[stateClass(p), { on: p.id === S.selectedId && S.view === 'provider', fixed: isFixedProvider(p), dragging: dragId === p.id, over: overId === p.id }]"
                         :draggable="!isFixedProvider(p)" :title="statusText(p)"
                         @click="pick(p.id)" @keydown.enter.prevent="pick(p.id)"
                         @dragstart="dragStart($event, p)" @dragover="dragOver($event, p)" @drop="drop($event, p)" @dragend="dragEnd" @dragleave="overId = overId === p.id ? '' : overId">
                        <span v-if="!isFixedProvider(p)" class="grip" aria-hidden="true"><AIcon name="grip" /></span>
                        <span v-if="!isFixedProvider(p)" class="mk"><AIcon :name="g.key === 'cli' ? 'terminal' : 'key'" /></span>
                        <span class="nm"><b>{{ p.name || p.id }}</b><span v-if="!isFixedProvider(p)">{{ meta(p) }}</span></span>
                        <span v-if="p.primary" class="prim">{{ t('api.primaryBadge', '首选') }}</span>
                        <button v-else type="button" class="setprim" :title="t('api.setPrimary', '设为首选')" :aria-label="t('api.setPrimary', '设为首选')" @click.stop="store.setPrimary(p.id)"><AIcon name="star" /></button>
                        <span class="dot" :aria-label="statusText(p)"></span>
                        <span class="proto">{{ pill(p) }}</span>
                    </div>
                </TransitionGroup>
            </template>
            <div v-if="!groups.length" class="none">没有匹配「{{ q.trim() }}」的平台</div>
        </div>

        <div class="foot">
            <button type="button" class="nv-btn sm primary addbtn" :class="{ on: addOpen }" :aria-expanded="addOpen" @click="addOpen = !addOpen"><AIcon name="plus" />{{ t('api.addProvider', '新增平台') }}</button>
            <button type="button" class="nv-btn sm" :class="{ cur: S.view === 'recommend' }" @click="store.openRecommend(); emit('close')"><AIcon name="sparkles" />{{ t('api.recommendApi', '推荐API') }}</button>
            <Transition name="menu">
                <div v-if="addOpen" class="addmenu nv-menu" role="menu">
                    <button type="button" class="opt" role="menuitem" @click="choose('openai')"><AIcon name="bolt" /><span><b>OpenAI 兼容</b><em>大多数中转站与官方 API</em></span></button>
                    <button type="button" class="opt" role="menuitem" @click="choose('apimart')"><AIcon name="clock" /><span><b>异步任务协议</b><em>提交任务后轮询结果，如 APIMart</em></span></button>
                    <button type="button" class="opt" role="menuitem" @click="choose('cli')"><AIcon name="terminal" /><span><b>本机 CLI</b><em>即梦 / GPT / Antigravity，使用本机登录态</em></span></button>
                    <button type="button" class="opt" role="menuitem" @click="choose('recommend')"><AIcon name="sparkles" /><span><b>从推荐 API 选择</b><em>一键套用已验证的平台配置</em></span></button>
                </div>
            </Transition>
        </div>

        <div ref="cliEl" class="grp" :class="{ flash }">
            <div class="plabel">{{ t('api.cliSettings', 'CLI 设置') }}</div>
            <div class="qrow">
                <button type="button" class="qbtn" @click="store.addCliProvider('jimeng')"><AIcon name="image" />即梦 CLI</button>
                <button type="button" class="qbtn" @click="store.addCliProvider('codex')"><AIcon name="terminal" />GPT CLI</button>
                <button type="button" class="qbtn" @click="store.addCliProvider('gemini-cli')"><AIcon name="sparkles" />Antigravity CLI</button>
            </div>
            <div class="note">需要先安装 CLI文件夹中的依赖。</div>
        </div>
        <div class="grp">
            <div class="plabel">存储设置</div>
            <div class="qrow"><button type="button" class="qbtn" :class="{ on: S.view === 'storage' }" @click="store.showStorage()"><AIcon name="folder" />输出目录</button></div>
        </div>
    </div>
</template>

<style scoped>
.sw { position: relative; width: 300px; max-height: min(640px, calc(100vh - 180px)); overflow-y: auto; overscroll-behavior: contain; padding: 8px; border-radius: 16px; background: var(--solid); box-shadow: var(--shadow-pop); display: flex; flex-direction: column; gap: 2px; scrollbar-width: none; }
.sw::-webkit-scrollbar { display: none; }
.search { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 10px; border-radius: 9px; background: var(--fill-1); color: var(--ink-3); flex: none; }
.search .nv-i { width: 14px; height: 14px; }
.search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; font: 400 12.5px/1 var(--font-sans); color: var(--ink); }
.search input::placeholder { color: var(--ink-4); }
.plabel { padding: 10px 10px 4px; font: 400 10.5px/14px var(--font-mono); letter-spacing: .05em; color: var(--ink-3); text-transform: uppercase; }
.rows { display: flex; flex-direction: column; gap: 2px; }
.prow { position: relative; display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 10px; border-radius: 10px; cursor: pointer; color: var(--ink); outline: none; transition: background var(--duration-instant) linear, opacity 160ms; }
.prow:hover, .prow:focus-visible { background: var(--fill-1); }
.prow.on { background: var(--fill-2); }
.prow.dragging { opacity: .45; }
.prow.over { background: var(--fill-3); }
.grip { width: 12px; color: var(--ink-4); display: inline-flex; cursor: grab; flex: none; }
.grip .nv-i { width: 12px; height: 12px; }
.mk { width: 26px; height: 26px; border-radius: 8px; background: var(--solid); display: inline-flex; align-items: center; justify-content: center; flex: none; box-shadow: 0 1px 3px rgba(0,0,0,.08); color: var(--ink-2); }
.mk .nv-i { width: 13px; height: 13px; }
.nm { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.nm b { font: 500 12.5px/16px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.prow.fixed .nm b { font-weight: 400; font-size: 13px; }
.nm span { font: 400 11px/14px var(--font-sans); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ink); flex: none; }
.prow.miss .dot { background: transparent; box-shadow: inset 0 0 0 1.2px var(--ink-4); }
.prow.off .dot { background: var(--ink-4); }
.proto { height: 18px; padding: 0 6px; border-radius: 5px; background: var(--fill-2); font: 400 11px/18px var(--font-mono); letter-spacing: .04em; color: var(--ink-2); text-transform: uppercase; flex: none; }
.prim { height: 18px; padding: 0 6px; border-radius: 5px; background: var(--accent); color: var(--on-accent); font: 400 10.5px/18px var(--font-sans); flex: none; }
.setprim { width: 22px; height: 22px; border: 0; padding: 0; border-radius: 6px; background: transparent; color: var(--ink-3); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; opacity: 0; transition: opacity 120ms, background 120ms; flex: none; }
.setprim .nv-i { width: 13px; height: 13px; }
.prow:hover .setprim, .setprim:focus-visible { opacity: 1; }
.setprim:hover { background: var(--fill-2); color: var(--ink); }
.none { padding: 18px 10px; font: 400 12px/16px var(--font-sans); color: var(--ink-3); text-align: center; }
.foot { position: relative; display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 8px 2px 2px; }
.foot .nv-btn { width: 100%; }
.foot .nv-btn.cur { background: var(--fill-3); }
.addmenu { position: absolute; left: 2px; right: 2px; bottom: calc(100% + 6px); z-index: 2; min-width: 0; padding: 6px; }
.opt { display: flex; align-items: flex-start; gap: 10px; padding: 9px 10px; border: 0; border-radius: 10px; background: transparent; text-align: left; cursor: pointer; color: var(--ink); }
.opt:hover, .opt:focus-visible { background: var(--fill-1); outline: none; }
.opt .nv-i { width: 15px; height: 15px; color: var(--ink-2); margin-top: 2px; }
.opt b { display: block; font: 500 12.5px/17px var(--font-sans); }
.opt em { display: block; font: normal 400 11px/15px var(--font-sans); color: var(--ink-3); }
.grp { padding: 2px 0; border-radius: 12px; transition: background 240ms; }
.qrow { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 4px; }
.qbtn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 0; border-radius: 8px; background: var(--fill-1); font: 400 12px/1 var(--font-sans); color: var(--ink); white-space: nowrap; cursor: pointer; transition: background 120ms; }
.qbtn:hover { background: var(--fill-2); }
.qbtn.on { background: var(--fill-3); }
.qbtn .nv-i { width: 13px; height: 13px; color: var(--ink-3); }
.grp.flash .qbtn { animation: qflash 1.1s var(--ease-out); }
@keyframes qflash { 0%, 60% { background: var(--fill-3); } 100% { background: var(--fill-1); } }
.note { padding: 6px 8px 2px; font: 400 11px/15px var(--font-sans); color: var(--ink-3); }
.menu-enter-active { transition: opacity 140ms var(--ease-out), transform 140ms var(--ease-out); }
.menu-leave-active { transition: opacity 100ms linear; }
.menu-enter-from { opacity: 0; transform: translateY(4px); }
.menu-leave-to { opacity: 0; }
.prow-move { transition: transform 220ms cubic-bezier(.22,1,.36,1); }
.prow-enter-active { transition: opacity 200ms var(--ease-out), transform 200ms var(--ease-out); }
.prow-enter-from { opacity: 0; transform: translateY(-4px); }
.prow-leave-active { display: none; }
</style>
