<script setup>
// 新手引导卡：ModelScope / RunningHub 还没保存 Key 时替代完整设置（获取链接 → 粘贴 → 保存）
import { computed, inject } from 'vue';
import AIcon from './AIcon.vue';
import { t } from '../../../../lib/store.js';
import { ONBOARDING_GUIDES } from '../core/constants.js';

const props = defineProps({ kind: String });
const store = inject('apiStore');
const S = store.S;
const g = computed(() => ONBOARDING_GUIDES[props.kind] || {});
const rows = computed(() => {
    const x = g.value;
    if (props.kind === 'modelscope') {
        return [{ label: t('api.msTokenLabel', 'ModelScope Token'), model: 'key', field: 'API Key', placeholder: t('api.msTokenPlaceholder', '粘贴 ModelScope Token'),
            links: [{ href: x.primaryUrl, icon: 'key', text: t(x.primaryLabelKey, x.primaryLabel) }, { href: x.secondaryUrl, icon: 'globe', text: t(x.secondaryLabelKey, x.secondaryLabel) }] }];
    }
    return [
        { label: t('api.rhCoinKey', 'RH币 Key'), model: 'rhFree', field: t('api.rhCoinApiKeyRequired', 'RH币 API Key · 必填'), placeholder: t('api.rhCoinPlaceholder', '粘贴 RH币 API Key'),
            links: [{ href: x.primaryUrl, icon: 'coins', text: t(x.primaryLabelKey, x.primaryLabel) }, { href: x.secondaryUrl, icon: 'globe', text: t(x.secondaryLabelKey, x.secondaryLabel) }] },
        { label: t('api.rhWalletKey', '账户余额 Key'), model: 'rhWallet', field: t('api.rhWalletApiKeyOptional', '账户余额 API Key · 可选'), placeholder: t('api.rhWalletPlaceholder', '需要账户余额时再粘贴'),
            links: [{ href: x.walletPrimaryUrl, icon: 'wallet', text: t(x.walletPrimaryLabelKey, x.walletPrimaryLabel) }, { href: x.walletSecondaryUrl, icon: 'globe', text: t(x.walletSecondaryLabelKey, x.walletSecondaryLabel) }] },
    ];
});
function save() { if (props.kind === 'runninghub') store.saveOnboardingRunningHubKey(); else store.saveKeyOnly(); }
</script>

<template>
    <section class="ob">
        <div class="hd">
            <div><b>{{ t(g.titleKey, g.title) }}</b><span>{{ t(g.descKey, g.desc) }}</span></div>
            <span class="new">{{ t('api.onboardingNew', 'NEW') }}</span>
        </div>
        <div class="panel">
            <div class="ph"><b>{{ kind === 'runninghub' ? t('api.rhOnboardingStep', '获取 Key 后填写并保存') : t('api.msOnboardingStep', '获取 Token 后填写并保存') }}</b><AIcon name="key" /></div>
            <div v-for="r in rows" :key="r.model" class="flow">
                <div class="src">
                    <span class="lb">{{ r.label }}</span>
                    <div class="links">
                        <a v-for="l in r.links" :key="l.href" class="nv-btn sm lk" :href="l.href" target="_blank" rel="noopener noreferrer"><AIcon :name="l.icon" />{{ l.text }}</a>
                    </div>
                </div>
                <span class="arrow" aria-hidden="true"><AIcon name="arrowr" /></span>
                <label class="fld"><span class="lb">{{ r.field }}</span>
                    <input v-model="S.form[r.model]" type="password" autocomplete="off" spellcheck="false" :placeholder="r.placeholder" @keydown.enter="save">
                </label>
            </div>
            <div class="sv"><button type="button" class="nv-btn sm primary" :disabled="S.saving" @click="save"><span v-if="S.saving" class="spin xs"></span><AIcon v-else name="check" />{{ t('api.save', '保存') }}</button></div>
        </div>
    </section>
</template>

<style scoped>
.ob { background: var(--solid); border-radius: 16px; box-shadow: var(--shadow-float); padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; }
.hd { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.hd b { display: block; font: 500 14px/20px var(--font-sans); }
.hd span { display: block; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.hd .new { height: 18px; padding: 0 6px; border-radius: 5px; background: var(--accent); color: var(--on-accent); font: 500 11px/18px var(--font-mono); letter-spacing: .04em; flex: none; }
.panel { background: var(--fill-1); border-radius: 14px; padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; }
.ph { display: flex; align-items: center; justify-content: space-between; }
.ph b { font: 500 12.5px/18px var(--font-sans); }
.ph .nv-i { width: 14px; height: 14px; color: var(--ink-3); }
.flow { display: grid; grid-template-columns: minmax(0, 1fr) 24px minmax(0, 1fr); gap: 10px; align-items: end; }
.src, .fld { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.lb { font: 400 11px/14px var(--font-sans); color: var(--ink-3); }
.links { display: flex; gap: 6px; flex-wrap: wrap; }
.lk { background: var(--solid); text-decoration: none; color: var(--ink); }
.lk:hover { background: var(--fill-2); }
.arrow { height: 32px; display: flex; align-items: center; justify-content: center; color: var(--ink-4); }
.arrow .nv-i { width: 14px; height: 14px; }
.fld input { height: 32px; padding: 0 10px; border: 0; outline: 0; border-radius: 8px; background: var(--solid); font: 400 12px/1 var(--font-mono); color: var(--ink); transition: box-shadow 160ms; }
.fld input:focus { background: var(--fill-2); box-shadow: none; }
.fld input::placeholder { font-family: var(--font-sans); color: var(--ink-4); }
.sv { display: flex; justify-content: flex-end; }
.spin.xs { width: 12px; height: 12px; border-width: 1.2px; }
@media (max-width: 860px) { .flow { grid-template-columns: 1fr; } .arrow { display: none; } }
</style>
