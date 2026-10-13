<script setup>
// 下拉选择：按钮 + nv-menu（挂到 body，fixed 定位，避免被弹窗 / 滚动容器裁掉）
// options: ['a', 'b'] 或 [{ value, label }]
import { ref, computed, nextTick, onBeforeUnmount } from 'vue';
import NvIcon from '../../../../components/NvIcon.vue';

const props = defineProps({
    modelValue: [String, Number],
    options: { type: Array, default: () => [] },
    label: String,
    placeholder: { type: String, default: '' },
    disabled: Boolean,
    size: { type: String, default: 'md' },   // md 32px / sm 26px
    mono: Boolean,
});
const emit = defineEmits(['update:modelValue']);
defineOptions({ inheritAttrs: false });
const opts = computed(() => props.options.map(o => (o && typeof o === 'object' ? o : { value: o, label: String(o) })));
const current = computed(() => opts.value.find(o => String(o.value) === String(props.modelValue)));
const open = ref(false);
const btn = ref(null);
const menu = ref(null);
const pos = ref({ left: 0, top: 0, width: 0 });

function place() {
    const r = btn.value && btn.value.getBoundingClientRect();
    if (!r) return;
    const h = Math.min(280, opts.value.length * 31 + 8);
    const below = innerHeight - r.bottom - 8;
    const top = below >= h || below >= r.top ? r.bottom + 4 : Math.max(8, r.top - 4 - h);
    pos.value = { left: Math.min(r.left, innerWidth - Math.max(r.width, 160) - 8), top, width: r.width };
}
function onDoc(e) {
    if (btn.value && btn.value.contains(e.target)) return;
    if (menu.value && menu.value.contains(e.target)) return;
    close();
}
function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
function onScroll(e) { if (menu.value && menu.value.contains(e.target)) return; close(); }
function toggle() {
    if (props.disabled) return;
    if (open.value) { close(); return; }
    place();
    open.value = true;
    document.addEventListener('mousedown', onDoc, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    nextTick(() => {
        const on = menu.value && menu.value.querySelector('.is-on');
        if (on) on.scrollIntoView({ block: 'nearest' });
    });
}
function close() {
    open.value = false;
    document.removeEventListener('mousedown', onDoc, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', close);
}
function pick(o) { emit('update:modelValue', o.value); close(); }
onBeforeUnmount(close);
</script>

<template>
    <button ref="btn" v-bind="$attrs" type="button" class="ks" :class="[size, { open, mono }]" :disabled="disabled" :aria-label="label" aria-haspopup="listbox" :aria-expanded="open" @click="toggle">
        <span class="ks-v" :class="{ ph: !current }">{{ current ? current.label : (placeholder || modelValue || '') }}</span>
        <NvIcon name="chev" class="ks-c" />
    </button>
    <Teleport to="#nv-layer">
        <Transition name="ksm">
            <div v-if="open" ref="menu" class="nv-menu ks-menu" role="listbox" :style="{ left: pos.left + 'px', top: pos.top + 'px', minWidth: Math.max(pos.width, 140) + 'px' }">
                <button v-for="o in opts" :key="o.value" type="button" role="option" class="nv-menu-item" :class="{ 'is-on': String(o.value) === String(modelValue), mono }" :aria-selected="String(o.value) === String(modelValue)" @click="pick(o)">
                    <span class="ks-l">{{ o.label }}</span>
                    <NvIcon v-if="String(o.value) === String(modelValue)" name="check" class="ks-ck" />
                </button>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.ks { display: inline-flex; align-items: center; gap: 6px; min-width: 0; height: 32px; padding: 0 10px 0 12px; border: 0; border-radius: var(--radius-md); background: var(--fill-1); color: var(--ink); font: 400 13px/1 var(--font-sans); cursor: pointer; text-align: left; transition: background var(--duration-fast) var(--ease-out); }
.ks:hover, .ks.open { background: var(--fill-2); }
.ks:disabled { color: var(--ink-4); cursor: default; background: var(--fill-1); }
.ks.sm { height: 26px; padding: 0 8px; border-radius: 7px; font-size: 11.5px; }
.ks.mono .ks-v { font-family: var(--font-mono); }
.ks-v { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ks-v.ph { color: var(--ink-4); }
.ks-c { width: 12px; height: 12px; color: var(--ink-3); transition: transform var(--duration-fast) var(--ease-out); }
.ks.open .ks-c { transform: rotate(180deg); }
</style>
<style>
.ks-menu { position: fixed; z-index: 2400; max-height: 280px; overflow-y: auto; font-family: var(--font-sans); }
.ks-menu .nv-menu-item { flex: none; gap: 8px; font-size: 12.5px; }
.ks-menu .nv-menu-item.mono .ks-l { font-family: var(--font-mono); font-size: 12px; }
.ks-menu .ks-l { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ks-menu .ks-ck { width: 13px; height: 13px; color: var(--ink); }
.ksm-enter-active { transition: opacity 140ms var(--ease-out), transform 140ms var(--ease-out); }
.ksm-leave-active { transition: opacity 100ms var(--ease-out); }
.ksm-enter-from { opacity: 0; transform: translateY(-4px); }
.ksm-leave-to { opacity: 0; }
</style>
