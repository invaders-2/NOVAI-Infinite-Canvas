<script setup>
// GPT CLI（codex）/ Antigravity CLI（agy）账户：检测安装状态 + 官方命令帮助（旧 codexCliPanel / geminiCliPanel）
import { ref, computed, onMounted, watch } from 'vue';
import ExtIcon from '../kit/ExtIcon.vue';
import CliHelpDialog from './CliHelpDialog.vue';
import CliStatus from './CliStatus.vue';

const props = defineProps({ kind: { type: String, default: 'codex' } });   // 'codex' | 'gemini'
const CONF = {
    codex: {
        title: 'OpenAI CLI 账户', desc: '使用本机 codex 登录态，无需在本项目保存 API Key。', note: '',
        status: '/api/codex/status', help: '/api/codex/help',
        helpTitle: 'OpenAI Codex CLI 帮助', helpSub: '查看 codex 官方命令帮助输出', root: 'codex',
        commands: ['exec', 'login', 'logout', 'doctor', 'mcp', 'app', 'update'],
    },
    gemini: {
        title: 'Antigravity CLI 账户', desc: '使用本机 agy 登录态，无需在本项目保存 API Key。', note: '需要先安装 CLI 文件夹中的依赖。',
        status: '/api/gemini-cli/status', help: '/api/gemini-cli/help',
        helpTitle: 'Antigravity CLI 帮助', helpSub: '查看 gemini 官方命令帮助输出', root: 'gemini',
        commands: ['help', 'mcp', 'extensions'],
    },
};
const c = computed(() => CONF[props.kind] || CONF.codex);
const status = ref({ text: '未检测', ok: null });
const info = ref('');
const checking = ref(false);
const helpOpen = ref(false);
let seq = 0;

async function refresh(showInfo = true) {
    const my = ++seq;
    checking.value = true;
    status.value = { text: '检测中...', ok: null };
    try {
        const data = await fetch(c.value.status).then(r => r.json());
        if (my !== seq) return;
        status.value = { text: data.installed ? '已安装' : '未安装', ok: data.installed === true };
        if (showInfo) info.value = [data.version, data.path, data.message].filter(Boolean).join(' · ');
    } catch (e) {
        if (my !== seq) return;
        status.value = { text: '检测失败', ok: false };
        info.value = (e && e.message) || String(e);
    } finally {
        if (my === seq) checking.value = false;
    }
}
onMounted(() => refresh(false));
watch(() => props.kind, () => { info.value = ''; refresh(false); });
</script>

<template>
    <div class="ca">
        <div class="ca-h">
            <div class="ca-t">
                <b>{{ c.title }}</b><span>{{ c.desc }}</span><span v-if="c.note" class="note">{{ c.note }}</span>
            </div>
            <CliStatus :text="status.text" :ok="status.ok" />
        </div>
        <div class="ca-acts">
            <button type="button" class="nv-btn sm primary" :disabled="checking" @click="refresh(true)"><span v-if="checking" class="spin sm"></span><ExtIcon v-else name="radar" />检测 CLI</button>
            <button type="button" class="nv-btn sm" @click="helpOpen = true"><ExtIcon name="terminal" />帮助</button>
        </div>
        <Transition name="ca-f"><div v-if="info" class="ca-info">{{ info }}</div></Transition>
        <CliHelpDialog :open="helpOpen" :title="c.helpTitle" :sub="c.helpSub" :endpoint="c.help" :root="c.root" :commands="c.commands" @close="helpOpen = false" />
    </div>
</template>

<style scoped>
.ca { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.ca-h { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.ca-t { min-width: 0; }
.ca-t b { display: block; font: 500 13px/19px var(--font-sans); color: var(--ink); }
.ca-t span { display: block; margin-top: 2px; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.ca-t .note { color: var(--ink-2); }
.ca-acts { display: flex; flex-wrap: wrap; gap: 6px; }
.ca-acts .nv-i { width: 13px; height: 13px; }
.ca-info { padding: 9px 12px; border-radius: 10px; background: var(--solid); font: 400 12px/18px var(--font-sans); color: var(--ink-2); overflow-wrap: anywhere; }
.spin.sm { width: 12px; height: 12px; }
.ca-f-enter-active, .ca-f-leave-active { transition: opacity var(--duration-fast) var(--ease-out); }
.ca-f-enter-from, .ca-f-leave-to { opacity: 0; }
</style>
