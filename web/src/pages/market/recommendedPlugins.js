// 应用市场「插件」区的推荐插件：读 /api/mcp/catalog 拿目录里可安装的插件（当前只有 Photoshop 精修）。
// 安装是后端后台任务，这里只负责发起 + 每 1.5s 轮询进度；卡片由市场页按 .pl 结构和其它插件同构渲染。
// 装好（installed）且 MCP 列表里已经有同名服务时不再返回它 —— 状态和停用/启用交给下面那张服务卡。
import { computed, onMounted, onUnmounted, ref, unref } from 'vue';
import { toast } from '../../lib/store.js';
import { ICONS } from '../../lib/icons.js';

const POLL_MS = 1500;

export function useRecommendedPlugins(options = {}) {
    const onInstalled = typeof options.onInstalled === 'function' ? options.onInstalled : () => {};
    const items = ref([]);
    const enabling = ref('');
    const timers = new Map();
    let alive = true;

    // 已经接入的 MCP 服务名：用于判断「这张卡是否已经在下面有同名服务卡」
    const served = computed(() => {
        const list = unref(options.servers);
        return new Set((Array.isArray(list) ? list : []).map(row => row && row.name).filter(Boolean));
    });
    const visible = computed(() => items.value.filter(it => !(it.state === 'installed' && it.server_name && served.value.has(it.server_name))));

    function stateOf(raw) {
        const v = String(raw || '').toLowerCase();
        if (v === 'done' || v === 'installed' || v === 'success') return 'installed';
        if (v === 'failed' || v === 'error') return 'failed';
        if (v === 'installing' || v === 'running' || v === 'pending') return 'installing';
        return 'idle';
    }
    const installing = it => !!it && it.state === 'installing';
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
        if (!it || it.state === 'installing') return;
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
        onInstalled();
        if (it) toast((it.name || '插件') + ' 安装完成', { icon: 'check' });
        loadCatalog();
    }

    async function enable(it) {
        if (!it || enabling.value) return;
        enabling.value = it.id;
        try {
            const res = await fetch('/api/mcp/servers/' + encodeURIComponent(it.server_name) + '/enable', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ confirm: true }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(errText(body, res.status));
            onInstalled();
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

    return { items, visible, enabling, install, enable, countOf, missing, stateOf, iconOf, installing, reload: loadCatalog };
}
