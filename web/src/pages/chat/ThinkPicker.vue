<script setup>
// 思考强度：只在当前对话模型支持推理时显示（父组件判断），档位按模型能力裁剪；选择记在 gpt_chat_think_level
import { ref, computed } from 'vue';
import ChIcon from './ChIcon.vue';
import { S, thinkLevels, setThinkLevel } from './chatState.js';
import { THINK_LEVELS, thinkLevelLabel } from './thought.js';
import { usePop, POP_Z } from './usePop.js';

const btn = ref(null);
const pop = ref(null);
const { open, toggle } = usePop('think', btn, pop, { place: { align: 'left', maxH: 300 } });
const items = computed(() => THINK_LEVELS.filter(x => (thinkLevels.value || []).includes(x.key)));
function pick(k) { setThinkLevel(k); toggle(false); }
</script>

<template>
    <button ref="btn" type="button" class="ca-pk lite" :class="{ on: open }" title="思考强度" aria-label="思考强度" @click="toggle()">
        {{ thinkLevelLabel(S.thinkLevel) }}<ChIcon name="chevu" class="cv" :class="{ flip: open }" />
    </button>
    <Teleport to="#nv-layer">
        <Transition name="pop">
            <div v-if="open" ref="pop" class="nv-menu tp-pop" :style="{ zIndex: POP_Z }">
                <div class="tp-hd">思考强度</div>
                <button v-for="it in items" :key="it.key" type="button" class="nv-menu-item tp-row" :class="{ 'is-on': it.key === S.thinkLevel }" @click="pick(it.key)">
                    <span>{{ it.label }}</span>
                    <ChIcon v-if="it.key === S.thinkLevel" name="check" class="tail" />
                </button>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.tp-pop { position: fixed; width: 150px; min-width: 0; overflow-y: auto; padding: 6px; border-radius: 14px; }
.tp-hd { padding: 6px 8px 8px; font: 400 11px/14px var(--font-mono); letter-spacing: .04em; color: var(--ink-3); }
.tp-row { height: 32px; border-radius: 8px; justify-content: space-between; }
.tail { width: 13px; height: 13px; color: var(--ink) !important; }
</style>
