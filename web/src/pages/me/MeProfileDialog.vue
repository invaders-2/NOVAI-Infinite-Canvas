<script setup>
// 编辑资料弹窗（M4）：昵称 / 头像 + 账户 + 管理员设置。原来的资料 / 账户内容都并进这里，
// 头像走既有的 ProfileDialog（取景裁切 + 压到 200KB），账户相关沿用 lib/auth.js 与旧页面一致的接口。
import { computed, onMounted, ref, watch } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import NvSwitch from '../../components/NvSwitch.vue';
import ProfileDialog from '../../shell/ProfileDialog.vue';
import { toast } from '../../lib/store.js';
import { auth, getAuthSettings, setInviteRequired, createInvite, logout as authLogout, openAuth } from '../../lib/auth.js';

const props = defineProps({ me: { type: Object, default: () => ({}) } });
const emit = defineEmits(['close', 'saved']);

const nickname = ref(String((props.me && props.me.nickname) || ''));
const avatar = ref(String((props.me && props.me.avatar) || ''));
const saving = ref(false);
const avatarOpen = ref(false);
const credits = ref(null);

const me = computed(() => (auth.loggedIn ? auth.user : null));
const authOn = computed(() => !!(me.value && me.value.username));
const accountsOn = computed(() => auth.mode !== 'off');
const roleText = computed(() => ({ admin: '管理员', team: '团队', user: '普通用户' }[(me.value && me.value.role) || ''] || '用户'));
const isAdmin = computed(() => !!(me.value && me.value.role === 'admin'));
const avatarSrc = computed(() => (String(avatar.value || '').startsWith('data:') ? avatar.value : ''));
const avatarText = computed(() => {
    const text = String(avatar.value || '').trim();
    if (text && !text.startsWith('data:')) return [...text].slice(0, 2).join('');
    return [...(nickname.value.trim() || '我')][0];
});
const creditText = computed(() => {
    const value = Number(credits.value && credits.value.balance);
    return Number.isFinite(value) ? value.toFixed(2) : '';
});

watch(() => props.me, next => {
    if (!next) return;
    nickname.value = String(next.nickname || '');
    avatar.value = String(next.avatar || '');
});

async function save() {
    if (saving.value) return;
    const name = nickname.value.trim();
    if (!name) { toast('昵称不能为空', { danger: true }); return; }
    saving.value = true;
    try {
        const response = await fetch('/api/lan/me', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ nickname: name, avatar: avatar.value || '' }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(String(data && data.detail || '保存失败'));
        toast('资料已保存');
        emit('saved', (data && data.me) || null);
        emit('close');
    } catch (e) {
        toast(e.message || '保存失败', { danger: true });
    } finally {
        saving.value = false;
    }
}

function onAvatarSaved(next) {
    avatarOpen.value = false;
    if (next && typeof next === 'object') avatar.value = String(next.avatar || '');
    emit('saved', next);
}

/* ── 账户 ── */
function go(path) { location.assign(path); }
async function doLogout() {
    await authLogout();
    toast('已退出登录');
    emit('close');
}

/* ── 管理员：开放注册 / 邀请码 ── */
const openReg = ref(false);
const regBusy = ref(false);
const lastInvite = ref('');
watch(isAdmin, async yes => {
    if (!yes) return;
    try { openReg.value = !(await getAuthSettings()).invite_required; } catch (e) { /* 读不到就保持默认 */ }
}, { immediate: true });
async function toggleOpenReg(value) {
    if (regBusy.value) return;
    regBusy.value = true;
    const previous = openReg.value;
    openReg.value = value;
    try {
        const required = await setInviteRequired(!value);
        openReg.value = !required;
        toast(required ? '已改为凭邀请码注册' : '已开放注册，不需要邀请码');
    } catch (e) {
        openReg.value = previous;
        toast(e.message || '保存失败', { danger: true });
    } finally {
        regBusy.value = false;
    }
}
async function newInvite() {
    try {
        const invite = await createInvite({ uses: 1, days: 7, role: 'user' });
        lastInvite.value = invite && invite.code ? String(invite.code) : '';
        if (!lastInvite.value) return;
        try { await navigator.clipboard.writeText(lastInvite.value); toast('邀请码已复制：' + lastInvite.value); }
        catch (e) { toast('邀请码：' + lastInvite.value + '（没能自动复制，请手动记下）'); }
    } catch (e) {
        toast(e.message || '生成失败', { danger: true });
    }
}

