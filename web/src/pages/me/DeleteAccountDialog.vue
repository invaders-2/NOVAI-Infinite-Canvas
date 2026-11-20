<script setup>
// 注销账号（2026-11）：两步确认。
// 第一步列出会被删 / 会被保留的东西（数据来自 GET /api/auth/delete-account）；
// 第二步必须手输当前账号名 + 当前密码才能点「注销账号」，明确写「不可恢复」。
// 成功：清本地登录态、toast、回登录页；失败：原样留在弹窗里并给出具体原因。
import { computed, onMounted, ref } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import { deleteAccount, getDeleteAccountImpact } from '../../lib/auth.js';
import { toast } from '../../lib/store.js';

const props = defineProps({ username: { type: String, default: '' } });
const emit = defineEmits(['close']);

const step = ref(1);
const impact = ref(null);
const loading = ref(true);
const loadError = ref('');
const name = ref('');
const password = ref('');
const busy = ref(false);
const error = ref('');

const counts = computed(() => (impact.value && impact.value.counts) || {});
const blocked = computed(() => (impact.value && impact.value.blocked) || '');
const lastAccount = computed(() => !!(impact.value && impact.value.last_account));
const deleteUnowned = computed(() => !!(impact.value && impact.value.delete_unowned));
const nameOk = computed(() => name.value.trim() === String(props.username || ''));
const canSubmit = computed(() => nameOk.value && !!password.value && !busy.value && !blocked.value);

const deletedItems = computed(() => {
    const c = counts.value;
    const rows = [{ text: '账号与全部登录会话' }];
    if (c.lan_account) {
        const extra = [];
        if (c.lan_friends) extra.push('好友 ' + c.lan_friends + ' 位');
        if (c.lan_chat_messages) extra.push('聊天 ' + c.lan_chat_messages + ' 条');
        rows.push({ text: '本机这个账号的局域网身份' + (extra.length ? '（' + extra.join('、') + '）' : '') });
    }
    if (c.canvases) rows.push({ text: '名下 ' + c.canvases + ' 本画布（含回收站）及画布内容' });
    if (c.canvas_members) rows.push({ text: '这些画布上的 ' + c.canvas_members + ' 位共享成员' });
    if (c.asset_libraries) rows.push({ text: '名下 ' + c.asset_libraries + ' 个素材库（含 ' + (c.asset_items || 0) + ' 个素材条目）' });
    if (c.prompt_libraries) rows.push({ text: '自己建的 ' + c.prompt_libraries + ' 个提示词库' });
    if (c.asset_files) rows.push({ text: '名下 ' + c.asset_files + ' 个素材文件（账号目录里的上传与生成结果）' });
    if (c.invites) rows.push({ text: '自己生成的 ' + c.invites + ' 个邀请码' });
    if (c.share_links) rows.push({ text: c.share_links + ' 个画布分享链接（已发出的链接失效）' });
    if (c.credit_records) rows.push({ text: c.credit_records + ' 条积分流水' });
    if (c.unowned_canvases && deleteUnowned.value) rows.push({ text: '无归属历史画布 ' + c.unowned_canvases + ' 本（整机最后一个账号，一起删除）' });
    return rows;
});
const keptItems = computed(() => {
    const c = counts.value;
    const rows = [];
    if (c.shared_canvases) rows.push({ text: '别人共享给你的 ' + c.shared_canvases + ' 本画布：只退出共享，画布本身保留' });
    if (c.unowned_canvases && !deleteUnowned.value) rows.push({ text: '无归属历史画布 ' + c.unowned_canvases + ' 本：没有归属信息，不会删除' });
    rows.push({ text: '机器级旧素材（assets/uploads、assets/output、assets/library 里的历史文件）不随账号删除' });
    return rows;
});

onMounted(async () => {
    try {
        impact.value = await getDeleteAccountImpact();
    } catch (e) {
        loadError.value = (e && e.message) || '读取注销清单失败，请重试';
    } finally {
        loading.value = false;
    }
});

function close() {
    if (!busy.value) emit('close');
}

function next() {
    if (blocked.value || loading.value || loadError.value) return;
    error.value = '';
    step.value = 2;
}

async function submit() {
    if (!canSubmit.value) return;
    busy.value = true;
    error.value = '';
    try {
        const data = await deleteAccount(password.value, name.value);
        emit('close');
        toast(data && data.notice === 'last_account' ? '账号已注销，本机回到首启状态' : '账号已注销');
        setTimeout(() => location.assign('/login'), 700);
    } catch (e) {
        error.value = (e && e.message) || '注销失败，请重试';
        toast(error.value, { danger: true });
    } finally {
        busy.value = false;
    }
}
</script>

