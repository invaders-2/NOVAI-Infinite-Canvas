<script setup>
// 消息区：日期分隔 + 消息；空会话时显示欢迎页。
// 滚动跟随（同旧版）：贴底时跟随最新内容；用户主动上滚即停止跟随，滚回底部自动恢复；
// 用户在翻历史时整表重建（流式结束）会锚定视口里第一条消息，不弹回底部。
import { ref, computed, onMounted } from 'vue';
import MessageItem from './MessageItem.vue';
import WelcomeDeck from './WelcomeDeck.vue';
import { C, hooks } from './session.js';

const emit = defineEmits(['preview', 'fill']);
const box = ref(null);
let pinned = true;

const pad = n => (n < 10 ? '0' : '') + n;
function fmtTime(ts) { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function fmtDay(ts) {
    const d = new Date(ts), n = new Date();
    return (d.getFullYear() === n.getFullYear() ? '' : d.getFullYear() + '年 ') + (d.getMonth() + 1) + '月 ' + d.getDate() + '日';
}
const rows = computed(() => {
    let last = '';
    return C.messages.map(m => {
        const raw = Number(m.created_at) || Date.now();
        const ts = raw < 1e11 ? raw * 1000 : raw;
        const day = fmtDay(ts);
        const divider = day !== last ? day : '';
        last = day;
        return { m, day: divider, time: fmtTime(ts) };
    });
});

function atBottom(th = 24) { const el = box.value; return !el || el.scrollHeight - el.scrollTop - el.clientHeight <= th; }
function scroll(force) {
    const el = box.value;
    if (!el) return;
    if (force) pinned = true;
    else if (!pinned) return;
    requestAnimationFrame(() => { if (!force && !pinned) return; el.scrollTop = el.scrollHeight; });
}
function anchor() {
    const el = box.value;
    if (!el || pinned) return null;
    const top = el.getBoundingClientRect().top;
    const list = el.querySelectorAll('[data-row]');
    for (let i = 0; i < list.length; i++) {
        const r = list[i].getBoundingClientRect();
        if (r.bottom > top + 1) return { index: i, offset: Math.round(r.top - top) };
    }
    return null;
}
function restore(a) {
    const el = box.value;
    if (!el || !a) return;
    const row = el.querySelectorAll('[data-row]')[a.index];
    if (!row) return;
    const off = row.getBoundingClientRect().top - el.getBoundingClientRect().top;
    if (Math.abs(off - a.offset) >= 1) el.scrollTop += off - a.offset;
}
function onWheel(e) {
    const el = box.value;
    if (e.deltaY < 0) { if (el && el.scrollTop > 0) pinned = false; return; }
    requestAnimationFrame(() => { if (atBottom(8)) pinned = true; });
}
function onTouch() { if (box.value && box.value.scrollTop > 0) pinned = false; }
function onScroll() { if (atBottom(8)) pinned = true; }

onMounted(() => { Object.assign(hooks, { scroll, anchor, restore }); });
</script>

<template>
    <div ref="box" class="ml" @wheel.passive="onWheel" @touchmove.passive="onTouch" @scroll.passive="onScroll">
        <div class="col">
            <WelcomeDeck v-if="!C.messages.length" @fill="v => emit('fill', v)" />
            <template v-for="r in rows" :key="r.m._key">
                <div v-if="r.day" class="day">{{ r.day }}</div>
                <MessageItem :msg="r.m" :time="r.time" data-row @preview="u => emit('preview', u)" />
            </template>
        </div>
    </div>
</template>

<style scoped>
.ml { position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; }
.col { width: min(760px, calc(100% - 48px)); margin: 0 auto; padding: 24px 0 calc(var(--cmp-h, 120px) + 48px); display: flex; flex-direction: column; gap: 22px; }
.day { align-self: center; font: 400 11px/14px var(--font-mono); letter-spacing: .04em; color: var(--ink-4); }
</style>