async function loadCredits() {
    if (window.NOVAI_CREDITS) { credits.value = window.NOVAI_CREDITS.state; return; }
    try {
        const response = await fetch('/api/credits/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        const data = await response.json();
        if (!data || data.auth_enabled === false || typeof data.balance === 'undefined' || data.enabled === false) return;
        credits.value = { balance: Number(data.balance) || 0 };
    } catch (e) { /* 积分关闭或不可用：不展示 */ }
}

function onKey(event) { if (event.key === 'Escape') emit('close'); }
onMounted(() => {
    document.addEventListener('keydown', onKey);
    loadCredits();
});
</script>

<template>
    <Teleport to="#nv-layer">
        <div class="pe-scrim" @click="emit('close')"></div>
        <div class="pe" role="dialog" aria-modal="true" aria-label="编辑资料">
            <header class="pe-h">
                <h2>编辑资料</h2>
                <span class="sp"></span>
                <button type="button" class="pe-x" aria-label="关闭" @click="emit('close')"><NvIcon name="x" /></button>
            </header>
            <div class="pe-body">
                <div class="pe-avatar">
                    <span class="av">
                        <img v-if="avatarSrc" :src="avatarSrc" alt="" />
                        <template v-else>{{ avatarText }}</template>
                    </span>
                    <div class="tx">
                        <b>头像与昵称</b>
                        <small>局域网里的人会看到这个名字，好友码不会变</small>
                    </div>
                    <button type="button" class="nv-btn sm" @click="avatarOpen = true">换头像</button>
                </div>
                <label class="pe-row">
                    <span class="lb">昵称</span>
                    <input v-model="nickname" class="nv-field pe-inp" maxlength="40" placeholder="例如 Weiping" @keydown.enter="save" />
                </label>
                <div v-if="authOn && creditText" class="pe-row"><span class="lb">积分</span><span class="pe-val mono">{{ creditText }}</span></div>

                <div class="pe-sep"></div>
                <div class="pe-rows">
                    <template v-if="authOn">
                        <div class="pe-row-line"><span>{{ me.username }} · {{ roleText }}</span><button type="button" class="nv-btn sm" @click="go('/account')">我的账户</button></div>
                        <div class="pe-row-line"><span>修改密码</span><button type="button" class="nv-btn sm" @click="go('/account#password')">去修改</button></div>
                        <div v-if="isAdmin" class="pe-row-line"><span>管理后台</span><button type="button" class="nv-btn sm" @click="go('/admin')">打开</button></div>
                        <div class="pe-row-line"><span>退出登录</span><button type="button" class="nv-btn sm danger" @click="doLogout">退出</button></div>
                    </template>
                    <template v-else-if="accountsOn">
                        <div class="pe-row-line"><span>未登录 · 不登录也能照常本机使用，登录后可用共享、协作等账号功能</span>
                            <span class="acts"><button type="button" class="nv-btn sm" @click="openAuth('register')">注册</button><button type="button" class="nv-btn sm primary" @click="openAuth('login')">登录</button></span>
                        </div>
                    </template>
                    <div v-else class="pe-row-line"><span>本机模式 · 数据只存在这台电脑</span></div>
                </div>

                <template v-if="isAdmin">
                    <div class="pe-sep"></div>
                    <div class="pe-row-line">
                        <span class="two">开放注册<small>打开后不需要邀请码；关闭时凭邀请码注册</small></span>
                        <NvSwitch :model-value="openReg" label="开放注册" :disabled="regBusy" @update:model-value="toggleOpenReg" />
                    </div>
                    <div class="pe-row-line">
                        <span class="two">邀请码<small>{{ lastInvite ? '刚生成：' + lastInvite + '（7 天内可用 1 次）' : '生成一个 7 天内可用 1 次的邀请码' }}</small></span>
                        <button type="button" class="nv-btn sm" @click="newInvite">生成并复制</button>
                    </div>
                </template>
            </div>
            <footer class="pe-f">
                <button type="button" class="nv-btn" @click="emit('close')">取消</button>
                <button type="button" class="nv-btn primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
            </footer>
            <ProfileDialog v-if="avatarOpen" :nickname="nickname" :avatar="avatar" @close="avatarOpen = false" @saved="onAvatarSaved" />
        </div>
    </Teleport>
</template>

<style scoped>
.pe-scrim { position: fixed; inset: 0; z-index: 84; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); }
.pe { position: fixed; left: 50%; top: 50%; z-index: 85; transform: translate(-50%, -50%); width: min(520px, calc(100vw - 32px)); max-height: min(680px, calc(100vh - 64px)); display: flex; flex-direction: column;
    border-radius: 20px; color: var(--ink); font-family: var(--font-sans); background: color-mix(in srgb, var(--solid) 90%, transparent); backdrop-filter: blur(44px) saturate(190%); -webkit-backdrop-filter: blur(44px) saturate(190%); box-shadow: var(--shadow-dialog); }
