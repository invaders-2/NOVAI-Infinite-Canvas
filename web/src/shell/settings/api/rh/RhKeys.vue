<script setup>
// RunningHub 双 Key：RH币（必填）/ 账户余额（可选）。输入值由父组件持有（collect() 要用）。
import { computed } from 'vue';
import NvIcon from '../../../../components/NvIcon.vue';
import { t } from '../../../../lib/store.js';

const props = defineProps({ provider: Object, free: String, wallet: String, busy: String });
const emit = defineEmits(['update:free', 'update:wallet', 'save', 'clear']);

const p = computed(() => props.provider || {});
const rows = computed(() => [
    {
        kind: 'free',
        title: t('api.rhCoinApiKeyRequired', 'RH币 API Key · 必填'),
        desc: t('api.rhCoinKeyDesc', '使用 RH币 接口时填写'),
        cn: 'https://www.runninghub.cn/enterprise-api/consumerApi?inviteCode=rh-v1331',
        global: 'https://www.runninghub.ai/enterprise-api/consumerApi?inviteCode=rh-v1331',
        value: props.free,
        placeholder: p.value.has_key ? `${t('api.rhKeepCoinKey', '保持当前 RH币 Key')} ${p.value.key_preview || ''}` : t('api.rhEnterCoinKey', '输入 RH币 API Key'),
        hint: p.value.has_key ? `${t('api.rhCoinKeySaved', '当前 RH币 Key 已保存：')}${p.value.key_env || 'API/.env'} ${p.value.key_preview || ''}` : t('api.rhNoCoinKey', '还没有保存 RH币 Key。'),
        saved: p.value.has_key === true,
        saveTitle: t('api.saveRhCoinKeyTitle', '保存 RH币 Key'),
        clearTitle: t('api.clearRhCoinKeyTitle', '清除 RH币 Key'),
    },
    {
        kind: 'wallet',
        title: t('api.rhWalletApiKeyOptional', '账户余额 API Key · 可选'),
        desc: t('api.rhWalletKeyDesc', '使用账户余额接口时填写'),
        cn: 'https://www.runninghub.cn/enterprise-api/sharedApi?inviteCode=rh-v1331',
        global: 'https://www.runninghub.ai/enterprise-api/sharedApi?inviteCode=rh-v1331',
        value: props.wallet,
        placeholder: p.value.has_wallet_key ? `${t('api.rhKeepWalletKey', '保持当前账户余额 Key')} ${p.value.wallet_key_preview || ''}` : t('api.rhEnterWalletKey', '输入账户余额 Key'),
        hint: p.value.has_wallet_key ? `${t('api.rhWalletKeySaved', '当前账户余额 Key 已保存：')}${p.value.wallet_key_env || 'API/.env'} ${p.value.wallet_key_preview || ''}` : t('api.rhNoWalletKey', '还没有保存账户余额 Key。验证地址和拉取模型会优先使用它。'),
        saved: p.value.has_wallet_key === true,
        saveTitle: t('api.saveRhWalletKeyTitle', '保存账户余额 Key'),
        clearTitle: t('api.clearRhWalletKeyTitle', '清除账户余额 Key'),
    },
]);
function input(kind, v) { emit(kind === 'free' ? 'update:free' : 'update:wallet', v); }
</script>

<template>
    <div class="rk">
        <div class="rk-h"><NvIcon name="key" /><span>API Key</span></div>
        <div v-for="r in rows" :key="r.kind" class="rk-item">
            <div class="rk-top">
                <div class="rk-t"><b>{{ r.title }}</b><span>{{ r.desc }}</span></div>
                <div class="rk-links">
                    <span>{{ t('api.get', '获取') }}</span>
                    <a :href="r.cn" target="_blank" rel="noopener"><NvIcon name="ext" />{{ t('api.cnKey', '国内 Key') }}</a>
                    <a :href="r.global" target="_blank" rel="noopener"><NvIcon name="ext" />{{ t('api.globalKey', '国外 Key') }}</a>
                </div>
            </div>
            <div class="rk-line">
                <label class="nv-field rk-inp"><input :value="r.value" type="password" autocomplete="off" spellcheck="false" :placeholder="r.placeholder" :aria-label="r.title"
                        @input="input(r.kind, $event.target.value)" @keydown.enter="emit('save', r.kind)"></label>
                <button type="button" class="rk-kb dark" :title="r.saveTitle" :aria-label="r.saveTitle" :disabled="!!busy" @click="emit('save', r.kind)">
                    <span v-if="busy === r.kind" class="spin sm"></span><NvIcon v-else name="check" />
                </button>
                <button type="button" class="rk-kb ghost" :title="r.clearTitle" :aria-label="r.clearTitle" :disabled="!!busy" @click="emit('clear', r.kind)"><NvIcon name="trash" /></button>
            </div>
            <div class="rk-hint" :class="{ ok: r.saved }">{{ r.hint }}</div>
        </div>
    </div>
</template>

<style scoped>
.rk { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.rk-h { display: flex; align-items: center; gap: 7px; font: 500 12px/16px var(--font-sans); color: var(--ink-2); }
.rk-h .nv-i { width: 14px; height: 14px; color: var(--ink-3); }
.rk-item { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.rk-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.rk-t b { display: block; font: 500 12px/17px var(--font-sans); color: var(--ink); }
.rk-t span { display: block; font: 400 11px/15px var(--font-sans); color: var(--ink-3); }
.rk-links { display: flex; align-items: center; gap: 10px; flex: none; font: 400 11px/16px var(--font-sans); color: var(--ink-3); }
.rk-links a { display: inline-flex; align-items: center; gap: 3px; color: var(--ink-3); text-decoration: none; transition: color var(--duration-fast) var(--ease-out); }
.rk-links a:hover { color: var(--ink); }
.rk-links .nv-i { width: 11px; height: 11px; }
.rk-line { display: flex; align-items: center; gap: 6px; }
.rk-inp { flex: 1; min-width: 0; min-height: 30px; background: var(--solid); }
.rk-inp input { font: 400 12px/18px var(--font-mono); padding: 5px 0; }
.rk-inp input::placeholder { font-family: var(--font-sans); }
.rk-kb { width: 30px; height: 30px; border: 0; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; flex: none; transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), transform var(--duration-instant); }
.rk-kb .nv-i { width: 14px; height: 14px; }
.rk-kb:active { transform: scale(.94); }
.rk-kb.dark { background: var(--accent); color: var(--on-accent); }
.rk-kb.ghost { background: transparent; color: var(--ink-3); }
.rk-kb.ghost:hover { background: var(--fill-2); color: var(--danger); }
.rk-kb:disabled { cursor: default; opacity: .6; }
.rk-hint { font: 400 11px/15px var(--font-sans); color: var(--ink-4); overflow-wrap: anywhere; }
.rk-hint.ok { color: var(--ink-3); }
.spin.sm { width: 12px; height: 12px; }
</style>
