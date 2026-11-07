<script setup>
// 设置 → API 与模型（2026-11 按原型）：这里只放平台总览，点一个平台打开「API 设置」管理弹窗。
// 弹窗左栏是平台列表（复用 PlatformSwitcher 的 inline 形态），右边就是原来的 ApiSettingsPanel；总览和弹窗共用一个 store，
// 所以弹窗里保存后总览立刻刷新，不用再拉一次。
import { ref, computed, provide, onMounted, onBeforeUnmount } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import SetCard from './SetCard.vue';
import ApiSettingsPanel from './ApiSettingsPanel.vue';
import PlatformSwitcher from './api/parts/PlatformSwitcher.vue';
import ProtocolUpdateDialog from './api/parts/ProtocolUpdateDialog.vue';
import { createApiStore, providerGroupOf } from './api/core/useApiStore.js';
import { hasUsableKey, isCliProtocol } from './api/core/helpers.js';

const store = createApiStore();
const S = store.S;
provide('apiStore', store);
provide('apiInline', true);

const open = ref(false);
const list = computed(() => store.sortedProviders());
const GROUP = { builtin: '内置', custom: '自定义', cli: '本机 CLI' };
const PROTO = { openai: 'OpenAI 兼容', apimart: '异步任务协议', runninghub: '应用与工作流', volcengine: '火山方舟', lovart: 'Lovart', jimeng: '本机 CLI', codex: '本机 CLI', 'gemini-cli': '本机 CLI' };
function protoLabel(p) { return PROTO[String(p.protocol || '').toLowerCase()] || GROUP[providerGroupOf(p)] || 'OpenAI 兼容'; }
function models(p) {
    const parts = [['图片', p.image_models], ['视频', p.video_models], ['对话', p.chat_models], ['音频', p.audio_models]]
        .map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]).filter(([, n]) => n).map(([k, n]) => k + ' ' + n);
    return parts.length ? parts.join(' · ') : '还没有模型';
}
function status(p) {
    if (p.enabled === false) return { text: '已停用', cls: 'off' };
    if (isCliProtocol(p.protocol)) return { text: '本机登录态', cls: 'ok' };
    return hasUsableKey(p) ? { text: '可用', cls: 'ok' } : { text: '未填 Key', cls: 'miss' };
}

// 配置/协议可更新：只有接口下发了 available=true 才显示提醒，一条都没有就什么都不显示
function updOf(p) { return store.updateOf(p.id); }
function openUpdate(id) { store.openUpdate(id); }

function openProvider(id) { store.select(id); open.value = true; }
function openView(view) {
    if (view === 'recommend') store.openRecommend();
    else if (view === 'storage') store.showStorage();
    else if (view === 'cli') { S.view = 'provider'; setTimeout(() => { S.cliFlash++; }, 260); }
    open.value = true;
}
function addNew() { store.chooseAddProvider('openai'); open.value = true; }
async function closeDlg() {
    if (S.dirty || S.childDirty) {
        const ok = await store.ask({ title: '有未保存的修改', desc: '关闭后这次的修改不会保存。', ok: '放弃修改' });
        if (!ok) return;
        await store.reload();
    }
    S.switcherOpen = false;
    open.value = false;
}
function onKey(e) {
    if (e.key !== 'Escape' || !open.value || S.confirm) return;
    // 弹窗里还有自己的浮层（下拉、模型选择）时交给它们先关
    if (document.querySelector('.ks-menu, .am-scrim, .apid-scrim')) return;
    e.stopPropagation(); closeDlg();
}
onMounted(() => { store.load(); window.addEventListener('keydown', onKey, true); });
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
    <div class="ao">
        <SetCard title="平台">
            <template #action><button type="button" class="nv-btn sm" @click="addNew"><NvIcon name="plus" />新增平台</button></template>
            <div v-if="!S.loaded" class="ld">
                <template v-if="S.loadFailed"><span>API 平台加载失败</span><button type="button" class="nv-btn sm" @click="store.load()">重试</button></template>
                <template v-else><div class="nv-skel"></div><div class="nv-skel"></div><div class="nv-skel"></div></template>
            </div>
            <button v-for="p in list" v-else :key="p.id" type="button" class="row" @click="openProvider(p.id)">
                <span class="lead"><NvIcon :name="providerGroupOf(p) === 'cli' ? 'terminal' : 'key'" /></span>
                <span class="tx">
                    <b>
                        {{ p.name || p.id }}<span v-if="p.primary" class="prim"><NvIcon name="star" />首选</span>
                        <span v-if="updOf(p)" class="upd" role="button" tabindex="0" title="协议/配置可更新" @click.stop="openUpdate(p.id)" @keydown.enter.stop.prevent="openUpdate(p.id)"><i></i>协议/配置可更新</span>
                    </b>
                    <small>{{ protoLabel(p) }} · {{ models(p) }}</small>
                </span>
                <span class="stt" :class="status(p).cls"><i></i>{{ status(p).text }}</span>
                <NvIcon name="chevr" class="chev" />
            </button>
        </SetCard>
        <SetCard title="更多" desc="推荐平台一键套用；即梦 / GPT / Antigravity 走本机登录态，不需要 Key。">
            <button type="button" class="row" @click="openView('recommend')"><span class="lead"><NvIcon name="sparkles" /></span><span class="tx"><b>推荐 API</b><small>已验证可用的平台，选一个填 Key 即可开始生成</small></span><NvIcon name="chevr" class="chev" /></button>
            <button type="button" class="row" @click="openView('cli')"><span class="lead"><NvIcon name="terminal" /></span><span class="tx"><b>CLI 设置</b><small>即梦 / GPT / Antigravity，使用本机登录态</small></span><NvIcon name="chevr" class="chev" /></button>
            <button type="button" class="row" @click="openView('storage')"><span class="lead"><NvIcon name="folder" /></span><span class="tx"><b>生成文件目录</b><small>生成的图片、视频保存在哪里，修改后需重启生效</small></span><NvIcon name="chevr" class="chev" /></button>
        </SetCard>

        <Teleport to="#nv-layer">
            <Transition name="apm">
                <div v-if="open" class="apm-scrim" @mousedown.self="closeDlg">
                    <div class="apm" role="dialog" aria-modal="true" aria-label="API 设置">
                        <aside class="apm-side">
                            <h4>API 设置</h4>
                            <PlatformSwitcher inline />
                        </aside>
                        <section class="apm-main"><ApiSettingsPanel :store="store" /></section>
                        <button type="button" class="nv-icon-btn sm round apm-x" aria-label="关闭" @click="closeDlg"><NvIcon name="x" /></button>
                    </div>
                </div>
            </Transition>
        </Teleport>
        <ProtocolUpdateDialog />
    </div>
