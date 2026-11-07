// 账号（2026-11-07 接上登录 / 注册）：
//   · 后端三种模式：off（没有账号体系）/ optional（默认，可选登录：不登录照常本机用）/ required（必须登录）；
//   · 这里集中管登录态 + 登录弹层的开关，「我的」页、登录页、标题栏都读这一份；
//   · 所有接口都可能失败（旧后端没有 /api/auth/config），一律兜底，不让页面崩。
import { reactive } from 'vue';

export const auth = reactive({
    loaded: false,
    mode: 'off',            // off | optional | required
    loggedIn: false,
    user: null,             // { id, username, role, avatar? }
    inviteRequired: true,
    hasUsers: true,         // false = 这台 NOVAI 还没有任何账号（第一个注册的是管理员）
    dialog: '',             // '' | 'login' | 'register' | 'reset'：弹层当前视图
});

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

async function getJSON(url) {
    const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!r.ok) throw Object.assign(new Error('http ' + r.status), { status: r.status });
    return r.json();
}

/* 后端错误码 → 给人看的话（后端 detail 已经是中文，这里只补几个更具体的） */
const CODE_TEXT = {
    bad_credentials: '用户名或密码不正确',
    user_disabled: '这个账号已被停用，请联系管理员',
    invite_required: '需要邀请码才能注册，请向管理员索取',
    invalid_invite: '邀请码无效，请检查后重试',
    invite_disabled: '这个邀请码已停用',
    invite_expired: '这个邀请码已过期',
    invite_exhausted: '这个邀请码已被用完',
    username_taken: '用户名已被占用，换一个试试',
    rate_limited: '尝试太频繁了，请稍后再试',
    auth_disabled: '当前没有开启账号功能',
};

async function post(url, body) {
    let r;
    try {
        r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: JSON_HEADERS, body: JSON.stringify(body || {}) });
    } catch (e) {
        throw new Error('连不上服务，请检查网络后重试');
    }
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (!r.ok) {
        const code = data && data.code;
        const detail = data && (typeof data.detail === 'string' ? data.detail : '');
        throw Object.assign(new Error(CODE_TEXT[code] || detail || '操作失败（' + r.status + '）'), { code, status: r.status });
    }
    return data || {};
}

/** 读模式 + 登录态。force=false 时已读过就不再请求 */
export async function loadAuth(force = false) {
    if (auth.loaded && !force) return auth;
    try {
        const cfg = await getJSON('/api/auth/config');
        auth.mode = cfg.auth_mode || 'off';
        auth.inviteRequired = cfg.invite_required !== false;
        auth.hasUsers = cfg.has_users !== false;
    } catch (e) {
        // 旧后端没有 config：用 me 推断（auth_enabled=true 就是必须登录）
        auth.mode = 'off';
    }
    try {
        const me = await getJSON('/api/auth/me');
        if (me.auth_mode) auth.mode = me.auth_mode;
        else if (me.auth_enabled === true) auth.mode = 'required';
        const logged = me.logged_in === true || (me.auth_enabled === true && !!me.username);
        auth.loggedIn = logged;
        auth.user = logged ? { id: me.id, username: me.username, role: me.role, avatar: me.avatar || '' } : null;
    } catch (e) {
        auth.loggedIn = false;
        auth.user = null;
    }
    auth.loaded = true;
    return auth;
}

export async function login(username, password) {
    const data = await post('/api/auth/login', { username: String(username || '').trim(), password: String(password || '') });
    await loadAuth(true);
    return data.user;
}

export async function register(username, password, inviteCode) {
    const data = await post('/api/auth/register', {
        username: String(username || '').trim(),
        password: String(password || ''),
        invite_code: String(inviteCode || '').trim(),
    });
    await loadAuth(true);
    return data.user;
}

export async function resetPassword(username, code, newPassword) {
    return post('/api/auth/reset-password', { username: String(username || '').trim(), code: String(code || '').trim(), new_password: String(newPassword || '') });
}

export async function logout() {
    try { await post('/api/auth/logout', {}); } catch (e) { /* 网络失败也按已退出处理 */ }
    if (auth.mode === 'required') { location.assign('/login'); return; }
    await loadAuth(true);
}

/* ───── 管理员：注册方式 + 邀请码 ───── */
export async function getAuthSettings() { return getJSON('/api/admin/auth-settings'); }
export async function setInviteRequired(required) {
    let r;
    try {
        r = await fetch('/api/admin/auth-settings', { method: 'PUT', credentials: 'same-origin', headers: JSON_HEADERS, body: JSON.stringify({ invite_required: !!required }) });
    } catch (e) { throw new Error('连不上服务，请检查网络后重试'); }
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error((data && data.detail) || '保存失败（' + r.status + '）');
    auth.inviteRequired = !!(data && data.invite_required);
    return auth.inviteRequired;
}
export async function createInvite(opts = {}) {
    const data = await post('/api/admin/invites', { uses: opts.uses || 1, days: opts.days == null ? 7 : opts.days, role: opts.role || 'user' });
    return data;
}

export function openAuth(view = 'login') { auth.dialog = view; }
export function closeAuth() { auth.dialog = ''; }

/** 当前地址是不是独立的登录 / 忘记密码页（必须登录模式下中间件会把人送到 /login） */
export function standaloneView() {
    const p = location.pathname.replace(/\/+$/, '');
    if (p === '/login' || p === '/login.html') return 'login';
    if (p === '/reset' || p === '/reset.html') return 'reset';
    return '';
}

/** 登录成功后去哪：?next= 只接受站内路径 */
export function nextUrl() {
    try {
        const n = new URLSearchParams(location.search).get('next') || '';
        if (n.startsWith('/') && !n.startsWith('//')) return n;
    } catch (e) {}
    return '/';
}
