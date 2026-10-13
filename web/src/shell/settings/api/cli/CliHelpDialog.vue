<script setup>
// CLI 帮助弹窗（旧 jimengHelpOverlay / codexHelpOverlay / geminiCliHelpOverlay）：选子命令 → POST {command} → 显示 --help 输出
import { ref, watch } from 'vue';
import NvIcon from '../../../../components/NvIcon.vue';
import ApiDialog from '../kit/ApiDialog.vue';
import KSelect from '../kit/KSelect.vue';
import { postJson, prettyJson } from '../kit/kit.js';

const props = defineProps({
    open: Boolean,
    title: String,
    sub: String,
    endpoint: String,          // /api/jimeng/help | /api/codex/help | /api/gemini-cli/help
    root: String,              // 空命令显示名：dreamina / codex / gemini
    commands: { type: Array, default: () => [] },
});
const emit = defineEmits(['close']);
const command = ref('');
const output = ref('');
const loading = ref(false);
let seq = 0;
const options = () => [{ value: '', label: props.root }, ...props.commands.map(c => ({ value: c, label: c }))];

async function load() {
    const my = ++seq;
    loading.value = true;
    output.value = '加载中...';
    try {
        const data = await postJson(props.endpoint, { command: command.value || '' }, '加载帮助失败');
        if (my === seq) output.value = data.text || prettyJson(data.raw);
    } catch (e) {
        if (my === seq) output.value = (e && e.message) || String(e);
    } finally {
        if (my === seq) loading.value = false;
    }
}
watch(() => props.open, v => { if (v) load(); });
</script>

<template>
    <ApiDialog :open="open" width="560px" height="min(640px, calc(100vh - 32px))" :label="title" @close="emit('close')">
        <div class="hp">
            <div class="hp-h">
                <div class="hp-t"><b>{{ title }}</b><span>{{ sub }}</span></div>
                <button type="button" class="nv-icon-btn round" aria-label="关闭" @click="emit('close')"><NvIcon name="x" /></button>
            </div>
            <div class="hp-bar">
                <KSelect v-model="command" class="hp-sel" :options="options()" label="命令" mono />
                <button type="button" class="nv-btn sm primary" :disabled="loading" @click="load"><span v-if="loading" class="spin sm"></span><NvIcon v-else name="refresh" />刷新</button>
            </div>
            <pre class="hp-out" :class="{ dim: loading }">{{ output }}</pre>
            <div class="hp-foot">命令：{{ [root, ...commands].join(' · ') }}</div>
        </div>
    </ApiDialog>
</template>

<style scoped>
.hp { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 12px; padding: 22px 24px 20px; }
.hp-h { display: flex; align-items: flex-start; gap: 12px; }
.hp-t { flex: 1; min-width: 0; }
.hp-t b { display: block; font: 500 16px/22px var(--font-sans); color: var(--ink); }
.hp-t span { display: block; margin-top: 2px; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.hp-bar { display: flex; align-items: center; gap: 8px; }
.hp-bar :deep(.hp-sel) { flex: 1; }
.hp-bar .nv-btn { height: 32px; }
.hp-out { flex: 1; min-height: 120px; margin: 0; overflow: auto; font: 400 11.5px/18px var(--font-mono); color: var(--ink-2); background: var(--fill-1); border-radius: 12px; padding: 12px 14px; white-space: pre; transition: opacity var(--duration-fast); }
.hp-out.dim { opacity: .6; }
.hp-foot { font: 400 11px/16px var(--font-sans); color: var(--ink-3); overflow-wrap: anywhere; }
.spin.sm { width: 12px; height: 12px; }
</style>
