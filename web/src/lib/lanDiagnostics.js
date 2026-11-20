// 局域网诊断：GET /api/lan/diagnostics 的按需加载 + 缓存 + 摘要 + 纯文本导出。
// 后端契约（另一岗实现）：self / interfaces / proxy / discovery / probe / checks。
// 旧后端没有这个路由时 status=404，界面据此显示「诊断接口未就绪」。
// 缓存只为「按需查看」服务：好友列表里的离线判断不会每次打开页面都重新探测。

const TTL = 20000;

let cache = { data: null, at: 0, status: 0, error: '' };
let pending = null;

export function diagnosticsCache() { return cache; }

/** 有缓存且没过期就直接用；失败不缓存（下次调用会重试）。 */
export async function loadDiagnostics(options = {}) {
    const force = !!options.force;
    if (!force && cache.data && Date.now() - cache.at < TTL) return cache;
    if (pending) return pending;
    pending = fetchOnce().finally(() => { pending = null; });
    return pending;
}

async function fetchOnce() {
    try {
        const response = await fetch('/api/lan/diagnostics', {
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
            cache = { data: null, at: Date.now(), status: response.status, error: detailOf(body, response.status) };
            return cache;
        }
        cache = { data: body && typeof body === 'object' ? body : {}, at: Date.now(), status: response.status, error: '' };
        return cache;
    } catch (e) {
        cache = { data: null, at: Date.now(), status: 0, error: e.message || '诊断请求失败' };
        return cache;
    }
}

function detailOf(body, status) {
    const detail = body && body.detail;
    if (typeof detail === 'string' && detail) return detail;
    return '请求失败（' + status + '）';
}

/** 本机自己的 IP：命中的 peer 是「本机其他实例」，不按网络可达性归类。 */
export function ownIps(diagnostics) {
    const data = diagnostics || {};
    const self = data.self || {};
    const interfaces = Array.isArray(data.interfaces) ? data.interfaces : [];
    const list = [self.lan_ip].concat(interfaces.map(item => item && item.ip));
    return new Set(list.filter(Boolean).map(value => String(value)));
}

export function probeState(entry) {
    if (!entry) return 'unknown';
    if (entry.reachable === true) return 'online';
    if (entry.reachable === false) return 'offline';
    return 'unknown';
}

/** 计数互斥：本机其他实例优先，其余按可达性分三类。 */
export function summarize(diagnostics) {
    const probes = Array.isArray((diagnostics || {}).probe) ? diagnostics.probe : [];
    const own = ownIps(diagnostics);
    let reachable = 0;
    let offline = 0;
    let unknown = 0;
    let local = 0;
    for (const entry of probes) {
        if (!entry) continue;
        if (own.has(String(entry.ip || ''))) { local += 1; continue; }
        const state = probeState(entry);
        if (state === 'online') reachable += 1;
        else if (state === 'offline') offline += 1;
        else unknown += 1;
    }
    return { total: probes.length, reachable, offline, unknown, local };
}

export function summarizeText(summary) {
    const parts = ['发现 ' + summary.total + ' 台'];
    if (summary.reachable) parts.push(summary.reachable + ' 台能连');
    if (summary.offline) parts.push(summary.offline + ' 台连不上');
    if (summary.unknown) parts.push(summary.unknown + ' 台未探测');
    if (summary.local) parts.push(summary.local + ' 台是本机其他实例');
    return parts.join(' · ');
}

/** 代理：契约是 {system_proxy, env_proxy, note}，实际后端给 {system, env, detected, hint}，两种都认。 */
export function proxyFlags(proxy) {
    const data = proxy || {};
    const system = typeof data.system_proxy === 'boolean'
        ? data.system_proxy
        : (data.detected === true || (Array.isArray(data.system) && data.system.length > 0));
    const env = typeof data.env_proxy === 'boolean'
        ? data.env_proxy
        : (Array.isArray(data.env) && data.env.length > 0);
    let note = typeof data.note === 'string' ? data.note : String(data.hint || '');
    if (!note) note = data.lan_requests_direct ? '局域网请求直连，不走代理' : '';
    return { system, env, note };
}

/** 自检项：新后端给 checks_list（[{name, ok, detail}]），旧形状是 {udp_bind: true, ...} 对象，统一成列表。 */
export function checkList(checks) {
    if (Array.isArray(checks)) {
        return checks.filter(Boolean).map(item => ({
            name: String(item.name || '检查'),
            ok: item.ok !== false,
            detail: text(item.detail, ''),
        }));
    }
    if (!checks || typeof checks !== 'object') return [];
    const list = [];
    for (const key of Object.keys(checks)) {
        const value = checks[key];
        if (typeof value === 'boolean') list.push({ name: key, ok: value, detail: '' });
        else if (typeof value === 'number') list.push({ name: key, ok: true, detail: String(value) });
        else if (typeof value === 'string' && value) {
            const isError = /_error$/.test(key);
            list.push({ name: key, ok: isError ? false : true, detail: value });
        }
    }
    return list;
}

function text(value, fallback = '') {
    const raw = value === null || value === undefined ? '' : String(value);
    return raw || fallback;
}

function yes(value) { return value ? '是' : '否'; }

function stampText() {
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
        + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
}

/** 供「复制诊断信息」：一整段纯文本，用户可以直接发出去。 */
export function diagnosticsText(diagnostics) {
    const data = diagnostics || {};
    const self = data.self || {};
    const proxy = proxyFlags(data.proxy);
    const discovery = data.discovery || {};
    const interfaces = Array.isArray(data.interfaces) ? data.interfaces : [];
    const peers = Array.isArray(discovery.peers) ? discovery.peers : [];
    const probes = Array.isArray(data.probe) ? data.probe : [];
    // 新后端补了 checks_list（列表），旧形状只有 checks（对象）：有列表就优先用它
    const checks = checkList(Array.isArray(data.checks_list) ? data.checks_list : data.checks);
    const lines = [];

    lines.push('NOVAI 网络诊断 · ' + stampText());
    lines.push('结论：' + summarizeText(summarize(data)));

    lines.push('');
    lines.push('[本机]');
    lines.push('id: ' + text(self.id, '—'));
    lines.push('好友码: ' + text(self.friend_code || self.code, '—'));
    lines.push('局域网 IP: ' + text(self.lan_ip, '—'));
    lines.push('端口: ' + text(self.port, '—'));
    lines.push('版本: ' + text(self.version, '—'));
    lines.push('局域网口令: ' + yes(self.lan_auth));

    lines.push('');
    lines.push('[网卡]');
    if (!interfaces.length) lines.push('（无）');
    for (const item of interfaces) {
        if (!item) continue;
        lines.push(text(item.name, '—') + ': ' + text(item.ip, '—') + ' / ' + text(item.netmask, '—')
            + ' / 广播 ' + text(item.broadcast, '—'));
    }

    lines.push('');
    lines.push('[代理]');
    lines.push('系统代理: ' + yes(proxy.system));
    lines.push('环境变量代理: ' + yes(proxy.env));
    lines.push('说明: ' + text(proxy.note, '无代理'));

    lines.push('');
    lines.push('[发现]');
    lines.push('开关: ' + (discovery.enabled ? '开启' : '关闭'));
    lines.push('最近错误: ' + text(discovery.last_error || discovery.last_broadcast_error, '无'));
    if (!peers.length) lines.push('peer: （无）');
    for (const peer of peers) {
        if (!peer) continue;
        lines.push('peer: ' + text(peer.code, '—') + ' ' + text(peer.nickname, '局域网用户')
            + ' ' + text(peer.ip, '—') + ':' + text(peer.port, '—')
            + ' ' + text(peer.seen_ms_ago, '—') + 'ms 前');
    }

    lines.push('');
    lines.push('[探测]');
    if (!probes.length) lines.push('（无）');
    for (const entry of probes) {
        if (!entry) continue;
        const state = probeState(entry) === 'online' ? '能连' : probeState(entry) === 'offline' ? '连不上' : '未探测';
        // probe 可能不带昵称（契约只保证 code / ip / port），按码回 discovery.peers 补
        const code = String(entry.code || '');
        const known = code ? peers.find(peer => peer && String(peer.code || '') === code) : null;
        const nickname = text(entry.nickname || (known && known.nickname), '局域网用户');
        const bits = [text(entry.code, '—'), nickname,
            text(entry.ip, '—') + ':' + text(entry.port, '—'), state];
        if (entry.latency_ms) bits.push('延迟 ' + entry.latency_ms + 'ms');
        if (entry.http_status) bits.push('HTTP ' + entry.http_status);
        if (entry.error) bits.push('错误 ' + entry.error);
        lines.push(bits.join(' | '));
    }

    lines.push('');
    lines.push('[检查]');
    if (!checks.length) lines.push('（无）');
    for (const check of checks) {
        if (!check) continue;
        lines.push((check.ok ? '[通过] ' : '[失败] ') + text(check.name, '检查') + (check.detail ? '：' + check.detail : ''));
    }

    return lines.join('\n');
}
