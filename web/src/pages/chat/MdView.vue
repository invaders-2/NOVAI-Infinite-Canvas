<script setup>
// Markdown 正文（markdown.js 生成，已转义）；代码块右上角的复制按钮用事件委托处理
import { computed } from 'vue';
import { md } from './markdown.js';
import { copyText } from './copy.js';
import { toast } from '../../lib/store.js';

const props = defineProps({ text: { type: String, default: '' } });
const html = computed(() => md(props.text));
async function onClick(e) {
    const btn = e.target.closest && e.target.closest('[data-md-copy]');
    if (!btn) return;
    const code = btn.closest('.md-pre') && btn.closest('.md-pre').querySelector('code');
    if (!code) return;
    const ok = await copyText(code.textContent);
    toast(ok ? '已复制代码' : '复制失败', { icon: ok ? 'check' : 'alert', danger: !ok });
}
</script>

<template>
    <div class="md" @click="onClick" v-html="html"></div>
</template>

<style scoped>
.md { min-width: 0; font: 400 13.5px/23px var(--font-sans); color: var(--ink); display: flex; flex-direction: column; gap: 10px; overflow-wrap: anywhere; }
.md :deep(p) { margin: 0; }
.md :deep(h1), .md :deep(h2), .md :deep(h3), .md :deep(h4), .md :deep(h5), .md :deep(h6) { margin: 4px 0 0; font-weight: 500; letter-spacing: -.01em; color: var(--ink); }
.md :deep(h1) { font-size: 16px; line-height: 24px; }
.md :deep(h2) { font-size: 15.5px; line-height: 23px; }
.md :deep(h3) { font-size: 15px; line-height: 22px; }
.md :deep(h4), .md :deep(h5), .md :deep(h6) { font-size: 13.5px; line-height: 22px; }
.md :deep(ul), .md :deep(ol) { margin: 0; padding: 0 0 0 20px; display: flex; flex-direction: column; gap: 4px; }
.md :deep(li > ul), .md :deep(li > ol) { margin-top: 4px; }
.md :deep(li::marker) { color: var(--ink-3); }
.md :deep(strong) { font-weight: 500; }
.md :deep(em) { font-style: italic; }
.md :deep(del) { color: var(--ink-3); }
.md :deep(a) { color: var(--ink); text-decoration: underline; text-decoration-color: var(--ink-4); text-underline-offset: 3px; }
.md :deep(a:hover) { text-decoration-color: var(--ink); }
.md :deep(hr) { width: 100%; height: 1px; margin: 4px 0; border: 0; background: var(--separator); }
.md :deep(code) { font: 400 12px/1 var(--font-mono); padding: 2px 5px; border-radius: 5px; background: var(--fill-2); }
.md :deep(blockquote) { margin: 0; padding: 10px 14px; border-radius: 10px; background: var(--fill-1); color: var(--ink-2); font-size: 13px; line-height: 21px; display: flex; flex-direction: column; gap: 6px; }
.md :deep(.md-table) { max-width: 100%; overflow-x: auto; }
.md :deep(table) { width: 100%; border-collapse: separate; border-spacing: 0; font: 400 12.5px/1.5 var(--font-sans); }
.md :deep(.md-table) { border-radius: 10px; }
.md :deep(th) { text-align: left; padding: 9px 10px; font: 500 11.5px/1.4 var(--font-sans); color: var(--ink-3); white-space: nowrap; background: var(--fill-1); }
.md :deep(td) { padding: 9px 10px; vertical-align: top; }
.md :deep(tbody tr:nth-child(even) td) { background: var(--fill-1); }
.md :deep(th:first-child), .md :deep(tr td:first-child) { border-top-left-radius: 8px; border-bottom-left-radius: 8px; }
.md :deep(th:last-child), .md :deep(tr td:last-child) { border-top-right-radius: 8px; border-bottom-right-radius: 8px; }
.md :deep(.md-pre) { position: relative; border-radius: 12px; background: var(--fill-1); overflow: hidden; }
.md :deep(.md-pre-h) { display: flex; align-items: center; justify-content: space-between; height: 32px; padding: 0 6px 0 14px; font: 400 11px/1 var(--font-mono); color: var(--ink-3); letter-spacing: .03em; }
.md :deep(.md-copy) { width: 24px; height: 24px; border: 0; padding: 0; border-radius: 7px; background: transparent; color: var(--ink-3); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; transition: background var(--duration-fast), color var(--duration-fast); }
.md :deep(.md-copy:hover) { background: var(--fill-2); color: var(--ink); }
.md :deep(.md-copy .nv-i) { width: 13px; height: 13px; }
.md :deep(pre) { margin: 0; padding: 2px 14px 12px; overflow-x: auto; }
.md :deep(pre code) { padding: 0; background: none; font: 400 12px/19px var(--font-mono); color: var(--ink-2); white-space: pre; }
</style>
