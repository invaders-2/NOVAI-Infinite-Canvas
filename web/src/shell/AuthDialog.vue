<script setup>
// 登录 / 注册 / 忘记密码（2026-11-07）：
//   · page=false：外壳里的弹层（可选登录模式，从「我的」页打开），Esc / 点遮罩关闭；
//   · page=true：独立页（/login、/reset；必须登录模式下没登录会被送到这里），背后铺首页同款光幕；
//   · 视觉跟首页一致：黑白灰 + 磨砂玻璃；输入框点进去不出描边 / 阴影 / 上浮，只把底色加深一档。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import NvIcon from '../components/NvIcon.vue';
import NvLogo from '../components/NvLogo.vue';
import NvVeilBg from '../components/NvVeilBg.vue';
import { auth, closeAuth, loadAuth, login, nextUrl, register, resetPassword } from '../lib/auth.js';
import { toast } from '../lib/store.js';

const props = defineProps({
    page: { type: Boolean, default: false },
    initial: { type: String, default: 'login' },
});

const view = ref(props.page ? props.initial : (auth.dialog || 'login'));
watch(() => auth.dialog, (v) => { if (!props.page && v) view.value = v; });

const username = ref('');
const password = ref('');
const confirm = ref('');
const invite = ref('');
const code = ref('');
const showPwd = ref(false);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const firstInput = ref(null);

const firstAccount = computed(() => !auth.hasUsers);
const inviteMode = computed(() => (firstAccount.value ? 'none' : auth.inviteRequired ? 'required' : 'optional'));
const title = computed(() => ({ login: '登录 NOVAI', register: '创建账号', reset: '找回密码' })[view.value]);
const subtitle = computed(() => {
    if (view.value === 'reset') return '向管理员索取 6 位重置码（15 分钟内有效），再设一个新密码';
    if (view.value === 'register') {
        if (firstAccount.value) return '这是这台 NOVAI 的第一个账号，注册后自动成为管理员';
        return inviteMode.value === 'required' ? '注册需要管理员发的邀请码' : '填好用户名和密码就能注册';
    }
    return auth.mode === 'optional' ? '登录后可以使用共享、协作等账号功能，不登录也能照常本机使用' : '登录后继续使用';
});
const submitText = computed(() => ({ login: '登录', register: '注册并登录', reset: '重置密码' })[view.value]);

function switchView(v) {
    view.value = v;
    error.value = '';
    notice.value = '';
    password.value = '';
    confirm.value = '';
    code.value = '';
    if (!props.page) auth.dialog = v;
    nextTick(() => firstInput.value && firstInput.value.focus());
}

function validate() {
    const name = username.value.trim();
    if (!name) return '请输入用户名';
    if (view.value === 'login') return password.value ? '' : '请输入密码';
    if (name.length < 3 || name.length > 32 || !/^[\p{L}\p{N}_.@+-]+$/u.test(name)) return '用户名 3–32 位，可用中文、字母、数字和 _ . @ + -';
    if (view.value === 'reset' && !/^\d{6}$/.test(code.value.trim())) return '重置码是 6 位数字';
    if (password.value.length < 8) return '密码至少 8 位';
    if (password.value !== confirm.value) return '两次输入的密码不一致';
    if (view.value === 'register' && inviteMode.value === 'required' && !invite.value.trim()) return '请填写邀请码';
    return '';
}

async function submit() {
    if (busy.value) return;
    error.value = validate();
    notice.value = '';
    if (error.value) return;
    busy.value = true;
    try {
        if (view.value === 'login') {
            const user = await login(username.value, password.value);
            done(user && user.username ? '已登录：' + user.username : '已登录');
        } else if (view.value === 'register') {
            const user = await register(username.value, password.value, inviteMode.value === 'none' ? '' : invite.value);
            const who = user && user.username ? user.username : '';
            done(user && user.role === 'admin' ? '注册成功，' + who + ' 是这台 NOVAI 的管理员' : '注册成功，已登录：' + who);
        } else {
            await resetPassword(username.value, code.value, password.value);
            const name = username.value;
            switchView('login');
            username.value = name;
            notice.value = '密码已重置，用新密码登录吧';
        }
    } catch (e) {
        error.value = (e && e.message) || '操作失败，请重试';
    } finally {
        busy.value = false;
    }
}

function done(text) {
    if (props.page) { location.assign(nextUrl()); return; }
    closeAuth();
    toast(text, { icon: 'check' });
}

function close() { if (!props.page && !busy.value) closeAuth(); }
function onKey(e) { if (e.key === 'Escape') close(); }

