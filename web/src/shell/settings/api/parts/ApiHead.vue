<script setup>
// 页头：面包屑 / 标题 + 平台切换下拉 / 地址行 / 右侧操作。三个视图（平台、推荐 API、输出目录）共用
import { ref, inject, onMounted, onBeforeUnmount } from 'vue';
import AIcon from './AIcon.vue';
import PlatformSwitcher from './PlatformSwitcher.vue';

defineProps({ crumb: String, title: String, url: String, urlEmpty: Boolean });
const store = inject('apiStore');
const S = store.S;
const root = ref(null);

function toggle() { S.switcherOpen = !S.switcherOpen; }
function onDown(e) {
    if (!S.switcherOpen || !root.value) return;
    if (root.value.querySelector('.pop') && root.value.querySelector('.pop').contains(e.target)) return;
    if (e.target.closest && e.target.closest('.sw-btn')) return;
    S.switcherOpen = false;
}
function onKey(e) { if (e.key === 'Escape' && S.switcherOpen) { e.stopPropagation(); S.switcherOpen = false; } }
function onResize() { S.switcherOpen = false; }
onMounted(() => { document.addEventListener('mousedown', onDown, true); window.addEventListener('keydown', onKey, true); window.addEventListener('resize', onResize); });
onBeforeUnmount(() => { document.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', onResize); });
</script>

<template>
    <header ref="root" class="hd" :class="{ stuck: S.stuck }">
        <div class="main">
            <div class="crumb">{{ crumb }}</div>
            <div class="ttl">
                <b>{{ title }}</b>
                <button type="button" class="sw-btn" :class="{ on: S.switcherOpen }" title="切换平台" aria-haspopup="true" :aria-expanded="S.switcherOpen" @click="toggle"><AIcon name="chev" /></button>
                <slot name="badges" />
                <Transition name="pop">
                    <div v-if="S.switcherOpen" class="pop"><PlatformSwitcher @close="S.switcherOpen = false" /></div>
                </Transition>
            </div>
            <div v-if="url" class="url" :class="{ empty: urlEmpty }">{{ url }}</div>
        </div>
        <div class="acts"><slot name="actions" /></div>
    </header>
</template>

<style scoped>
.hd { position: sticky; top: 0; z-index: 30; display: flex; align-items: flex-start; gap: 16px; margin: 0 -4px; padding: 26px 24px 14px 4px; background: var(--solid); }
/* 滚动后吸顶：同色实底，下沿一段渐隐，不画分隔线 */
.hd::after { content: ""; position: absolute; left: 0; right: 0; top: 100%; height: 18px; background: linear-gradient(to bottom, var(--solid), transparent); pointer-events: none; opacity: 0; transition: opacity 160ms; }
.hd.stuck::after { opacity: 1; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.crumb { font: 400 11px/14px var(--font-mono); letter-spacing: .04em; color: var(--ink-3); text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ttl { position: relative; display: flex; align-items: center; gap: 8px; min-width: 0; }
.ttl b { font: 500 16px/26px var(--font-sans); letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.sw-btn { width: 26px; height: 26px; border: 0; padding: 0; border-radius: 8px; background: var(--fill-1); color: var(--ink-2); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; flex: none; transition: background 120ms; }
.sw-btn:hover { background: var(--fill-2); }
.sw-btn.on { background: var(--fill-3); color: var(--ink); }
.sw-btn .nv-i { width: 14px; height: 14px; transition: transform 200ms var(--ease-out); }
.sw-btn.on .nv-i { transform: rotate(180deg); }
.url { font: 400 11.5px/16px var(--font-mono); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.url.empty { color: var(--ink-4); }
.acts { display: flex; align-items: center; gap: 6px; flex: none; padding-top: 14px; }
.pop { position: absolute; left: -12px; top: calc(100% + 10px); z-index: 40; }
.pop-enter-active { transition: opacity 140ms var(--ease-out), transform 140ms var(--ease-out); }
.pop-leave-active { transition: opacity 100ms linear, transform 100ms linear; }
.pop-enter-from { opacity: 0; transform: translateY(-4px); }
.pop-leave-to { opacity: 0; transform: translateY(-2px); }
</style>
