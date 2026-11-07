<script setup>
// 我的（页面 id: me）：2026-11 把右上角头像菜单拆出来独立成页。
// 上半是身份（LAN 昵称 / 头像 + 编辑资料），中间是三个统计，下面是好友和账户；
// 所有接口都可能不存在（旧后端 / 未登录），一律 try/catch 兜底成 0 / 空态，页面本身不能崩。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import ProfileDialog from '../../shell/ProfileDialog.vue';
import { state, toast } from '../../lib/store.js';
import { frameEl, navigate, openCanvasUrl } from '../../lib/bridge.js';
import NvSwitch from '../../components/NvSwitch.vue';
import { auth, loadAuth, openAuth, logout as authLogout, getAuthSettings, setInviteRequired, createInvite } from '../../lib/auth.js';

const ROLE_TEXT = { admin: '管理员', team: '团队', user: '普通用户' };

/* ───────── 身份：LAN 优先，auth 开启时补账号名 / 角色 ───────── */
const lan = ref(null);
const lanBroken = ref(false);
// 账号：读 lib/auth.js 的共享登录态（登录弹层登录后这里立即更新）
const me = computed(() => (auth.loggedIn ? auth.user : null));
const authName = computed(() => String((me.value && me.value.username) || '').trim());
const authOn = computed(() => !!authName.value);
const accountsOn = computed(() => auth.mode !== 'off');
const displayName = computed(() => String((lan.value && lan.value.nickname) || '').trim() || authName.value || '本机用户');
const roleText = computed(() => ROLE_TEXT[(me.value && me.value.role) || ''] || '用户');
const isAdmin = computed(() => !!(me.value && me.value.role === 'admin'));
const subtitle = computed(() => '本机 · LAN 用户 · ' + (authOn.value ? authName.value + ' · ' + roleText.value : '未登录'));
const fallbackText = computed(() => (authName.value ? [...authName.value][0].toUpperCase() : '我'));
const avatarImg = computed(() => {
    if (lanBroken.value) return '';
    const a = lan.value && lan.value.avatar;
    return typeof a === 'string' && a.startsWith('data:') ? a : '';
});
const avatarText = computed(() => {
    if (avatarImg.value) return '';
    const a = String((lan.value && lan.value.avatar) || '').trim();
    return a && !a.startsWith('data:') ? a.slice(0, 8) : '';
});
const profileNick = computed(() => String((lan.value && lan.value.nickname) || '').trim() || displayName.value);
const profileAvatar = computed(() => String((lan.value && lan.value.avatar) || ''));

