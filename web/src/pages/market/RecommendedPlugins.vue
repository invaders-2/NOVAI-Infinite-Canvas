<script setup>
// 推荐插件：读 /api/mcp/catalog，把目录里可安装的插件（当前是 Photoshop 精修）做成一张推荐卡。
// 安装是后端跑的后台任务，这里只负责发起 + 每 1.5s 轮询进度；目录接口不可用时整块隐藏，市场页不受影响。
import { computed, onMounted, onUnmounted, ref } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import { toast } from '../../lib/store.js';
import { ICONS } from '../../lib/icons.js';

const POLL_MS = 1500;
const emit = defineEmits(['installed']);

const items = ref([]);
const enabling = ref('');
const timers = new Map();
let alive = true;

const visible = computed(() => items.value.length > 0);

function stateOf(raw) {
    const v = String(raw || '').toLowerCase();
    if (v === 'done' || v === 'installed' || v === 'success') return 'installed';
    if (v === 'failed' || v === 'error') return 'failed';
    if (v === 'installing' || v === 'running' || v === 'pending') return 'installing';
    return 'idle';
}
function errText(body, status) {
    const detail = body && body.detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
    return 'HTTP ' + status;
}
function patch(id, next) {
    items.value = items.value.map(it => (it.id === id ? { ...it, ...next } : it));
}
function iconOf(it) {
    return it && it.icon && ICONS[it.icon] ? it.icon : 'image';
}
function countOf(it) {
    return Number(it && it.tool_count) || 0;
}
// requires 里为 false 的才提示；字段缺失（后端没给）就当不用管
function missing(it) {
    const req = (it && it.requires) || {};
    const out = [];
    if (req.node === false) out.push('需要先装 Node.js');
    if (req.photoshop === false) out.push('没检测到 Photoshop');
    return out;
}

function stopPoll(id) {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
}
function stopAll() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
}

