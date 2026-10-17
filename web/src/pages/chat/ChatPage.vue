<script setup>
// GPT 对话（页面 id: gpt-chat，替换旧 static/gpt-chat.html）。
// 顶栏：会话标题 · 「对话 / 智能体 / 图像」切换 · 新建对话 · 系统提示词 · 历史对话；
// 正文区：消息列表，或「全部智能体 / 全部技能」网格视图（输入框始终在底部）；
// 悬浮输入框（Composer）+ 图片预览（ImagePreview）。数据与接口见 chatState / session / library / agents。
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import ChIcon from './ChIcon.vue';
import MessageList from './MessageList.vue';
import Composer from './Composer.vue';
import HistoryPop from './HistoryPop.vue';
import SystemPromptPop from './SystemPromptPop.vue';
import ImagePreview from './ImagePreview.vue';
import CapabilitySquare from './agents/CapabilitySquare.vue';
import OpenClawInstallModal from './agents/OpenClawInstallModal.vue';
import { S, setMode, loadConfig, normalizeSize } from './chatState.js';
import { C, newConversation, initSession, loadConversations } from './session.js';
import { loadPersonas, loadMemories, syncPersonaState } from './library.js';
import { CAP, openSquare, closeSquare, closePanel, selectCapability } from './agents/capState.js';
import { ensureStatus } from './agents/openclawSetup.js';
import { closeAllPops } from './usePop.js';
import { state, t } from '../../lib/store.js';

// 智能体 / 技能不再是独立页面：顶栏与输入框的入口都在正文区打开同一个网格视图，选中后挂成输入框里的 chip
const root = ref(null);
const cmpWrap = ref(null);
const composer = ref(null);
const histBtn = ref(null);
const sysBtn = ref(null);
const histPop = ref(null);
const sysPop = ref(null);
const histOpen = ref(false);
const sysOpen = ref(false);
const preview = ref('');
const active = computed(() => state.active === 'gpt-chat');
// 切到别的页面时收起所有弹层（输入框弹层 / 看图 Teleport 在 body 上，不随 v-show 隐藏）
watch(active, v => { if (!v) { closeAllPops(); histOpen.value = false; sysOpen.value = false; closeSquare(); closePanel(); preview.value = ''; } });

const title = computed(() => {
    const tt = C.current && C.current.title;
    return !tt || tt === '新对话' || tt === 'New Chat' ? t('chat.newConversation', '新对话') : tt;
});

function pickMode(id) { closeAllPops(); histOpen.value = false; sysOpen.value = false; closeSquare(); setMode(id); }
function openAgents() {
    histOpen.value = false;
    sysOpen.value = false;
    closeAllPops();
    // 用到 OpenClaw 的地方才探测一次（不在应用启动时探测，避免拖慢启动）
    ensureStatus(false);
    if (CAP.square === 'agent') closeSquare();
    else openSquare('agent');
}
function pickCap(cap) {
    selectCapability(cap);
    if (composer.value) composer.value.focus();
}
function toggleHistory(force) {
    histOpen.value = typeof force === 'boolean' ? force : !histOpen.value;
    if (histOpen.value) { sysOpen.value = false; closeSquare(); }
}
function toggleSystem(force) {
    sysOpen.value = typeof force === 'boolean' ? force : !sysOpen.value;
    if (sysOpen.value) { histOpen.value = false; closeSquare(); syncPersonaState(); }
}
async function createNew() { await newConversation(); histOpen.value = false; closeSquare(); }
function fill(v) { composer.value && composer.value.fill(v); }

// 顶栏两个弹层：点外面 / Esc 关闭
function onDown(e) {
    const inside = (els) => els.some(el => el && el.contains(e.target));
    if (histOpen.value && !inside([histPop.value && histPop.value.$el, histBtn.value])) histOpen.value = false;
    if (sysOpen.value && !inside([sysPop.value && sysPop.value.$el, sysBtn.value])) sysOpen.value = false;
}
function onKey(e) {
    if (e.key !== 'Escape' || preview.value) return;
    histOpen.value = false;
    sysOpen.value = false;
    closeSquare();
    closePanel();
}

// 设置里改了 API 平台 → 重新拉配置（BroadcastChannel，外壳也可能转发成 window message）
let channel = null;
function onMessage(e) { const d = e && e.data; if (d && d.type === 'providers-changed') loadConfig(); }
function onFocus(e) { if (e.detail && e.detail.id === 'gpt-chat') { loadConversations(); loadMemories(); } }

let ro = null;
onMounted(async () => {
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('message', onMessage);
    window.addEventListener('novai-page-focus', onFocus);
    try { channel = new BroadcastChannel('studio-api'); channel.onmessage = onMessage; } catch (err) {}
    if (typeof ResizeObserver !== 'undefined' && cmpWrap.value) {
        ro = new ResizeObserver(() => { if (root.value && cmpWrap.value) root.value.style.setProperty('--cmp-h', cmpWrap.value.offsetHeight + 'px'); });
        ro.observe(cmpWrap.value);
    }
    normalizeSize();
    // 旧版把「Agent」存成对话模式，它已升级为智能体入口：恢复时回到对话
    if (S.mode === 'agent') setMode('chat');
    // 角色库 / 记忆库拉取失败不影响对话
    await Promise.all([loadPersonas().catch(() => {}), loadMemories().catch(() => {})]);
    await loadConfig();
    await initSession();
});
onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('message', onMessage);
    window.removeEventListener('novai-page-focus', onFocus);
    if (channel) channel.close();
    if (ro) ro.disconnect();
});
</script>

