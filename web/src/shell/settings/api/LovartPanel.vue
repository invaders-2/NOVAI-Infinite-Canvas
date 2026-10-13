<script setup>
// Lovart 设计代理账户（旧 lovartPanel）：Access / Secret Key、清除已保存密钥、高成本操作自动确认、排队模式（应用即调接口切换）。
// AK / SK / 自动确认跟随主面板「保存」提交：输入时就写回 provider（lovart_access_key / lovart_secret_key / lovart_auto_confirm），
// 主面板不用额外处理；collect() 仍返回同样字段以备用。「清除」走 props.save，「应用」直接调 /api/providers/lovart/mode。
import { ref, computed, watch } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import ApiConfirm from './kit/ApiConfirm.vue';
import { toast } from '../../../lib/store.js';
import { prettyJson, useConfirm } from './kit/kit.js';

// 与旧页面同一份：同一会话内切走再切回仍显示上次查询结果
const modeHints = new Map();

const props = defineProps({
    provider: Object,
    providers: Array,
    save: Function,              // async () => boolean：主面板保存全部平台
    baseUrl: String,             // 主面板「请求地址」输入框当前值（未保存时也用它），缺省用 provider.base_url
});
const emit = defineEmits(['changed', 'dirty', 'save']);
const confirm = useConfirm();

const p = computed(() => props.provider || {});
const ak = ref('');
const sk = ref('');
const autoConfirm = ref(false);
const unlimited = ref(false);
const applying = ref(false);
const clearing = ref(false);
const hint = ref({ text: '点『应用』查询/切换', kind: '' });

function reset() {
    ak.value = '';
    sk.value = '';
    autoConfirm.value = p.value.lovart_auto_confirm === true;
    unlimited.value = p.value.lovart_unlimited === true;
    const saved = modeHints.get(p.value.id);
    hint.value = { text: saved || '点『应用』查询/切换', kind: saved ? 'ok' : '' };
}
watch(() => props.provider, reset, { immediate: true });
// 输入即写回 provider（主面板 syncEditor / 测试连接直接读 provider.lovart_access_key 等，旧 syncEditor 同样「有值才覆盖」）
function writeBack() {
    const item = props.provider;
    if (!item) return;
    const a = ak.value.trim(), s = sk.value.trim();
    if (a) item.lovart_access_key = a; else if ('lovart_access_key' in item) delete item.lovart_access_key;
    if (s) item.lovart_secret_key = s; else if ('lovart_secret_key' in item) delete item.lovart_secret_key;
    if ((item.lovart_auto_confirm === true) !== autoConfirm.value) item.lovart_auto_confirm = autoConfirm.value === true;
}
watch([ak, sk, autoConfirm], writeBack);

const keyHint = computed(() => {
    const a = p.value.has_lovart_access_key ? `AK 已保存：${p.value.lovart_access_key_env || 'API/.env'} ${p.value.lovart_access_key_preview || ''}` : 'AK 未保存';
    const s = p.value.has_lovart_secret_key ? `SK 已保存：${p.value.lovart_secret_key_env || 'API/.env'} ${p.value.lovart_secret_key_preview || ''}` : 'SK 未保存';
    return `${a} · ${s}`;
});
const akPlaceholder = computed(() => (p.value.has_lovart_access_key ? `保持当前 AK ${p.value.lovart_access_key_preview || ''}` : 'Access Key'));
const skPlaceholder = computed(() => (p.value.has_lovart_secret_key ? `保持当前 SK ${p.value.lovart_secret_key_preview || ''}` : 'Secret Key'));
const savedAuto = ref(false);
watch(() => props.provider, v => { savedAuto.value = !!(v && v.lovart_auto_confirm === true); }, { immediate: true });
const dirty = computed(() => !!(ak.value.trim() || sk.value.trim()) || autoConfirm.value !== savedAuto.value || unlimited.value !== (p.value.lovart_unlimited === true));
watch(dirty, v => emit('dirty', v), { immediate: true });

