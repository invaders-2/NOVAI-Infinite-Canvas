<script setup>
// 输入框：附件条（图片缩略 / 文件卡片，最多 20 个，可拖入 / 粘贴 / 「+」选择）、已挂载能力的 chip、
// 自适应高度的文本框（Enter 发送、Shift+Enter 换行）、「智能体」「技能」入口、
// 尺寸（Agent / 图像模式）、平台与模型、思考强度（推理模型）、发送 / 停止。
// 选中能力后输入框顶部换成该能力的表单行（名称 + 提示模板 + 必填标记 + 上传表格 / 查看教程），
// 提示模板与上传类型全部来自能力定义；「+」出子菜单（上传文件或图片 / 选择资产库文件）。
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import ChIcon from './ChIcon.vue';
import SizePicker from './SizePicker.vue';
import ModelPicker from './ModelPicker.vue';
import ThinkPicker from './ThinkPicker.vue';
import CapabilityChip from './agents/CapabilityChip.vue';
import GenImageModelPicker from './agents/GenImageModelPicker.vue';
import SkillPanel from './agents/SkillPanel.vue';
import OpenClawSetupBanner from './agents/OpenClawSetupBanner.vue';
import AssetPicker from './agents/AssetPicker.vue';
import TutorialModal from './agents/TutorialModal.vue';
import { S, setMode, thinkLevels } from './chatState.js';
import { C, send, stop, uploadFiles, removeRef, isImageRef, attachmentName } from './session.js';
import {
    CAP, openSquare, clearCapability, selectCapability, loadCapabilities,
    toggleSkillPanel, closePanel, promptTemplateOf, hasRequiredInput, acceptOf, inputFilesOf, tutorialOf,
    selectGenerateImage, isGenerateImage, capabilityForSuggestion, wantsGeneratedImage,
} from './agents/capState.js';
import { LIST as PLATFORMS, platformsOf, loadPlatforms } from './agents/platforms.js';
import SuggestedQuestions from './agents/SuggestedQuestions.vue';
import { ICONS } from '../../lib/icons.js';
import { usePop, closeAllPops, POP_Z } from './usePop.js';
import { t, toast } from '../../lib/store.js';

const emit = defineEmits(['preview']);
const text = ref('');
const ta = ref(null);
const fileIn = ref(null);
const tableIn = ref(null);
const body = ref(null);
const drag = ref(false);
const assetOpen = ref(false);
const tutorialOpen = ref(false);

// 「智能体」下拉（目录顺序列表 + 查看全部）与「+」子菜单（上传文件或图片 / 选择资产库文件）
const agentBtn = ref(null);
const agentPop = ref(null);
const { open: agentOpen, toggle: toggleAgentMenu, place: placeAgentMenu } = usePop('composer-agent', agentBtn, agentPop, { place: { align: 'left', maxH: 440 } });
const addBtn = ref(null);
const addPop = ref(null);
const { open: addOpen, toggle: toggleAddMenu } = usePop('composer-add', addBtn, addPop, { place: { align: 'left', maxH: 260 } });

const agents = computed(() => CAP.list.filter(c => c.kind === 'agent'));
// 「智能体」弹层里的平台筛选：数据来自 platforms.js（后端 /api/capabilities/platforms，带内置兜底）
const platform = ref('all');
const menuAgents = computed(() => agents.value.filter(a => platform.value === 'all' || platformsOf(a.tags).some(p => p.id === platform.value)));
function choosePlatform(p) { if (p && p.soon) return; platform.value = p.id; }
// 列表是异步到的：到货后重新定位，否则弹层按空列表算高度会贴着输入框
watch(agents, () => { if (agentOpen.value) nextTick(placeAgentMenu); });
// AI 生图不是一个目录能力，不显示「名称 + 模板 + 上传表格」那行表单，只显示 chip
const capIsCatalog = computed(() => !!CAP.selected && !isGenerateImage(CAP.selected));
const capPrompt = computed(() => promptTemplateOf(CAP.selected));
const capRequired = computed(() => hasRequiredInput(CAP.selected));
const capAccepts = computed(() => acceptOf(CAP.selected));
const capHasFiles = computed(() => inputFilesOf(CAP.selected).length > 0);
const capTutorial = computed(() => tutorialOf(CAP.selected));
// 会生图的能力才显示「生图模型」，判定与后端一致（deliverables 含 image / 填了 image_prompt）
const capWantsImage = computed(() => wantsGeneratedImage(CAP.selected));

