<script setup>
// 下拉选择：触发器 + nv-menu 弹层（Teleport 到 body，固定定位，避免被节点弹层 / 滚动容器裁切）
import { ref, computed, onBeforeUnmount, nextTick } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';

const props = defineProps({
    modelValue: { type: [String, Number, Boolean], default: '' },
    options: { type: Array, default: () => [] },     // [{ value, label }]
    disabled: Boolean,
    placeholder: { type: String, default: '' },
    size: { type: String, default: 'md' },             // md | sm
    label: String,
});
const emit = defineEmits(['update:modelValue']);
const open = ref(false);
const trig = ref(null);
const menu = ref(null);
const pos = ref({ left: 0, top: 0, width: 0, up: false });
const current = computed(() => props.options.find(o => String(o.value) === String(props.modelValue)));
const text = computed(() => (current.value ? current.value.label : (props.modelValue !== '' && props.modelValue != null ? String(props.modelValue) : props.placeholder)));

function place() {
    const r = trig.value.getBoundingClientRect();
    const h = Math.min(260, props.options.length * 31 + 10);
    const up = r.bottom + 4 + h > innerHeight - 8 && r.top - 4 - h > 8;
    pos.value = { left: Math.min(r.left, innerWidth - Math.max(r.width, 140) - 8), top: up ? r.top - 4 - h : r.bottom + 4, width: r.width, up };
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
    nextTick(() => { const el = menu.value && menu.value.querySelector('.is-on'); if (el) el.scrollIntoView({ block: 'nearest' }); });
}
function close() { if (!open.value) return; open.value = false; bind(false); }
function pick(o) { emit('update:modelValue', o.value); close(); }
onBeforeUnmount(() => bind(false));
</script>

<template>
    <button ref="trig" type="button" class="wsel" :class="[size, { open, ph: !current && (modelValue === '' || modelValue == null) }]" :disabled="disabled" :aria-label="label" aria-haspopup="listbox" :aria-expanded="open" @click.stop="toggle">
        <span class="tx">{{ text }}</span><NvIcon name="chev" />
    </button>
    <Teleport to="#nv-layer">
        <Transition name="wsel-m">
            <div v-if="open" ref="menu" class="nv-menu wsel-menu" :class="{ up: pos.up }" role="listbox" :style="{ left: pos.left + 'px', top: pos.top + 'px', minWidth: Math.max(pos.width, 120) + 'px' }">
                <button v-for="o in options" :key="String(o.value)" type="button" role="option" class="nv-menu-item" :class="{ 'is-on': String(o.value) === String(modelValue) }" :aria-selected="String(o.value) === String(modelValue)" @click="pick(o)">
                    <span class="lb">{{ o.label }}</span><NvIcon v-if="String(o.value) === String(modelValue)" name="check" class="ck" />
                </button>
                <div v-if="!options.length" class="empty">{{ placeholder || '无选项' }}</div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.wsel { display: inline-flex; align-items: center; justify-content: space-between; gap: 6px; width: 100%; min-width: 0; height: 32px; padding: 0 10px; border: 0; border-radius: var(--radius-md); background: var(--solid); color: var(--ink); font: 400 12.5px/1 var(--font-sans); cursor: pointer; transition: background var(--duration-fast) var(--ease-out); }
.wsel.sm { height: 26px; padding: 0 8px; font-size: 11.5px; border-radius: 7px; }
.wsel:hover:not(:disabled) { background: var(--fill-2); }
.wsel.open { background: var(--fill-2); }
.wsel:disabled { background: var(--fill-1); color: var(--ink-4); cursor: default; }
.wsel.ph .tx { color: var(--ink-4); }
.wsel .tx { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.wsel .nv-i { width: 12px; height: 12px; opacity: .6; transition: transform var(--duration-fast) var(--ease-out); }
.wsel.open .nv-i { transform: rotate(180deg); }
</style>
<style>
.wsel-menu { position: fixed; z-index: 2600; max-height: 260px; overflow-y: auto; min-width: 120px; }
.wsel-menu .nv-menu-item { height: 30px; font-size: 12.5px; flex: none; }
.wsel-menu .nv-menu-item .lb { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsel-menu .nv-menu-item .ck { width: 13px; height: 13px; color: var(--ink); }
.wsel-menu .empty { padding: 8px 10px; font: 400 12px/16px var(--font-sans); color: var(--ink-4); }
.wsel-m-enter-active { transition: opacity 140ms var(--ease-out), transform 140ms var(--ease-out); }
.wsel-m-leave-active { transition: opacity 100ms linear; }
.wsel-m-enter-from { opacity: 0; transform: translateY(-4px); }
.wsel-m-enter-from.up { transform: translateY(4px); }
.wsel-m-leave-to { opacity: 0; }
</style>