async function loadLan() {
    try {
        const r = await fetch('/api/lan/me', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
        if (!r.ok) return;
        const data = await r.json();
        if (data && data.me && typeof data.me === 'object') lan.value = data.me;
    } catch (e) { /* 旧后端没有 LAN 接口：退回本机用户 */ }
}
async function loadMe() { await loadAuth(true); }

/* ───────── 积分：沿用旧右上角菜单的来源（credits.js 全局状态 + SSE 事件），接口缺失就不展示 ───────── */
const credits = ref(null);
const creditText = computed(() => formatCredits(credits.value ? credits.value.balance : 0));

function formatCredits(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num.toFixed(2) : '0.00';
}
function applyCredits(detail) {
    if (!detail || detail.available !== true || detail.enabled === false) { credits.value = null; return; }
    credits.value = detail;
}
function onCreditsEvent(event) { applyCredits(event.detail); }
async function loadCredits() {
    if (window.NOVAI_CREDITS) { applyCredits(window.NOVAI_CREDITS.state); return; }
    try {
        const res = await fetch('/api/credits/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        const data = await res.json();
        if (!data || data.auth_enabled === false || typeof data.balance === 'undefined') return;
        applyCredits({ available: true, enabled: data.enabled !== false, balance: Number(data.balance) || 0, usd_per_credit: Number(data.usd_per_credit) || 0.1 });
    } catch (e) { /* 积分关闭或接口不可用：不展示 */ }
}

/* ───────── 统计：三个数各自独立取，失败就显示 0 ───────── */
const canvases = ref(0);
const assets = ref(0);

async function loadCanvasCount() {
    try {
        const r = await fetch('/api/canvases', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
        if (!r.ok) return 0;
        const data = await r.json();
        return Array.isArray(data && data.canvases) ? data.canvases.filter(Boolean).length : 0;
    } catch (e) { return 0; }
}
async function loadAssetCount() {
    try {
        const r = await fetch('/api/asset-library', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
        if (!r.ok) return 0;
        const data = await r.json();
        const lib = (data && data.library) || {};
        // 新版返回 libraries[]，老版只有顶层 categories[]，两种都数一遍
        const libs = Array.isArray(lib.libraries) && lib.libraries.length ? lib.libraries : [{ categories: lib.categories || [] }];
        return libs.reduce((n, l) => n + (Array.isArray(l && l.categories) ? l.categories : [])
            .reduce((m, c) => m + (Array.isArray(c && c.items) ? c.items.length : 0), 0), 0);
    } catch (e) { return 0; }
}
async function loadStats() {
    const [c, a] = await Promise.all([loadCanvasCount(), loadAssetCount()]);
    canvases.value = c;
    assets.value = a;
}

/* ───────── 好友：最多 6 个，点好友 = 打开最近画布并发 novai:lan-open ───────── */
const friends = ref([]);
const friendsState = ref('idle');       // idle | loading | ready | error
const friendsMore = ref(false);
const friendBroken = ref(new Set());
let friendsBusy = false;
const shownFriends = computed(() => (friendsMore.value ? friends.value : friends.value.slice(0, 6)));
const hasMoreFriends = computed(() => friends.value.length > 6);

async function loadFriends() {
    if (friendsBusy) return;
    friendsBusy = true;
    if (!friends.value.length) friendsState.value = 'loading';
    try {
        const r = await fetch('/api/lan/friends', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        friends.value = (Array.isArray(data && data.friends) ? data.friends : []).filter(f => f && f.id);
        friendsState.value = 'ready';
    } catch (e) {
        friendsState.value = 'error';
    } finally {
        friendsBusy = false;
    }
}
function friendAvatarImg(f) {
    if (!f || friendBroken.value.has(f.id)) return '';
    return typeof f.avatar === 'string' && f.avatar.startsWith('data:') ? f.avatar : '';
}
function friendAvatarText(f) {
    const a = String((f && f.avatar) || '').trim();
    if (a && !a.startsWith('data:')) return a.slice(0, 8);
    return [...(String((f && f.nickname) || '友').trim() || '友')][0];
}
function markFriendAvatar(id) { friendBroken.value.add(id); }
function friendStateText(f) {
    if (f && f.online) return '在线';
    const t = Number(f && f.last_seen) || 0;
    if (!t) return '离线';
    const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (mins < 1) return '离线 刚刚';
    if (mins < 60) return '离线 ' + mins + ' 分钟前';
    const hours = Math.round(mins / 60);
    if (hours < 24) return '离线 ' + hours + ' 小时前';
    const days = Math.round(hours / 24);
    if (days < 30) return '离线 ' + days + ' 天前';
    return '离线';
}

function tsOf(c) { const v = Number((c && (c.updated_at || c.created_at)) || 0); return v < 1e10 ? v * 1000 : v; }
async function latestCanvas() {
    try {
        const r = await fetch('/api/canvases', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
        if (!r.ok) return null;
        const data = await r.json();
        const list = (Array.isArray(data && data.canvases) ? data.canvases : []).filter(Boolean);
        list.sort((a, b) => tsOf(b) - tsOf(a));
        return list[0] || null;
    } catch (e) { return null; }
}
function postToCanvas(payload) {
    const frame = frameEl('canvas');
    try { frame && frame.contentWindow && frame.contentWindow.postMessage(payload, '*'); } catch (e) {}
}
function waitCanvasReady(url, done) {
    const frame = frameEl('canvas');
    let target = url;
    try { target = new URL(url, location.href).href; } catch (e) {}
    let tries = 0;
    const tick = () => {
        let ready = false;
        try {
            const win = frame && frame.contentWindow;
            ready = !!win && win.location.href === target && win.document.readyState === 'complete';
        } catch (e) { ready = false; }
        if (ready || tries++ >= 80) { done(); return; }
        setTimeout(tick, 100);
    };
    tick();
}
async function openFriendChat(f) {
    const c = await latestCanvas();
    if (!c) { toast('先打开一张画布，就能在里面聊天'); return; }
    const url = '/static/canvas.html?id=' + encodeURIComponent(c.id) + '&project=' + encodeURIComponent(c.project || 'default');
    let same = false;
    try { same = !!frameEl('canvas') && frameEl('canvas').contentWindow.location.href === new URL(url, location.href).href; } catch (e) { same = false; }
    if (same) { state.canvasOpen = true; navigate('canvas'); }   // 已经停在这张画布上：不再重设 src，避免整页重载丢消息
    else openCanvasUrl(url);
    waitCanvasReady(url, () => postToCanvas({ type: 'novai:lan-open', friendId: String(f.id) }));
}

/* ───────── 资料 / 账户 ───────── */
const profileOpen = ref(false);
function openProfile() { profileOpen.value = true; }
function onProfileSaved(next) {
    if (next && typeof next === 'object') lan.value = next;   // 保存后头像和昵称立即更新，不用刷新页面
    else loadLan();
}
function go(path) { location.assign(path); }
async function logout() {
    await authLogout();     // 必须登录模式会回登录页；可选登录模式留在这里变回「未登录」
    toast('已退出登录');
}

/* ───────── 管理员：注册方式 + 邀请码 ───────── */
const openReg = ref(false);
const regBusy = ref(false);
const lastInvite = ref('');
const inviteCopied = ref(false);
watch(isAdmin, async (yes) => {
    if (!yes) return;
    try { openReg.value = !(await getAuthSettings()).invite_required; } catch (e) { /* 读不到就保持默认 */ }
}, { immediate: true });
async function toggleOpenReg(v) {
    if (regBusy.value) return;
    regBusy.value = true;
    const prev = openReg.value;
    openReg.value = v;
    try {
        const required = await setInviteRequired(!v);
        openReg.value = !required;
        toast(required ? '已改为凭邀请码注册' : '已开放注册，不需要邀请码');
    } catch (e) {
        openReg.value = prev;
        toast((e && e.message) || '保存失败', { danger: true });
    } finally { regBusy.value = false; }
}
async function newInvite() {
    try {
        const inv = await createInvite({ uses: 1, days: 7, role: 'user' });
        lastInvite.value = inv && inv.code ? String(inv.code) : '';
        if (!lastInvite.value) return;
        try { await navigator.clipboard.writeText(lastInvite.value); inviteCopied.value = true; toast('邀请码已复制：' + lastInvite.value); }
        catch (e) { inviteCopied.value = false; toast('邀请码：' + lastInvite.value + '（没能自动复制，请手动记下）'); }
    } catch (e) { toast((e && e.message) || '生成失败', { danger: true }); }
}

function loadAll() { loadLan(); loadMe(); loadStats(); loadFriends(); loadCredits(); }
// 从别的页面切回来时刷新：画布 / 素材数 / 余额可能在别处变了
function onFocus(e) { if (!e.detail || e.detail.id !== 'me') return; loadAll(); }
onMounted(() => {
    loadAll();
    document.addEventListener('novai-credits', onCreditsEvent);
    window.addEventListener('novai-page-focus', onFocus);
});
onBeforeUnmount(() => {
    document.removeEventListener('novai-credits', onCreditsEvent);
    window.removeEventListener('novai-page-focus', onFocus);
});
</script>

<template>
    <div class="me">
        <div class="me-in">
            <header class="me-head">
                <span class="me-av" aria-hidden="true">
                    <img v-if="avatarImg" :src="avatarImg" alt="" @error="lanBroken = true" />
                    <template v-else>{{ avatarText || fallbackText }}</template>
                </span>
                <div class="me-id">
                    <b>{{ displayName }}</b>
                    <span class="sub">{{ subtitle }}</span>
                    <span v-if="authOn && credits" class="me-credits">
                        <span class="val">积分 {{ creditText }}</span>
                        <span class="note">管理员分配</span>
                    </span>
                </div>
                <button type="button" class="me-edit" @click="openProfile">编辑资料</button>
            </header>

            <div class="me-stats">
                <div class="stat"><b>{{ canvases }}</b><span>画布</span></div>
                <div class="stat"><b>{{ assets }}</b><span>素材</span></div>
                <div class="stat"><b>{{ friends.length }}</b><span>好友</span></div>
            </div>

            <section class="me-card">
                <div class="me-card-hd">
                    <span>好友</span>
                    <button v-if="hasMoreFriends" type="button" @click="friendsMore = !friendsMore">{{ friendsMore ? '收起' : '查看全部' }}</button>
                </div>
                <div v-if="friendsState === 'loading' && !friends.length" class="me-empty">正在读取好友…</div>
                <div v-else-if="friendsState === 'error' && !friends.length" class="me-empty"><b>好友列表读取失败</b></div>
                <div v-else-if="!friends.length" class="me-empty">
                    <b>还没有好友</b>
                    在画布里点左下角头像，用好友码加好友
                </div>
                <div v-else class="me-friends">
                    <button v-for="f in shownFriends" :key="f.id" type="button" class="me-fr" @click="openFriendChat(f)">
                        <span class="av" aria-hidden="true"><img v-if="friendAvatarImg(f)" :src="friendAvatarImg(f)" alt="" @error="markFriendAvatar(f.id)" /><template v-else>{{ friendAvatarText(f) }}</template></span>
                        <span class="tx"><b>{{ f.nickname || '好友' }}</b><small class="st" :class="{ on: f.online }">{{ friendStateText(f) }}</small></span>
                        <i v-if="Number(f.unread) > 0" class="dot" title="有未读消息" aria-hidden="true"></i>
                    </button>
                </div>
            </section>

            <section class="me-card">
                <div class="me-card-hd"><span>账户</span></div>
                <div v-if="authOn" class="me-rows">
                    <button type="button" class="me-row" @click="go('/account')"><NvIcon name="user" /><span>我的账户</span></button>
                    <button type="button" class="me-row" @click="go('/account#password')"><NvIcon name="key" /><span>修改密码</span></button>
                    <button v-if="isAdmin" type="button" class="me-row" @click="go('/admin')"><NvIcon name="shield" /><span>管理后台</span></button>
                    <button type="button" class="me-row danger" @click="logout"><NvIcon name="logout" /><span>退出登录</span></button>
                </div>
                <div v-else-if="accountsOn" class="me-rows">
                    <div class="me-row">
                        <span class="tx2">未登录 · 不登录也能照常本机使用，登录后可用共享、协作等账号功能</span>
                        <span class="me-acts">
                            <button type="button" class="go ghost" @click="openAuth('register')">注册</button>
                            <button type="button" class="go primary" @click="openAuth('login')">登录</button>
                        </span>
                    </div>
                </div>
                <div v-else class="me-rows">
                    <div class="me-row"><span class="tx2">本机模式 · 数据只存在这台电脑</span></div>
                </div>
            </section>

            <section v-if="isAdmin" class="me-card">
                <div class="me-card-hd"><span>注册设置</span></div>
                <div class="me-rows">
                    <div class="me-row">
                        <span class="tx2 tx-main">开放注册<small>打开后不需要邀请码，任何人填用户名和密码就能注册；关闭时凭邀请码注册</small></span>
                        <NvSwitch :model-value="openReg" label="开放注册" :disabled="regBusy" @update:model-value="toggleOpenReg" />
                    </div>
                    <div class="me-row">
                        <span class="tx2 tx-main">邀请码<small>{{ lastInvite ? '刚生成：' + lastInvite + '（7 天内可用 1 次' + (inviteCopied ? '，已复制' : '') + '）' : '生成一个 7 天内可用 1 次的邀请码' }}</small></span>
                        <button type="button" class="go" @click="newInvite">生成并复制</button>
                    </div>
                </div>
            </section>
        </div>

        <ProfileDialog v-if="profileOpen" :nickname="profileNick" :avatar="profileAvatar" @close="profileOpen = false" @saved="onProfileSaved" />
    </div>
</template>

<style scoped>
/* 页面铺满、自己留标题栏高度：内容从标题栏下面滚过，渐变磨砂由 App.vue 提供（与素材库 / 应用市场同一套） */
.me { position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden; color: var(--ink); }
.me-in { width: min(700px, 100%); margin: 0 auto; padding: calc(var(--tbh, 0px) + 26px) 28px 48px; display: flex; flex-direction: column; gap: 14px; }

.me-head { display: flex; align-items: center; gap: 14px; padding: 0 2px 4px; }
.me-av { width: 64px; height: 64px; flex: 0 0 64px; border-radius: 50%; overflow: hidden; background: var(--fill-2); color: var(--ink); display: inline-flex; align-items: center; justify-content: center; font: 500 26px/1 var(--font-sans); }
.me-av img { width: 100%; height: 100%; object-fit: cover; display: block; }
.me-id { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.me-id b { font: 600 20px/25px var(--font-sans); letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.me-id .sub { font: 400 12px/17px var(--font-sans); color: var(--ink-3); }
/* 积分：副标题下面一行，数值用等宽数字对齐，说明弱化成字 */
.me-credits { display: flex; align-items: baseline; gap: 6px; margin-top: 1px; }
.me-credits .val { font: 600 12px/16px var(--font-sans); color: var(--ink); font-variant-numeric: tabular-nums; white-space: nowrap; }
.me-credits .note { font: 400 10px/14px var(--font-sans); color: var(--ink-3); white-space: nowrap; }
.me-edit { margin-left: auto; height: 32px; padding: 0 14px; border: 0; border-radius: var(--radius-pill); background: var(--fill-1); color: var(--ink-2); font: 500 12px/1 var(--font-sans); cursor: pointer; white-space: nowrap; transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out); }
.me-edit:hover { background: var(--fill-2); color: var(--ink); }

.me-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.stat { padding: 14px 16px; border-radius: 14px; background: var(--solid); box-shadow: var(--shadow-float); }
.stat b { display: block; font: 600 20px/24px var(--font-sans); font-variant-numeric: tabular-nums; }
.stat span { display: block; margin-top: 2px; font: 400 11px/15px var(--font-sans); color: var(--ink-3); }

/* 卡片只用实底 + 柔和投影分层，不画描边 */
.me-card { padding: 14px 16px 12px; border-radius: 16px; background: var(--solid); box-shadow: var(--shadow-float); }
.me-card-hd { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 24px; padding: 0 2px; font: 600 13px/18px var(--font-sans); }
.me-card-hd button { border: 0; background: transparent; color: var(--ink-3); font: 500 12px/1 var(--font-sans); cursor: pointer; padding: 4px 2px; border-radius: var(--radius-sm); }
.me-card-hd button:hover { color: var(--ink); }

.me-empty { padding: 14px 8px 10px; text-align: center; color: var(--ink-4); font: 400 12px/18px var(--font-sans); }
.me-empty b { display: block; margin-bottom: 3px; font: 500 12.5px/18px var(--font-sans); color: var(--ink-2); }

.me-friends, .me-rows { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
.me-fr { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 44px; padding: 6px 8px; border: 0; border-radius: 10px; background: transparent; color: var(--ink); font-family: var(--font-sans); text-align: left; cursor: pointer; transition: background var(--duration-fast) var(--ease-out); }
.me-fr:hover { background: var(--fill-1); }
.me-fr .av { width: 32px; height: 32px; flex: 0 0 32px; border-radius: 50%; overflow: hidden; background: var(--fill-2); display: inline-flex; align-items: center; justify-content: center; font: 500 14px/1 var(--font-sans); }
.me-fr .av img { width: 100%; height: 100%; object-fit: cover; display: block; }
.me-fr .tx { flex: 1; min-width: 0; }
.me-fr b { display: block; font: 500 13px/18px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.me-fr .st { display: block; margin-top: 1px; font: 400 11px/15px var(--font-sans); color: var(--ink-4); }
.me-fr .st.on { color: var(--ink-2); }
.me-fr .st.on::before { content: ''; display: inline-block; width: 5px; height: 5px; margin-right: 4px; border-radius: 50%; background: var(--success); vertical-align: 1px; }
.me-fr .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--danger); flex: none; }

.me-row { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 38px; padding: 0 8px; border: 0; border-radius: 10px; background: transparent; color: var(--ink); font: 400 13px/18px var(--font-sans); text-align: left; }
.me-row .nv-i { width: 16px; height: 16px; flex: none; color: var(--ink-2); }
button.me-row { cursor: pointer; transition: background var(--duration-fast) var(--ease-out); }
button.me-row:hover { background: var(--fill-1); }
.me-row.danger, .me-row.danger .nv-i { color: var(--danger); }
.me-row .tx2 { flex: 1; min-width: 0; color: var(--ink-2); }
.me-row .go { flex: none; height: 28px; padding: 0 12px; border: 0; border-radius: var(--radius-pill); background: var(--fill-1); color: var(--ink); font: 500 12px/1 var(--font-sans); cursor: pointer; }
.me-row .go:hover { background: var(--fill-2); }
.me-row .go.primary { background: var(--accent); color: var(--on-accent); }
.me-row .go.primary:hover { background: var(--accent); opacity: .88; }
.me-row .go.ghost { background: transparent; color: var(--ink-2); }
.me-row .go.ghost:hover { background: var(--fill-1); color: var(--ink); }
.me-acts { display: flex; align-items: center; gap: 6px; flex: none; }
.me-row .tx-main { display: flex; flex-direction: column; gap: 2px; padding: 8px 0; color: var(--ink); }
.me-row .tx-main small { font: 400 11.5px/16px var(--font-sans); color: var(--ink-3); }

.me-edit:focus-visible, .me-card-hd button:focus-visible, .me-fr:focus-visible, button.me-row:focus-visible, .me-row .go:focus-visible { outline: 1.5px solid var(--accent); outline-offset: 2px; }

@media (max-width: 720px) {
    .me-in { padding: calc(var(--tbh, 0px) + 18px) 16px 36px; }
    .me-id b { font: 600 17px/22px var(--font-sans); }
}
</style>