// 挂了能力时可以只带附件发送（能力自己会读文件）；普通对话仍要求有文字
const canSend = computed(() => (!!text.value.trim() || (!!CAP.selected && C.refs.length > 0)) && !C.busy);
const showThink = computed(() => !!(thinkLevels.value && thinkLevels.value.length));

function iconKey(a) { const k = String((a && a.icon) || '').trim(); return ICONS[k] ? k : ''; }
function charIcon(a) { const k = String((a && a.icon) || '').trim(); return k && !ICONS[k] && k.length <= 2 ? k : ''; }

function openAgentMenu() {
    closeAllPops();
    closePanel();
    toggleAgentMenu();
    if (agentOpen.value) { loadCapabilities(); loadPlatforms(); }
}
function pickAgent(a) {
    if (!a || !a.available) return;
    toggleAgentMenu(false);
    selectCapability(a);
    focus();
}
function viewAllAgents() {
    toggleAgentMenu(false);
    openSquare('agent');
}
function openAddMenu() {
    closeAllPops();
    closePanel();
    toggleAddMenu();
}
function chooseUpload() {
    toggleAddMenu(false);
    if (fileIn.value) fileIn.value.click();
}
function chooseAssets() {
    toggleAddMenu(false);
    assetOpen.value = true;
}
function openSkillPanel() {
    toggleAgentMenu(false);
    toggleAddMenu(false);
    closeAllPops();
    toggleSkillPanel();
}
function pickSkill(s) {
    selectCapability(s);
    focus();
}
// AI 生图：切到图像模式并挂上 type=generate-image 的能力（发送时随请求带 capability）
function pickGenerateImage() {
    closeAllPops();
    closePanel();
    toggleAgentMenu(false);
    if (S.mode !== 'image') setMode('image');
    selectGenerateImage(3);
    focus();
}
// 猜你想问：填进输入框，并按 capability 类型挂能力（能力不可用时只填文案，不假装能跑）
function onSuggestion(s) {
    if (!s) return;
    const cap = s.capability || {};
    if (cap.type === 'generate-image') {
        if (S.mode !== 'image') setMode('image');
        selectGenerateImage(cap.cardType);
    } else {
        const found = capabilityForSuggestion(s);
        if (found && found.available) selectCapability(found);
        else if (found) toast('「' + found.name + '」即将上线，问题已填入输入框', { icon: 'alert' });
        else toast('该能力暂不可用，问题已填入输入框', { icon: 'alert' });
    }
    fill(s.text);
}
// 教程按钮只在能力声明了教程时渲染；内容来自能力数据，在应用内弹窗里看，不跳外链
function openTutorial() {
    if (capTutorial.value) tutorialOpen.value = true;
}
// 选择素材库文件：以同源 URL 取回字节再走既有上传链路挂成附件
async function onAssetPick(item) {
    assetOpen.value = false;
    if (!item || !item.url) return;
    let name = item.name || '素材';
    try { name = decodeURIComponent(String(item.url).split('/').pop() || '') || name; } catch (e) {}
    try {
        const res = await fetch(item.url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        await uploadFiles([new File([blob], name, { type: blob.type || '' })]);
    } catch (e) {
        toast('读取素材失败', { danger: true, icon: 'alert' });
    }
}
function replaceCap() { if (CAP.selected) openSquare(CAP.selected.kind); }

function grow() {
    const el = ta.value;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.4) + 'px';
}
function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); if (!C.busy) submit(); }
}
async function submit() {
    if (C.busy) { stop(); return; }
    const v = text.value;
    if (!v.trim() && !(CAP.selected && C.refs.length)) return;
    text.value = '';
    nextTick(grow);
    await send(v);
}
function fill(v) {
    text.value = v;
    nextTick(() => { grow(); if (ta.value) { ta.value.focus(); ta.value.setSelectionRange(v.length, v.length); } });
}
function focus() { if (ta.value) ta.value.focus(); }
defineExpose({ fill, focus });

