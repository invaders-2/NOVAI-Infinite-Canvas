<script setup>
// 老用户首次启动：只问一次「要不要把旧数据从用户目录迁到安装目录」。
// 迁移直接复用设置页的迁移接口（后端先复制+校验，成功才改配置），失败时旧数据完好、下次还能再问。
import { computed, onBeforeUnmount, onMounted } from 'vue';
import NvIcon from '../components/NvIcon.vue';
import { storageOffer, checkStorageOffer, answerStorageOffer, closeStorageOffer } from '../lib/storageOffer.js';

const detail = computed(() => storageOffer.detail || {});
const files = computed(() => Number(detail.value.total && detail.value.total.files) || 0);
const sizeText = computed(() => humanBytes(Number(detail.value.total && detail.value.total.bytes) || 0));
const migrating = computed(() => storageOffer.phase === 'migrating');

function humanBytes(size) {
    let value = Number(size) || 0;
    if (value < 1024) return value + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    for (let i = 0; i < units.length; i += 1) {
        value /= 1024;
        if (value < 1024 || i === units.length - 1) return value.toFixed(1) + ' ' + units[i];
    }
    return '0 B';
}

function onScrim(e) { if (e.target === e.currentTarget) closeStorageOffer(); }
function onKey(e) { if (e.key === 'Escape' && storageOffer.open) closeStorageOffer(); }

let timer = 0;
onMounted(() => {
    window.addEventListener('keydown', onKey);
    // 等外壳先画出来再问，别和首屏抢资源
    timer = setTimeout(checkStorageOffer, 1200);
});
onBeforeUnmount(() => {
    if (timer) clearTimeout(timer);
    window.removeEventListener('keydown', onKey);
});
</script>

<template>
    <Transition name="modal">
        <div v-if="storageOffer.open" class="scrim" @mousedown="onScrim">
            <div class="smp" role="dialog" aria-modal="true" aria-labelledby="sm-title">
                <header class="sm-h">
                    <h3 id="sm-title">把数据移到安装目录？</h3>
                    <button v-if="!migrating" type="button" class="nv-icon-btn sm" title="关闭（保持原位）" aria-label="关闭" @click="closeStorageOffer"><NvIcon name="x" /></button>
                </header>
                <div class="sm-b">
                    <template v-if="storageOffer.phase === 'done'">
                        <p class="msg done"><span class="dot ok"></span>迁移完成，重启 NOVAI 后生效。</p>
                        <p class="note">{{ storageOffer.message }}</p>
                    </template>
                    <template v-else>
                        <p class="lead">检测到你的数据还在用户目录（旧版本的默认位置）。可以把它移到安装目录，跟程序放在一起；原来那份会保留，确认没问题后可以自己删。</p>
                        <div class="rows">
                            <div class="row">
                                <span class="k">现在的位置</span>
                                <span class="v mono">{{ detail.current_root }}</span>
                            </div>
                            <div class="row">
                                <span class="k">迁移到</span>
                                <span class="v mono">{{ detail.target_root }}</span>
                            </div>
                            <div class="row">
                                <span class="k">要搬的内容</span>
                                <span class="v">{{ files }} 个文件 · {{ sizeText }}</span>
                            </div>
                        </div>
                        <p v-if="migrating" class="msg"><span class="dot"></span>正在复制数据，数据多时可能需要几分钟，请不要关掉 NOVAI。</p>
                        <p v-else-if="storageOffer.phase === 'error'" class="msg bad"><span class="dot bad"></span>{{ storageOffer.error }}</p>
                        <p v-else class="note">默认不迁：点「保持原位」或关闭这个提示，数据继续留在现在的位置，之后不再询问。</p>
                    </template>
                </div>
                <footer class="sm-f">
                    <template v-if="storageOffer.phase === 'done'">
                        <span class="grow"></span>
                        <button type="button" class="nv-btn sm primary" @click="closeStorageOffer">知道了</button>
                    </template>
                    <template v-else-if="migrating">
                        <span class="grow"></span>
                        <button type="button" class="nv-btn sm primary" disabled>正在迁移…</button>
                    </template>
                    <template v-else>
                        <span class="grow"></span>
                        <button type="button" class="nv-btn sm ghost" @click="answerStorageOffer('keep')">保持原位</button>
                        <button type="button" class="nv-btn sm primary" @click="answerStorageOffer('migrate')">
                            {{ storageOffer.phase === 'error' ? '重试迁移' : '迁移到安装目录' }}
                        </button>
                    </template>
                </footer>
            </div>
        </div>
    </Transition>
</template>

<style scoped>
/* 磨砂全屏背板 + 独立合成层（同 UpdateModal，避免 Electron/macOS 逐帧重采样闪烁） */
.scrim { position: fixed; inset: 0; z-index: 2550; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); display: flex; align-items: center; justify-content: center; padding: 24px; transform: translateZ(0); will-change: transform; isolation: isolate; }
.smp { width: min(520px, 100%); max-height: calc(100vh - 48px); display: flex; flex-direction: column; border-radius: 20px; background: var(--solid); box-shadow: var(--shadow-dialog); overflow: hidden; }
.sm-h { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 22px 24px 6px; }
.sm-h h3 { margin: 0; font: 500 17px/24px var(--font-sans); letter-spacing: -.01em; }
.sm-b { padding: 6px 24px 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.lead { margin: 0; font: 400 12.5px/19px var(--font-sans); color: var(--ink-2); }
.rows { display: flex; flex-direction: column; gap: 2px; padding: 6px 0; }
.row { display: flex; gap: 12px; align-items: baseline; padding: 7px 0; }
.k { flex: none; width: 82px; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.v { font: 400 12.5px/18px var(--font-sans); color: var(--ink); word-break: break-all; }
.mono { font-family: var(--font-mono); font-size: 11.5px; }
.note { margin: 0; font: 400 11.5px/18px var(--font-sans); color: var(--ink-3); }
.msg { display: flex; align-items: flex-start; gap: 8px; margin: 0; font: 400 12.5px/19px var(--font-sans); color: var(--ink-2); }
.msg.done { color: var(--ink); }
.msg.bad { color: var(--danger); }
.dot { width: 6px; height: 6px; border-radius: 50%; flex: none; margin-top: 6px; background: var(--ink-4); }
.dot.ok { background: var(--ink); }
.dot.bad { background: var(--danger); }
.sm-f { display: flex; align-items: center; gap: 8px; padding: 14px 24px 20px; }
.grow { flex: 1; }
.modal-enter-active, .modal-leave-active { transition: opacity var(--duration-base) var(--ease-out); }
.modal-enter-active .smp { animation: nv-dialog-in var(--duration-slow) var(--ease-sheet) both; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
