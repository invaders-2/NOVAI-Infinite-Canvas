<script setup>
// API Key 卡片：普通平台一行 Key（显示 / 粘贴 / 保存 / 清除）；RunningHub 两把 Key（RH币必填 + 账户余额可选）；ModelScope 附 Token 获取链接
import { computed, inject } from 'vue';
import AIcon from './AIcon.vue';
import { t } from '../../../../lib/store.js';
import { RH_KEY_LINKS } from '../core/constants.js';

const store = inject('apiStore');
const S = store.S;
const it = store.item;
const fl = store.flags;

const placeholder = computed(() => {
    const p = it.value; if (!p) return '';
    if (fl.value.isJimeng) return '即梦 CLI 使用本机 dreamina login，无需 API Key';
    if (fl.value.isCodex) return 'OpenAI CLI 使用本机 codex login，无需 API Key';
    if (fl.value.isGeminiCli) return 'Antigravity CLI 使用本机 agy 登录态，无需 API Key';
    if (fl.value.isVolc) return p.has_key ? `保持当前方舟 API Key ${p.key_preview || ''}` : '输入方舟 API Key';
    return p.has_key ? `${t('api.keepCurrentKey', '保持当前 Key')} ${p.key_preview || ''}` : t('api.enterKey', '输入 API Key');
});
// 右上角状态：已保存时是一枚标签，否则是提示文字
const hint = computed(() => {
    const p = it.value; if (!p) return { text: '', saved: false };
    if (fl.value.isVolc) return { text: p.has_key ? `方舟 API Key 已保存：${p.key_env || 'API/.env'} ${p.key_preview || ''}` : '还没有保存方舟 API Key。', saved: false };
    if (p.has_key) return { text: `${t('api.keySaved', '当前 Key 已保存：')}${p.key_env || 'API/.env'}`, saved: true };
    return { text: t('api.noKey', '还没有保存 Key。'), saved: false };
});
const rhItems = computed(() => {
    const p = it.value || {};
    return [
        {
            kind: 'free', model: 'rhFree', title: t('api.rhCoinApiKeyRequired', 'RH币 API Key · 必填'), desc: t('api.rhCoinKeyDesc', '使用 RH币 接口时填写'), links: RH_KEY_LINKS.free,
            placeholder: p.has_key ? `${t('api.rhKeepCoinKey', '保持当前 RH币 Key')} ${p.key_preview || ''}` : t('api.rhEnterCoinKey', '输入 RH币 API Key'),
            hint: p.has_key ? `${t('api.rhCoinKeySaved', '当前 RH币 Key 已保存：')}${p.key_env || 'API/.env'} ${p.key_preview || ''}` : t('api.rhNoCoinKey', '还没有保存 RH币 Key。'),
            saveTitle: t('api.saveRhCoinKeyTitle', '保存 RH币 Key'), clearTitle: t('api.clearRhCoinKeyTitle', '清除 RH币 Key'),
        },
        {
            kind: 'wallet', model: 'rhWallet', title: t('api.rhWalletApiKeyOptional', '账户余额 API Key · 可选'), desc: t('api.rhWalletKeyDesc', '使用账户余额接口时填写'), links: RH_KEY_LINKS.wallet,
            placeholder: p.has_wallet_key ? `${t('api.rhKeepWalletKey', '保持当前账户余额 Key')} ${p.wallet_key_preview || ''}` : t('api.rhEnterWalletKey', '输入账户余额 Key'),
            hint: p.has_wallet_key ? `${t('api.rhWalletKeySaved', '当前账户余额 Key 已保存：')}${p.wallet_key_env || 'API/.env'} ${p.wallet_key_preview || ''}` : t('api.rhNoWalletKey', '还没有保存账户余额 Key。'),
            saveTitle: t('api.saveRhWalletKeyTitle', '保存账户余额 Key'), clearTitle: t('api.clearRhWalletKeyTitle', '清除账户余额 Key'),
        },
    ];
});
</script>