function pickFiles(e) { uploadFiles(e.target.files); e.target.value = ''; }
const hasFiles = dt => Array.from((dt && dt.items) || []).some(it => it.kind === 'file');
function onDragOver(e) { if (!hasFiles(e.dataTransfer)) return; e.preventDefault(); drag.value = true; }
function onDragLeave(e) { if (!body.value || !body.value.contains(e.relatedTarget)) drag.value = false; }
function onDrop(e) { if (!hasFiles(e.dataTransfer)) return; e.preventDefault(); drag.value = false; uploadFiles(e.dataTransfer.files); }

// 粘贴图片 / 文件（与旧版一样挂在 window 上；页面不在前台时不接）
const props = defineProps({ active: { type: Boolean, default: true } });
function onPaste(e) {
    if (!props.active) return;
    const files = Array.from((e.clipboardData && e.clipboardData.items) || []).filter(x => x.kind === 'file').map(x => x.getAsFile()).filter(Boolean);
    if (files.length) uploadFiles(files);
}
onMounted(() => { window.addEventListener('paste', onPaste); grow(); });
onBeforeUnmount(() => window.removeEventListener('paste', onPaste));
</script>

<template>
    <div class="cmp-stack">
        <OpenClawSetupBanner v-if="capIsCatalog" dense />
        <div ref="body" class="cmp" :class="{ drag }" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
            <div v-if="capIsCatalog" class="cap-form">
                <div class="cf-head">
                    <span class="cf-name">{{ CAP.selected.name }}</span>
                    <span v-if="capPrompt" class="cf-prompt" :title="capPrompt">{{ capPrompt }}</span>
                    <span v-if="capRequired" class="cf-star" title="必填" aria-label="必填">*</span>
                </div>
                <div v-if="capWantsImage || capHasFiles || capTutorial" class="cf-acts">
                    <GenImageModelPicker v-if="capWantsImage" />
                    <button v-if="capHasFiles" type="button" class="cf-btn" @click="tableIn && tableIn.click()">上传表格</button>
                    <button v-if="capTutorial" type="button" class="cf-btn" title="查看教程" aria-haspopup="dialog" @click="openTutorial">查看教程</button>
                </div>
            </div>
            <TransitionGroup v-if="C.refs.length || C.uploading" tag="div" name="ref" class="refs">
                <div v-for="(r, i) in C.refs" :key="r.url + i" class="ref" :class="{ fl: !isImageRef(r) }" :title="attachmentName(r)">
                    <img v-if="isImageRef(r)" :src="r.url" alt="" @click="emit('preview', r.url)" />
                    <template v-else><ChIcon name="file" /><span class="nm">{{ attachmentName(r) }}</span></template>
                    <button type="button" class="x" aria-label="移除附件" @click="removeRef(i)"><ChIcon name="x" /></button>
                </div>
                <div v-if="C.uploading" key="__up" class="ref up"><span class="spin"></span></div>
            </TransitionGroup>
            <textarea ref="ta" v-model="text" rows="1" :placeholder="t('chat.inputPlaceholder', '请输入任务，交给我来帮你完成')" @input="grow" @keydown="onKey"></textarea>
            <div v-if="CAP.selected" class="caps">
                <CapabilityChip :cap="CAP.selected" @remove="clearCapability" @replace="replaceCap" />
            </div>
            <div class="foot">
                <input ref="fileIn" class="file-in" type="file" multiple @change="pickFiles" />
                <input ref="tableIn" class="file-in" type="file" multiple :accept="capAccepts" @change="pickFiles" />
                <button ref="addBtn" type="button" class="add" :class="{ on: addOpen }" title="上传文件或图片 / 选择资产库文件" aria-label="添加" @click="openAddMenu"><ChIcon name="plus" /></button>
                <button ref="agentBtn" type="button" class="cap-entry" :class="{ on: agentOpen }" title="智能体：选一个挂到输入框" aria-label="智能体" @click="openAgentMenu">
                    <ChIcon name="sparkles" /><span>智能体</span>
                </button>
                <button type="button" class="cap-entry" :class="{ on: CAP.panel === 'skill' }" title="技能：展开技能面板" aria-label="技能" @click="openSkillPanel">
                    <ChIcon name="wand2" /><span>技能</span>
                </button>
                <button type="button" class="cap-entry" :class="{ on: CAP.selected && CAP.selected.kind === 'generate-image' }" title="AI生图：直接用一句话生成商品图片" aria-label="AI生图" @click="pickGenerateImage">
                    <ChIcon name="image" /><span>AI生图</span>
                </button>
                <SizePicker v-if="S.mode !== 'chat'" />
                <span class="grow"></span>
                <ModelPicker />
                <ThinkPicker v-if="showThink" />
                <button type="button" class="send" :class="{ busy: C.busy, off: !C.busy && !canSend }" :disabled="!C.busy && !canSend"
                    :title="C.busy ? '停止' : t('chat.send', '发送')" :aria-label="C.busy ? '停止' : t('chat.send', '发送')" @click="submit">
                    <template v-if="C.busy"><span class="spin"></span><ChIcon name="stop" class="stop" /></template>
                    <ChIcon v-else name="send" />
                </button>
            </div>
        </div>

        <SuggestedQuestions @pick="onSuggestion" />

        <SkillPanel v-if="CAP.panel === 'skill'" @pick="pickSkill" @close="closePanel" />

        <Teleport to="#nv-layer">
            <Transition name="pop">
                <div v-if="agentOpen" ref="agentPop" class="nv-menu cm-pop agent-pop" :style="{ zIndex: POP_Z }">
                    <div class="cm-pf" role="group" aria-label="平台筛选">
                        <button v-for="p in PLATFORMS" :key="p.id" type="button" class="cm-pf-chip" :class="{ on: platform === p.id }"
                            :disabled="p.soon" @click="choosePlatform(p)">
                            <svg class="nv-i" viewBox="0 0 24 24" aria-hidden="true" v-html="p.icon"></svg>
                            <span>{{ p.name }}</span>
                        </button>
                    </div>
                    <div class="cm-list">
                        <div v-if="!agents.length" class="cm-load"><span class="spin"></span>正在加载…</div>
                        <div v-else-if="!menuAgents.length" class="cm-empty">该平台暂无智能体</div>
                        <button v-for="a in menuAgents" :key="a.id" type="button" class="cm-item" :class="{ off: !a.available }" :disabled="!a.available"
                            :title="a.unavailable_reason || a.description" @click="pickAgent(a)">
                            <span class="ic">
                                <ChIcon v-if="iconKey(a)" :name="iconKey(a)" />
                                <em v-else-if="charIcon(a)">{{ charIcon(a) }}</em>
                                <ChIcon v-else name="sparkles" />
                            </span>
                            <span class="tx"><b>{{ a.name }}</b><em>{{ a.description || '暂无描述' }}</em></span>
                            <span v-if="!a.available" class="soon">即将上线</span>
                        </button>
                    </div>
                    <button type="button" class="cm-all" @click="viewAllAgents"><ChIcon name="grid9" />查看全部</button>
                </div>
            </Transition>
        </Teleport>

        <Teleport to="#nv-layer">
            <Transition name="pop">
                <div v-if="addOpen" ref="addPop" class="nv-menu cm-pop add-pop" :style="{ zIndex: POP_Z }">
                    <button type="button" class="nv-menu-item" @click="chooseUpload"><ChIcon name="image" />上传文件或图片</button>
                    <button type="button" class="nv-menu-item" @click="chooseAssets"><ChIcon name="library" />选择资产库文件</button>
                </div>
            </Transition>
        </Teleport>

        <Teleport to="#nv-layer">
            <AssetPicker v-if="assetOpen" @pick="onAssetPick" @close="assetOpen = false" />
        </Teleport>

        <Teleport to="#nv-layer">
            <TutorialModal v-if="tutorialOpen && capTutorial" :tutorial="capTutorial" @close="tutorialOpen = false" />
        </Teleport>
    </div>
