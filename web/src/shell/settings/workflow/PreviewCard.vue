<script setup>
// 画布节点预览：已暴露字段的实时控件 + 运行测试 + 结果（点击放大）
import NvIcon from '../../../components/NvIcon.vue';
import PreviewField from './PreviewField.vue';
import { t } from '../../../lib/store.js';
import { wf, runTest } from './wfStore.js';
</script>

<template>
    <section class="grp">
        <div class="hd"><NvIcon name="eye" /><b>{{ t('comfy.nodePreview', '画布节点预览') }}</b><span class="nv-badge">{{ t('comfy.live', '实时') }}</span></div>
        <span class="desc">{{ t('comfy.previewDesc', '这个工作流在画布 Comfy 节点上将显示出的控件，可直接填写并点击「运行测试」。') }}</span>
        <div v-if="!wf.config || !wf.config.fields.length" class="empty" v-html="t('comfy.previewEmpty', '勾选节点输入字段后<br>预览将出现在这里')"></div>
        <template v-else>
            <TransitionGroup name="pf" tag="div" class="fields">
                <PreviewField v-for="f in wf.config.fields" :key="f.id" :field="f" />
            </TransitionGroup>
            <button type="button" class="run" :disabled="wf.running" @click="runTest">
                <span v-if="wf.running" class="spin s13"></span><NvIcon v-else name="play" />{{ wf.running ? t('comfy.runningTest', '运行中...') : t('comfy.runTest', '运行测试') }}
            </button>
            <Transition name="res">
                <div v-if="wf.runResult" class="res">
                    <button type="button" class="res-img" title="点击放大预览" @click="wf.lightbox = wf.runResult"><img :src="wf.runResult" alt="运行结果" /></button>
                    <span class="ok"><NvIcon name="check" />{{ t('comfy.runSuccess', '运行成功') }} · 点击放大预览</span>
                </div>
            </Transition>
        </template>
    </section>
</template>

<style scoped>
.grp { display: flex; flex-direction: column; gap: 10px; padding: 14px; border-radius: 14px; background: var(--fill-1); }
.hd { display: flex; align-items: center; gap: 6px; }
.hd .nv-i { width: 14px; height: 14px; color: var(--ink-3); }
.hd b { font: 500 13px/18px var(--font-sans); }
.desc { font: 400 11px/17px var(--font-sans); color: var(--ink-3); }
.empty { padding: 18px; border-radius: 12px; background: var(--solid); font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); text-align: center; }
.fields { position: relative; display: flex; flex-direction: column; gap: 10px; }
.run { height: 34px; border: 0; border-radius: 10px; background: var(--accent); color: var(--on-accent); display: flex; align-items: center; justify-content: center; gap: 6px; font: 500 12.5px/1 var(--font-sans); cursor: pointer; transition: box-shadow var(--duration-fast), transform var(--duration-instant), opacity var(--duration-fast); }
.run:hover:not(:disabled) { box-shadow: var(--shadow-lift); }
.run:active:not(:disabled) { transform: scale(.98); }
.run:disabled { opacity: .7; cursor: default; }
.run .nv-i { width: 13px; height: 13px; }
.s13 { width: 13px; height: 13px; }
.res { display: flex; flex-direction: column; gap: 6px; }
.res-img { padding: 0; border: 0; border-radius: 10px; overflow: hidden; background: var(--solid); cursor: zoom-in; }
.res-img img { display: block; width: 100%; max-height: 220px; object-fit: contain; }
.ok { display: flex; align-items: center; gap: 6px; font: 400 11px/14px var(--font-sans); color: var(--ink-2); }
.ok .nv-i { width: 13px; height: 13px; }
.pf-enter-active, .pf-leave-active { transition: opacity 200ms var(--ease-out), transform 200ms var(--ease-out); }
.pf-enter-from, .pf-leave-to { opacity: 0; transform: translateY(-4px); }
.pf-leave-active { position: absolute; left: 0; right: 0; }
.pf-move { transition: transform 200ms var(--ease-out); }
.res-enter-active { transition: opacity 240ms var(--ease-out), transform 240ms var(--ease-out); }
.res-enter-from { opacity: 0; transform: translateY(6px); }
</style>
