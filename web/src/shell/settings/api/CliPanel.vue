<script setup>
// 本机 CLI 平台的账户面板：kind = 'jimeng'（即梦 dreamina）| 'codex'（GPT CLI）| 'gemini'（Antigravity CLI，协议名 gemini-cli 也认）。
// 这些面板只调本机 CLI 接口，不改 provider、也没有要随主面板「保存」提交的字段（collect() 恒为 {}）。
// 旧 renderEditor 里 CLI 协议的默认模型补全（applyCliProtocolDefaults）属于主面板的模型逻辑，不在这里做。
import { computed } from 'vue';
import JimengAccount from './cli/JimengAccount.vue';
import CliAccount from './cli/CliAccount.vue';

const props = defineProps({
    kind: { type: String, default: '' },
    provider: Object,
    providers: Array,
});
defineEmits(['changed', 'dirty']);
// 没传 kind 时按 provider.protocol 推断
const k = computed(() => {
    const v = String(props.kind || (props.provider && props.provider.protocol) || '').toLowerCase();
    if (v === 'gemini-cli' || v === 'gemini') return 'gemini';
    if (v === 'codex') return 'codex';
    if (v === 'jimeng') return 'jimeng';
    return '';
});
defineExpose({ collect: () => ({}), reset: () => {} });
</script>

<template>
    <section v-if="k" class="cli">
        <JimengAccount v-if="k === 'jimeng'" :key="'jm-' + (provider && provider.id)" />
        <CliAccount v-else :key="k + '-' + (provider && provider.id)" :kind="k" />
    </section>
</template>

<style scoped>
.cli { background: var(--fill-1); border-radius: 14px; padding: 14px 16px; min-width: 0; }
</style>
