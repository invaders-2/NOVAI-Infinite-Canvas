<script setup>
// 首次访问欢迎页（novai-visited 未设置时出现）+「快速上手」弹窗（关于页可再次打开）
import { onBeforeUnmount, onMounted, watch } from 'vue';
import NvIcon from '../components/NvIcon.vue';
import NvLogo from '../components/NvLogo.vue';
import { navigate } from '../lib/bridge.js';

const props = defineProps({ mode: String }); // 'welcome' | 'quickstart' | ''
const emit = defineEmits(['close']);

// 欢迎层整屏盖住侧栏：期间给侧栏加 inert（不可点击、不触发 hover、退出 Tab 焦点与无障碍树），关闭后移除
function syncSidebarInert() {
    const sb = document.querySelector('.sidebar');
    if (!sb) return;
    if (props.mode === 'welcome') sb.setAttribute('inert', '');
    else sb.removeAttribute('inert');
}
onMounted(syncSidebarInert);
watch(() => props.mode, syncSidebarInert);
onBeforeUnmount(() => document.querySelector('.sidebar')?.removeAttribute('inert'));
const FEATURES = [
    { icon: 'globe', title: 'AI 在线生图', desc: '多平台多模型切换，文生图、图生图，实时预览' },
    { icon: 'chat', title: 'GPT 对话', desc: '构思创意、优化提示词，支持图片与深度思考' },
    { icon: 'workflow', title: '无限画布', desc: '节点连线自由编排，批量生成、编辑与管理' },
];
function done(go) {
    try { localStorage.setItem('novai-visited', '1'); } catch (e) {}
    emit('close');
    if (go) navigate(go);
}
</script>

<template>
    <Transition name="wel">
        <div v-if="props.mode === 'welcome'" class="wel">
            <div class="wel-in nv-enter">
                <span class="logo"><NvLogo /></span>
                <h1 class="display">NOVAI</h1>
                <p class="p sub">支持 OpenAI API · ComfyUI · 火山引擎 · 即梦 CLI</p>
                <div class="feats">
                    <div v-for="f in FEATURES" :key="f.title" class="feat"><span class="ic"><NvIcon :name="f.icon" /></span><b>{{ f.title }}</b><span>{{ f.desc }}</span></div>
                </div>
                <div class="acts">
                    <button type="button" class="nv-btn lg primary" @click="done('canvas')">开始使用<NvIcon name="arrowr" /></button>
                    <button type="button" class="nv-btn lg ghost" @click="done('home')">先看看首页</button>
                </div>
            </div>
        </div>
    </Transition>
    <Transition name="modal">
        <div v-if="props.mode === 'quickstart'" class="scrim" @mousedown.self="emit('close')">
            <div class="qs" role="dialog" aria-modal="true" aria-labelledby="qs-title">
                <h3 id="qs-title">快速上手</h3>
                <p>NOVAI 集成了多种 AI 图像生成能力，几步即可开始创作。</p>
                <div class="steps">
                    <div class="st"><span class="n mono">01</span><div><b>在「设置 → API 设置」里添加平台</b><span>填好 Key 后测试连接，拉取模型列表。</span></div></div>
                    <div class="st"><span class="n mono">02</span><div><b>在首页写一句需求或选一个技能</b><span>画布上的节点会自动搭好，Agent 也可以帮你规划。</span></div></div>
                    <div class="st"><span class="n mono">03</span><div><b>在画布上选中节点运行</b><span>生成结果留在画布里，也会进素材库。</span></div></div>
                </div>
                <div class="qs-f"><button type="button" class="nv-btn primary" @click="emit('close')">开始体验</button></div>
            </div>
        </div>
    </Transition>
</template>

<style scoped>
/* 欢迎层只负责视觉：根层不参与鼠标命中，否则它会盖住左侧导航，侧栏收不到 :hover（展开失效）。事件交回 .wel-in 内的内容。 */
.wel { position: fixed; inset: 0; z-index: 2600; background: var(--bg); display: flex; align-items: center; justify-content: center; pointer-events: none; }
.wel-in { width: min(880px, calc(100% - 64px)); display: flex; flex-direction: column; align-items: center; text-align: center; pointer-events: auto; }
.logo { width: 44px; height: 44px; color: var(--ink); }
.logo :deep(svg) { width: 44px; height: 44px; }
.wel h1 { margin-top: 20px; letter-spacing: .04em; }
.sub { margin-top: 8px; color: var(--ink-3); }
.feats { margin-top: 48px; width: 100%; display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; text-align: left; }
.feat { padding: 20px; border-radius: 16px; background: var(--fill-1); display: flex; flex-direction: column; gap: 6px; }
.feat .ic { width: 36px; height: 36px; border-radius: 10px; background: var(--solid); box-shadow: var(--shadow-float); display: flex; align-items: center; justify-content: center; margin-bottom: 8px; }
.feat b { font: 500 14px/20px var(--font-sans); }
.feat span { font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.acts { margin-top: 44px; display: flex; gap: 10px; }
.scrim { position: fixed; inset: 0; z-index: 2600; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); display: flex; align-items: center; justify-content: center; padding: 24px; }
.qs { width: min(480px, 100%); padding: 28px; border-radius: 20px; background: var(--solid); box-shadow: var(--shadow-dialog); }
.qs h3 { margin: 0; font: 500 18px/26px var(--font-sans); }
.qs > p { margin: 4px 0 20px; font: 400 12.5px/19px var(--font-sans); color: var(--ink-3); }
.steps { display: flex; flex-direction: column; gap: 14px; }
.st { display: flex; gap: 14px; }
.st .n { font: 400 11px/20px var(--font-mono); color: var(--ink-4); }
.st b { display: block; font: 500 13px/20px var(--font-sans); }
.st span { font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.qs-f { margin-top: 24px; display: flex; justify-content: flex-end; }
.wel-leave-active { transition: opacity 400ms var(--ease-out), transform 400ms var(--ease-out); }
.wel-leave-to { opacity: 0; transform: scale(1.02); }
.modal-enter-active, .modal-leave-active { transition: opacity var(--duration-base) var(--ease-out); }
.modal-enter-active .qs { animation: nv-dialog-in var(--duration-slow) var(--ease-sheet) both; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
