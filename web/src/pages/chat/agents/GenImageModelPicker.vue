<script setup>
// 能力生图模型：挂在输入框顶部的能力表单行里。只在选中的能力会生图时出现（判定见 capState.wantsGeneratedImage）。
// 数据源与对话页模型选择器同一个（/api/config → api_providers.image_models），不新增接口。
// 「自动」= 一个字段都不发，后端按既有规则选；选了就把 image_provider / image_model 交给本次能力运行。
// 弹层里只列用户已配置的模型（自定义模型在「设置 → API 设置」的平台模型列表里加）；选择跨刷新记住，失效自动回退到自动。
import { computed, ref } from 'vue';
import ChIcon from '../ChIcon.vue';
import { providersOf, shortModelName } from '../chatState.js';
import { GEN_IMAGE, setGenImage, clearGenImage } from './genImageState.js';
import { usePop, POP_Z } from '../usePop.js';

const btn = ref(null);
const pop = ref(null);
const { open, toggle } = usePop('cap-gen-image', btn, pop, { place: { align: 'right', maxH: 380 } });

// 只列「已启用 + 有 Key + 配了生图模型」的平台，与对话页模型选择器的过滤规则一致；
// 模型只来自用户已配置的 image_models，弹层里不再临时手填（那是设置里平台模型列表的职责）
const providers = computed(() => providersOf('image'));
const providerName = computed(() => {
    const p = providers.value.find(x => x.id === GEN_IMAGE.provider);
    return p ? (p.name || p.id) : GEN_IMAGE.provider;
});
const value = computed(() => (GEN_IMAGE.provider && GEN_IMAGE.model ? providerName.value + ' · ' + shortModelName(GEN_IMAGE.model) : '自动'));

function pick(pid, model) { setGenImage(pid, model); toggle(false); }
function reset() { clearGenImage(); toggle(false); }
</script>

<template>
    <button ref="btn" type="button" class="gi-btn" :class="{ on: open }" :title="'生图模型 · ' + value" aria-haspopup="dialog" :aria-expanded="open" @click="toggle()">
        <ChIcon name="image" />
        <span class="gl">生图模型</span>
        <span class="gv">{{ value }}</span>
        <ChIcon name="chev" class="gc" :class="{ flip: open }" />
    </button>
    <Teleport to="#nv-layer">
        <Transition name="pop">
            <div v-if="open" ref="pop" class="nv-menu gi-pop" :style="{ zIndex: POP_Z }">
                <div class="gi-hd">
                    <span class="gi-t">生图模型</span>
                    <span class="gi-s">未选 = 自动</span>
                </div>
                <button type="button" class="gi-row" :class="{ on: !GEN_IMAGE.provider }" @click="reset">
                    <span class="gi-nm">自动（平台默认）</span>
                    <ChIcon v-if="!GEN_IMAGE.provider" name="check" class="gi-ck on" />
                </button>
                <div v-if="!providers.length" class="gi-empty">还没有已配置的生图平台，请先到「API 设置」添加并填好 Key</div>
                <template v-else>
                    <div v-for="p in providers" :key="p.id" class="gi-grp">
                        <div class="gi-gt">{{ p.name || p.id }}</div>
                        <button v-for="m in (p.image_models || [])" :key="m" type="button" class="gi-row" :title="m"
                            :class="{ on: GEN_IMAGE.provider === p.id && GEN_IMAGE.model === m }" @click="pick(p.id, m)">
                            <span class="gi-nm mono">{{ shortModelName(m) }}</span>
                            <ChIcon v-if="GEN_IMAGE.provider === p.id && GEN_IMAGE.model === m" name="check" class="gi-ck on" />
                        </button>
                    </div>
                    <div class="gi-hint">要加自定义模型，去「设置 → API 设置」的平台模型列表里添加</div>
                </template>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.gi-btn { height: 28px; max-width: 320px; padding: 0 10px; flex: none; border: 0; border-radius: 999px; background: var(--fill-1); color: var(--ink-2); display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font: 500 12px/1 var(--font-sans); white-space: nowrap; transition: background var(--duration-fast), color var(--duration-fast); }
.gi-btn:hover, .gi-btn.on { background: var(--fill-2); color: var(--ink); }
.gi-btn .nv-i { width: 14px; height: 14px; flex: none; }
.gi-btn .gl { flex: none; }
.gi-btn .gv { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-3); }
.gi-btn.on .gv { color: var(--ink-2); }
.gi-btn .gc { width: 12px; height: 12px; color: var(--ink-3); transition: transform var(--duration-fast) var(--ease-out); }
.gi-btn .gc.flip { transform: rotate(180deg); }
.gi-pop { position: fixed; width: 288px; min-width: 0; max-height: 380px; overflow-y: auto; padding: 6px; }
.gi-hd { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 6px 8px 8px; }
.gi-t { font: 500 12px/1 var(--font-sans); color: var(--ink); }
.gi-s { font: 400 10.5px/1 var(--font-mono); color: var(--ink-4); }
.gi-grp { display: flex; flex-direction: column; gap: 1px; }
.gi-gt { padding: 6px 8px 2px; font: 400 10.5px/14px var(--font-mono); letter-spacing: .04em; color: var(--ink-4); }
.gi-row { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 8px; border: 0; border-radius: 8px; background: transparent; color: var(--ink); text-align: left; cursor: pointer; transition: background var(--duration-instant) linear; }
.gi-row:hover, .gi-row.on { background: var(--fill-1); }
.gi-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 400 12.5px/1 var(--font-sans); }
.gi-nm.mono { font-family: var(--font-mono); font-size: 12px; }
.gi-ck { width: 13px; height: 13px; flex: none; color: var(--ink); }
.gi-empty { padding: 8px 10px 10px; font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); }
.gi-hint { padding: 8px 8px 4px; margin-top: 2px; font: 400 10.5px/15px var(--font-sans); color: var(--ink-4); }
</style>