</template>

<style scoped>
.ao :deep(.sc-b) { padding: 4px 6px; }
.row { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 58px; padding: 8px 10px; border: 0; border-radius: 10px; background: transparent; text-align: left; cursor: pointer; color: var(--ink); transition: background var(--duration-fast); }
.row + .row { box-shadow: 0 -1px 0 var(--separator); }
.row:hover { background: var(--fill-2); box-shadow: none; }
.row:hover + .row { box-shadow: none; }
.lead { width: 32px; height: 32px; border-radius: 9px; background: var(--solid); display: inline-flex; align-items: center; justify-content: center; color: var(--ink-2); flex: none; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
.lead .nv-i { width: 14px; height: 14px; }
.tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.tx b { display: flex; align-items: center; gap: 8px; font: 500 13px/18px var(--font-sans); min-width: 0; }
.tx small { font: 400 11.5px/16px var(--font-sans); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.prim { display: inline-flex; align-items: center; gap: 3px; height: 18px; padding: 0 7px; border-radius: 9px; background: var(--fill-2); font: 400 10.5px/1 var(--font-sans); color: var(--ink-2); flex: none; }
.prim .nv-i { width: 10px; height: 10px; }
/* 配置/协议可更新：半透明软底 + 文字提亮 + 小圆点，不描边 */
.upd { display: inline-flex; align-items: center; gap: 5px; height: 18px; padding: 0 7px; border-radius: 9px; background: var(--fill-2); font: 500 10.5px/1 var(--font-sans); color: var(--ink); flex: none; cursor: pointer; transition: background var(--duration-fast); }
.upd i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.upd:hover { background: var(--fill-3); }
.stt { display: inline-flex; align-items: center; gap: 6px; font: 400 12px/1 var(--font-sans); color: var(--ink-2); white-space: nowrap; flex: none; }
.stt i { width: 6px; height: 6px; border-radius: 50%; background: var(--ink); }
.stt.miss { color: var(--ink-3); }
.stt.miss i { background: transparent; box-shadow: inset 0 0 0 1.2px var(--ink-4); }
.stt.off { color: var(--ink-4); }
.stt.off i { background: var(--ink-4); }
.chev { width: 14px; height: 14px; color: var(--ink-4); flex: none; }
.ld { display: flex; flex-direction: column; gap: 8px; padding: 10px; font: 400 12.5px/18px var(--font-sans); color: var(--ink-2); }
.ld .nv-skel { height: 44px; border-radius: 10px; }
.ld .nv-btn { align-self: flex-start; }

/* 管理弹窗：压在设置弹窗（2200）之上，低于 API 面板自己的对话框（2300）和下拉（2400） */
.apm-scrim { position: fixed; inset: 0; z-index: 2260; display: flex; align-items: center; justify-content: center; padding: 20px; background: var(--scrim); font-family: var(--font-sans); color: var(--ink); }
.apm { position: relative; width: min(1100px, 100%); height: min(760px, 100%); display: flex; border-radius: 22px; background: var(--solid); box-shadow: var(--shadow-dialog); overflow: hidden; }
.apm-side { width: 272px; flex: none; display: flex; flex-direction: column; gap: 10px; padding: 22px 12px 14px; background: var(--fill-1); min-height: 0; }
.apm-side h4 { margin: 0; padding: 0 8px; font: 500 16px/22px var(--font-sans); letter-spacing: -.01em; }
.apm-side :deep(.sw) { flex: 1; min-height: 0; overflow-y: auto; }
.apm-main { position: relative; flex: 1; min-width: 0; }
.apm-main :deep(.api) { padding-right: 64px; }
.apm-x { position: absolute; right: 14px; top: 14px; z-index: 60; }
.nv-icon-btn.apm-x, .nv-icon-btn.apm-x:hover { background: transparent; }
.apm-enter-active, .apm-leave-active { transition: opacity var(--duration-base) var(--ease-out); }
.apm-enter-active .apm { animation: nv-dialog-in var(--duration-slow) var(--ease-sheet) both; }
.apm-enter-from, .apm-leave-to { opacity: 0; }
@media (max-width: 820px) { .apm-side { display: none; } .apm-main :deep(.api) { padding-right: 20px; } }
</style>
