<script setup>
// 查看教程：应用内弹窗，一页一步（上一页 / 下一页 / 末页「完成」+ ← → 翻页）。
// 内容区给一个能装下最高截图的最小高度，翻页时弹窗不跳；截图弹层用近乎不透明的实底，
// 避免被图染色；点遮罩 / 关闭按钮 / Esc 关闭；点截图用对话页既有的图片预览放大。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import ImagePreview from '../ImagePreview.vue';

const props = defineProps({ tutorial: { type: Object, required: true } });
const emit = defineEmits(['close']);
const zoom = ref('');
const box = ref(null);
const at = ref(0);

const steps = computed(() => props.tutorial.steps || []);
const total = computed(() => steps.value.length);
const step = computed(() => steps.value[at.value] || {});
const last = computed(() => at.value >= total.value - 1);

function go(n) {
    if (n < 0 || n > total.value - 1) return;
    at.value = n;
    zoom.value = '';
}
function prev() { go(at.value - 1); }
function next() { if (last.value) emit('close'); else go(at.value + 1); }

// 放大图打开时键盘整段交给 ImagePreview（它的 Esc 只关放大图），别抢它的翻页 / 关闭
function onKey(e) {
    if (zoom.value) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); next(); return; }
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    emit('close');
}
onMounted(() => {
    window.addEventListener('keydown', onKey, true);
    if (box.value) box.value.focus();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
    <Transition name="tut">
        <div class="tut-scrim" @mousedown.self="emit('close')">
            <div ref="box" class="tut" role="dialog" aria-modal="true" aria-labelledby="tut-title" tabindex="-1">
                <header class="tut-h">
                    <span class="tut-eyebrow">使用教程</span>
                    <h3 id="tut-title">{{ tutorial.title }}</h3>
                    <button type="button" class="nv-icon-btn sm tut-x" title="关闭（Esc）" aria-label="关闭" @click="emit('close')"><NvIcon name="x" /></button>
                </header>
                <div class="tut-b">
                    <div class="tut-step">
                        <span class="tut-n">{{ at + 1 }}</span>
                        <p class="tut-st">{{ step.text }}</p>
                    </div>
                    <button v-if="step.image" type="button" class="tut-shot" title="点开放大" @click="zoom = step.image">
                        <img :src="step.image" :alt="'第 ' + (at + 1) + ' 步截图'" loading="lazy" />
                    </button>
                </div>
                <footer class="tut-f">
                    <span class="tut-hint">点截图可放大 · 点遮罩或按 Esc 关闭</span>
                    <nav class="tut-pager" aria-label="教程翻页">
                        <button type="button" class="nv-btn sm" :disabled="at === 0" aria-label="上一页" @click="prev"><NvIcon name="arrowl" />上一页</button>
                        <span class="tut-page" aria-live="polite">{{ at + 1 }} / {{ total }}</span>
                        <button v-if="!last" type="button" class="nv-btn sm primary" aria-label="下一页" @click="next">下一页<NvIcon name="arrowr" /></button>
                        <button v-else type="button" class="nv-btn sm primary" aria-label="完成" @click="emit('close')"><NvIcon name="check" />完成</button>
                    </nav>
                </footer>
            </div>
        </div>
    </Transition>
    <Teleport to="#nv-layer">
        <ImagePreview v-if="zoom" :url="zoom" @close="zoom = ''" />
    </Teleport>
</template>

<style scoped>
/* 2350：高过对话页的浮层（POP_Z 2300），又低于「点开截图放大」的 ImagePreview（2400），放大图才盖在上面 */
.tut-scrim { position: fixed; inset: 0; z-index: 2350; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); display: flex; align-items: center; justify-content: center; padding: 24px; }
.tut { position: relative; width: min(680px, 100%); max-height: calc(100vh - 48px); display: flex; flex-direction: column; border-radius: 20px; background: var(--solid); box-shadow: var(--shadow-dialog); overflow: hidden; outline: none; }
.tut-h { flex: none; padding: 22px 64px 10px 24px; }
.tut-eyebrow { font: 400 11px/14px var(--font-mono); letter-spacing: .04em; color: var(--ink-3); }
.tut-h h3 { margin: 4px 0 0; font: 500 17px/24px var(--font-sans); letter-spacing: -.01em; }
.tut-x { position: absolute; right: 16px; top: 16px; }
/* 一页一步：min-height 按最高截图（632px 宽时约 340px）+ 两行文字预留，保证各页高度一致 */
.tut-b { flex: 1 1 auto; min-height: min(416px, calc(100vh - 200px)); padding: 6px 24px 8px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.tut-step { flex: none; display: flex; gap: 12px; }
.tut-n { flex: none; width: 22px; height: 22px; margin-top: 1px; border-radius: 50%; background: var(--fill-2); color: var(--ink-2); font: 500 12px/22px var(--font-sans); text-align: center; }
.tut-st { margin: 0; font: 400 13px/20px var(--font-sans); color: var(--ink-2); }
.tut-shot { flex: none; display: block; width: 100%; padding: 0; border: 0; border-radius: 12px; overflow: hidden; background: var(--fill-1); cursor: zoom-in; transition: box-shadow var(--duration-base) var(--ease-out); }
.tut-shot:hover { box-shadow: var(--shadow-lift); }
.tut-shot img { display: block; width: 100%; height: auto; max-height: 340px; }
.tut-f { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 24px 18px; }
.tut-hint { font: 400 11px/16px var(--font-sans); color: var(--ink-3); }
.tut-pager { flex: none; display: flex; align-items: center; gap: 8px; }
.tut-page { min-width: 44px; text-align: center; font: 400 11.5px/1 var(--font-mono); letter-spacing: .04em; color: var(--ink-3); }
.tut-pager .nv-i { width: 13px; height: 13px; }
.tut-enter-active, .tut-leave-active { transition: opacity var(--duration-base) var(--ease-out); }
.tut-enter-active .tut { animation: nv-dialog-in var(--duration-slow) var(--ease-sheet) both; }
.tut-enter-from, .tut-leave-to { opacity: 0; }
@media (max-height: 620px) { .tut-f { flex-wrap: wrap; } }
</style>
