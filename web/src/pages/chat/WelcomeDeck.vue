<script setup>
// 欢迎页（空会话时）：6 个快捷入口（点击把「标题：」填进输入框，不发送）+ 最近 3 条会话（点击打开）
import { computed } from 'vue';
import ChIcon from './ChIcon.vue';
import { C, openConversation } from './session.js';

const emit = defineEmits(['fill']);
const PROMPTS = [
    { ic: 'image', title: '生成图片', desc: '一句话描述画面，AI 帮你画' },
    { ic: 'pen', title: '写文案', desc: '产品介绍、标题、广告语' },
    { ic: 'terminal', title: '写代码', desc: '修 bug、补注释、转语言' },
    { ic: 'doc', title: '读文档', desc: '总结、问答、提取要点' },
    { ic: 'search', title: '查资料', desc: '联网检索与整理' },
    { ic: 'bulb', title: '头脑风暴', desc: '开脑洞、列方案、做规划' },
];
const recent = computed(() => C.conversations.slice(0, 3));
</script>

<template>
    <div class="wel">
        <div class="hd">
            <h1>开始新的对话</h1>
            <p>从一句提示词开始，或点下面的快捷入口</p>
        </div>
        <div class="grid">
            <button v-for="(p, i) in PROMPTS" :key="p.title" type="button" class="card" :style="{ '--d': i * 40 + 'ms' }" @click="emit('fill', p.title + '：')">
                <span class="ic"><ChIcon :name="p.ic" /></span>
                <b>{{ p.title }}</b><span>{{ p.desc }}</span>
            </button>
        </div>
        <div class="rec">
            <div class="rh">最近会话</div>
            <div v-if="!recent.length" class="empty">还没有历史会话，聊点什么吧</div>
            <div v-else class="list">
                <button v-for="c in recent" :key="c.id" type="button" class="it" @click="openConversation(c.id)">
                    <b>{{ c.title || '新对话' }}</b>
                    <span>{{ c.last_message ? String(c.last_message).slice(0, 40) : '' }}</span>
                    <ChIcon name="arrowr" />
                </button>
            </div>
        </div>
    </div>
</template>

<style scoped>
.wel { display: flex; flex-direction: column; gap: 28px; padding-top: 24px; }
.hd h1 { margin: 0; font: 500 28px/36px var(--font-sans); letter-spacing: -.02em; color: var(--ink); }
.hd p { margin: 4px 0 0; font: 400 13px/20px var(--font-sans); color: var(--ink-3); }
.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.card { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 16px; border: 0; border-radius: 16px; background: var(--solid); box-shadow: var(--shadow-float); cursor: pointer; text-align: left; color: var(--ink);
    transition: box-shadow var(--duration-base) var(--ease-out), transform var(--duration-base) var(--ease-out); animation: wel-in 420ms var(--ease-out) var(--d) both; }
.card:hover { box-shadow: var(--shadow-lift); transform: translateY(-2px); }
.card:active { transform: scale(.99); }
.card .ic { width: 30px; height: 30px; margin-bottom: 10px; border-radius: 9px; background: var(--fill-1); display: inline-flex; align-items: center; justify-content: center; color: var(--ink-2); }
.card .ic .nv-i { width: 15px; height: 15px; }
.card b { font: 500 13.5px/20px var(--font-sans); }
.card > span:not(.ic) { font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.rec { display: flex; flex-direction: column; gap: 6px; }
.rh { font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.list { display: flex; flex-direction: column; gap: 2px; }
.it { display: flex; align-items: center; gap: 12px; height: 44px; padding: 0 12px; border: 0; border-radius: 10px; background: transparent; cursor: pointer; text-align: left; color: var(--ink); transition: background var(--duration-fast); }
.it:hover { background: var(--fill-1); }
.it b { font: 500 13px/1 var(--font-sans); white-space: nowrap; max-width: 40%; overflow: hidden; text-overflow: ellipsis; }
.it span { flex: 1; min-width: 0; font: 400 12px/1 var(--font-sans); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.it .nv-i { width: 14px; height: 14px; color: var(--ink-4); flex: none; transition: transform var(--duration-base) var(--ease-out); }
.it:hover .nv-i { transform: translateX(2px); color: var(--ink-3); }
.empty { padding: 18px 12px; border-radius: 12px; background: var(--fill-1); font: 400 12px/18px var(--font-sans); color: var(--ink-3); text-align: center; }
@keyframes wel-in { from { opacity: 0; transform: translateY(6px); } }
@media (max-width: 720px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (prefers-reduced-motion: reduce) { .card { animation: none; } }
</style>
