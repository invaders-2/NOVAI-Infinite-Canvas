<script setup>
// MCP 服务管理：总开关（二次确认）/ 服务增删改 / 单卡启停 / 空态与错误态。
// 打开开关会真正启动本机外部程序，所以总开关和单服务启用都要先确认一次。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import NvSwitch from '../../components/NvSwitch.vue';
import McpServerDialog from './McpServerDialog.vue';
import { toast } from '../../lib/store.js';

const EXAMPLE = '{\n  "mcpServers": {\n    "my-server": {\n      "command": "python3",\n      "args": ["/abs/path/server.py"],\n      "env": { "API_TOKEN": "..." },\n      "timeout": 30,\n      "enabled": false\n    }\n  }\n}';

const data = ref({ enabled: false, env_override: '', config_path: '', servers: [] });
const loading = ref(true);
const error = ref('');
const expanded = ref({});
const confirmBox = ref(null);        // null | { kind: 'switch' } | { kind: 'server', server }
const busyName = ref('');
const switchBusy = ref(false);
const dialog = ref({ open: false, server: null });
const dialogBusy = ref(false);
const removing = ref('');            // 正在显示删除确认条的服务名
const removeBusy = ref('');
const copying = ref(false);

const servers = computed(() => data.value.servers || []);
const envOverride = computed(() => String(data.value.env_override || ''));
const envLocked = computed(() => !!envOverride.value);
const switchOn = computed(() => (envLocked.value ? envOverride.value === 'on' : !!data.value.enabled));
const switchLocked = computed(() => loading.value || !!error.value || switchBusy.value || envLocked.value);
const statusText = computed(() => {
    if (switchBusy.value) return data.value.enabled ? '正在关闭 MCP 服务…' : '正在开启并发现服务，可能需要几秒…';
    if (error.value) return '状态未知，接口暂时不可用。';
    if (envLocked.value) return '总开关由环境变量控制，这里的开关暂不生效。';
    if (data.value.enabled) return '总开关已启用，正在按配置发现服务。';
    return '总开关未启用，不会启动任何外部程序。';
});

function errText(body, status) {
    const detail = body && body.detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
    return 'HTTP ' + status;
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
    if (server.type === 'http') return !!String(server.url || '').trim();
    return !!String(server.command || '').trim();
}
function upsert(row) {
    if (!row || !row.name) return;
    const exists = servers.value.some(s => s.name === row.name);
    data.value = {
        ...data.value,
        servers: exists ? servers.value.map(s => (s.name === row.name ? { ...s, ...row } : s)) : servers.value.concat([row]),
    };
}

