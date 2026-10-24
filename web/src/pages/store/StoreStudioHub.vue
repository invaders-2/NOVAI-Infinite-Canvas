<script setup>
// Forge 1.0 hub：粉紫渐变大标题 + ticker + 竖屏参考视频卡；点「改成我的」带着 persona/format 去 Builder。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import { fetchItemDetail } from './storeData.js';

const props = defineProps({
    detail: { type: Object, required: true },
});
const emit = defineEmits(['open-builder']);

const studio = computed(() => props.detail.influencerStudio || {});
const builder = ref(null);
const cardsRef = ref(null);
const hovered = ref(-1);
const pickerOpen = ref(false);
const pickerIndex = ref(-1);
const pickerHovered = ref(-1);
const caption = computed(() => String(props.detail.displayName || 'Forge 1.0'));

const cards = computed(() => {
    const list = (studio.value.heroes || []).slice();
    if (!list.length && studio.value.hero) list.push(studio.value.hero);
    return list;
});
const ticker = computed(() => studio.value.ticker || []);
const tickerLoop = computed(() => ticker.value.concat(ticker.value));

const personas = computed(() => {
    const map = {};
    const list = (builder.value && builder.value.influencerStudio && builder.value.influencerStudio.personas) || [];
    list.forEach(persona => { map[persona.id] = persona; });
    return map;
});
function personaOf(card) { return (card && personas.value[card.persona]) || null; }
function handleOf(card) {
    const persona = personaOf(card);
    return (card && card.handle) || (persona && persona.handle) || (card && card.persona) || '';
}
function nameOf(card) {
    const persona = personaOf(card);
    return (persona && persona.name) || (card && card.persona) || '';
}
function formatOf(card) {
    const persona = personaOf(card);
    if (persona && persona.format) return persona.format;
    return String((card && card.caption) || '').indexOf('POV') >= 0 ? 'pov-skit' : 'day-in-life';
}
function openCard(card, wantsUpload = false) {
    mountHover(-1);
    emit('open-builder', { persona: card.persona, format: formatOf(card), wantsUpload });
}
function pickVideo() {
    pickerIndex.value = -1;
    pickerHovered.value = -1;
    pickerOpen.value = true;
}
function closePicker() {
    pickerOpen.value = false;
    pickerIndex.value = -1;
    pickerHovered.value = -1;
}
function choosePick(card) {
    const index = cards.value.indexOf(card);
    pickerIndex.value = index;
}
function confirmPick() {
    const card = cards.value[pickerIndex.value];
    if (!card) return;
    closePicker();
    emit('open-builder', { persona: card.persona, format: formatOf(card) });
}
function openUploader() {
    emit('open-builder', { wantsUpload: true, highlightUpload: true });
}
function mountHover(index) { hovered.value = index; }
function onKey(event) {
    if (event.key === 'Escape' && pickerOpen.value) { event.stopPropagation(); closePicker(); }
}
onMounted(() => document.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true));

onMounted(async () => {
    const target = studio.value.studio;
    if (!target || !target.name) return;
    try { builder.value = await fetchItemDetail(target.kind || 'skill', target.name); } catch (e) { /* handle 取不到就退回 persona id */ }
});
</script>