async function loadCatalog() {
    try {
        const res = await fetch('/api/mcp/catalog', { headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        const body = await res.json();
        const list = Array.isArray(body && body.items) ? body.items.filter(it => it && it.id) : [];
        items.value = list.map(it => ({ ...it, state: stateOf(it.state) }));
        // 上次没装完的（页面刷新 / 切页回来）接着轮询
        for (const it of items.value) if (it.state === 'installing') startPoll(it.id);
    } catch (e) {
        // 目录接口还没上线：整块静默隐藏
    }
}

async function install(it) {
    if (it.state === 'installing') return;
    const prev = { state: it.state, error: it.error || '' };
    patch(it.id, { state: 'installing', step: '', error: '' });
    try {
        const res = await fetch('/api/mcp/catalog/' + encodeURIComponent(it.id) + '/install', {
            method: 'POST',
            headers: { Accept: 'application/json' },
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(errText(body, res.status));
        if (stateOf(body.state) === 'installed') {
            patch(it.id, { state: 'installed' });
            finish(it.id);
            return;
        }
        patch(it.id, { state: 'installing', step: body.step || '' });
        startPoll(it.id);
    } catch (e) {
        patch(it.id, prev);
        toast((e && e.message) || '安装失败，请稍后再试', { danger: true, icon: 'alert' });
    }
}

function startPoll(id) {
    stopPoll(id);
    const timer = setTimeout(async function tick() {
        if (!alive) return;
        timers.delete(id);
        let body = null;
        try {
            const res = await fetch('/api/mcp/catalog/' + encodeURIComponent(id) + '/install', { headers: { Accept: 'application/json' } });
            if (res.ok) body = await res.json().catch(() => null);
        } catch (e) {
            // 网络抖动：继续等下一轮
        }
        if (!alive) return;
        if (!body) {
            timers.set(id, setTimeout(tick, POLL_MS));
            return;
        }
        const state = stateOf(body.state);
        if (state === 'installed') {
            patch(id, { state: 'installed', step: '', error: '' });
            finish(id);
            return;
        }
        if (state === 'failed') {
            patch(id, { state: 'failed', step: '', error: String(body.error || '安装失败') });
            toast('安装失败：' + (body.error || '请稍后重试'), { danger: true, icon: 'alert' });
            return;
        }
        patch(id, { state: 'installing', step: String(body.step || '') });
        timers.set(id, setTimeout(tick, POLL_MS));
    }, POLL_MS);
    timers.set(id, timer);
}

function finish(id) {
    const it = items.value.find(x => x.id === id);
    emit('installed');
    if (it) toast((it.name || '插件') + ' 安装完成', { icon: 'check' });
    loadCatalog();
}

async function enable(it) {
    if (enabling.value) return;
    enabling.value = it.id;
    try {
        const res = await fetch('/api/mcp/servers/' + encodeURIComponent(it.server_name) + '/enable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ confirm: true }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(errText(body, res.status));
        emit('installed');
        // 目录里的 enabled 还叠着 MCP 总开关，重新拉一次才反映真实状态
        await loadCatalog();
        toast((body.ok ? '已启用 ' : '已提交启用：') + (it.name || it.server_name), { danger: !body.ok, icon: 'check' });
    } catch (e) {
        toast((e && e.message) || '启用失败', { danger: true, icon: 'alert' });
    } finally {
        enabling.value = '';
    }
}

onMounted(loadCatalog);
onUnmounted(() => {
    alive = false;
    stopAll();
});
</script>

<template>
    <section v-if="visible" class="rec" aria-label="推荐插件">
        <div class="rec-cap"><NvIcon name="sparkles" />推荐插件</div>
        <div class="rec-list">
            <article v-for="it in items" :key="it.id" class="rec-card">
                <span class="ic"><NvIcon :name="iconOf(it)" /></span>
                <div class="rec-body">
                    <div class="rec-ttl"><b>{{ it.name || it.server_name || '插件' }}</b><span v-if="it.size_hint" class="sz">{{ it.size_hint }}</span></div>
                    <p v-if="it.summary || it.description" class="rec-sum">{{ it.summary || it.description }}</p>
                    <p v-if="missing(it).length" class="rec-need"><NvIcon name="alert" />{{ missing(it).join(' · ') }}</p>
                    <p v-if="it.state === 'failed' && it.error" class="rec-err">{{ it.error }}</p>
                </div>
                <div class="rec-act">
                    <template v-if="it.state === 'installed'">
                        <span class="rec-done"><NvIcon name="check" />已安装 · {{ countOf(it) }} 个工具</span>
                        <button v-if="it.enabled === false" type="button" class="nv-btn sm primary" :disabled="enabling === it.id" @click="enable(it)">{{ enabling === it.id ? '启用中…' : '启用' }}</button>
                    </template>
                    <template v-else-if="it.state === 'installing'">
                        <button type="button" class="nv-btn sm primary" disabled>安装中…</button>
                        <p v-if="it.step" class="rec-step" aria-live="polite">{{ it.step }}</p>
                    </template>
                    <button v-else type="button" class="nv-btn sm primary" @click="install(it)">{{ it.state === 'failed' ? '重试' : '安装' }}</button>
                </div>
            </article>
        </div>
    </section>
</template>

<style scoped>
.rec { margin: 0 0 16px; }
.rec-cap { display: flex; align-items: center; gap: 5px; margin: 0 0 8px; color: var(--ink-3); font: 500 11.5px/16px var(--font-sans); letter-spacing: .02em; }
.rec-cap .nv-i { width: 12px; height: 12px; color: var(--ink-4); }
.rec-list { display: grid; gap: 10px; }
.rec-card { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; padding: 14px 16px; border-radius: 16px; background: color-mix(in srgb, var(--solid) 78%, transparent); backdrop-filter: var(--material-thick); -webkit-backdrop-filter: var(--material-thick); box-shadow: var(--shadow-float); transition: background var(--duration-base) var(--ease-out); }
.rec-card:hover { background: color-mix(in srgb, var(--solid) 88%, transparent); }
.rec-card .ic { width: 40px; height: 40px; flex: none; border-radius: 12px; background: var(--fill-1); display: flex; align-items: center; justify-content: center; color: var(--ink-2); }
.rec-card .ic .nv-i { width: 18px; height: 18px; }
.rec-body { flex: 1 1 240px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.rec-ttl { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.rec-ttl b { font: 600 14px/20px var(--font-sans); color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rec-ttl .sz { flex: none; font: 400 11px/16px var(--font-mono); color: var(--ink-4); }
.rec-sum { margin: 0; font: 400 12px/18px var(--font-sans); color: var(--ink-3); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.rec-need { display: flex; align-items: center; gap: 4px; margin: 2px 0 0; font: 400 11px/16px var(--font-sans); color: var(--ink-3); }
.rec-need .nv-i { width: 12px; height: 12px; flex: none; color: var(--ink-4); }
.rec-err { margin: 2px 0 0; font: 400 11.5px/17px var(--font-sans); color: var(--danger); word-break: break-word; }
.rec-act { margin-left: auto; flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; max-width: 42%; }
.rec-act .nv-btn { min-width: 64px; }
.rec-step { margin: 0; max-width: 100%; text-align: right; font: 400 11px/16px var(--font-sans); color: var(--ink-3); word-break: break-word; }
.rec-done { display: inline-flex; align-items: center; gap: 4px; font: 400 11.5px/16px var(--font-sans); color: var(--ink-3); white-space: nowrap; }
.rec-done .nv-i { width: 13px; height: 13px; color: var(--success); }
</style>
