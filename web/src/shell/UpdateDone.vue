<script setup>
// 更新完成后的轻量提示：重启后弹一次「已更新到 vX.Y.Z」+ 简短更新内容，点「知道了」就清掉标记。
import { computed } from 'vue';
import NvIcon from '../components/NvIcon.vue';
import { updDone, closeUpdateDone, versionLabel } from '../lib/update.js';

const items = computed(() => ((updDone.notes && updDone.notes.items) || []).filter(Boolean).slice(0, 6).map(i => (typeof i === 'string' ? i : i.text)).filter(Boolean));
const title = computed(() => (updDone.version ? '已更新到 ' + versionLabel(updDone.version) : '更新完成'));
</script>

<template>
    <Transition name="modal">
        <div v-if="updDone.open" class="scrim" @mousedown.self="closeUpdateDone" @keydown.esc="closeUpdateDone">
            <div class="ud" role="dialog" aria-modal="true" aria-labelledby="ud-title">
                <header class="ud-h">
                    <span class="mark"><NvIcon name="check" /></span>
                    <div>
                        <h3 id="ud-title">{{ title }}</h3>
                        <p class="sub">更新已完成，下面是这次的更新内容。</p>
                    </div>
                </header>
                <div class="ud-b">
                    <ul v-if="items.length" class="notes"><li v-for="(it, i) in items" :key="i">{{ it }}</li></ul>
                    <p v-else class="muted">这次没有单独的更新说明。</p>
                </div>
                <footer class="ud-f">
                    <button type="button" class="nv-btn primary" @click="closeUpdateDone">知道了</button>
                </footer>
            </div>
        </div>
    </Transition>
</template>

<style scoped>
/* 全屏 backdrop-filter 在 Electron/macOS 上会逐帧重采样下层（表现为闪烁），提独立合成层隔离；transform 不影响 flex 居中 */
.scrim { position: fixed; inset: 0; z-index: 2500; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); display: flex; align-items: center; justify-content: center; padding: 24px; transform: translateZ(0); will-change: transform; isolation: isolate; }
.ud { width: min(520px, 100%); max-height: calc(100vh - 48px); display: flex; flex-direction: column; border-radius: 20px; background: var(--solid); box-shadow: var(--shadow-dialog); overflow: hidden; }
.ud-h { display: flex; align-items: center; gap: 14px; padding: 24px 24px 6px; }
.mark { width: 36px; height: 36px; border-radius: 50%; background: var(--fill-1); display: flex; align-items: center; justify-content: center; flex: none; }
.mark .nv-i { width: 18px; height: 18px; color: var(--ink); }
.ud-h h3 { margin: 0; font: 500 17px/24px var(--font-sans); letter-spacing: -.01em; }
.sub { margin: 3px 0 0; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.ud-b { padding: 12px 24px 8px; overflow-y: auto; }
.notes { margin: 0; padding-left: 16px; font: 400 12.5px/21px var(--font-sans); color: var(--ink-2); }
.notes li + li { margin-top: 3px; }
.muted { margin: 0; font: 400 12.5px/19px var(--font-sans); color: var(--ink-3); }
.ud-f { display: flex; justify-content: flex-end; padding: 14px 24px 22px; }
.modal-enter-active, .modal-leave-active { transition: opacity var(--duration-base) var(--ease-out); }
.modal-enter-active .ud { animation: nv-dialog-in var(--duration-slow) var(--ease-sheet) both; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