<template>
    <div class="hub">
        <header class="hub-head">
            <h1 class="hub-title">{{ caption }}</h1>
            <p class="hub-kicker">FORGE FOR FUN</p>
            <p class="hub-slogan">挑一支视频，换你来演。</p>
            <p class="hub-desc">先选参考视频，再选角色或上传自己的照片，开始制作。</p>
            <div class="hub-actions">
                <button type="button" class="hub-btn light" @click="pickVideo">挑选视频</button>
                <button type="button" class="hub-btn dark" @click="openUploader">用我的照片</button>
            </div>
        </header>

        <div v-if="tickerLoop.length" class="hub-ticker" aria-hidden="true">
            <div class="ticker-track">
                <span v-for="(word, index) in tickerLoop" :key="word + index" class="ticker-word">{{ word }}</span>
            </div>
        </div>

        <div ref="cardsRef" class="hub-cards">
            <article v-for="(card, index) in cards" :key="(card.persona || 'card') + index" class="hub-card"
                     :class="{ 'is-hover': hovered === index }" @mouseenter="mountHover(index)" @mouseleave="mountHover(-1)"
                     @click="openCard(card)">
                <img v-if="card.poster" class="hub-cover" :src="card.poster" :alt="card.caption" loading="lazy" />
                <video v-if="hovered === index && card.video" class="hub-cover" :src="card.video" :poster="card.poster || undefined"
                       muted loop autoplay playsinline preload="metadata"></video>
                <div class="hub-scrim"></div>
                <div class="hub-tabs"><span>关注</span><span class="on">推荐</span></div>
                <p class="hub-caption">{{ card.caption }}</p>
                <div class="hub-icons" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M12 20s-7-4.3-7-9a4.2 4.2 0 0 1 7-3 4.2 4.2 0 0 1 7 3c0 4.7-7 9-7 9z"/></svg>
                    <svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z"/></svg>
                    <svg viewBox="0 0 24 24"><path d="M6 4h12v17l-6-4-6 4z"/></svg>
                    <svg viewBox="0 0 24 24"><path d="m21 3-7 18-3-7-7-3z"/></svg>
                </div>
                <div class="hub-card-foot">
                    <div class="hub-persona">
                        <b>@{{ handleOf(card) }}</b>
                        <span class="hub-ai">AI 生成</span>
                    </div>
                    <div class="hub-sound"><NvIcon name="music" /><span>原声 - {{ handleOf(card) }}</span></div>
                    <span class="hub-name">{{ nameOf(card) }}</span>
                </div>
                <button type="button" class="hub-make" @click.stop="openCard(card)">改成我的</button>
            </article>
        </div>

        <Teleport to="body">
            <div v-if="pickerOpen" class="pick-root" role="dialog" aria-modal="true" aria-label="挑选视频">
                <div class="pick-scrim" @click="closePicker"></div>
                <div class="pick-sheet" @click.stop>
                    <div class="pick-head">
                        <div>
                            <h2>挑选视频</h2>
                            <p>先选一条参考视频，下一步再选角色或上传照片。</p>
                        </div>
                        <button type="button" class="pick-close" aria-label="关闭" @click="closePicker"><NvIcon name="close" /></button>
                    </div>
                    <div class="pick-grid">
                        <button v-for="(card, index) in cards" :key="'pick-' + index" type="button" class="pick-card"
                                :class="{ 'is-picked': pickerIndex === index, 'is-hover': pickerHovered === index }"
                                @mouseenter="pickerHovered = index" @mouseleave="pickerHovered = -1" @click="choosePick(card)">
                            <img v-if="card.poster" class="pick-cover" :src="card.poster" :alt="card.caption" loading="lazy" />
                            <video v-if="pickerHovered === index && card.video" class="pick-cover" :src="card.video" :poster="card.poster || undefined" muted loop autoplay playsinline preload="metadata"></video>
                            <span class="pick-tint"></span>
                            <span v-if="pickerIndex === index" class="pick-check"><NvIcon name="check" /></span>
                            <span class="pick-caption">{{ card.caption }}</span>
                            <span class="pick-handle">@{{ handleOf(card) }}</span>
                        </button>
                    </div>
                    <div class="pick-foot">
                        <span class="pick-count">{{ pickerIndex >= 0 ? '已选 1 条' : '先选一条，再点下一步' }}</span>
                        <button type="button" class="pick-cancel" @click="closePicker">取消</button>
                        <button type="button" class="pick-next" :disabled="pickerIndex < 0" @click="confirmPick">下一步</button>
                    </div>
                </div>
            </div>
        </Teleport>
    </div>
</template>