async function doSave() {
    if (props.save) return (await props.save()) !== false;
    emit('save');
    return true;
}
async function clearKeys() {
    if (!(await confirm.ask({ title: '确认清除已保存的 Lovart Access Key / Secret Key？', desc: '清除后需要重新填写才能使用 Lovart。', ok: '清除' }))) return;
    props.provider._clearLovartAccessKey = true;
    props.provider._clearLovartSecretKey = true;
    clearing.value = true;
    try {
        if (await doSave()) { ak.value = ''; sk.value = ''; }
    } finally { clearing.value = false; }
}

function modeLabel(mode, unl) {
    const raw = String(mode || '').trim();
    const key = raw.toLowerCase();
    if (key.includes('unlimited') || key.includes('queue') || raw.includes('排队')) return '排队模式';
    if (key.includes('fast') || raw.includes('快速')) return '快速模式';
    if (typeof unl === 'boolean') return unl ? '排队模式' : '快速模式';
    return raw || '未知模式';
}
function modeText(prefix, mode, unl, credits) {
    const c = (credits === null || credits === undefined || credits === '') ? '' : ` · 额度 ${credits}`;
    return `${prefix}${modeLabel(mode, unl)}${c}`;
}
function errorText(data, status) {
    const d = data && data.detail;
    if (typeof d === 'string' && d.trim()) return d.trim();
    if (d) return prettyJson(d);
    return `切换失败（HTTP ${status}）`;
}
async function applyMode() {
    const item = props.provider;
    if (!item) return;
    const body = { unlimited: unlimited.value === true };
    if (ak.value.trim()) body.lovart_access_key = ak.value.trim();
    if (sk.value.trim()) body.lovart_secret_key = sk.value.trim();
    const base = String(props.baseUrl || item.base_url || '').trim();
    if (base) body.base_url = base;
    applying.value = true;
    hint.value = { text: '正在应用...', kind: '' };
    try {
        const res = await fetch('/api/providers/lovart/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(errorText(data, res.status));
        const unl = data.unlimited === true;
        item.lovart_unlimited = unl;
        unlimited.value = unl;
        const text = modeText('当前：', data.mode, unl, data.credits);
        modeHints.set(item.id, text);
        hint.value = { text, kind: 'ok' };
        toast(modeText('已切换为', data.mode, unl, data.credits), { icon: 'check' });
    } catch (err) {
        modeHints.delete(item.id);
        const message = (err && err.message) || String(err);
        hint.value = { text: message, kind: 'error' };
        toast(message, { danger: true, icon: 'alert' });
    } finally { applying.value = false; }
}

// 保存前合并进 provider（旧 syncEditor 的 Lovart 段：输入框有值才覆盖 Key，自动确认总是写入）
function collect() {
    const out = { lovart_auto_confirm: autoConfirm.value === true };
    if (ak.value.trim()) out.lovart_access_key = ak.value.trim();
    if (sk.value.trim()) out.lovart_secret_key = sk.value.trim();
    return out;
}
defineExpose({ collect, reset });
</script>

<template>
    <section class="lv">
        <div class="lv-h">
            <div class="lv-t">
                <b>Lovart 设计代理账户</b>
                <span>到 lovart.ai 登录后点头像 → Settings，复制 access_key 和 secret_key。
                    <a href="https://lovart.notion.site/Lovart-OpenClaw-User-Guide-33da46b16a0f80f6a7fff8e4896b9fca" target="_blank" rel="noopener noreferrer"><NvIcon name="ext" />查看官方文档</a></span>
            </div>
        </div>
        <button type="button" class="nv-btn sm lv-clear" :disabled="clearing" @click="clearKeys"><span v-if="clearing" class="spin sm"></span><NvIcon v-else name="trash" />清除已保存密钥</button>
        <div class="lv-keys">
            <label class="lv-fld"><span>Access Key</span>
                <span class="nv-field lv-inp"><input v-model="ak" type="password" autocomplete="off" spellcheck="false" :placeholder="akPlaceholder" aria-label="Access Key"></span></label>
            <label class="lv-fld"><span>Secret Key</span>
                <span class="nv-field lv-inp"><input v-model="sk" type="password" autocomplete="off" spellcheck="false" :placeholder="skPlaceholder" aria-label="Secret Key"></span></label>
        </div>
        <div class="lv-hint">{{ keyHint }}</div>
        <button type="button" class="lv-chk" role="checkbox" :aria-checked="autoConfirm" @click="autoConfirm = !autoConfirm">
            <span class="box" :class="{ on: autoConfirm }"><NvIcon v-if="autoConfirm" name="check" /></span>
            <span class="tx"><b>高成本操作（视频等）自动确认</b><span>勾选后 Lovart 遇到高成本操作会自动确认并继续执行，会自动消耗账户额度。</span></span>
        </button>
        <button type="button" class="lv-chk" role="checkbox" :aria-checked="unlimited" @click="unlimited = !unlimited">
            <span class="box" :class="{ on: unlimited }"><NvIcon v-if="unlimited" name="check" /></span>
            <span class="tx"><b>排队模式（不消耗积分，出图更慢）</b><span>关闭 = 快速模式，会消耗积分。</span></span>
        </button>
        <div class="lv-apply">
            <button type="button" class="nv-btn sm" :disabled="applying" @click="applyMode"><span v-if="applying" class="spin sm"></span><NvIcon v-else name="refresh" />应用</button>
            <span class="lv-mode" :class="hint.kind">{{ hint.text }}</span>
        </div>
        <ApiConfirm :state="confirm.st.value" @done="confirm.done" />
    </section>
</template>

<style scoped>
.lv { display: flex; flex-direction: column; gap: 12px; background: var(--fill-1); border-radius: 14px; padding: 14px 16px; min-width: 0; }
.lv-t b { display: block; font: 500 13px/19px var(--font-sans); color: var(--ink); }
.lv-t > span { display: block; margin-top: 2px; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.lv-t a { display: inline-flex; align-items: center; gap: 3px; color: var(--ink); font-weight: 500; text-decoration: underline; text-underline-offset: 3px; }
.lv-t a .nv-i { width: 12px; height: 12px; }
.lv-clear { align-self: stretch; background: var(--solid); }
.lv-clear:hover { background: var(--fill-2); }
.lv-keys { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.lv-fld { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.lv-fld > span:first-child { font: 400 11px/14px var(--font-sans); color: var(--ink-3); }
.lv-inp { background: var(--solid); min-height: 30px; }
.lv-inp input { font: 400 12px/18px var(--font-mono); padding: 5px 0; }
.lv-inp input::placeholder { font-family: var(--font-sans); }
.lv-hint { margin-top: -4px; font: 400 11px/15px var(--font-sans); color: var(--ink-4); overflow-wrap: anywhere; }
.lv-chk { display: flex; align-items: flex-start; gap: 10px; border: 0; padding: 0; background: transparent; text-align: left; cursor: pointer; color: inherit; }
.lv-chk .box { width: 16px; height: 16px; margin-top: 1px; flex: none; border-radius: 5px; box-shadow: inset 0 0 0 1.2px var(--ink-4); display: inline-flex; align-items: center; justify-content: center; color: var(--on-accent); transition: background var(--duration-fast), box-shadow var(--duration-fast); }
.lv-chk .box.on { background: var(--accent); box-shadow: none; }
.lv-chk .box .nv-i { width: 11px; height: 11px; stroke-width: 2; }
.lv-chk .tx b { display: block; font: 400 12.5px/18px var(--font-sans); color: var(--ink); }
.lv-chk .tx span { display: block; font: 400 11px/16px var(--font-sans); color: var(--ink-3); }
.lv-apply { display: flex; align-items: center; gap: 10px; }
.lv-apply .nv-btn { background: var(--solid); }
.lv-mode { font: 400 11.5px/16px var(--font-sans); color: var(--ink-3); overflow-wrap: anywhere; min-width: 0; }
.lv-mode.ok { color: var(--ink); }
.lv-mode.error { color: var(--danger); }
.spin.sm { width: 12px; height: 12px; }
@media (max-width: 720px) { .lv-keys { grid-template-columns: 1fr; } }
</style>