html.theme-dark .pe { background: color-mix(in srgb, #1a1a1a 92%, transparent); }
.pe-h { display: flex; align-items: center; gap: 10px; padding: 16px 14px 10px 20px; }
.pe-h h2 { margin: 0; font: 600 16px/22px var(--font-sans); }
.sp { flex: 1; }
.pe-x { width: 28px; height: 28px; border: 0; border-radius: 14px; background: transparent; color: var(--ink-3); display: flex; align-items: center; justify-content: center; cursor: pointer; }
.pe-x:hover { background: var(--fill-1); color: var(--ink); }
.pe-x .nv-i { width: 15px; height: 15px; }
.pe-body { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 20px 8px; display: flex; flex-direction: column; gap: 12px; }
.pe-avatar { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 14px; background: var(--fill-1); }
.pe-avatar .av { width: 44px; height: 44px; flex: none; border-radius: 50%; overflow: hidden; background: var(--fill-2); display: inline-flex; align-items: center; justify-content: center; font: 500 18px/1 var(--font-sans); }
.pe-avatar .av img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pe-avatar .tx { flex: 1; min-width: 0; }
.pe-avatar b { display: block; font: 500 13px/18px var(--font-sans); }
.pe-avatar small { display: block; margin-top: 2px; font: 400 11px/16px var(--font-sans); color: var(--ink-3); }
.pe-row { display: flex; align-items: center; gap: 10px; }
.pe-row .lb { width: 44px; flex: none; font: 500 12px/18px var(--font-sans); color: var(--ink-3); }
.pe-inp { flex: 1; border: 0; }
.pe-val { font: 500 12.5px/1 var(--font-mono); }
/* 分隔只靠留白（不加发丝线） */
.pe-sep { height: 0; margin: 8px 0; }
.pe-rows { display: flex; flex-direction: column; gap: 2px; }
.pe-row-line { display: flex; align-items: center; gap: 10px; min-height: 34px; font: 400 12.5px/18px var(--font-sans); color: var(--ink-2); }
.pe-row-line > span:first-child { flex: 1; min-width: 0; }
.pe-row-line .two { display: flex; flex-direction: column; gap: 2px; color: var(--ink); }
.pe-row-line .two small { font: 400 11px/16px var(--font-sans); color: var(--ink-3); }
.pe-row-line .acts { display: flex; gap: 6px; flex: none; }
.pe-f { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px 16px; }
.pe-f .nv-btn { height: 34px; border-radius: 17px; padding: 0 18px; }
</style>
