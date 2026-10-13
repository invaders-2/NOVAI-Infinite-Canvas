<script setup>
// 平台详情：页头（未保存 / 首选 / 删除 / 保存 / 测试连接）+ 新手引导卡 或 概览便当格 + RunningHub 应用与工作流 + 模型列表
import { computed, inject } from 'vue';
import AIcon from './AIcon.vue';
import ApiHead from './ApiHead.vue';
import OverviewBento from './OverviewBento.vue';
import OnboardingCard from './OnboardingCard.vue';
import ModelsSection from './ModelsSection.vue';
import ModelPicker from './ModelPicker.vue';
import RunningHubPanel from '../RunningHubPanel.vue';
import { t } from '../../../../lib/store.js';
import { isFixedProvider, isCliProtocol } from '../core/helpers.js';

const store = inject('apiStore');
const emitChild = inject('apiChildEvents');
const S = store.S;
const it = store.item;
const fl = store.flags;

const crumb = computed(() => {
    const p = it.value;
    const group = !p ? '平台' : isFixedProvider(p) ? '内置平台' : isCliProtocol(p.protocol) ? '本机 CLI' : '自定义平台';
    return `${group} · 共 ${S.providers.length} 个平台`;
});
const title = computed(() => S.form.name.trim() || (it.value && it.value.id) || t('api.provider', '平台'));
const url = computed(() => {
    if (fl.value.isCli || isCliProtocol(it.value && it.value.protocol)) return { text: '使用本机登录态，无需请求地址', empty: false };
    const u = S.form.base.trim() || (it.value && it.value.base_url) || '';
    return { text: u || '尚未填写请求地址', empty: !u };
});
const unsaved = computed(() => S.dirty || S.childDirty);
</script>

<template>
    <div class="pv">
        <ApiHead :crumb="crumb" :title="title" :url="url.text" :url-empty="url.empty">
            <template #badges>
                <Transition name="fade"><span v-if="unsaved" class="unsaved"><i></i>未保存</span></Transition>
                <span v-if="it && it.primary" class="prim" :title="t('api.currentPrimary', '当前首选')"><AIcon name="star" />{{ t('api.primaryBadge', '首选') }}</span>
                <button v-else-if="it && !store.onboarding.value" type="button" class="setprim" :disabled="S.saving" @click="store.setPrimary(it.id)"><AIcon name="star" />{{ t('api.setPrimary', '设为首选') }}</button>
            </template>
            <template v-if="!store.onboarding.value" #actions>
                <button v-if="fl.deletable" type="button" class="nv-icon-btn sm" title="删除平台" aria-label="删除平台" @click="store.deleteProvider()"><AIcon name="trash" /></button>
                <button type="button" class="nv-btn sm" :disabled="S.saving" @click="store.save()"><span v-if="S.saving" class="spin xs"></span><AIcon v-else name="save" />{{ t('api.save', '保存') }}</button>
                <button type="button" class="nv-btn sm primary" :disabled="S.testing" title="验证地址与 Key，并自动识别接口协议" @click="store.testProviderConnection()"><span v-if="S.testing" class="spin xs"></span><AIcon v-else name="plug" />{{ S.testing ? t('api.testingUrl', '验证中...') : '测试连接' }}</button>
            </template>
        </ApiHead>

        <OnboardingCard v-if="store.onboarding.value" :kind="store.onboarding.value" />
        <template v-else>
            <OverviewBento />
            <!-- RH 两把 Key 在概览的 API Key 卡里，这里只渲染「应用与工作流」 -->
            <RunningHubPanel v-if="fl.isRh" :key="'rh' + it.id" section="entries" :provider="it" :providers="S.providers" :save="store.save" @dirty="emitChild.dirty" @save="store.save()" />
            <ModelsSection />
        </template>
        <ModelPicker />
    </div>
</template>

<style scoped>
.pv { display: flex; flex-direction: column; gap: 22px; }
.unsaved { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; border-radius: 99px; background: var(--fill-1); font: 400 11px/1 var(--font-sans); color: var(--ink-2); flex: none; }
.unsaved i { width: 6px; height: 6px; border-radius: 50%; background: var(--ink); }
.prim { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border-radius: 99px; background: var(--accent); color: var(--on-accent); font: 400 11px/1 var(--font-sans); flex: none; }
.prim .nv-i, .setprim .nv-i { width: 12px; height: 12px; }
.setprim { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border: 0; border-radius: 99px; background: transparent; color: var(--ink-3); font: 400 11px/1 var(--font-sans); cursor: pointer; flex: none; transition: background 120ms, color 120ms; }
.setprim:hover { background: var(--fill-1); color: var(--ink); }
.spin.xs { width: 12px; height: 12px; border-width: 1.2px; }
.fade-enter-active, .fade-leave-active { transition: opacity 160ms var(--ease-out), transform 160ms var(--ease-out); }
.fade-enter-from, .fade-leave-to { opacity: 0; transform: scale(.94); }
</style>