<template>
    <div class="tile s2 key">
        <div class="th"><AIcon name="key" /><span>API Key</span>
            <span v-if="!fl.isRh && hint.text" class="r" :class="{ tag: hint.saved }">{{ hint.text }}</span>
        </div>

        <template v-if="!fl.isRh">
            <div class="kline">
                <label class="inp">
                    <input v-model="S.form.key" :type="S.keyRevealed ? 'text' : 'password'" autocomplete="off" spellcheck="false" :placeholder="placeholder" aria-label="API Key">
                    <button type="button" class="ib" :class="{ on: S.keyRevealed }" title="显示 / 隐藏" @click="S.keyRevealed = !S.keyRevealed"><AIcon :name="S.keyRevealed ? 'eyeoff' : 'eye'" /></button>
                    <button type="button" class="ib" title="从剪贴板粘贴" @click="store.pasteKey()"><AIcon name="paste" /></button>
                </label>
                <button type="button" class="kb dark" :title="t('api.saveKeyTitle', '保存 Key')" :disabled="S.saving" @click="store.saveKeyOnly()"><span v-if="S.saving" class="spin sm"></span><AIcon v-else name="check" /></button>
                <button type="button" class="kb ghost" :title="t('api.clearKeyTitle', '清除 Key')" @click="store.clearKeyOnly()"><AIcon name="trash" /></button>
            </div>
            <div class="sub">Key 写入后端 env，页面不会回显完整内容</div>
            <div v-if="fl.isMs" class="links">
                <span>{{ t('api.msTokenCn', '获取 Token · 国内：') }}<a href="https://www.modelscope.cn/my/access/token" target="_blank" rel="noopener">modelscope.cn/my/access/token</a></span>
                <span>{{ t('api.msTokenGlobal', '获取 Token · 国外：') }}<a href="https://www.modelscope.ai/my/access/token" target="_blank" rel="noopener">modelscope.ai/my/access/token</a></span>
            </div>
        </template>

        <div v-else class="rh">
            <div v-for="k in rhItems" :key="k.kind" class="rhi">
                <div class="rhh">
                    <div><b>{{ k.title }}</b><span>{{ k.desc }}</span></div>
                    <div class="rhl">{{ t('api.get', '获取') }}
                        <a :href="k.links.cn" target="_blank" rel="noopener"><AIcon name="ext" />{{ t('api.cnKey', '国内 Key') }}</a>
                        <a :href="k.links.global" target="_blank" rel="noopener"><AIcon name="ext" />{{ t('api.globalKey', '国外 Key') }}</a>
                    </div>
                </div>
                <div class="kline">
                    <label class="inp"><input v-model="S.form[k.model]" type="password" autocomplete="off" spellcheck="false" :placeholder="k.placeholder" :aria-label="k.title"></label>
                    <button type="button" class="kb dark" :title="k.saveTitle" :disabled="S.saving" @click="store.saveRhKeyOnly(k.kind)"><AIcon name="check" /></button>
                    <button type="button" class="kb ghost" :title="k.clearTitle" @click="store.clearRhKeyOnly(k.kind)"><AIcon name="trash" /></button>
                </div>
                <div class="sub">{{ k.hint }}</div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.tile { position: relative; background: var(--fill-1); border-radius: 14px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.th { display: flex; align-items: center; gap: 7px; font: 500 12px/16px var(--font-sans); color: var(--ink-2); min-width: 0; }
.th .nv-i { width: 14px; height: 14px; color: var(--ink-3); flex: none; }
.th .r { margin-left: auto; font: 400 11px/14px var(--font-sans); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.th .r.tag { height: 18px; line-height: 18px; padding: 0 7px; border-radius: 99px; background: var(--solid); color: var(--ink-2); }
.kline { display: flex; align-items: center; gap: 6px; }
.inp { flex: 1; min-width: 0; height: 32px; display: flex; align-items: center; gap: 2px; padding: 0 4px 0 10px; border-radius: 8px; background: var(--solid); transition: box-shadow 160ms; }
.inp:focus-within { background: var(--fill-2); box-shadow: none; }
.inp input { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; font: 400 12px/1 var(--font-mono); color: var(--ink); }
.inp input::placeholder { font-family: var(--font-sans); color: var(--ink-4); }
.ib { width: 24px; height: 24px; border: 0; padding: 0; border-radius: 6px; background: transparent; color: var(--ink-3); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; flex: none; }
.ib:hover, .ib.on { background: var(--fill-1); color: var(--ink); }
.ib .nv-i { width: 13px; height: 13px; }
.kb { width: 32px; height: 32px; border: 0; padding: 0; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; flex: none; transition: background 120ms, transform 100ms; }
.kb:active { transform: scale(.94); }
.kb .nv-i { width: 14px; height: 14px; }
.kb.dark { background: var(--accent); color: var(--on-accent); }
.kb.dark:disabled { background: var(--fill-2); color: var(--ink-4); cursor: default; }
.kb.ghost { background: transparent; color: var(--ink-3); }
.kb.ghost:hover { background: var(--fill-2); color: var(--danger); }
.spin.sm { width: 12px; height: 12px; }
.sub { font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); }
.links { display: flex; flex-direction: column; gap: 2px; font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); }
.links a, .rhl a { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--ink-4); }
.rh { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.rhi { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.rhh { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.rhh b { display: block; font: 500 12px/16px var(--font-sans); color: var(--ink); }
.rhh span { display: block; font: 400 11px/15px var(--font-sans); color: var(--ink-3); }
.rhl { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; font: 400 11px/15px var(--font-sans); color: var(--ink-3); }
.rhl a { display: inline-flex; align-items: center; gap: 3px; text-decoration: none; }
.rhl a:hover { text-decoration: underline; }
.rhl .nv-i { width: 11px; height: 11px; }
@media (max-width: 900px) { .rh { grid-template-columns: 1fr; } }
</style>
