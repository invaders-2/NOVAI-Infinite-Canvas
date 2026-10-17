<script setup>
// 触发式引导入口（不弹窗、不打断）：只在用到 OpenClaw 的地方（智能体广场 / 挂了能力的输入框）渲染。
// 没装 OpenClaw 时给一句说明 + 「安装 OpenClaw」按钮；检测接口不可用时不显示，避免误报。
import { computed, onMounted } from 'vue';
import ChIcon from '../ChIcon.vue';
import { ensureStatus, installNeeded, openInstallModal, loadStatus, OC } from './openclawSetup.js';
import { chromeHint, chromeMissing } from './openclawSetupCore.js';

const props = defineProps({ dense: { type: Boolean, default: false } });

const show = computed(() => installNeeded());
const chrome = computed(() => (chromeMissing(OC.status) ? chromeHint(OC.status) : null));

onMounted(() => { ensureStatus(false); });
</script>

<template>
    <div v-if="show" class="ocb" :class="{ dense: props.dense }" role="status" data-oc-banner="1">
        <ChIcon name="alert" />
        <div class="tx">
            <b>未检测到 OpenClaw</b>
            <span>智能体 / 技能需要本机 OpenClaw 才能运行；普通对话与生图不受影响。</span>
            <span v-if="chrome" class="ocb-warn" data-oc-chrome-warn="1">{{ chrome.text }}</span>
        </div>
        <button type="button" class="ocb-ghost" title="已手动安装？重新检测" @click="loadStatus(true)">重新检测</button>
        <button type="button" class="nv-btn sm" data-oc-install="1" @click="openInstallModal">
            <ChIcon name="download" />安装 OpenClaw
        </button>
    </div>
</template>

<style scoped>
.ocb { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 12px; background: var(--danger-fill); }
.ocb.dense { padding: 8px 10px; }
.ocb > .nv-i { width: 15px; height: 15px; flex: none; color: var(--danger); }
.ocb .tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ocb .tx b { font: 500 12px/17px var(--font-sans); color: var(--danger); }
.ocb .tx span { font: 400 11.5px/16px var(--font-sans); color: var(--ink-2); }
.ocb .tx .ocb-warn { color: var(--ink-3); }
.ocb-ghost { flex: none; padding: 0 4px; border: 0; background: transparent; color: var(--ink-3); font: 400 11.5px/1 var(--font-sans); cursor: pointer; }
.ocb-ghost:hover { color: var(--ink); }
.ocb .nv-btn { flex: none; }
.ocb .nv-btn .nv-i { width: 13px; height: 13px; }
@media (max-width: 720px) { .ocb { flex-wrap: wrap; } .ocb .tx { flex-basis: 100%; } }
</style>