onMounted(() => {
    loadAuth(true);
    document.addEventListener('keydown', onKey);
    nextTick(() => firstInput.value && firstInput.value.focus());
});
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<template>
    <Teleport to="#nv-layer" :disabled="page">
    <div :class="page ? 'au-page' : 'au-modal'">
        <template v-if="page">
            <NvVeilBg />
            <div class="au-drag" aria-hidden="true"></div>
        </template>
        <div v-else class="au-scrim" @click="close"></div>

        <div class="au-wrap" :class="{ modal: !page }">
            <div v-if="page" class="au-brand"><NvLogo /><span>NOVAI</span></div>
            <section class="au-card" role="dialog" :aria-modal="page ? null : 'true'" aria-labelledby="au-title">
                <button v-if="!page" type="button" class="au-x" aria-label="关闭" @click="close"><NvIcon name="x" /></button>

                <div v-if="view !== 'reset'" class="au-seg" role="tablist" aria-label="登录或注册">
                    <span class="thumb" :class="{ right: view === 'register' }" aria-hidden="true"></span>
                    <button type="button" role="tab" :aria-selected="view === 'login'" :class="{ on: view === 'login' }" @click="switchView('login')">登录</button>
                    <button type="button" role="tab" :aria-selected="view === 'register'" :class="{ on: view === 'register' }" @click="switchView('register')">注册</button>
                </div>
                <button v-else type="button" class="au-back" @click="switchView('login')"><NvIcon name="arrowl" />返回登录</button>

                <h2 id="au-title">{{ title }}</h2>
                <p class="au-sub">{{ subtitle }}</p>

                <form class="au-form" novalidate @submit.prevent="submit">
                    <label class="au-field">
                        <span>用户名</span>
                        <input ref="firstInput" v-model="username" type="text" name="username" autocomplete="username" spellcheck="false" autocapitalize="off" placeholder="3–32 位，可用中文" />
                    </label>

                    <label v-if="view === 'reset'" class="au-field">
                        <span>重置码</span>
                        <input v-model="code" type="text" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="管理员发给你的 6 位数字" />
                    </label>

                    <label class="au-field">
                        <span>{{ view === 'reset' ? '新密码' : '密码' }}</span>
                        <span class="au-pwd">
                            <input v-model="password" :type="showPwd ? 'text' : 'password'" name="password" :autocomplete="view === 'login' ? 'current-password' : 'new-password'" :placeholder="view === 'login' ? '' : '至少 8 位'" />
                            <button type="button" class="au-eye" :aria-label="showPwd ? '隐藏密码' : '显示密码'" :title="showPwd ? '隐藏密码' : '显示密码'" @click="showPwd = !showPwd"><NvIcon :name="showPwd ? 'eyeoff' : 'eye'" /></button>
                        </span>
                    </label>

                    <label v-if="view !== 'login'" class="au-field">
                        <span>确认密码</span>
                        <input v-model="confirm" :type="showPwd ? 'text' : 'password'" name="confirm" autocomplete="new-password" placeholder="再输一遍" />
                    </label>

                    <label v-if="view === 'register' && inviteMode !== 'none'" class="au-field">
                        <span>邀请码<em v-if="inviteMode === 'optional'">选填</em></span>
                        <input v-model="invite" type="text" name="invite" inputmode="numeric" autocomplete="off" spellcheck="false" :placeholder="inviteMode === 'required' ? '向管理员索取' : '有的话填上，可获得对应权限'" />
                    </label>

                    <p class="au-msg" :class="{ err: !!error }" role="status" aria-live="polite">{{ error || notice }}</p>

                    <button type="submit" class="au-submit" :disabled="busy">
                        <span v-if="busy" class="au-spin" aria-hidden="true"></span>{{ busy ? '请稍候…' : submitText }}
                    </button>
                </form>

                <div class="au-foot">
                    <button v-if="view === 'login'" type="button" class="au-link" @click="switchView('reset')">忘记密码？</button>
                    <a v-if="page && auth.mode === 'optional'" class="au-link" href="/">先不登录，继续使用</a>
                </div>
            </section>
        </div>
    </div>
    </Teleport>
</template>

<style scoped>
/* ── 独立页：铺满，光幕在最底下；顶部留一条可拖动窗口的区域（桌面端） ── */
.au-page { position: fixed; inset: 0; z-index: 1; background: var(--bg); color: var(--ink); font-family: var(--font-sans); overflow: auto; }
.au-drag { position: fixed; left: 0; right: 0; top: 0; height: 52px; z-index: 2; -webkit-app-region: drag; }
.au-brand { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 20px; font: 600 15px/1 var(--font-sans); letter-spacing: .02em; }
.au-brand :deep(svg) { width: 22px; height: 22px; }

/* ── 弹层：遮罩轻微磨砂，卡片居中 ── */
.au-scrim { position: fixed; inset: 0; z-index: 2000; background: var(--scrim); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); animation: auFade var(--duration-base) var(--ease-out); }
.au-wrap { position: relative; z-index: 3; min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 72px 16px 40px; box-sizing: border-box; }
.au-wrap.modal { position: fixed; inset: 0; z-index: 2001; pointer-events: none; }
.au-wrap.modal .au-card { pointer-events: auto; animation: auIn var(--duration-slow) var(--ease-out); }
@keyframes auFade { from { opacity: 0; } }
@keyframes auIn { from { opacity: 0; transform: translateY(8px) scale(.985); } }

.au-card { position: relative; width: 100%; max-width: 380px; box-sizing: border-box; padding: 22px 22px 18px; border-radius: 22px; color: var(--ink); font-family: var(--font-sans);
    background: var(--glass-strong); backdrop-filter: var(--material-thick); -webkit-backdrop-filter: var(--material-thick); box-shadow: var(--shadow-rim), var(--shadow-dialog); }