async function load(silent) {
    if (!silent) loading.value = true;
    error.value = '';
    try {
        const res = await fetch('/api/mcp/servers', { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const body = await res.json();
        data.value = {
            enabled: !!body.enabled,
            env_override: String(body.env_override || ''),
            config_path: String(body.config_path || ''),
            servers: Array.isArray(body.servers) ? body.servers : [],
        };
    } catch (e) {
        if (!silent) error.value = (e && e.message) || '加载失败';
    } finally {
        if (!silent) loading.value = false;
    }
}

async function reload() {
    try {
        const res = await fetch('/api/mcp/reload', { method: 'POST', headers: { Accept: 'application/json' } });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(errText(body, res.status));
        if (Array.isArray(body.servers)) data.value = { ...data.value, servers: body.servers };
        if (typeof body.enabled === 'boolean') data.value = { ...data.value, enabled: body.enabled };
        toast('已重新加载 MCP 服务');
    } catch (e) {
        toast((e && e.message) || '重新加载失败', { danger: true, icon: 'alert' });
    }
}

function onSwitchValue(next) {
    if (switchLocked.value) return;
    if (!next) { saveSwitch(false); return; }
    confirmBox.value = { kind: 'switch' };
}

async function saveSwitch(next) {
    if (switchBusy.value) return;
    switchBusy.value = true;
    try {
        const res = await fetch('/api/mcp/servers/switch', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ enabled: !!next, confirm: true }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(errText(body, res.status));
        data.value = {
            ...data.value,
            enabled: !!body.enabled,
            env_override: String(body.env_override || data.value.env_override || ''),
            servers: Array.isArray(body.servers) ? body.servers : data.value.servers,
        };
        confirmBox.value = null;
        toast(next ? '已开启 MCP 服务' : '已关闭 MCP 服务', { icon: 'check' });
    } catch (e) {
        toast((e && e.message) || (next ? '开启失败' : '关闭失败'), { danger: true, icon: 'alert' });
    } finally {
        switchBusy.value = false;
    }
}

function onToggle(server, next) {
    if (busyName.value) return;
    if (!next) { disableServer(server); return; }
    if (!canEnable(server)) {
        toast('该服务配置不完整，请先编辑补全', { danger: true, icon: 'alert' });
        return;
    }
    confirmBox.value = { kind: 'server', server };
}

async function disableServer(server) {
    busyName.value = server.name;
    try {
        const res = await fetch('/api/mcp/servers/' + encodeURIComponent(server.name) + '/disable', {
            method: 'POST',
            headers: { Accept: 'application/json' },
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(errText(body, res.status));
        upsert(body.server || { name: server.name, enabled: false, status: '未启用', tool_count: 0, tools: [] });
        toast('已停用 ' + server.name, { icon: 'check' });
    } catch (e) {
        toast((e && e.message) || '停用失败', { danger: true, icon: 'alert' });
    } finally {
        busyName.value = '';
    }
}

async function enableServer(server) {
    busyName.value = server.name;
    try {
        const res = await fetch('/api/mcp/servers/' + encodeURIComponent(server.name) + '/enable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ confirm: true }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(errText(body, res.status));
        upsert(body.server || { name: server.name, enabled: true });
        confirmBox.value = null;
        toast(body.ok ? '已启用 ' + server.name : '已提交启用：' + server.name, { danger: !body.ok, icon: 'check' });
    } catch (e) {
        toast((e && e.message) || '启用失败', { danger: true, icon: 'alert' });
    } finally {
        busyName.value = '';
    }
}

function confirmYes() {
    const box = confirmBox.value;
    if (!box) return;
    if (box.kind === 'switch') { saveSwitch(true); return; }
    if (box.kind === 'server') enableServer(box.server);
}

function openCreate() {
    dialog.value = { open: true, server: null };
}
function openEdit(server) {
    dialog.value = { open: true, server };
}
function closeDialog() {
    if (dialogBusy.value) return;
    dialog.value = { open: false, server: null };
}

async function saveServer(payload) {
    const editing = !!dialog.value.server;
    // 编辑走原名的路径：body.name 与路径名不同时后端按改名处理
    const pathName = editing ? dialog.value.server.name : payload.name;
    dialogBusy.value = true;
    try {
        const res = await fetch(editing ? '/api/mcp/servers/' + encodeURIComponent(pathName) : '/api/mcp/servers', {
            method: editing ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(errText(body, res.status));
        dialog.value = { open: false, server: null };
        toast((editing ? '已保存 ' : '已添加 ') + payload.name, { icon: 'check' });
        // 返回的是脱敏配置（没有 status/tools），列表以重新拉取的为准
        load(true);
    } catch (e) {
        toast((e && e.message) || '保存失败', { danger: true, icon: 'alert' });
    } finally {
        dialogBusy.value = false;
    }
}

function askRemove(server) {
    if (removeBusy.value) return;
    removing.value = server.name;
}
async function doRemove(server) {
    if (removeBusy.value) return;
    removeBusy.value = server.name;
    try {
        const res = await fetch('/api/mcp/servers/' + encodeURIComponent(server.name), { method: 'DELETE' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(errText(body, res.status));
        data.value = { ...data.value, servers: servers.value.filter(s => s.name !== server.name) };
        removing.value = '';
        toast('已删除 ' + server.name, { icon: 'check' });
        load(true);
    } catch (e) {
        toast((e && e.message) || '删除失败', { danger: true, icon: 'alert' });
    } finally {
        removeBusy.value = '';
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
    if (event.key !== 'Escape') return;
    if (confirmBox.value) {
        event.stopImmediatePropagation();
        confirmBox.value = null;
        return;
    }
    if (removing.value) {
        event.stopImmediatePropagation();
        removing.value = '';
    }
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
            <div class="mcp-top-main">
                <span class="mcp-total-dot" :class="{ 'is-on': !error && switchOn }"></span>
                <div class="mcp-total">
                    <b>MCP 服务</b>
                    <p>{{ statusText }}</p>
                </div>
                <div class="mcp-top-actions">
                    <button type="button" class="mcp-icon" title="重新加载" aria-label="重新加载" :disabled="loading || !!error || switchBusy" @click="reload"><NvIcon name="refresh" /></button>
                    <NvSwitch :model-value="switchOn" :disabled="switchLocked" label="MCP 总开关" @update:model-value="onSwitchValue" />
                </div>
            </div>
            <p v-if="envLocked" class="mcp-note"><NvIcon name="lock" />由环境变量 NOVAI_MCP_ENABLED 控制</p>
        </div>

        <div v-if="loading" class="mcp-loading">
            <div v-for="n in 3" :key="n" class="nv-skel mcp-skel"></div>
        </div>

        <div v-else-if="error" class="mcp-state">
            <p class="state-title">MCP 服务加载失败</p>
            <p class="state-sub">{{ error }}</p>
            <button type="button" class="nv-btn sm" @click="load()"><NvIcon name="refresh" />重试</button>
        </div>

        <template v-else>
            <div v-if="!servers.length" class="mcp-empty">
                <div class="mcp-empty-head">
                    <b>还没有配置 MCP 服务</b>
                    <span v-if="data.enabled" class="mcp-empty-open">已开启总开关，但还没有配置服务，现在不会连接任何外部程序。</span>
                    <span>可以手动添加，也可以把本机的 MCP 服务一条条加进来，画布助手就能调用它们的工具。</span>
                    <div class="mcp-empty-actions">
                        <button type="button" class="nv-btn sm primary" @click="openCreate"><NvIcon name="plus" />添加服务</button>
                    </div>
                </div>
                <div class="mcp-example">
                    <div class="mcp-example-head">
                        <span>最小示例</span>
                        <button type="button" class="nv-btn sm ghost" @click="copyExample"><NvIcon :name="copying ? 'check' : 'copy'" />复制</button>
                    </div>
                    <pre>{{ EXAMPLE }}</pre>
                </div>
            </div>

            <template v-else>
                <div class="mcp-list-head">
                    <span>服务 · {{ servers.length }} 个</span>
                    <button type="button" class="nv-btn sm" @click="openCreate"><NvIcon name="plus" />添加服务</button>
                </div>
                <div class="mcp-list">
                    <article v-for="server in servers" :key="server.name" class="mcp-card">
                        <div class="mcp-row">
                            <span class="mcp-dot" :class="statusKind(server)"></span>
                            <div class="mcp-name">
                                <b>{{ server.name }}</b>
                                <span class="mcp-type">{{ server.type || 'stdio' }}</span>
                            </div>
                            <span class="mcp-status" :class="statusKind(server)">{{ effectiveStatus(server) }}</span>
                            <span class="mcp-count">{{ server.tool_count || 0 }} 个工具</span>
                            <button type="button" class="mcp-icon" :title="'编辑 ' + server.name" :aria-label="'编辑 ' + server.name" @click="openEdit(server)"><NvIcon name="edit3" /></button>
                            <button type="button" class="mcp-icon" :title="'删除 ' + server.name" :aria-label="'删除 ' + server.name" @click="askRemove(server)"><NvIcon name="trash" /></button>
                            <button type="button" class="mcp-icon" :aria-expanded="!!expanded[server.name]" :aria-label="'展开 ' + server.name" @click="toggleExpand(server)">
                                <NvIcon :name="expanded[server.name] ? 'chevu' : 'chev'" />
                            </button>
                            <NvSwitch :model-value="!!server.enabled" :disabled="busyName === server.name" :label="'启用 ' + server.name" @update:model-value="v => onToggle(server, v)" />
                        </div>

                        <div v-if="removing === server.name" class="mcp-del">
                            <NvIcon name="alert" />
                            <span>删除后这份配置会一起移除，无法恢复。确定删除「{{ server.name }}」？</span>
                            <button type="button" class="nv-btn sm" @click="removing = ''">取消</button>
                            <button type="button" class="nv-btn sm danger" :disabled="removeBusy === server.name" @click="doRemove(server)">{{ removeBusy === server.name ? '删除中…' : '删除' }}</button>
                        </div>

                        <div v-if="expanded[server.name]" class="mcp-detail">
                            <div v-if="server.type === 'http'" class="mcp-line">
                                <span>地址</span>
                                <code>{{ server.url || '（未配置 url）' }}</code>
                            </div>
                            <div v-else class="mcp-line">
                                <span>命令行</span>
                                <code>{{ [server.command, ...(server.args || [])].filter(Boolean).join(' ') || '（未配置 command）' }}</code>
                            </div>
                            <div v-if="(server.env_keys || []).length" class="mcp-line">
                                <span>环境变量</span>
                                <code class="mcp-keys"><i v-for="key in server.env_keys" :key="key">{{ key }}</i></code>
                            </div>
                            <div v-if="(server.header_keys || []).length" class="mcp-line">
                                <span>请求头</span>
                                <code class="mcp-keys"><i v-for="key in server.header_keys" :key="key">{{ key }}</i></code>
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
            </template>
        </template>

        <p v-if="data.config_path" class="mcp-path">配置文件：<code>{{ data.config_path }}</code></p>

        <McpServerDialog :open="dialog.open" :server="dialog.server" :busy="dialogBusy" @submit="saveServer" @close="closeDialog" />

        <Teleport to="#nv-layer">
            <div v-if="confirmBox" class="mcp-confirm-root" role="dialog" aria-modal="true" aria-labelledby="mcp-confirm-title">
                <div class="mcp-confirm-scrim" @click="confirmBox = null"></div>
                <div class="mcp-confirm">
                    <template v-if="confirmBox.kind === 'switch'">
                        <h3 id="mcp-confirm-title">开启 MCP 服务</h3>
                        <p class="mcp-confirm-text">开启后 NOVAI 会按配置启动本机的 MCP 外部程序，并以你的系统权限运行；服务卡里的开关决定具体连哪些。</p>
                    </template>
                    <template v-else>
                        <h3 id="mcp-confirm-title">启用 {{ confirmBox.server.name }}</h3>
                        <p class="mcp-confirm-text">该服务会以你的系统权限在本机运行外部程序，请确认来源可信。</p>
                        <pre class="mcp-confirm-command">{{ confirmBox.server.type === 'http' ? (confirmBox.server.url || '') : ([confirmBox.server.command, ...(confirmBox.server.args || [])].filter(Boolean).join(' ')) }}</pre>
                    </template>
                    <p class="mcp-confirm-warn"><NvIcon name="alert" />外部程序不受 NOVAI 沙箱限制，只启用你信任的服务。</p>
                    <div class="mcp-confirm-foot">
                        <button type="button" class="nv-btn" @click="confirmBox = null">取消</button>
                        <button type="button" class="nv-btn primary" :disabled="switchBusy || !!busyName" @click="confirmYes">
                            {{ (switchBusy || busyName) ? '处理中…' : '确认开启' }}
                        </button>
                    </div>
                </div>
            </div>
        </Teleport>
    </div>
</template>

<style scoped>
.mcp { display: flex; flex-direction: column; gap: var(--space-5); padding-top: var(--space-1); }
.mcp-top { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-5) var(--space-6); border-radius: var(--radius-xl); background: var(--fill-1); }
.mcp-top-main { display: flex; align-items: center; gap: var(--space-5); min-width: 0; }
.mcp-total-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-4); flex: none; }
.mcp-total-dot.is-on { background: var(--success); }
.mcp-total { flex: 1; min-width: 0; }
.mcp-total b { color: var(--ink); font: 500 14px/20px var(--font-sans); }
.mcp-total p { margin: 2px 0 0; color: var(--ink-3); font: 400 11.5px/17px var(--font-sans); }
.mcp-top-actions { display: flex; align-items: center; gap: var(--space-4); flex: none; }
.mcp-note { display: flex; align-items: center; gap: var(--space-3); margin: 0; color: var(--ink-3); font: 400 11.5px/17px var(--font-sans); }
.mcp-note .nv-i { width: 13px; height: 13px; color: var(--ink-4); flex: none; }
.mcp-icon { width: var(--control-sm); height: var(--control-sm); flex: none; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--ink-3); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: background var(--duration-base) var(--ease-out), color var(--duration-base) var(--ease-out); }
.mcp-icon:hover { background: var(--fill-2); color: var(--ink); }
.mcp-icon:disabled { color: var(--ink-4); cursor: default; background: transparent; }
.mcp :deep(.nv-switch:disabled) { opacity: .4; cursor: default; }
.mcp-icon .nv-i { width: 13px; height: 13px; }
.mcp-loading { display: flex; flex-direction: column; gap: var(--space-4); }
.mcp-skel { height: 64px; border-radius: var(--radius-lg); }
.mcp-state { display: flex; flex-direction: column; align-items: center; gap: var(--space-3); padding: var(--space-10) 0 var(--space-9); text-align: center; }
.state-title { margin: 0; color: var(--ink); font: 500 15px/22px var(--font-sans); }
.state-sub { margin: 0 0 var(--space-4); color: var(--ink-3); font: 400 12px/18px var(--font-sans); }
.mcp-empty { display: flex; flex-direction: column; gap: var(--space-6); }
.mcp-empty-head { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-7); border-radius: var(--radius-xl); background: var(--fill-1); }
.mcp-empty-head b { color: var(--ink); font: 500 14px/20px var(--font-sans); }
.mcp-empty-head span { color: var(--ink-3); font: 400 12px/18px var(--font-sans); }
.mcp-empty-head span.mcp-empty-open { color: var(--ink-2); font-weight: 500; }
.mcp-empty-actions { display: flex; gap: var(--space-4); margin-top: var(--space-4); }
.mcp-example { border-radius: var(--radius-xl); background: var(--canvas); padding: var(--space-5) var(--space-6) var(--space-6); }
.mcp-example-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4); }
.mcp-example-head span { color: var(--ink-2); font: 500 12px/17px var(--font-sans); }
.mcp-example pre { margin: 0; padding: var(--space-5); border-radius: var(--radius-lg); background: var(--fill-1); color: var(--ink-2); font: 400 11px/18px var(--font-mono); overflow: auto; white-space: pre; }
.mcp-list-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); }
.mcp-list-head span { color: var(--ink-3); font: 400 11.5px/17px var(--font-sans); }
.mcp-list { display: flex; flex-direction: column; gap: var(--space-4); }
.mcp-card { border-radius: var(--radius-lg); background: var(--fill-1); transition: background var(--duration-base) var(--ease-out); }
.mcp-card:hover { background: var(--fill-2); }
.mcp-row { display: flex; align-items: center; gap: var(--space-4); min-height: 62px; padding: var(--space-4) var(--space-5); }
.mcp-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-4); flex: none; }
.mcp-dot.ok { background: var(--success); box-shadow: 0 0 0 4px var(--success-fill); }
.mcp-dot.error { background: var(--danger); box-shadow: 0 0 0 4px var(--danger-fill); }
.mcp-name { min-width: 0; display: flex; align-items: center; gap: var(--space-3); flex: 1; }
.mcp-name b { color: var(--ink); font: 500 13.5px/19px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mcp-type { flex: none; padding: 2px 6px; border-radius: var(--radius-xs); background: var(--solid); color: var(--ink-3); font: 400 9.5px/13px var(--font-mono); text-transform: lowercase; }
.mcp-status { flex: none; color: var(--ink-3); font: 400 11.5px/16px var(--font-sans); }
.mcp-status.ok { color: var(--success); }
.mcp-status.error { color: var(--danger); }
.mcp-count { flex: none; color: var(--ink-4); font: 400 11px/16px var(--font-mono); }
.mcp-del { display: flex; align-items: center; gap: var(--space-4); margin: 0 var(--space-5) var(--space-4); padding: 9px 11px; border-radius: var(--radius-lg); background: var(--solid); font: 400 11.5px/17px var(--font-sans); color: var(--ink-2); animation: card-in 200ms var(--ease-out) both; }
.mcp-del .nv-i { width: 14px; height: 14px; color: var(--danger); flex: none; }
.mcp-del span { flex: 1; min-width: 0; }
.mcp-detail { display: flex; flex-direction: column; gap: var(--space-4); padding: 0 var(--space-6) var(--space-5) 44px; animation: card-in 240ms var(--ease-out) both; }
.mcp-line { display: flex; align-items: flex-start; gap: var(--space-5); }
.mcp-line > span, .mcp-tools > span { flex: 0 0 64px; padding-top: 1px; color: var(--ink-4); font: 400 10.5px/16px var(--font-sans); }
.mcp-line code { flex: 1; min-width: 0; color: var(--ink-2); font: 400 11px/17px var(--font-mono); word-break: break-all; }
.mcp-keys { display: flex; flex-wrap: wrap; gap: var(--space-3); }
.mcp-keys i { padding: 1px 6px; border-radius: var(--radius-xs); background: var(--fill-2); color: var(--ink-2); font: 400 10.5px/16px var(--font-mono); font-style: normal; }
.mcp-error { margin: 0; color: var(--danger); font: 400 11.5px/17px var(--font-sans); }
.mcp-tools { display: flex; gap: var(--space-5); align-items: flex-start; }
.mcp-tool-list { display: flex; flex-wrap: wrap; gap: var(--space-3); flex: 1; }
.mcp-tool { padding: 1px 7px; border-radius: var(--radius-xs); background: var(--fill-2); color: var(--ink-2); font: 400 10.5px/16px var(--font-mono); }
.mcp-path { margin: 0; color: var(--ink-4); font: 400 10.5px/16px var(--font-sans); word-break: break-all; }
.mcp-path code { font-family: var(--font-mono); }
.mcp-confirm-root { position: fixed; inset: 0; z-index: 2300; display: flex; align-items: center; justify-content: center; padding: var(--space-7); }
.mcp-confirm-scrim { position: absolute; inset: 0; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); animation: nv-fade var(--duration-base) var(--ease-out) both; }
.mcp-confirm { position: relative; width: min(520px, calc(100vw - 48px)); padding: var(--space-7); border-radius: var(--radius-2xl); background: var(--solid); box-shadow: var(--shadow-dialog); color: var(--ink); animation: nv-dialog-in var(--duration-slow) var(--ease-sheet) both; display: flex; flex-direction: column; gap: var(--space-4); }
.mcp-confirm h3 { margin: 0; font: 500 18px/26px var(--font-sans); letter-spacing: -0.015em; }
.mcp-confirm-text { margin: 0; color: var(--ink-2); font: 400 12.5px/19px var(--font-sans); }
.mcp-confirm-command { margin: 0; padding: var(--space-5); border-radius: var(--radius-lg); background: var(--fill-1); color: var(--ink); font: 400 11.5px/18px var(--font-mono); white-space: pre-wrap; word-break: break-all; }
.mcp-confirm-warn { display: flex; align-items: flex-start; gap: var(--space-3); margin: 0; padding: var(--space-5); border-radius: var(--radius-lg); background: var(--danger-fill); color: var(--ink-2); font: 400 12px/18px var(--font-sans); }
.mcp-confirm-warn .nv-i { width: 15px; height: 15px; color: var(--danger); flex: none; margin-top: 1px; }
.mcp-confirm-foot { display: flex; justify-content: flex-end; gap: var(--space-4); margin-top: var(--space-1); }
@keyframes card-in { from { opacity: 0; transform: translateY(6px); filter: blur(2px); } }
</style>