</template>

<style scoped>
.cmp-stack { display: flex; flex-direction: column; gap: 10px; }
.cmp { position: relative; border-radius: 20px; padding: 12px 12px 10px 16px; background: var(--glass-strong); backdrop-filter: blur(44px) saturate(190%); -webkit-backdrop-filter: blur(44px) saturate(190%);
    box-shadow: var(--shadow-rim), var(--shadow-lift); display: flex; flex-direction: column; gap: 10px; transition: box-shadow var(--duration-base) var(--ease-out), background var(--duration-base); }
.cmp:focus-within { box-shadow: var(--shadow-rim), var(--shadow-pop); }
.cmp.drag { background: var(--solid); box-shadow: var(--shadow-lift); }
.cap-form { display: flex; align-items: center; gap: 10px 12px; min-width: 0; flex-wrap: wrap; }
.cf-head { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 6px; }
.cf-name { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 13px/20px var(--font-sans); color: var(--accent); }
.cf-prompt { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 400 12.5px/20px var(--font-sans); color: var(--ink-3); }
.cf-star { flex: none; font: 600 14px/20px var(--font-sans); color: var(--danger); }
.cf-acts { flex: none; display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 6px; }
.cf-btn { height: 28px; padding: 0 12px; border: 0; border-radius: 999px; background: var(--fill-1); color: var(--ink-2); font: 500 12px/1 var(--font-sans); cursor: pointer; white-space: nowrap; transition: background var(--duration-fast), color var(--duration-fast); }
.cf-btn:hover { background: var(--fill-2); color: var(--ink); }
textarea { width: 100%; min-height: 48px; max-height: 40vh; padding: 2px 0; border: 0; outline: 0; resize: none; background: transparent; color: var(--ink); font: 400 14.5px/24px var(--font-sans); }
textarea::placeholder { color: var(--ink-4); }
.caps { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.refs { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding-top: 4px; }
.ref { position: relative; width: 48px; height: 48px; border-radius: 10px; background: var(--fill-1); }
.ref img { width: 100%; height: 100%; object-fit: cover; border-radius: 10px; display: block; cursor: zoom-in; }
.ref.fl { width: auto; max-width: 220px; padding: 0 14px 0 10px; display: inline-flex; align-items: center; gap: 8px; font: 400 12px/1 var(--font-sans); color: var(--ink-2); }
.ref.fl .nv-i { width: 16px; height: 16px; color: var(--ink-3); flex: none; }
.ref .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ref.up { display: flex; align-items: center; justify-content: center; color: var(--ink-3); }
.ref.up .spin { width: 14px; height: 14px; }
.ref .x { position: absolute; right: -5px; top: -5px; width: 17px; height: 17px; padding: 0; border: 0; border-radius: 6px; cursor: pointer; background: var(--accent); color: var(--on-accent);
    display: inline-flex; align-items: center; justify-content: center; opacity: 0; transform: scale(.85); transition: opacity var(--duration-fast), transform var(--duration-fast) var(--ease-out); }
.ref .x .nv-i { width: 10px; height: 10px; }
.ref:hover .x, .ref .x:focus-visible { opacity: 1; transform: none; }
.ref-enter-active, .ref-leave-active { transition: opacity .18s var(--ease-out), transform .18s var(--ease-out); }
.ref-enter-from, .ref-leave-to { opacity: 0; transform: scale(.9); }
.foot { display: flex; align-items: center; gap: 6px; min-width: 0; }
.grow { flex: 1; }
.file-in { display: none; }
.add { width: 32px; height: 32px; flex: none; border: 0; border-radius: 99px; cursor: pointer; background: var(--fill-1); color: var(--ink-2); display: inline-flex; align-items: center; justify-content: center; transition: background var(--duration-fast), color var(--duration-fast); }
.add:hover, .add.on { background: var(--fill-2); color: var(--ink); }
.add .nv-i { width: 16px; height: 16px; }
.cap-entry { height: 32px; flex: none; padding: 0 11px; border: 0; border-radius: 999px; cursor: pointer; background: transparent; color: var(--ink-2); display: inline-flex; align-items: center; gap: 6px;
    font: 500 12px/1 var(--font-sans); white-space: nowrap; transition: background var(--duration-fast), color var(--duration-fast); }
.cap-entry:hover { background: var(--fill-1); color: var(--ink); }
.cap-entry.on { background: var(--fill-2); color: var(--ink); }
.cap-entry .nv-i { width: 14px; height: 14px; }
.send { position: relative; width: 34px; height: 34px; flex: none; margin-left: 4px; border: 0; border-radius: 99px; cursor: pointer; background: var(--accent); color: var(--on-accent);
    display: inline-flex; align-items: center; justify-content: center; transition: transform var(--duration-base) var(--ease-out), box-shadow var(--duration-base), background var(--duration-fast); }
.send:hover:not(:disabled) { transform: translateY(-1px); box-shadow: var(--shadow-lift); }
.send .nv-i { width: 15px; height: 15px; }
.send.off { background: var(--fill-2); color: var(--ink-4); cursor: default; }
.send.busy { background: var(--fill-2); color: var(--ink-2); }
.send.busy .spin { width: 14px; height: 14px; transition: opacity var(--duration-fast); }
.send.busy .stop { position: absolute; width: 12px; height: 12px; opacity: 0; transition: opacity var(--duration-fast); }
.send.busy:hover .spin { opacity: 0; }
.send.busy:hover .stop { opacity: 1; }
.cm-pop { position: fixed; overflow-y: auto; }
.agent-pop { width: 304px; padding: 6px; display: flex; flex-direction: column; gap: 2px; }
.cm-pf { position: sticky; top: 0; z-index: 2; flex: none; display: flex; gap: 4px; margin: 0 -6px; padding: 6px; overflow-x: auto; background: var(--solid); }
.cm-pf-chip { display: inline-flex; align-items: center; gap: 4px; flex: none; height: 26px; padding: 0 9px; border: 0; border-radius: 999px; background: transparent; color: var(--ink-3); font: 400 11.5px/1 var(--font-sans); cursor: pointer; white-space: nowrap; transition: background var(--duration-fast), color var(--duration-fast); }
.cm-pf-chip .nv-i { width: 12px; height: 12px; flex: none; opacity: .8; }
.cm-pf-chip:hover:not(:disabled) { background: var(--fill-1); color: var(--ink-2); }
.cm-pf-chip.on { background: var(--fill-2); color: var(--ink); font-weight: 500; }
.cm-pf-chip:disabled { color: var(--ink-4); cursor: default; }
.cm-pf-chip:disabled .nv-i { opacity: .4; }
.cm-empty { padding: 18px 8px; text-align: center; font: 400 12px/1 var(--font-sans); color: var(--ink-4); }
.cm-list { display: flex; flex-direction: column; gap: 1px; }
.cm-item { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border: 0; border-radius: 9px; background: transparent; color: var(--ink); text-align: left; cursor: pointer; transition: background var(--duration-instant) linear; }
.cm-item:hover:not(:disabled) { background: var(--fill-1); }
.cm-item.off { opacity: .55; cursor: default; }
.cm-item .ic { flex: none; width: 26px; height: 26px; border-radius: 8px; background: var(--fill-1); color: var(--ink-2); display: inline-flex; align-items: center; justify-content: center; }
.cm-item .ic .nv-i { width: 14px; height: 14px; }
.cm-item .ic em { font: 500 13px/1 var(--font-sans); font-style: normal; }
.cm-item .tx { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.cm-item .tx b { font: 500 12.5px/17px var(--font-sans); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cm-item .tx em { font: 400 11px/15px var(--font-sans); font-style: normal; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cm-item .soon { flex: none; margin-left: auto; padding: 2px 6px; border-radius: 999px; background: var(--fill-2); color: var(--ink-3); font: 400 10px/1 var(--font-sans); }
.cm-all { position: sticky; bottom: 0; z-index: 1; display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 2px; padding: 8px; border: 0; border-radius: 9px; background: var(--solid); color: var(--ink-2); font: 500 12.5px/1 var(--font-sans); cursor: pointer; transition: background var(--duration-fast), color var(--duration-fast); }
.cm-all:hover { background: var(--fill-1); color: var(--ink); }
.cm-all .nv-i { width: 14px; height: 14px; }
.add-pop { width: 208px; padding: 6px; }
.cm-load { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 18px 8px; font: 400 12px/1 var(--font-sans); color: var(--ink-3); }
@media (max-width: 640px) { .foot { flex-wrap: wrap; } }
</style>
