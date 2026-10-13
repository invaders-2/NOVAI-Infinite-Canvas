<script setup>
// 即梦 CLI 账户（旧 jimengCliPanel）：dreamina 扫码登录 / 查询积分 / 帮助 / 退出登录 / WSL 模式 / 低版本提示
import { ref, onMounted, onBeforeUnmount } from 'vue';
import NvIcon from '../../../../components/NvIcon.vue';
import ExtIcon from '../kit/ExtIcon.vue';
import ApiConfirm from '../kit/ApiConfirm.vue';
import CliHelpDialog from './CliHelpDialog.vue';
import CliStatus from './CliStatus.vue';
import { toast } from '../../../../lib/store.js';
import { fetchJson, postJson, prettyJson, useConfirm } from '../kit/kit.js';

const COMMANDS = ['login', 'logout', 'user_credit', 'text2image', 'image2image', 'image_upscale', 'text2video', 'image2video', 'multimodal2video', 'frames2video', 'multiframe2video', 'list_task', 'query_result'];
const status = ref({ text: '未检测', ok: null });
const credit = ref('');
const warn = ref('');
const login = ref(null);          // { qr: '', text: '' }，null = 不显示
const busy = ref('');
const helpOpen = ref(false);
const wsl = ref(false);
const wslBusy = ref(false);
const confirm = useConfirm();
let timer = null;
let alive = true;

function setStatus(text, ok = null) { status.value = { text: text || '未检测', ok }; }
function creditText(raw) {
    if (!raw) return '';
    const parts = [];
    const seen = new Set();
    const visit = value => {
        if (!value || typeof value !== 'object') return;
        Object.entries(value).forEach(([key, item]) => {
            if (/credit|balance|quota|point|coin|积分|余额/.test(key.toLowerCase()) && item !== null && typeof item !== 'object') {
                const label = `${key}: ${item}`;
                if (!seen.has(label)) { seen.add(label); parts.push(label); }
            }
            if (item && typeof item === 'object') visit(item);
        });
    };
    visit(raw);
    return parts.join(' · ') || prettyJson(raw);
}
function showLogin(data) {
    const qr = (data && data.qr_url) || '';
    login.value = { qr: qr && qr.startsWith('http') ? qr : '', text: (data && data.text) || '等待 CLI 输出登录二维码...' };
}
function stopPoll() { clearInterval(timer); timer = null; }

async function refreshStatus(showCredit = true) {
    setStatus('检测中...');
    try {
        const data = await fetch('/api/jimeng/status').then(r => r.json());
        if (!alive) return;
        setStatus(data.logged_in ? '已登录' : (data.installed ? '未登录' : '未安装'), data.logged_in === true);
        if (data.installed && data.version_ok === false) {
            warn.value = `检测到 dreamina CLI 版本 ${data.cli_version || '未知'}，低于推荐的 ${data.min_version || '1.4.2'}。旧版本任务状态可能无法更新，请升级 CLI。`;
        } else {
            warn.value = '';
            if (showCredit && data.raw) credit.value = creditText(data.raw);
        }
    } catch (e) {
        setStatus('检测失败', false);
        credit.value = (e && e.message) || String(e);
    }
}
async function startLogin() {
    busy.value = 'login';
    setStatus('等待扫码...');
    credit.value = '';
    try {
        const data = await fetchJson('/api/jimeng/login/start', { method: 'POST' }, '启动登录失败');
        showLogin(data);
        stopPoll();
        timer = setInterval(poll, 2500);
    } catch (e) {
        setStatus('登录失败', false);
        login.value = { qr: '', text: (e && e.message) || String(e) };
    } finally { busy.value = ''; }
}
async function poll() {
    try {
        const data = await fetch('/api/jimeng/login/status').then(r => r.json());
        if (!alive) return;
        showLogin(data);
        if (data.logged_in) {
            stopPoll();
            setStatus('已登录', true);
            credit.value = creditText(data.raw);
        } else if (data.running) {
            setStatus('等待扫码...');
        } else {
            setStatus('未登录', false);
        }
    } catch (e) {
        stopPoll();
        setStatus('登录检测失败', false);
    }
}
async function refreshCredit() {
    busy.value = 'credit';
    setStatus('查询余额...');
    try {
        const data = await fetchJson('/api/jimeng/credit', undefined, '查询余额失败');
        setStatus('已登录', true);
        credit.value = creditText(data.raw);
    } catch (e) {
        setStatus('未登录', false);
        credit.value = (e && e.message) || String(e);
    } finally { busy.value = ''; }
}
async function logout() {
    if (!(await confirm.ask({ title: '确认退出即梦 CLI 登录？', desc: '退出后需要重新扫码登录才能使用即梦生成。', ok: '退出登录' }))) return;
    busy.value = 'logout';
    try {
        const data = await fetchJson('/api/jimeng/logout', { method: 'POST' }, '退出登录失败');
        stopPoll();
        setStatus('已退出', false);
        credit.value = prettyJson(data.raw);
        login.value = null;
    } catch (e) {
        setStatus('退出失败', false);
        credit.value = (e && e.message) || String(e);
    } finally { busy.value = ''; }
}
// WSL 模式：后端 /api/jimeng/wsl-mode 写 JIMENG_USE_WSL（旧页面复选框绑定的 toggleJimengWsl 没有实现，这里补上）
async function loadWsl() {
    try { const d = await fetchJson('/api/jimeng/wsl-mode'); if (alive) wsl.value = d.enabled === true; } catch (e) {}
}
async function toggleWsl() {
    if (wslBusy.value) return;
    const next = !wsl.value;
    wslBusy.value = true;
    try {
        const d = await postJson('/api/jimeng/wsl-mode', { enabled: next }, '切换 WSL 模式失败');
        wsl.value = d.enabled === true;
        toast(wsl.value ? '已启用 WSL 模式' : '已关闭 WSL 模式', { icon: 'check' });
        refreshStatus(false);
    } catch (e) {
        toast((e && e.message) || '切换 WSL 模式失败', { danger: true, icon: 'alert' });
    } finally { wslBusy.value = false; }
}

