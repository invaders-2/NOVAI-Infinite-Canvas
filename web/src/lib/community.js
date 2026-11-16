// 社区（局域网版）前端公共件：接口封装 + 类型标签 + 时间 / 体积 / 计数格式化。
// 后端契约见 server/routes/community.py：本机接口 /api/community/*，公开接口 /api/community/public/*。

export const KINDS = ['canvas', 'skill', 'prompt'];

export const KIND_META = {
    canvas: { label: '画布', icon: 'canvas', unit: '个节点' },
    skill: { label: '技能', icon: 'wand2', unit: '' },
    prompt: { label: '提示词', icon: 'type', unit: '' },
};

export const CATEGORIES = ['电商', '海报', '人像', '分镜视频', '角色设定', '其它'];

export function kindMeta(kind) { return KIND_META[kind] || KIND_META.canvas; }

export async function communityApi(path, options = {}) {
    const opts = { credentials: 'same-origin', headers: { Accept: 'application/json' }, ...options };
    if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof FormData)) {
        opts.headers = { ...opts.headers, 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(opts.body);
    }
    const response = await fetch('/api/community' + path, opts);
    let body = null;
    try { body = await response.json(); } catch (e) { body = null; }
    if (!response.ok) {
        const detail = (body && body.detail) || ('请求失败（' + response.status + '）');
        const error = new Error(typeof detail === 'string' ? detail : '请求失败');
        error.status = response.status;
        error.body = body;
        throw error;
    }
    return body || {};
}

export function ago(value) {
    const stamp = Number(value) || 0;
    if (!stamp) return '';
    const ms = stamp < 1e12 ? stamp * 1000 : stamp;
    const diff = Math.max(0, Date.now() - ms);
    const mins = Math.round(diff / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return mins + ' 分钟前';
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + ' 小时前';
    const days = Math.round(hours / 24);
    if (days < 30) return days + ' 天前';
    const months = Math.round(days / 30);
    if (months < 12) return months + ' 个月前';
    return Math.round(months / 12) + ' 年前';
}

export function fmtSize(bytes) {
    const size = Number(bytes) || 0;
    if (!size) return '—';
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
    return (size / 1024 / 1024).toFixed(1) + ' MB';
}

export function fmtCount(value) {
    const num = Number(value) || 0;
    if (num < 1000) return String(num);
    if (num < 10000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return (num / 10000).toFixed(1).replace(/\.0$/, '') + 'w';
}

/** 作品封面地址：自己的包 / 别人的缓存都走本机代理，作者离线时不会闪白。 */
export function coverUrl(item) {
    const id = item && item.id;
    if (!id) return '';
    const stamp = Number((item && item.package_updated_at) || (item && item.updated_at) || 0);
    if (!item.cover) return '';
    return '/api/community/cover/' + encodeURIComponent(id) + '?v=' + stamp;
}

/** 详情快照里的媒体地址已经是本机代理地址，这里只给 <img>/<video> 用。 */
export function mediaUrl(url) {
    const text = String(url || '');
    if (!text) return '';
    if (/^(https?:|data:|blob:|\/)/.test(text)) return text;
    return '/' + text.replace(/^\/+/, '');
}

export function authorInitial(author) {
    const nickname = String((author && author.nickname) || '').trim();
    if (!nickname) return '友';
    return [...nickname][0].toUpperCase();
}

export function avatarImage(author) {
    const avatar = String((author && author.avatar) || '');
    return avatar.startsWith('data:') ? avatar : '';
}

export function avatarText(author) {
    const avatar = String((author && author.avatar) || '');
    if (!avatar || avatar.startsWith('data:')) return '';
    return [...avatar].slice(0, 2).join('');
}

/** 克隆结果 → 一句提示（画布还可以直接打开新画布）。 */
export function describeCloneResult(body) {
    const result = body || {};
    if (result.kind === 'canvas' || (!result.kind && result.target_id)) {
        const failed = Number(result.failed) || 0;
        return {
            text: '已克隆到我的画布' + (failed ? '（' + failed + ' 个素材没取到，已标注）' : ''),
            canvasUrl: '/static/canvas.html?id=' + encodeURIComponent(result.target_id || '') + '&project=default',
        };
    }
    if (result.kind === 'skill') return { text: result.message || '技能已导入，默认停用，去设置里确认后启用' };
    if (result.kind === 'prompt') return { text: '提示词已加进「社区」分组' };
    return { text: '已完成' };
}
