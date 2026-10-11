<script setup>
// 设置栏下拉（替换旧 online.html 的「自定义下拉浮层」enhanceSelect）：
//   触发器 + .nv-menu 弹层（Teleport 到 body、固定定位，空间不足向上展开，避免被左栏滚动容器裁切）；
//   支持：前缀标签（质量 / 数量）、比例形状小图标、右侧附注（平台协议）、置灰项、分隔线（自定义项放最后）。
import { ref, computed, onBeforeUnmount, nextTick } from 'vue';
import NvIcon from '../../components/NvIcon.vue';

const props = defineProps({
    modelValue: { type: [String, Number], default: '' },
    options: { type: Array, default: () => [] },     // [{ value, label, disabled?, shape?: {w,h,dashed}, tag?, sep? }]
    disabled: Boolean,
    prefix: { type: String, default: '' },
    placeholder: { type: String, default: '' },
    label: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue']);
const open = ref(false);
const trig = ref(null);
const menu = ref(null);
const pos = ref({ left: 0, top: 0, width: 0, maxH: 300, up: false });
const current = computed(() => props.options.find(o => String(o.value) === String(props.modelValue)));
const text = computed(() => (current.value ? current.value.label : props.placeholder));

function place() {
    const r = trig.value.getBoundingClientRect();
    const h = Math.min(300, props.options.reduce((n, o) => n + (o.sep ? 9 : 0) + 31, 10));
    const below = innerHeight - r.bottom - 12, above = r.top - 12;
    const up = h > below && above > below;
    const maxH = Math.max(80, Math.min(300, up ? above : below));
    const width = Math.max(r.width, 154);
    pos.value = { left: Math.max(8, Math.min(r.left, innerWidth - width - 8)), top: up ? r.top - 4 - Math.min(h, maxH) : r.bottom + 4, width, maxH, up };
}
function onDoc(e) { if (!(trig.value && trig.value.contains(e.target)) && !(menu.value && menu.value.contains(e.target))) close(); }
function onScroll(e) { if (menu.value && menu.value.contains(e.target)) return; close(); }
function onKey(e) { if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); close(); } }
function bind(on) {
    const m = on ? 'addEventListener' : 'removeEventListener';
    document[m]('mousedown', onDoc, true);
    window[m]('scroll', onScroll, true);
    window[m]('resize', close);
    window[m]('keydown', onKey, true);
}
function toggle() {
    if (props.disabled) return;
    if (open.value) { close(); return; }
    place();
    open.value = true;
    bind(true);
    nextTick(() => { const el = menu.value && menu.value.querySelector('.is-on'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); });
}
function close() { if (!open.value) return; open.value = false; bind(false); }
function pick(o) { if (o.disabled) return; emit('update:modelValue', o.value); close(); }
function shapeStyle(s) { return { width: s.w + 'px', height: s.h + 'px', borderStyle: s.dashed ? 'dashed' : 'solid' }; }
onBeforeUnmount(() => bind(false));
</script>

<template>
    <button ref="trig" type="button" class="osel" :class="{ open, ph: !current }" :disabled="disabled" :aria-label="label || prefix" aria-haspopup="listbox" :aria-expanded="open" @click.stop="toggle">
        <span class="tx">
            <span v-if="prefix" class="pre">{{ prefix }}</span>
            <span v-if="current && current.shape" class="shape" :style="shapeStyle(current.shape)"></span>
            <span class="v">{{ text }}</span>
        </span>
        <NvIcon name="chev" class="cv" />
    </button>
    <Teleport to="#nv-layer">
        <Transition name="pop">
            <div v-if="open" ref="menu" class="nv-menu osel-menu" :class="{ up: pos.up }" role="listbox"
                :style="{ left: pos.left + 'px', top: pos.top + 'px', minWidth: pos.width + 'px', maxHeight: pos.maxH + 'px' }">
                <template v-for="o in options" :key="String(o.value)">
                    <div v-if="o.sep" class="osel-sep"></div>
                    <button type="button" role="option" class="nv-menu-item" :class="{ 'is-on': String(o.value) === String(modelValue), dis: o.disabled }"
                        :aria-selected="String(o.value) === String(modelValue)" :aria-disabled="o.disabled || undefined" @click="pick(o)">
                        <span v-if="o.shape" class="shape" :style="shapeStyle(o.shape)"></span>
                        <span class="lb">{{ o.label }}</span>
                        <span v-if="o.tag" class="tg">{{ o.tag }}</span>
                        <NvIcon v-else-if="String(o.value) === String(modelValue)" name="check" class="ck" />
                    </button>
                </template>
                <div v-if="!options.length" class="osel-empty">{{ placeholder || '无选项' }}</div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.osel { display: flex; align-items: center; justify-content: space-between; gap: 6px; width: 100%; min-width: 0; height: 34px; padding: 0 10px 0 12px; border: 0; border-radius: 10px; background: var(--fill-1); color: var(--ink); font: 500 12px/1 var(--font-sans); cursor: pointer; transition: background var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out); }
.osel:hover:not(:disabled) { background: var(--fill-2); }
.osel.open { background: var(--solid); box-shadow: var(--shadow-float); }
.osel:disabled { opacity: .55; cursor: not-allowed; }
.osel.ph .v { color: var(--ink-4); }
.osel .tx { display: flex; align-items: center; gap: 6px; min-width: 0; }
.osel .pre { color: var(--ink-3); font-weight: 400; flex: none; }
.osel .v { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.osel .cv { width: 12px; height: 12px; opacity: .55; flex: none; transition: transform var(--duration-fast) var(--ease-out); }
.osel.open .cv { transform: rotate(180deg); }
.shape { flex: none; box-sizing: border-box; border: 1.3px solid currentColor; border-radius: 2px; opacity: .8; }
</style>
<style>
.osel-menu { position: fixed; z-index: 2350; overflow-y: auto; }
.osel-menu .nv-menu-item { height: 30px; flex: none; gap: 8px; font-size: 12px; color: var(--ink-2); }
.osel-menu .nv-menu-item.is-on { color: var(--ink); font-weight: 500; }
.osel-menu .nv-menu-item.dis { color: var(--ink-4); cursor: not-allowed; }
.osel-menu .nv-menu-item .lb { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.osel-menu .nv-menu-item .tg { margin-left: 12px; font: 400 10.5px/1 var(--font-mono); color: var(--ink-3); flex: none; }
.osel-menu .nv-menu-item .ck { width: 13px; height: 13px; color: var(--ink); flex: none; }
.osel-menu .nv-menu-item .shape { box-sizing: border-box; border: 1.3px solid currentColor; border-radius: 2px; flex: none; opacity: .75; }
.osel-menu .osel-sep { height: 1px; margin: 3px 8px; background: var(--separator); flex: none; }
.osel-menu .osel-empty { padding: 8px 10px; font: 400 12px/16px var(--font-sans); color: var(--ink-4); }
.pop-enter-from.osel-menu.up, .pop-leave-to.osel-menu.up { transform: translateY(4px) !important; }
</style>
