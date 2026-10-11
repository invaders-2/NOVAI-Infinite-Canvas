<script setup>
// 平台 / 模型选择：单栏平台列表，悬停或点击某个平台 → 右侧飞出它的模型子菜单（旧 modelPicker + modelSubmenu）。
// Agent 模式下顶部多一个「对话 / 图像」切换，分别选两套平台与模型。
import { ref, computed, nextTick } from 'vue';
import ChIcon from './ChIcon.vue';
import { S, pickerKind, providersOf, currentProviderId, currentModel, providerName, shortModelName, modelsOf, setProvider, setActiveModel, setModelPickerScope } from './chatState.js';
import { usePop, placeBeside, POP_Z } from './usePop.js';

const btn = ref(null);
const pop = ref(null);
const sub = ref(null);
const hoverPid = ref('');
let closeTimer = 0;

const { open, toggle, place } = usePop('model', btn, pop, {
    place: { align: 'left', maxH: 340 },
    extra: () => [sub.value],
    onClose: () => { hoverPid.value = ''; },
});

const kind = computed(() => pickerKind.value);
const providers = computed(() => providersOf(kind.value));
const pid = computed(() => currentProviderId(kind.value));
const model = computed(() => currentModel(kind.value));
const label = computed(() => providerName(pid.value, kind.value));
const subModels = computed(() => (hoverPid.value ? modelsOf(hoverPid.value, kind.value) : []));

function openPicker() {
    if (!open.value) {
        if (S.mode === 'image') S.modelPickerScope = 'image';
        if (S.mode === 'chat') S.modelPickerScope = 'chat';
    }
    toggle();
}
function cancelClose() { clearTimeout(closeTimer); }
function scheduleClose() { cancelClose(); closeTimer = setTimeout(() => { hoverPid.value = ''; }, 180); }
// 已经展开某个平台的子菜单时，鼠标斜着移向子菜单难免擦过别的平台行：
// 悬停切换延迟 140ms，期间鼠标进了子菜单就取消（同 macOS 菜单的做法），避免子菜单被「换掉 / 消失」。点击立即切换。
// 再加「安全三角」：鼠标正朝子菜单方向移动时不切换，停下来或明显偏离方向才切。
let switchTimer = 0;
let pending = null;
let prevPt = null;
let curPt = null;
function showFor(id, row) {
    clearTimeout(switchTimer);
    pending = null;
    cancelClose();
    hoverPid.value = id;
    nextTick(() => placeBeside(row, pop.value, sub.value));
}
function aiming() {
    const el = sub.value;
    if (!el || !prevPt || !curPt) return false;
    const r = el.getBoundingClientRect();
    const right = r.left >= curPt.x - 2;
    const ex = right ? r.left : r.right;
    const a = { x: ex, y: r.top - 24 }, b = { x: ex, y: r.bottom + 24 };
    const s = (p1, p2, p3) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
    const d1 = s(curPt, prevPt, a), d2 = s(curPt, a, b), d3 = s(curPt, b, prevPt);
    const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
}
function arm() {
    clearTimeout(switchTimer);
    switchTimer = setTimeout(() => { if (pending) showFor(pending.id, pending.row); }, 160);
}
function track(ev) {
    const p = { x: ev.clientX, y: ev.clientY };
    if (!curPt || Math.hypot(p.x - curPt.x, p.y - curPt.y) >= 3) { prevPt = curPt; curPt = p; }
    if (!pending) return;
    if (aiming()) arm();
    else showFor(pending.id, pending.row);
}
function hover(id, ev, immediate) {
    const row = ev && ev.currentTarget;
    clearTimeout(switchTimer);
    if (immediate || !hoverPid.value || hoverPid.value === id) { showFor(id, row); return; }
    pending = { id, row };
    if (aiming()) arm();
    else showFor(id, row);
}
function enterSub() { clearTimeout(switchTimer); pending = null; cancelClose(); }
function pick(m) {
    setProvider(hoverPid.value, kind.value);
    setActiveModel(m, kind.value);
    toggle(false);
}
function scope(k) { hoverPid.value = ''; setModelPickerScope(k); nextTick(place); }
</script>

