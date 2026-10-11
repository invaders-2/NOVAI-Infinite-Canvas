<script setup>
// 尺寸选择（Agent / 图像模式显示）：自动 / 内置尺寸（7 种比例 × 1K/2K/4K，像素随当前图像模型）/ 自定义宽高（256–8192）
import { ref, computed, watch, nextTick } from 'vue';
import ChIcon from './ChIcon.vue';
import { S, sizeOpts, sizeOf, sizeLabel, setRatio, setResolution, setResolutionScope, applyCustomSize } from './chatState.js';
import { RATIOS, LEVELS } from './sizes.js';
import { usePop, POP_Z } from './usePop.js';

const btn = ref(null);
const pop = ref(null);
const scope = computed(() => (S.chatResolution === 'auto' ? 'auto' : (S.chatResolution === 'custom' ? 'custom' : 'preset')));
const width = computed(() => (scope.value === 'preset' ? 312 : 264));
const { open, toggle, place } = usePop('size', btn, pop, { place: { align: 'center', maxH: 420 } });

const ratios = computed(() => RATIOS.filter(r => !!sizeOpts.value[r.key]));
const levels = computed(() => {
    const list = sizeOpts.value[S.chatRatio] || sizeOpts.value.square || [];
    return LEVELS.filter(l => list.some(([, x]) => x === l));
});

const cw = ref('');
const ch = ref('');
const hint = ref('');
const hintErr = ref(false);
function syncCustom() { const [w, h] = String(S.chatCustomSize || '1024x1024').split('x'); cw.value = w; ch.value = h; }
watch(open, v => { if (v) { syncCustom(); hint.value = ''; hintErr.value = false; } });
watch(() => [S.chatResolution, S.chatRatio], () => { if (open.value) nextTick(place); });

function apply() {
    if (!applyCustomSize(cw.value, ch.value)) { hint.value = '请输入 256-8192 之间的有效宽度和高度'; hintErr.value = true; return; }
    hint.value = '已应用自定义分辨率';
    hintErr.value = false;
    syncCustom();
}
</script>

<template>
    <button ref="btn" type="button" class="ca-pk" :class="{ on: open }" title="比例和分辨率" @click="toggle()">
        <ChIcon name="size" /><span class="k">尺寸</span><span class="d"></span>{{ sizeLabel }}
        <ChIcon name="chevu" class="cv" :class="{ flip: open }" />
    </button>
    <Teleport to="#nv-layer">
        <Transition name="pop">
            <div v-if="open" ref="pop" class="nv-glass-pop sp-pop" :style="{ zIndex: POP_Z, width: width + 'px' }">
                <div class="sp-hd">
                    <span class="t">尺寸选择</span>
                    <span class="sp-seg" data-glide="button" data-glide-active="is-on">
                        <button type="button" :class="{ 'is-on': scope === 'auto' }" @click="setResolutionScope('auto')">自动</button>
                        <button type="button" :class="{ 'is-on': scope === 'preset' }" @click="setResolutionScope('preset')">内置尺寸</button>
                        <button type="button" :class="{ 'is-on': scope === 'custom' }" @click="setResolutionScope('custom')">自定义</button>
                    </span>
                </div>
                <div v-if="scope === 'auto'" class="sp-box">
                    <b>自动尺寸</b>
                    <span>默认 1024x1024；提示词包含比例或明确尺寸时自动匹配。</span>
                </div>
                <template v-else-if="scope === 'preset'">
                    <div class="sp-grid" data-glide=".rt" data-glide-active="is-on">
                        <button v-for="r in ratios" :key="r.key" type="button" class="rt" :class="{ 'is-on': S.chatRatio === r.key }" @click="setRatio(r.key)">
                            {{ r.label }}<small>{{ r.sub }}</small>
                        </button>
                    </div>
                                        <div class="sp-grid lv" data-glide=".rt" data-glide-active="is-on">
                        <button v-for="l in levels" :key="l" type="button" class="rt" :class="{ 'is-on': S.chatPresetResolution === l }" @click="setResolution(l)">
                            {{ l.toUpperCase() }}<small class="mono">{{ sizeOf(l) }}</small>
                        </button>
                    </div>
                </template>
                <div v-else class="sp-box">
                    <b>自定义分辨率</b>
                    <div class="sp-row">
                        <input v-model="cw" type="number" min="256" max="8192" step="1" placeholder="宽" aria-label="宽" @keydown.enter="apply" />
                        <span class="x">x</span>
                        <input v-model="ch" type="number" min="256" max="8192" step="1" placeholder="高" aria-label="高" @keydown.enter="apply" />
                        <button type="button" class="nv-btn sm primary" @click="apply">应用</button>
                    </div>
                    <span :class="{ err: hintErr }">{{ hint || '输入 256-8192 之间的宽度和高度' }}</span>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.sp-pop { position: fixed; overflow-y: auto; padding: 6px; border-radius: 14px; display: flex; flex-direction: column; gap: 2px; }
.sp-hd { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 8px 8px; }
.sp-hd .t { white-space: nowrap; font: 400 11px/14px var(--font-mono); letter-spacing: .04em; color: var(--ink-3); }
.sp-seg { position: relative; display: inline-flex; gap: 2px; padding: 2px; border-radius: 999px; background: var(--fill-1); --nv-glide-bg: var(--solid); }
.sp-seg button { height: 24px; padding: 0 10px; border: 0; border-radius: 999px; background: transparent; color: var(--ink-3); font: 500 11.5px/1 var(--font-sans); cursor: pointer; white-space: nowrap; transition: color var(--duration-fast); }
.sp-seg button:hover { color: var(--ink-2); }
.sp-seg button.is-on { background: var(--solid); color: var(--ink); }
.sp-seg :deep(.nv-glide-pill) { border-radius: 999px; box-shadow: var(--shadow-float); }
.sp-grid { position: relative; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; padding: 0 4px; }
.sp-grid.lv { grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 8px; padding-top: 8px; padding-bottom: 4px; }
.rt { height: 52px; border: 0; border-radius: 10px; background: transparent; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; font: 400 12px/1 var(--font-mono); color: var(--ink); }
.lv .rt { height: 46px; }
.rt:hover { background: var(--fill-1); }
.rt.is-on { background: var(--fill-2); }
.rt small { font: 400 10.5px/1 var(--font-sans); color: var(--ink-3); }
.rt small.mono { font-family: var(--font-mono); }
.sp-box { margin: 0 4px 4px; padding: 12px 14px; border-radius: 10px; background: var(--fill-1); display: flex; flex-direction: column; gap: 6px; }
.sp-box b { font: 500 12.5px/18px var(--font-sans); color: var(--ink); }
.sp-box span { font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); }
.sp-box span.err { color: var(--danger); }
.sp-row { display: flex; align-items: center; gap: 6px; margin: 4px 0 2px; }
.sp-row input { width: 0; flex: 1; height: 30px; padding: 0 10px; border: 0; outline: 0; border-radius: 8px; background: var(--solid); color: var(--ink); font: 400 12px/1 var(--font-mono); -moz-appearance: textfield; }
.sp-row input::-webkit-outer-spin-button, .sp-row input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.sp-row input:focus { background: var(--fill-2); box-shadow: none; }
.sp-row .x { color: var(--ink-3) !important; font: 400 12px/1 var(--font-mono) !important; }
.sp-row .nv-btn { margin-left: 6px; }
</style>
