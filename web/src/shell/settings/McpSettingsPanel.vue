<script setup>
// MCP 服务管理：总开关状态 / 卡片列表 / 显式确认启用 / 空态与错误态。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import { toast } from '../../lib/store.js';

const EXAMPLE = '{\n  "mcpServers": {\n    "my-server": {\n      "command": "python3",\n      "args": ["/abs/path/server.py"],\n      "env": { "API_TOKEN": "..." },\n      "timeout": 30,\n      "enabled": false\n    }\n  }\n}';

const data = ref({ enabled: false, servers: [] });
const loading = ref(true);
const error = ref('');
const expanded = ref({});
const pending = ref(null);
const busyName = ref('');
const copying = ref(false);

const servers = computed(() => data.value.servers || []);

function commandLine(server) {
    return [server.command, ...(server.args || [])].filter(Boolean).join(' ');
}
function isEnabled(server) {
    return !!server.enabled;
}
function effectiveStatus(server) {
    return server.status || (server.enabled ? '就绪' : '未启用');
}
function statusKind(server) {
    const status = effectiveStatus(server);
    if (status === '就绪') return 'ok';
    if (status === '失败') return 'error';
    return 'off';
}
function toggleExpand(server) {
    expanded.value = { ...expanded.value, [server.name]: !expanded.value[server.name] };
}
function canEnable(server) {
    return !!String(server.command || '').trim();
}