<template>
    <Teleport to="#nv-layer">
        <div class="da-scrim" @click="close"></div>
        <div id="delete-account-dialog" class="da" role="dialog" aria-modal="true" aria-labelledby="da-title" :data-step="step">
            <header class="da-h">
                <h2 id="da-title">注销账号</h2>
                <button type="button" class="da-x" aria-label="关闭" @click="close"><NvIcon name="x" /></button>
            </header>

            <div class="da-body">
                <p v-if="loading" class="da-lead">正在读取要删除的数据…</p>
                <p v-else-if="loadError" class="da-lead danger">{{ loadError }}</p>

                <template v-else-if="step === 1">
                    <p class="da-lead">注销会永久删除下面这些东西，<b class="danger">不可恢复</b>。</p>
                    <ul id="delete-impact-list" class="da-list">
                        <li v-for="row in deletedItems" :key="row.text">{{ row.text }}</li>
                    </ul>
                    <p class="da-sub">下面这些会保留：</p>
                    <ul id="delete-kept-list" class="da-list kept">
                        <li v-for="row in keptItems" :key="row.text">{{ row.text }}</li>
                    </ul>
                    <p v-if="lastAccount" id="delete-last-account" class="da-note">这是本机唯一的账号；注销后会回到「第一个注册的账号是管理员」的首启状态，可以重新注册。</p>
                    <p v-if="blocked === 'last_admin'" id="delete-blocked" class="da-blocked">你是本机最后一个管理员，请先把其他账号设为管理员再注销（否则没有人能管理账号）。</p>
                </template>

                <template v-else>
                    <p class="da-lead">确认要注销 <b>{{ username }}</b> 吗？<b class="danger">这一步之后无法撤销。</b></p>
                    <label class="da-field">
                        <span>输入账号名 <b class="mono">{{ username }}</b> 确认</span>
                        <input id="delete-confirm-name" v-model="name" type="text" autocomplete="off" spellcheck="false" :placeholder="username" />
                    </label>
                    <label class="da-field">
                        <span>当前密码</span>
                        <input id="delete-confirm-password" v-model="password" type="password" autocomplete="current-password" placeholder="输入当前账号的密码" />
                    </label>
                    <p id="delete-error" class="da-msg" :class="{ err: !!error }">{{ error }}</p>
                </template>
            </div>

            <footer class="da-f">
                <button type="button" class="nv-btn" @click="close">{{ step === 1 ? '取消' : '返回' }}</button>
                <button v-if="step === 1" id="delete-continue" type="button" class="nv-btn danger" :disabled="loading || !!loadError || !!blocked" @click="step === 1 && next()">继续</button>
                <button v-else id="delete-submit" type="button" class="nv-btn danger" :disabled="!canSubmit" @click="submit">{{ busy ? '注销中…' : '注销账号' }}</button>
            </footer>
        </div>
    </Teleport>
</template>

<style scoped>
.da-scrim { position: fixed; inset: 0; z-index: 90; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); }
.da { position: fixed; left: 50%; top: 50%; z-index: 91; transform: translate(-50%, -50%); width: min(460px, calc(100vw - 32px)); max-height: min(640px, calc(100vh - 64px)); display: flex; flex-direction: column;
    border-radius: 20px; color: var(--ink); font-family: var(--font-sans); background: color-mix(in srgb, var(--solid) 90%, transparent); backdrop-filter: blur(44px) saturate(190%); -webkit-backdrop-filter: blur(44px) saturate(190%); box-shadow: var(--shadow-dialog); }
html.theme-dark .da { background: color-mix(in srgb, #1a1a1a 92%, transparent); }
.da-h { display: flex; align-items: center; gap: 10px; padding: 16px 14px 8px 20px; }
.da-h h2 { margin: 0; flex: 1; font: 600 16px/22px var(--font-sans); }
.da-x { width: 28px; height: 28px; border: 0; border-radius: 14px; background: transparent; color: var(--ink-3); display: flex; align-items: center; justify-content: center; cursor: pointer; }
.da-x:hover { background: var(--fill-1); color: var(--ink); }
.da-x .nv-i { width: 15px; height: 15px; }
.da-body { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 20px 10px; display: flex; flex-direction: column; gap: 10px; }
.da-lead { margin: 0; font: 400 13px/20px var(--font-sans); color: var(--ink-2); }
.da-lead.danger, .da .danger { color: var(--danger); }
.da-sub { margin: 6px 0 0; font: 500 12px/18px var(--font-sans); color: var(--ink-3); }
.da-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; }
.da-list li { position: relative; padding: 7px 10px 7px 24px; border-radius: 10px; background: var(--fill-1); font: 400 12.5px/18px var(--font-sans); color: var(--ink); }
.da-list li::before { content: ''; position: absolute; left: 11px; top: 14px; width: 5px; height: 5px; border-radius: 50%; background: var(--danger); }
.da-list.kept li::before { background: var(--ink-4); }
.da-note { margin: 2px 0 0; font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); }
.da-blocked { margin: 4px 0 0; padding: 10px 12px; border-radius: 12px; background: color-mix(in srgb, var(--danger) 10%, var(--fill-1)); font: 400 12.5px/19px var(--font-sans); color: var(--danger); }
.da-field { display: flex; flex-direction: column; gap: 6px; }
.da-field > span { font: 500 12px/1 var(--font-sans); color: var(--ink-2); }
.da-field .mono { font-family: var(--font-mono); }
.da-field input { width: 100%; height: 40px; box-sizing: border-box; padding: 0 12px; border: 0; border-radius: 12px; background: var(--fill-1); color: var(--ink); font: 400 14px/1 var(--font-sans); outline: none; -webkit-appearance: none; appearance: none; }
.da-field input:focus { background: var(--fill-2); }
.da-msg { min-height: 18px; margin: 0; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.da-msg.err { color: var(--danger); }
.da-f { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px 16px; }
.da-f .nv-btn { height: 34px; border-radius: 17px; padding: 0 18px; }
.da-f .nv-btn.danger { color: var(--danger); }
.da-f .nv-btn.danger:disabled { opacity: .5; cursor: default; }
</style>