.au-x { position: absolute; top: 12px; right: 12px; width: 28px; height: 28px; border: 0; border-radius: 50%; background: transparent; color: var(--ink-3); display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background var(--duration-fast), color var(--duration-fast); }
.au-x:hover { background: var(--fill-1); color: var(--ink); }
.au-x .nv-i { width: 15px; height: 15px; }

/* 登录 / 注册切换：带滑动底块的分段 */
.au-seg { position: relative; display: grid; grid-template-columns: 1fr 1fr; width: 168px; height: 32px; padding: 3px; box-sizing: border-box; border-radius: var(--radius-pill); background: var(--fill-1); margin-bottom: 18px; }
.au-seg .thumb { position: absolute; top: 3px; left: 3px; width: calc(50% - 3px); height: 26px; border-radius: var(--radius-pill); background: var(--solid); box-shadow: 0 1px 3px rgba(0,0,0,.08); transition: transform var(--duration-base) var(--ease-out); }
.au-seg .thumb.right { transform: translateX(100%); }
.au-seg button { position: relative; z-index: 1; border: 0; background: transparent; color: var(--ink-3); font: 500 12.5px/1 var(--font-sans); cursor: pointer; border-radius: var(--radius-pill); transition: color var(--duration-fast); }
.au-seg button.on { color: var(--ink); }
.au-back { display: inline-flex; align-items: center; gap: 4px; height: 28px; margin: 0 0 14px -6px; padding: 0 8px; border: 0; border-radius: var(--radius-pill); background: transparent; color: var(--ink-3); font: 500 12px/1 var(--font-sans); cursor: pointer; }
.au-back:hover { background: var(--fill-1); color: var(--ink); }
.au-back .nv-i { width: 13px; height: 13px; }

h2 { margin: 0; font: 600 20px/1.3 var(--font-sans); letter-spacing: -.01em; }
.au-sub { margin: 6px 0 16px; font: 400 12.5px/1.6 var(--font-sans); color: var(--ink-3); text-wrap: pretty; }

.au-form { display: flex; flex-direction: column; gap: 12px; }
.au-field { display: flex; flex-direction: column; gap: 6px; }
.au-field > span:first-child { font: 500 12px/1 var(--font-sans); color: var(--ink-2); }
.au-field em { font-style: normal; margin-left: 6px; color: var(--ink-4); font-weight: 400; }
/* 输入框：点进去不描边、不投影、不上浮，只把底色加深一档 */
.au-field input { width: 100%; height: 40px; box-sizing: border-box; padding: 0 12px; border: 0; border-radius: 12px; background: var(--fill-1); color: var(--ink); font: 400 14px/1 var(--font-sans);
    outline: none; box-shadow: none; transition: background var(--duration-fast); -webkit-appearance: none; appearance: none; }
.au-field input::placeholder { color: var(--ink-4); }
.au-field input:hover { background: var(--fill-2); }
.au-field input:focus, .au-field input:focus-visible { background: var(--fill-2); outline: none; box-shadow: none; }
.au-pwd { position: relative; display: block; }
.au-pwd input { padding-right: 40px; }
.au-eye { position: absolute; right: 4px; top: 4px; width: 32px; height: 32px; border: 0; border-radius: 10px; background: transparent; color: var(--ink-4); display: flex; align-items: center; justify-content: center; cursor: pointer; }
.au-eye:hover { color: var(--ink); }
.au-eye .nv-i { width: 15px; height: 15px; }

.au-msg { min-height: 18px; margin: 0; font: 400 12px/18px var(--font-sans); color: var(--ink-2); }
.au-msg.err { color: var(--danger); }

.au-submit { height: 42px; border: 0; border-radius: 12px; background: var(--accent); color: var(--on-accent); font: 600 14px/1 var(--font-sans); cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;
    transition: transform var(--duration-fast) var(--ease-out), opacity var(--duration-fast); }
.au-submit:active { transform: scale(.985); }
.au-submit:disabled { opacity: .6; cursor: default; transform: none; }
.au-spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: auSpin .8s linear infinite; }
@keyframes auSpin { to { transform: rotate(360deg); } }

.au-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 20px; margin-top: 14px; }
.au-foot:empty { display: none; }
.au-link { border: 0; background: transparent; padding: 0; color: var(--ink-3); font: 500 12px/20px var(--font-sans); cursor: pointer; text-decoration: none; }
.au-link:hover { color: var(--ink); }
.au-link:only-child { margin: 0 auto; }

.au-x:focus-visible, .au-seg button:focus-visible, .au-back:focus-visible, .au-eye:focus-visible, .au-submit:focus-visible, .au-link:focus-visible { outline: 1.5px solid var(--accent); outline-offset: 2px; }

@media (prefers-reduced-motion: reduce) { .au-scrim, .au-wrap.modal .au-card { animation: none; } .au-seg .thumb { transition: none; } }
@media (max-width: 420px) { .au-card { padding: 20px 16px 16px; border-radius: 18px; } }
</style>