async function load() {
    loading.value = true;
    error.value = '';
    try {
        const res = await fetch('/api/mcp/servers', { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        data.value = await res.json();
    } catch (e) {
        error.value = (e && e.message) || '加载失败';
    } finally {
        loading.value = false;
    }
}

async function reload() {
    try {
        const res = await fetch('/api/mcp/reload', { method: 'POST', headers: { Accept: 'application/json' } });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.detail || ('HTTP ' + res.status));
        data.value = body;
        toast('已重新加载 MCP 服务');
    } catch (e) {
        toast((e && e.message) || '重新加载失败', { danger: true, icon: 'alert' });
    }
}

async function toggle(server) {
    if (busyName.value) return;
    if (isEnabled(server)) {
        busyName.value = server.name;
        try {
            const res = await fetch('/api/mcp/servers/' + encodeURIComponent(server.name) + '/disable', {
                method: 'POST',
                headers: { Accept: 'application/json' },
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.detail || ('HTTP ' + res.status));
            if (body.server) {
                data.value = { ...data.value, servers: data.value.servers.map(row => row.name === server.name ? body.server : row) };
            } else {
                data.value = { ...data.value, servers: data.value.servers.map(row => row.name === server.name ? { ...row, enabled: false, status: '未启用', tool_count: 0, tools: [] } : row) };
            }
            toast('已停用 ' + server.name);
        } catch (e) {
            toast((e && e.message) || '停用失败', { danger: true, icon: 'alert' });
        } finally {
            busyName.value = '';
        }
        return;
    }
    if (!canEnable(server)) {
        toast('该服务配置无效，无法启用', { danger: true, icon: 'alert' });
        return;
    }
    pending.value = server;
}

async function confirmEnable() {
    const server = pending.value;
    if (!server || busyName.value) return;
    busyName.value = server.name;
    try {
        const res = await fetch('/api/mcp/servers/' + encodeURIComponent(server.name) + '/enable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ confirm: true }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.detail || ('HTTP ' + res.status));
        if (body.server) {
            data.value = { ...data.value, servers: data.value.servers.map(row => row.name === server.name ? body.server : row) };
        }
        pending.value = null;
        toast(body.ok ? '已启用 ' + server.name : '已提交启用：' + server.name, { danger: !body.ok, icon: 'check' });
    } catch (e) {
        toast((e && e.message) || '启用失败', { danger: true, icon: 'alert' });
    } finally {
        busyName.value = '';
    }
}

async function copyExample() {
    try {
        await navigator.clipboard.writeText(EXAMPLE);
        copying.value = true;
        toast('示例已复制');
        setTimeout(() => { copying.value = false; }, 1600);
    } catch (e) {
        toast('复制失败，请手动选择', { danger: true, icon: 'alert' });
    }
}

function onKey(event) {
    if (event.key === 'Escape' && pending.value) pending.value = null;
}
onMounted(() => {
    load();
    document.addEventListener('keydown', onKey, true);
});
onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true));
</script>

<template>
    <div class="mcp">
        <div class="mcp-top">
            <div class="mcp-total">
                <span class="mcp-total-dot" :class="{ 'is-on': !error && data.enabled }"></span>
                <div>
                    <b>MCP 服务</b>
                    <p>{{ error ? '状态未知，接口暂时不可用。' : (data.enabled ? '总开关已启用，正在按配置发现服务。' : '总开关未启用，不会启动任何外部程序。') }}</p>
                </div>
            </div>
            <button type="button" class="nv-btn sm" @click="reload"><NvIcon name="refresh" />重新加载</button>
        </div>

        <div v-if="!loading && !error && !data.enabled" class="mcp-notice">
            <NvIcon name="alert" />
            <span>需要设置环境变量 <code>NOVAI_MCP_ENABLED=1</code> 后重启后端，MCP 服务才会真正连接。</span>
        </div>

        <div v-if="loading" class="mcp-loading">
            <div v-for="n in 3" :key="n" class="nv-skel mcp-skel"></div>
        </div>

        <div v-else-if="error" class="mcp-state">
            <p class="state-title">MCP 服务加载失败</p>
            <p class="state-sub">{{ error }}</p>
            <button type="button" class="nv-btn sm" @click="load"><NvIcon name="refresh" />重试</button>
        </div>

        <div v-else-if="!servers.length" class="mcp-empty">
            <div class="mcp-empty-head">
                <b>还没有配置 MCP 服务</b>
                <span>编辑 <code>data/mcp_servers.json</code>，或用环境变量 <code>NOVAI_MCP_CONFIG</code> 指向自定义配置文件。</span>
            </div>
            <div class="mcp-example">
                <div class="mcp-example-head">
                    <span>最小示例</span>
                    <button type="button" class="nv-btn sm ghost" @click="copyExample"><NvIcon :name="copying ? 'check' : 'copy'" />复制</button>
                </div>
                <pre>{{ EXAMPLE }}</pre>
            </div>
        </div>

        <div v-else class="mcp-list">
            <article v-for="server in servers" :key="server.name" class="mcp-card">
                <div class="mcp-row">
                    <span class="mcp-dot" :class="statusKind(server)"></span>
                    <div class="mcp-name">
                        <b>{{ server.name }}</b>
                        <span class="mcp-type">{{ server.type || 'stdio' }}</span>
                    </div>
                    <span class="mcp-status" :class="statusKind(server)">{{ effectiveStatus(server) }}</span>
                    <span class="mcp-count">{{ server.tool_count || 0 }} 个工具</span>
                    <button type="button" class="mcp-expand" :aria-expanded="!!expanded[server.name]" :aria-label="'展开 ' + server.name" @click="toggleExpand(server)">
                        <NvIcon :name="expanded[server.name] ? 'chevu' : 'chev'" />
                    </button>
                    <button type="button" class="mcp-switch" :class="{ 'is-on': isEnabled(server) }" role="switch"
                            :aria-checked="isEnabled(server)" :aria-label="'启用 ' + server.name" @click="toggle(server)">
                        <span class="mcp-knob"></span>
                    </button>
                </div>
                <div v-if="expanded[server.name]" class="mcp-detail">
                    <div class="mcp-line">
                        <span>命令行</span>
                        <code>{{ commandLine(server) || '（未配置 command）' }}</code>
                    </div>
                    <div v-if="(server.env_keys || []).length" class="mcp-line">
                        <span>环境变量</span>
                        <code class="mcp-keys"><i v-for="key in server.env_keys" :key="key">{{ key }}</i></code>
                    </div>
                    <div v-if="server.error" class="mcp-line">
                        <span>失败原因</span>
                        <p class="mcp-error">{{ server.error }}</p>
                    </div>
                    <div v-if="(server.tools || []).length" class="mcp-tools">
                        <span>工具</span>
                        <div class="mcp-tool-list">
                            <span v-for="tool in server.tools" :key="tool.id || tool.name" class="mcp-tool">{{ tool.name || tool.id }}</span>
                        </div>
                    </div>
                </div>
            </article>
        </div>

        <Teleport to="body">
            <div v-if="pending" class="mcp-confirm-root" role="dialog" aria-modal="true" aria-labelledby="mcp-confirm-title">
                <div class="mcp-confirm-scrim" @click="pending = null"></div>
                <div class="mcp-confirm">
                    <h3 id="mcp-confirm-title">启用 MCP 服务</h3>
                    <p class="mcp-confirm-name">{{ pending.name }} <span>{{ pending.type || 'stdio' }}</span></p>
                    <pre class="mcp-confirm-command">{{ commandLine(pending) }}</pre>
                    <p class="mcp-confirm-warn"><NvIcon name="alert" />该服务会以你的系统权限在本机运行外部程序，请确认来源可信。</p>
                    <div class="mcp-confirm-foot">
                        <button type="button" class="nv-btn" @click="pending = null">取消</button>
                        <button type="button" class="mcp-confirm-danger" :disabled="!!busyName" @click="confirmEnable">
                            {{ busyName ? '启用中…' : '确认启用' }}
                        </button>
                    </div>
                </div>
            </div>
        </Teleport>
    </div>
</template>

<style scoped>
.mcp { display: flex; flex-direction: column; gap: var(--space-5); padding-top: var(--space-1); }
.mcp-top { display: flex; align-items: center; justify-content: space-between; gap: var(--space-6); padding: var(--space-5) var(--space-6); border-radius: var(--radius-xl); background: var(--fill-1); }
.mcp-total { display: flex; align-items: center; gap: var(--space-5); min-width: 0; }
.mcp-total-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-4); flex: none; }
.mcp-total-dot.is-on { background: var(--success); }
.mcp-total b { color: var(--ink); font: 500 14px/20px var(--font-sans); }
.mcp-total p { margin: 2px 0 0; color: var(--ink-3); font: 400 11.5px/17px var(--font-sans); }
.mcp-notice { display: flex; align-items: flex-start; gap: var(--space-4); padding: var(--space-5) var(--space-6); border-radius: var(--radius-lg); background: color-mix(in srgb, var(--danger) 8%, transparent); color: var(--ink-2); font: 400 12px/18px var(--font-sans); }
.mcp-notice .nv-i { width: 15px; height: 15px; color: var(--danger); flex: none; margin-top: 1px; }
.mcp-notice code, .mcp-empty code { padding: 1px 5px; border-radius: var(--radius-xs); background: var(--fill-2); font: 400 11px/14px var(--font-mono); color: var(--ink); }
.mcp-loading { display: flex; flex-direction: column; gap: var(--space-4); }
.mcp-skel { height: 64px; border-radius: var(--radius-lg); }
.mcp-state { display: flex; flex-direction: column; align-items: center; gap: var(--space-3); padding: var(--space-10) 0 var(--space-9); text-align: center; }
.state-title { margin: 0; color: var(--ink); font: 500 15px/22px var(--font-sans); }
.state-sub { margin: 0 0 var(--space-4); color: var(--ink-3); font: 400 12px/18px var(--font-sans); }
.mcp-empty { display: flex; flex-direction: column; gap: var(--space-6); }
.mcp-empty-head { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-7); border-radius: var(--radius-xl); background: var(--fill-1); }
.mcp-empty-head b { color: var(--ink); font: 500 14px/20px var(--font-sans); }
.mcp-empty-head span { color: var(--ink-3); font: 400 12px/18px var(--font-sans); }
.mcp-example { border-radius: var(--radius-xl); background: var(--canvas); padding: var(--space-5) var(--space-6) var(--space-6); }
.mcp-example-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4); }
.mcp-example-head span { color: var(--ink-2); font: 500 12px/17px var(--font-sans); }
.mcp-example pre { margin: 0; padding: var(--space-5); border-radius: var(--radius-lg); background: var(--fill-1); color: var(--ink-2); font: 400 11px/18px var(--font-mono); overflow: auto; white-space: pre; }
.mcp-list { display: flex; flex-direction: column; gap: var(--space-4); }
.mcp-card { border-radius: var(--radius-lg); background: var(--fill-1); transition: background var(--duration-base) var(--ease-out); }
.mcp-card:hover { background: var(--fill-2); }
.mcp-row { display: flex; align-items: center; gap: var(--space-5); min-height: 62px; padding: var(--space-4) var(--space-6); }
.mcp-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-4); flex: none; }
.mcp-dot.ok { background: var(--success); box-shadow: 0 0 0 4px var(--success-fill); }
.mcp-dot.error { background: var(--danger); box-shadow: 0 0 0 4px var(--danger-fill); }
.mcp-name { min-width: 0; display: flex; align-items: center; gap: var(--space-4); flex: 1; }
.mcp-name b { color: var(--ink); font: 500 13.5px/19px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mcp-type { flex: none; padding: 2px 6px; border-radius: var(--radius-xs); background: var(--fill-2); color: var(--ink-3); font: 400 9.5px/13px var(--font-mono); text-transform: lowercase; }
.mcp-status { flex: none; color: var(--ink-3); font: 400 11.5px/16px var(--font-sans); }
.mcp-status.ok { color: var(--success); }
.mcp-status.error { color: var(--danger); }
.mcp-count { flex: none; color: var(--ink-4); font: 400 11px/16px var(--font-mono); }
.mcp-expand { width: var(--control-sm); height: var(--control-sm); border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--ink-3); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: background var(--duration-base) var(--ease-out), color var(--duration-base) var(--ease-out); }
.mcp-expand:hover { background: var(--fill-2); color: var(--ink); }
.mcp-expand .nv-i { width: 13px; height: 13px; }
.mcp-switch { position: relative; width: 36px; height: 20px; flex: none; border: 0; border-radius: var(--radius-pill); background: var(--fill-3); cursor: pointer; padding: 0; transition: background var(--duration-base) var(--ease-out); }
.mcp-switch.is-on { background: var(--accent); }
.mcp-knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--solid); box-shadow: var(--shadow-float); transition: transform var(--duration-base) var(--ease-out); }
.mcp-switch.is-on .mcp-knob { transform: translateX(16px); background: var(--on-accent); }
.mcp-detail { display: flex; flex-direction: column; gap: var(--space-4); padding: 0 var(--space-6) var(--space-5) 46px; animation: card-in 240ms var(--ease-out) both; }
.mcp-line { display: flex; align-items: flex-start; gap: var(--space-5); }
.mcp-line > span, .mcp-tools > span { flex: 0 0 64px; padding-top: 1px; color: var(--ink-4); font: 400 10.5px/16px var(--font-sans); }
.mcp-line code { flex: 1; min-width: 0; color: var(--ink-2); font: 400 11px/17px var(--font-mono); word-break: break-all; }
.mcp-keys { display: flex; flex-wrap: wrap; gap: var(--space-3); }
.mcp-keys i { padding: 1px 6px; border-radius: var(--radius-xs); background: var(--fill-2); color: var(--ink-2); font: 400 10.5px/16px var(--font-mono); font-style: normal; }
.mcp-error { margin: 0; color: var(--danger); font: 400 11.5px/17px var(--font-sans); }
.mcp-tools { display: flex; gap: var(--space-5); align-items: flex-start; }
.mcp-tool-list { display: flex; flex-wrap: wrap; gap: var(--space-3); flex: 1; }
.mcp-tool { padding: 1px 7px; border-radius: var(--radius-xs); background: var(--fill-2); color: var(--ink-2); font: 400 10.5px/16px var(--font-mono); }
.mcp-confirm-root { position: fixed; inset: 0; z-index: 2300; display: flex; align-items: center; justify-content: center; padding: var(--space-7); }
.mcp-confirm-scrim { position: absolute; inset: 0; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); animation: nv-fade var(--duration-base) var(--ease-out) both; }
.mcp-confirm { position: relative; width: min(520px, calc(100vw - 48px)); padding: var(--space-7); border-radius: var(--radius-2xl); background: var(--solid); box-shadow: var(--shadow-dialog); color: var(--ink); animation: nv-dialog-in var(--duration-slow) var(--ease-sheet) both; display: flex; flex-direction: column; gap: var(--space-4); }
.mcp-confirm h3 { margin: 0; font: 500 18px/26px var(--font-sans); letter-spacing: -0.015em; }
.mcp-confirm-name { margin: 0; color: var(--ink-2); font: 500 13px/19px var(--font-sans); }
.mcp-confirm-name span { margin-left: var(--space-3); color: var(--ink-4); font: 400 10px/14px var(--font-mono); }
.mcp-confirm-command { margin: 0; padding: var(--space-5); border-radius: var(--radius-lg); background: var(--fill-1); color: var(--ink); font: 400 11.5px/18px var(--font-mono); white-space: pre-wrap; word-break: break-all; }
.mcp-confirm-warn { display: flex; align-items: flex-start; gap: var(--space-3); margin: 0; padding: var(--space-5); border-radius: var(--radius-lg); background: color-mix(in srgb, var(--danger) 8%, transparent); color: var(--ink-2); font: 400 12px/18px var(--font-sans); }
.mcp-confirm-warn .nv-i { width: 15px; height: 15px; color: var(--danger); flex: none; margin-top: 1px; }
.mcp-confirm-foot { display: flex; justify-content: flex-end; gap: var(--space-4); margin-top: var(--space-1); }
.mcp-confirm-danger { border: 0; height: var(--control-md); padding: 0 16px; border-radius: var(--radius-md); background: var(--danger); color: var(--on-accent); font: 500 12.5px/1 var(--font-sans); cursor: pointer; transition: box-shadow var(--duration-base) var(--ease-out); }
.mcp-confirm-danger:hover { box-shadow: var(--shadow-lift); }
.mcp-confirm-danger:disabled { opacity: .6; cursor: default; box-shadow: none; }
@keyframes card-in { from { opacity: 0; transform: translateY(6px); filter: blur(2px); } }
</style>
