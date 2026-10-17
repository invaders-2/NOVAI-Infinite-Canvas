<script setup>
// 下拉选择（代替原生 select）：按钮 + .nv-menu 弹层（外壳给 .nv-menu 自动挂玻璃底和滑块高亮）。
// 弹层 Teleport 到 body 并按按钮位置定位，放在详情面板 / 弹窗这类会裁切的滚动容器里也不会被截断。
import { ref, computed, nextTick, onBeforeUnmount } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';

const props = defineProps({
    modelValue: { type: String, default: '' },
    options: { type: Array, default: () => [] },     // [{ value, label, sep? }]
    placeholder: { type: String, default: '请选择' },
    disabled: { type: Boolean, default: false },
    title: { type: String, default: '' },
    variant: { type: String, default: '' },           // '' | 'solid' | 'block'
});
const emit = defineEmits(['update:modelValue']);
const open = ref(false);
const btn = ref(null);
const pos = ref({});
const current = computed(() => props.options.find(o => o.value === props.modelValue));

function place() {
    const el = btn.value;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const up = below < 260 && r.top > below;
    pos.value = {
        left: Math.min(r.left, window.innerWidth - Math.max(r.width, 200) - 8) + 'px',
        minWidth: Math.max(r.width, 160) + 'px',
        ...(up ? { bottom: window.innerHeight - r.top + 6 + 'px', transformOrigin: 'bottom left' } : { top: r.bottom + 6 + 'px' }),
        maxHeight: Math.max(160, (up ? r.top : below) - 24) + 'px',
    };
}
function onDoc(e) {
    if (btn.value && btn.value.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.am-menu')) return;
    close();
}
function onScroll(e) { if (!(e.target.closest && e.target.closest('.am-menu'))) close(); }
function toggle() {
    if (props.disabled) return;
    if (open.value) { close(); return; }
    place();
    open.value = true;
    nextTick(() => {
        document.addEventListener('pointerdown', onDoc, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', close);
    });
}
function close() {
    open.value = false;
    document.removeEventListener('pointerdown', onDoc, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', close);
}
function pick(o) { emit('update:modelValue', o.value); close(); }
onBeforeUnmount(close);
</script>

<template>
    <button ref="btn" type="button" class="am-sel" :class="[variant, { open }]" :disabled="disabled" :title="title" :aria-expanded="open" @click="toggle">
        <span class="lb" :class="{ ph: !current }">{{ current ? current.label : placeholder }}</span>
        <NvIcon name="chev" class="cv" />
    </button>
    <Teleport to="#nv-layer">
        <Transition name="pop">
            <div v-if="open" class="nv-menu am-menu" role="listbox" :style="pos">
                <template v-for="(o, i) in options" :key="o.value + ':' + i">
                    <div v-if="o.sep" class="nv-menu-sep"></div>
                    <button type="button" class="nv-menu-item" :class="{ 'is-on': o.value === modelValue }" role="option" :aria-selected="o.value === modelValue" @click="pick(o)">
                        <span class="tx">{{ o.label }}</span><NvIcon v-if="o.value === modelValue" name="check" class="tk" />
                    </button>
                </template>
                <div v-if="!options.length" class="am-menu-empty">{{ placeholder }}</div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.am-sel { display: inline-flex; align-items: center; gap: 6px; max-width: 260px; height: 28px; padding: 0 9px 0 10px; border: 0; border-radius: 8px; background: var(--fill-1); color: var(--ink); font: 500 12px/1 var(--font-sans); cursor: pointer; transition: background var(--duration-fast); }
.am-sel:hover, .am-sel.open { background: var(--fill-2); }
.am-sel:disabled { color: var(--ink-4); cursor: default; background: var(--fill-1); }
.am-sel.solid { background: var(--solid); font-weight: 400; }
.am-sel.solid:hover, .am-sel.solid.open { background: var(--solid); box-shadow: var(--shadow-float); }
.am-sel.block { display: flex; width: 100%; max-width: none; height: 32px; background: var(--solid); font-weight: 400; font-size: 12.5px; }
.am-sel.block:hover, .am-sel.block.open { background: var(--solid); box-shadow: var(--shadow-float); }
.lb { flex: 1; min-width: 0; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lb.ph { color: var(--ink-4); }
.cv { width: 12px; height: 12px; color: var(--ink-3); flex: none; transition: transform var(--duration-fast) var(--ease-out); }
.open .cv { transform: rotate(180deg); }
.am-menu { position: fixed; z-index: 2400; overflow-y: auto; max-width: 360px; }
.am-menu .nv-menu-item { height: 30px; gap: 10px; font-size: 12.5px; }
.am-menu .tx { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tk { width: 13px; height: 13px; flex: none; }
.am-menu-empty { padding: 8px 10px; font: 400 12px/16px var(--font-sans); color: var(--ink-3); }
</style>
