<script setup>
// 设置 → 插件：NOVAI 内置的联网搜索开关 + 原 MCP 服务面板（插件 = 画布助手能调用的外部工具）
import { ref, onMounted } from 'vue';
import SetCard from './SetCard.vue';
import SetRow from './SetRow.vue';
import NvSwitch from '../../components/NvSwitch.vue';
import McpSettingsPanel from './McpSettingsPanel.vue';
import { toast } from '../../lib/store.js';

const web = ref(false);
const ready = ref(false);
const busy = ref(false);
async function load() {
    try { const r = await fetch('/api/agent/web-access'); if (r.ok) { web.value = Boolean((await r.json()).enabled); ready.value = true; } } catch (e) {}
}
async function setWeb(v) {
    if (busy.value) return;
    busy.value = true;
    try {
        const r = await fetch('/api/agent/web-access', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: v }) });
        if (!r.ok) throw new Error();
        web.value = Boolean((await r.json()).enabled);
    } catch (e) { toast('切换失败，请稍后再试', { danger: true, icon: 'alert' }); }
    finally { busy.value = false; }
}
onMounted(load);
</script>

<template>
    <div>
        <SetCard title="内置插件">
            <SetRow label="联网搜索" desc="让画布助手搜索公开网页、读取网页正文；不会登录任何网站。被墙的站点需要在「常用 → 通用 → 联网代理」里开代理。">
                <NvSwitch :model-value="web" :disabled="!ready || busy" label="联网搜索" @update:model-value="setWeb" />
            </SetRow>
        </SetCard>
        <div class="gap"></div>
        <McpSettingsPanel />
    </div>
</template>

<style scoped>
.gap { height: 28px; }
</style>