<template>
    <div ref="root" class="gc">
        <header class="top">
            <span class="ttl">{{ title }}</span>
            <span class="sub">{{ t('chat.title', 'GPT 对话') }}</span>
            <span class="modes" role="tablist" aria-label="对话模式" data-glide="button" data-glide-active="is-on">
                <button type="button" role="tab" :aria-selected="S.mode === 'chat' && !CAP.square" :class="{ 'is-on': S.mode === 'chat' && !CAP.square }" title="纯文字对话（流式输出）" @click="pickMode('chat')">对话</button>
                <button type="button" role="tab" :aria-selected="CAP.square === 'agent'" :class="{ 'is-on': CAP.square === 'agent' }" title="智能体：在对话里选一个挂上" @click="openAgents()">智能体</button>
                <button type="button" role="tab" :aria-selected="S.mode === 'image' && !CAP.square" :class="{ 'is-on': S.mode === 'image' && !CAP.square }" title="直接生成图片" @click="pickMode('image')">图像</button>
            </span>
            <div class="acts">
                <button type="button" class="nv-icon-btn" :title="t('chat.newConversation', '新建对话')" :aria-label="t('chat.newConversation', '新建对话')" @click="createNew"><ChIcon name="newchat" /></button>
                <button ref="sysBtn" type="button" class="nv-icon-btn" :class="{ 'is-on': sysOpen }" title="系统提示词" aria-label="系统提示词" @click="toggleSystem()"><ChIcon name="settings" /></button>
                <button ref="histBtn" type="button" class="nv-icon-btn" :class="{ 'is-on': histOpen }" :title="t('chat.history', '历史对话')" :aria-label="t('chat.history', '历史对话')" @click="toggleHistory()"><ChIcon name="history" /></button>
            </div>
        </header>

        <div class="body">
            <div class="chat-layer">
                <MessageList v-show="!CAP.square" @preview="u => (preview = u)" @fill="fill" />
                <CapabilitySquare v-if="CAP.square" :kind="CAP.square" @pick="pickCap" @close="closeSquare" />
                <div ref="cmpWrap" class="cmp-wrap">
                    <Composer ref="composer" :active="active" @preview="u => (preview = u)" />
                </div>
            </div>
            <Transition name="pop">
                <SystemPromptPop v-if="sysOpen" ref="sysPop" class="anchor" @close="sysOpen = false" />
            </Transition>
            <Transition name="pop">
                <HistoryPop v-if="histOpen" ref="histPop" class="anchor" @close="histOpen = false" />
            </Transition>
        </div>

        <ImagePreview :url="preview" @close="preview = ''" />
        <OpenClawInstallModal />
    </div>
</template>

<style scoped>
.gc { position: absolute; inset: 0; display: flex; flex-direction: column; overflow: hidden; background: transparent; color: var(--ink); }
.top { position: relative; z-index: 30; flex: none; height: 60px; display: flex; align-items: center; gap: 10px; padding: 0 20px 0 32px; }
.ttl { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 14px/20px var(--font-sans); }
.sub { flex: none; font: 400 11px/1 var(--font-mono); color: var(--ink-3); letter-spacing: .03em; }
.modes { position: relative; flex: none; margin-left: auto; display: inline-flex; gap: 2px; padding: 2px; border-radius: 999px; background: var(--fill-1); --nv-glide-bg: var(--solid); }
.modes button { height: 26px; padding: 0 12px; border: 0; border-radius: 999px; background: transparent; color: var(--ink-3); font: 500 12px/1 var(--font-sans); cursor: pointer; white-space: nowrap; transition: color var(--duration-fast); }
.modes button:hover { color: var(--ink-2); }
.modes button.is-on { background: var(--solid); color: var(--ink); }
.modes :deep(.nv-glide-pill) { border-radius: 999px; box-shadow: var(--shadow-float); }
.acts { flex: none; display: flex; gap: 4px; margin-left: 8px; }
.acts .nv-i { width: 17px; height: 17px; }
.body { position: relative; flex: 1; min-height: 0; }
.chat-layer { position: absolute; inset: 0; }
.cmp-wrap { position: absolute; left: 50%; bottom: 24px; z-index: 20; width: min(760px, calc(100% - 48px)); transform: translateX(-50%); }
.anchor { top: -2px; right: 20px; transform-origin: top right; }
@media (max-width: 720px) { .top { padding: 0 12px 0 16px; } .sub { display: none; } .modes button { padding: 0 9px; } }
</style>

<style>
/* 输入框底栏的选择按钮（尺寸 / 平台模型 / 思考强度）：几个子组件共用，挂全局（ca- 前缀只在本页用） */
.ca-pk { position: relative; height: 32px; padding: 0 10px; border: 0; border-radius: 999px; background: transparent; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; min-width: 0;
    font: 500 12px/1 var(--font-sans); color: var(--ink); white-space: nowrap; transition: background var(--duration-fast); }
.ca-pk:hover { background: var(--fill-1); }
.ca-pk.on { background: var(--fill-2); }
.ca-pk.lite:not(.on) { background: var(--fill-1); }
.ca-pk.lite:not(.on):hover { background: var(--fill-2); }
.ca-pk .nv-i { width: 14px; height: 14px; color: var(--ink-2); flex: none; }
.ca-pk .nv-i.cv { width: 11px; height: 11px; opacity: .6; transition: transform var(--duration-base) var(--ease-out); }
.ca-pk .nv-i.cv.flip { transform: rotate(180deg); }
.ca-pk .k { color: var(--ink-3); font-weight: 400; overflow: hidden; text-overflow: ellipsis; max-width: 120px; }
.ca-pk .d { width: 3px; height: 3px; flex: none; border-radius: 50%; background: var(--ink-4); }
.ca-pk .mm { font: 400 11.5px/1 var(--font-mono); letter-spacing: .01em; overflow: hidden; text-overflow: ellipsis; max-width: 180px; }
</style>