<template>
    <button ref="btn" type="button" class="ca-pk" :class="{ on: open }" title="选择平台和模型" @click="openPicker">
        <ChIcon name="cube" />
        <span class="k">{{ label }}</span><span class="d"></span>
        <span class="mm">{{ model ? shortModelName(model) : '未配置' }}</span>
        <ChIcon name="chev" class="cv" :class="{ flip: open }" />
    </button>
    <Teleport to="#nv-layer">
        <Transition name="pop">
            <div v-if="open" ref="pop" class="nv-menu mp-pop" :style="{ zIndex: POP_Z }" @mousemove="track">
                <div class="mp-hd">
                    <span class="t">选择模型</span>
                    <span v-if="S.mode === 'agent'" class="mp-seg">
                        <button type="button" :class="{ 'is-on': kind === 'chat' }" @click="scope('chat')">对话</button>
                        <button type="button" :class="{ 'is-on': kind === 'image' }" @click="scope('image')">图像</button>
                    </span>
                </div>
                <div v-if="!providers.length" class="mp-empty">未配置任何平台 · 去「API 设置」添加并填写 Key</div>
                <button v-for="p in providers" :key="p.id" type="button" class="nv-menu-item mp-row"
                    :class="{ 'is-on': p.id === pid, hovered: p.id === hoverPid }"
                    @mouseenter="hover(p.id, $event)" @click="hover(p.id, $event, true)">
                    <span class="nm">{{ p.name || p.id }}</span>
                    <ChIcon :name="p.id === pid ? 'check' : 'arrowr'" class="tail" :class="{ on: p.id === pid }" />
                </button>
            </div>
        </Transition>
        <Transition name="pop">
            <div v-if="open && hoverPid" ref="sub" class="nv-menu mp-sub" :style="{ zIndex: POP_Z + 1 }" @mouseenter="enterSub" @mouseleave="scheduleClose">
                <div v-if="!subModels.length" class="mp-empty">暂无模型</div>
                <button v-for="m in subModels" :key="m" type="button" class="nv-menu-item mp-model"
                    :class="{ 'is-on': hoverPid === pid && m === model }" :title="m" @click="pick(m)">
                    <span class="nm">{{ shortModelName(m) }}</span>
                    <ChIcon v-if="hoverPid === pid && m === model" name="check" class="tail on" />
                </button>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.mp-pop { position: fixed; width: 236px; min-width: 0; overflow-y: auto; padding: 6px; border-radius: 14px; }
.mp-sub { position: fixed; width: 212px; min-width: 0; overflow-y: auto; padding: 6px; border-radius: 14px; }
.mp-hd { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 8px 8px; }
.mp-hd .t { white-space: nowrap; font: 400 11px/14px var(--font-mono); letter-spacing: .04em; color: var(--ink-3); }
.mp-seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: 999px; background: var(--fill-1); }
.mp-seg button { height: 22px; padding: 0 10px; border: 0; border-radius: 999px; background: transparent; color: var(--ink-3); font: 500 11.5px/1 var(--font-sans); cursor: pointer; transition: color var(--duration-fast); }
.mp-seg button:hover { color: var(--ink-2); }
.mp-seg button.is-on { background: var(--solid); color: var(--ink); box-shadow: var(--shadow-float); }
.mp-row, .mp-model { height: 32px; gap: 8px; border-radius: 8px; }
.mp-row .nm, .mp-model .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mp-model { font: 400 12px/1 var(--font-mono); letter-spacing: .01em; }
.mp-row.hovered { background: var(--fill-1); }
.tail { width: 13px; height: 13px; color: var(--ink-3); flex: none; }
.tail.on { color: var(--ink); }
.mp-empty { padding: 10px 10px 12px; max-width: 220px; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
</style>