onMounted(() => { refreshStatus(false); loadWsl(); });
onBeforeUnmount(() => { alive = false; stopPoll(); });
</script>

<template>
    <div class="jm">
        <div class="jm-h">
            <div class="jm-t"><b>即梦 CLI 账户</b><span>使用本机 dreamina 登录态，无需 API Key。</span></div>
            <CliStatus :text="status.text" :ok="status.ok" />
        </div>
        <div class="jm-acts">
            <button type="button" class="nv-btn sm primary" :disabled="!!busy" @click="startLogin"><span v-if="busy === 'login'" class="spin sm"></span><NvIcon v-else name="qr" />扫码登录</button>
            <button type="button" class="nv-btn sm" :disabled="!!busy" @click="refreshCredit"><span v-if="busy === 'credit'" class="spin sm"></span><ExtIcon v-else name="wallet" />查询积分</button>
            <button type="button" class="nv-btn sm" @click="helpOpen = true"><ExtIcon name="terminal" />帮助</button>
            <button type="button" class="nv-btn sm danger" :disabled="!!busy" @click="logout"><span v-if="busy === 'logout'" class="spin sm"></span><ExtIcon v-else name="logout" />退出登录</button>
        </div>
        <button type="button" class="jm-chk" role="checkbox" :aria-checked="wsl" :disabled="wslBusy" @click="toggleWsl">
            <span class="box" :class="{ on: wsl }"><NvIcon v-if="wsl" name="check" /></span>WSL 模式（Windows CLI 异常时启用）
        </button>
        <Transition name="jm-f">
            <div v-if="login" class="jm-login">
                <div v-if="login.qr" class="jm-qr"><img :src="login.qr" alt="即梦登录二维码"></div>
                <pre class="jm-pre">{{ login.text }}</pre>
            </div>
        </Transition>
        <Transition name="jm-f"><div v-if="credit" class="jm-credit"><ExtIcon name="wallet" /><span>{{ credit }}</span></div></Transition>
        <Transition name="jm-f"><div v-if="warn" class="jm-warn" role="alert"><NvIcon name="alert" /><span>{{ warn }}</span></div></Transition>
        <CliHelpDialog :open="helpOpen" title="即梦 CLI 帮助" sub="查看 dreamina 官方命令帮助输出" endpoint="/api/jimeng/help" root="dreamina" :commands="COMMANDS" @close="helpOpen = false" />
        <ApiConfirm :state="confirm.st.value" @done="confirm.done" />
    </div>
</template>

<style scoped>
.jm { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.jm-h { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.jm-t b { display: block; font: 500 13px/19px var(--font-sans); color: var(--ink); }
.jm-t span { display: block; margin-top: 2px; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.jm-acts { display: flex; flex-wrap: wrap; gap: 6px; }
.jm-acts .nv-i { width: 13px; height: 13px; }
.jm-chk { align-self: flex-start; display: inline-flex; align-items: center; gap: 8px; border: 0; padding: 2px 0; background: transparent; cursor: pointer; font: 400 12.5px/18px var(--font-sans); color: var(--ink-2); }
.jm-chk:disabled { opacity: .6; cursor: default; }
.jm-chk .box { width: 16px; height: 16px; border-radius: 5px; box-shadow: inset 0 0 0 1.2px var(--ink-4); display: inline-flex; align-items: center; justify-content: center; color: var(--on-accent); transition: background var(--duration-fast), box-shadow var(--duration-fast); }
.jm-chk .box.on { background: var(--accent); box-shadow: none; }
.jm-chk .box .nv-i { width: 11px; height: 11px; stroke-width: 2; }
.jm-login { display: flex; gap: 14px; align-items: stretch; }
.jm-qr { width: 132px; height: 132px; border-radius: 12px; background: #fff; padding: 8px; box-shadow: var(--shadow-float); flex: none; }
.jm-qr img { width: 100%; height: 100%; object-fit: contain; display: block; }
.jm-pre { flex: 1; min-width: 0; min-height: 60px; max-height: 220px; margin: 0; overflow: auto; font: 400 11px/17px var(--font-mono); color: var(--ink-2); background: var(--solid); border-radius: 10px; padding: 10px 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.jm-credit, .jm-warn { display: flex; align-items: flex-start; gap: 8px; padding: 9px 12px; border-radius: 10px; background: var(--solid); font: 400 12px/18px var(--font-sans); color: var(--ink-2); }
.jm-credit span, .jm-warn span { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.jm-credit .nv-i, .jm-warn .nv-i { width: 13px; height: 13px; margin-top: 2.5px; color: var(--ink-3); flex: none; }
.jm-warn { background: var(--danger-fill); color: var(--danger); }
.jm-warn .nv-i { color: var(--danger); }
.spin.sm { width: 12px; height: 12px; }
.jm-f-enter-active, .jm-f-leave-active { transition: opacity var(--duration-base) var(--ease-out), transform var(--duration-base) var(--ease-out); }
.jm-f-enter-from, .jm-f-leave-to { opacity: 0; transform: translateY(-4px); }
</style>