<style scoped>
.hub { color: var(--ink); padding: var(--space-2) var(--space-2) var(--space-8); max-width: 1320px; margin: 0 auto; }
.hub-head { position: relative; padding: var(--space-3) var(--space-2) 0; }
.hub-title {
    margin: 0; width: fit-content;
    font: 500 clamp(30px, 3.6vw, 42px)/1.12 var(--font-sans); letter-spacing: -0.03em;
    background: linear-gradient(100deg, var(--ink) 0%, var(--ink-3) 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
}
.hub-kicker { margin: var(--space-5) 0 0; color: var(--ink-3); font: 500 11px/16px var(--font-mono); letter-spacing: .22em; text-transform: uppercase; }
.hub-slogan { margin: var(--space-6) 0 0; color: var(--ink); font: 500 clamp(18px, 2vw, 24px)/1.3 var(--font-sans); letter-spacing: -0.02em; }
.hub-desc { margin: var(--space-3) 0 0; max-width: 620px; color: var(--ink-3); font: 400 13px/20px var(--font-sans); }
.hub-actions { position: absolute; right: var(--space-2); bottom: 0; display: flex; gap: var(--space-4); }
.hub-btn { border: 0; height: var(--control-lg); padding: 0 18px; border-radius: var(--radius-pill); font: 500 12.5px/1 var(--font-sans); cursor: pointer; transition: background var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out), transform var(--duration-base) var(--ease-out); }
.hub-btn:hover { transform: translateY(-1px); }
.hub-btn.light { background: var(--accent); color: var(--on-accent); }
.hub-btn.light:hover { box-shadow: var(--shadow-lift); }
.hub-btn.dark { background: var(--fill-1); color: var(--ink); }
.hub-btn.dark:hover { background: var(--fill-2); }
.hub-ticker { overflow: hidden; margin: var(--space-6) 0 var(--space-5); padding: var(--space-1) 0; mask-image: linear-gradient(to right, transparent, var(--ink) 4%, var(--ink) 96%, transparent); -webkit-mask-image: linear-gradient(to right, transparent, var(--ink) 4%, var(--ink) 96%, transparent); }
.ticker-track { display: inline-flex; gap: var(--space-7); white-space: nowrap; animation: ticker 34s linear infinite; }
.hub-ticker:hover .ticker-track { animation-play-state: paused; }
.ticker-word { color: var(--ink-3); font: 500 11px/16px var(--font-sans); letter-spacing: .04em; }
.ticker-word::after { content: ""; display: inline-block; width: 4px; height: 4px; margin-left: var(--space-7); border-radius: 50%; background: var(--ink-4); vertical-align: middle; }
@keyframes ticker { from { transform: translateX(0); } to { transform: translateX(-50%); } }
.hub-cards { display: flex; gap: var(--space-5); overflow-x: auto; padding: var(--space-1) var(--space-1) var(--space-6); scroll-snap-type: x proximity; scrollbar-width: thin; }
.hub-card { position: relative; flex: 0 0 236px; height: 512px; border-radius: var(--radius-xl); overflow: hidden; background: var(--ink); cursor: pointer; scroll-snap-align: start; animation: card-in 480ms var(--ease-out) both; transition: transform var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out); box-shadow: var(--shadow-float); }
.hub-card.is-hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
.hub-cover { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
.hub-scrim { position: absolute; inset: 0; pointer-events: none; background: linear-gradient(to bottom, color-mix(in srgb, var(--ink) 52%, transparent), transparent 32%, color-mix(in srgb, var(--ink) 8%, transparent) 62%, color-mix(in srgb, var(--ink) 82%, transparent)); }
.hub-tabs { position: absolute; left: 0; right: 0; top: var(--space-5); display: flex; justify-content: center; gap: var(--space-5); color: color-mix(in srgb, var(--on-accent) 62%, transparent); font: 500 10.5px/14px var(--font-sans); }
.hub-tabs .on { color: var(--on-accent); }
.hub-caption { position: absolute; left: var(--space-6); right: var(--space-6); top: 52px; margin: 0; white-space: pre-line; text-align: center; color: var(--on-accent); font: 500 19px/1.3 var(--font-sans); letter-spacing: -0.01em; text-shadow: 0 2px 16px color-mix(in srgb, var(--ink) 35%, transparent); }
.hub-icons { position: absolute; right: var(--space-5); top: 45%; display: flex; flex-direction: column; gap: var(--space-6); color: var(--on-accent); }
.hub-icons svg { width: 23px; height: 23px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; filter: drop-shadow(0 2px 8px color-mix(in srgb, var(--ink) 35%, transparent)); }
.hub-card-foot { position: absolute; left: var(--space-6); right: var(--space-6); bottom: var(--space-5); display: flex; flex-direction: column; gap: var(--space-2); }
.hub-persona { display: flex; align-items: center; gap: var(--space-4); min-width: 0; }
.hub-persona b { color: var(--on-accent); font: 500 12px/16px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hub-ai { flex: none; padding: 2px 5px; border-radius: var(--radius-xs); background: color-mix(in srgb, var(--ink) 16%, transparent); color: var(--on-accent); font: 500 8.5px/1 var(--font-sans); letter-spacing: .02em; }
.hub-sound { display: flex; align-items: center; gap: var(--space-2); color: color-mix(in srgb, var(--on-accent) 82%, transparent); font: 400 10.5px/14px var(--font-sans); }
.hub-sound .nv-i { width: 12px; height: 12px; }
.hub-name { display: none; }
.hub-make { position: absolute; right: var(--space-5); bottom: var(--space-5); border: 0; height: var(--control-sm); padding: 0 13px; border-radius: var(--radius-pill); background: var(--solid); color: var(--ink); font: 500 11.5px/1 var(--font-sans); cursor: pointer; opacity: 0; transform: translateY(6px); transition: opacity var(--duration-base) var(--ease-out), transform var(--duration-base) var(--ease-out); box-shadow: var(--shadow-pop); }
.hub-card:hover .hub-make, .hub-card.is-hover .hub-make { opacity: 1; transform: translateY(0); }
.hub-card:hover .hub-card-foot { opacity: .4; }
@keyframes card-in { from { opacity: 0; transform: translateY(8px); filter: blur(3px); } }
.pick-root { position: fixed; inset: 0; z-index: var(--z-dialog); display: flex; align-items: center; justify-content: center; padding: var(--space-7); }
.pick-scrim { position: absolute; inset: 0; background: var(--scrim); backdrop-filter: var(--material-regular); -webkit-backdrop-filter: var(--material-regular); animation: nv-fade var(--duration-slow) var(--ease-out) both; }
.pick-sheet { position: relative; width: min(1120px, calc(100vw - 60px)); max-height: min(820px, calc(100vh - 60px)); display: flex; flex-direction: column; padding: var(--space-7); border-radius: var(--radius-2xl); background: var(--glass-strong); backdrop-filter: var(--material-thick); -webkit-backdrop-filter: var(--material-thick); box-shadow: var(--shadow-dialog); color: var(--ink); animation: nv-dialog-in var(--duration-slow) var(--ease-sheet) both; }
.pick-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-6); padding: 0 var(--space-1) var(--space-5); }
.pick-head h2 { margin: 0; font: 500 20px/28px var(--font-sans); letter-spacing: -0.015em; }
.pick-head p { margin: var(--space-2) 0 0; color: var(--ink-3); font: 400 11.5px/17px var(--font-sans); }
.pick-close { width: var(--control-md); height: var(--control-md); border: 0; border-radius: 50%; background: var(--fill-1); color: var(--ink-2); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: background var(--duration-base) var(--ease-out), color var(--duration-base) var(--ease-out); }
.pick-close:hover { background: var(--fill-2); color: var(--ink); }
.pick-close .nv-i { width: 13px; height: 13px; }
.pick-grid { flex: 1; min-height: 0; overflow-y: auto; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: var(--space-5); padding: var(--space-1) var(--space-1) var(--space-5); scrollbar-width: thin; }
.pick-card { position: relative; border: 0; padding: 0; width: 100%; aspect-ratio: 9 / 15; border-radius: var(--radius-lg); overflow: hidden; background: var(--solid); color: var(--on-accent); cursor: pointer; box-shadow: var(--shadow-pop); animation: card-in 480ms var(--ease-out) both; transition: transform var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out); }
.pick-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
.pick-card.is-picked { box-shadow: inset 0 0 0 2px var(--accent), var(--shadow-lift); }
.pick-cover { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
.pick-tint { position: absolute; inset: 0; pointer-events: none; background: linear-gradient(to bottom, color-mix(in srgb, var(--ink) 32%, transparent), transparent 45%, color-mix(in srgb, var(--ink) 76%, transparent)); }
.pick-card.is-picked .pick-tint { background: linear-gradient(to bottom, color-mix(in srgb, var(--accent) 22%, transparent), color-mix(in srgb, var(--accent) 8%, transparent) 48%, color-mix(in srgb, var(--ink) 76%, transparent)); }
.pick-caption { position: absolute; left: var(--space-4); right: var(--space-4); top: 50%; transform: translateY(-50%); white-space: pre-line; text-align: center; color: var(--on-accent); font: 500 14px/1.32 var(--font-sans); text-shadow: 0 2px 12px color-mix(in srgb, var(--ink) 35%, transparent); }
.pick-handle { position: absolute; left: var(--space-4); bottom: var(--space-3); color: color-mix(in srgb, var(--on-accent) 82%, transparent); font: 500 9.5px/13px var(--font-sans); }
.pick-check { position: absolute; right: var(--space-3); top: var(--space-3); width: 22px; height: 22px; border-radius: 50%; background: var(--accent); color: var(--on-accent); display: inline-flex; align-items: center; justify-content: center; box-shadow: var(--shadow-float); }
.pick-check .nv-i { width: 12px; height: 12px; }
.pick-foot { display: flex; align-items: center; gap: var(--space-4); padding: var(--space-5) var(--space-1) 0; }
.pick-count { flex: 1; color: var(--ink-3); font: 400 11px/16px var(--font-sans); }
.pick-cancel, .pick-next { border: 0; height: var(--control-md); padding: 0 18px; border-radius: var(--radius-pill); font: 500 12px/1 var(--font-sans); cursor: pointer; transition: background var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out); }
.pick-cancel { background: var(--fill-1); color: var(--ink-2); }
.pick-cancel:hover { background: var(--fill-2); color: var(--ink); }
.pick-next { background: var(--accent); color: var(--on-accent); }
.pick-next:hover { box-shadow: var(--shadow-lift); }
.pick-next:disabled { background: var(--fill-2); color: var(--ink-4); cursor: default; box-shadow: none; }
@media (max-width: 900px) {
    .hub-actions { position: static; margin-top: var(--space-6); }
    .hub-card { flex-basis: 210px; height: 450px; }
    .hub-caption { font-size: 17px; }
    .pick-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
