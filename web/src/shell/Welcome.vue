<script setup>
// 「快速上手」弹窗（设置 → 关于 →「快速上手」再次打开）
const props = defineProps({ mode: String }); // 'quickstart' | ''
const emit = defineEmits(['close']);
</script>

<template>
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
/* 全屏 backdrop-filter 在 Electron/macOS 上会逐帧重采样下层（表现为闪烁），提独立合成层隔离；transform 不影响 flex 居中 */
.scrim { position: fixed; inset: 0; z-index: 2600; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); display: flex; align-items: center; justify-content: center; padding: 24px; transform: translateZ(0); will-change: transform; isolation: isolate; }
.qs { width: min(480px, 100%); padding: 28px; border-radius: 20px; background: var(--solid); box-shadow: var(--shadow-dialog); }
.qs h3 { margin: 0; font: 500 18px/26px var(--font-sans); }
.qs > p { margin: 4px 0 20px; font: 400 12.5px/19px var(--font-sans); color: var(--ink-3); }
.steps { display: flex; flex-direction: column; gap: 14px; }
.st { display: flex; gap: 14px; }
.st .n { font: 400 11px/20px var(--font-mono); color: var(--ink-4); }
.st b { display: block; font: 500 13px/20px var(--font-sans); }
.st span { font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.qs-f { margin-top: 24px; display: flex; justify-content: flex-end; }
.modal-enter-active, .modal-leave-active { transition: opacity var(--duration-base) var(--ease-out); }
.modal-enter-active .qs { animation: nv-dialog-in var(--duration-slow) var(--ease-sheet) both; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
