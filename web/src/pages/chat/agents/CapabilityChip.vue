<script setup>
// 输入框里已挂载的能力 chip：线性小图标 + 名称 + 参数入口 + 移除。
// 参数弹层读 capability 的 input_schema.params（category/goal/product 这类，全部选填，可留空）；
// 列表接口不带 input_schema，第一次打开弹层时才拉详情（失败给可读提示，不阻塞发送）。
import { ref, computed, nextTick } from 'vue';
import ChIcon from '../ChIcon.vue';
import { ICONS } from '../../../lib/icons.js';
import { paramListOf, ensureSchema, hasParamValues } from './capState.js';
import { usePop, POP_Z } from '../usePop.js';

const props = defineProps({ cap: { type: Object, required: true } });
const emit = defineEmits(['remove', 'replace']);

const chip = ref(null);
const pop = ref(null);
const { open, toggle, place } = usePop('capchip', chip, pop, { place: { align: 'left', maxH: 360 } });
const schemaLoading = ref(false);

const fields = computed(() => paramListOf(props.cap));
function iconKey() {
    const k = String((props.cap && props.cap.icon) || '').trim();
    return ICONS[k] ? k : '';
}
function charIcon() {
    const k = String((props.cap && props.cap.icon) || '').trim();
    return k && !ICONS[k] && k.length <= 2 ? k : '';
}
function kindText() {
    const k = props.cap && props.cap.kind;
    if (k === 'skill') return '技能';
    if (k === 'generate-image') return 'AI生图';
    return '智能体';
}
function boolOptions() { return [{ value: true, label: '是' }, { value: false, label: '否' }]; }
function same(field, value) {
    const cur = props.cap.params[field.name];
    if (field.type === 'boolean') return (cur === true) === (value === true);
    return String(cur == null ? '' : cur) === String(value == null ? '' : value);
}
function setValue(field, value) { props.cap.params[field.name] = value; }
function label() {
    const p = props.cap.params || {};
    const n = Object.keys(p).filter(k => p[k] !== '' && p[k] != null && p[k] !== false).length;
    return n ? props.cap.name + ' · 已填 ' + n + ' 项参数' : props.cap.name;
}

async function openPanel() {
    toggle();
    if (!open.value || props.cap.input_schema) return;
    schemaLoading.value = true;
    await ensureSchema(props.cap);
    schemaLoading.value = false;
    nextTick(place);
}
function replace() {
    toggle(false);
    emit('replace', props.cap);
}
function remove() {
    toggle(false);
    emit('remove', props.cap);
}
</script>

<template>
    <div ref="chip" class="cap-chip" :class="{ on: open }">
        <button type="button" class="main" :title="'点击设置参数'" :aria-expanded="open" aria-haspopup="dialog" @click="openPanel">
            <span class="ic">
                <ChIcon v-if="iconKey()" :name="iconKey()" />
                <em v-else-if="charIcon()">{{ charIcon() }}</em>
                <ChIcon v-else name="sparkles" />
            </span>
            <span class="nm">{{ label() }}</span>
            <span v-if="hasParamValues(cap)" class="dot"></span>
            <ChIcon name="settings" class="gear" />
        </button>
        <button type="button" class="x" title="移除" aria-label="移除能力" @click.stop="remove"><ChIcon name="x" /></button>
        <Teleport to="#nv-layer">
            <Transition name="pop">
                <div v-if="open" ref="pop" class="nv-menu cap-pop" :style="{ zIndex: POP_Z }">
                    <div class="ph">
                        <span class="pic">
                            <ChIcon v-if="iconKey()" :name="iconKey()" />
                            <em v-else-if="charIcon()">{{ charIcon() }}</em>
                            <ChIcon v-else name="sparkles" />
                        </span>
                        <span class="pt">
                            <b>{{ cap.name }}</b>
                            <em>{{ kindText() }}参数 · 全部选填</em>
                        </span>
                    </div>

                    <div v-if="schemaLoading" class="pstate"><span class="spin"></span><span>正在读取参数…</span></div>
                    <div v-else-if="cap.schemaError" class="pstate err">
                        <ChIcon name="alert" />
                        <span>{{ cap.schemaError }}，可直接发送</span>
                    </div>
                    <template v-else-if="fields.length">
                        <label v-for="f in fields" :key="f.name" class="pfield">
                            <span class="pl">{{ f.label }}<em v-if="f.hint" :title="f.hint">?</em></span>
                            <input v-if="f.type === 'text' || f.type === 'number'" class="pin" :type="f.type === 'number' ? 'number' : 'text'"
                                v-model="cap.params[f.name]" :placeholder="f.placeholder || '可留空'" />
                            <textarea v-else-if="f.type === 'textarea'" class="pta" rows="2" v-model="cap.params[f.name]" :placeholder="f.placeholder || '可留空'"></textarea>
                            <span v-else class="pchips">
                                <button v-for="o in (f.type === 'boolean' ? boolOptions() : f.options)" :key="String(o.value)" type="button" class="pchip" :class="{ on: same(f, o.value) }" @click="setValue(f, o.value)">{{ o.label }}</button>
                            </span>
                        </label>
                    </template>
                    <div v-else class="pstate"><span>无需参数，直接发送即可。</span></div>

                    <div class="pfoot">
                        <button type="button" class="nv-btn sm ghost" @click="replace"><ChIcon name="refresh" />更换{{ kindText() }}</button>
                        <span class="grow"></span>
                        <button type="button" class="nv-btn sm" @click="toggle(false)">完成</button>
                    </div>
                </div>
            </Transition>
        </Teleport>
    </div>
</template>

<style scoped>
.cap-chip { position: relative; display: inline-flex; align-items: center; height: 36px; border-radius: 10px; background: var(--fill-1); color: var(--ink-2); transition: background var(--duration-fast); }
.cap-chip:hover, .cap-chip.on { background: var(--fill-2); }
.cap-chip .main { display: inline-flex; align-items: center; gap: 8px; height: 100%; padding: 0 4px 0 10px; border: 0; border-radius: 10px 0 0 10px; background: transparent; color: inherit; cursor: pointer; max-width: 300px; }
.cap-chip .ic { flex: none; width: 22px; height: 22px; border-radius: 7px; background: var(--solid); color: var(--ink-2); display: inline-flex; align-items: center; justify-content: center; box-shadow: var(--shadow-float); }
.cap-chip .ic .nv-i { width: 13px; height: 13px; }
.cap-chip .ic em { font: 500 12px/1 var(--font-sans); font-style: normal; }
.cap-chip .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 12px/1 var(--font-sans); color: var(--ink); }
.cap-chip .dot { flex: none; width: 5px; height: 5px; border-radius: 50%; background: var(--ink-2); }
.cap-chip .gear { flex: none; width: 13px; height: 13px; color: var(--ink-4); transition: color var(--duration-fast); }
.cap-chip:hover .gear, .cap-chip.on .gear { color: var(--ink-2); }
.cap-chip .x { flex: none; width: 24px; height: 24px; margin: 0 6px 0 2px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: var(--ink-4); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; transition: background var(--duration-fast), color var(--duration-fast); }
.cap-chip .x:hover { background: var(--fill-3); color: var(--ink); }
.cap-chip .x .nv-i { width: 11px; height: 11px; }
.cap-pop { position: fixed; width: 288px; min-width: 0; max-height: 360px; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.ph { display: flex; align-items: center; gap: 9px; }
.ph .pic { flex: none; width: 26px; height: 26px; border-radius: 8px; background: var(--fill-1); color: var(--ink-2); display: inline-flex; align-items: center; justify-content: center; }
.ph .pic .nv-i { width: 14px; height: 14px; }
.ph .pic em { font-style: normal; font: 500 13px/1 var(--font-sans); }
.ph .pt { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ph .pt b { font: 500 13px/17px var(--font-sans); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ph .pt em { font-style: normal; font: 400 10.5px/1 var(--font-mono); color: var(--ink-4); }
.pstate { display: flex; align-items: center; gap: 8px; padding: 6px 2px; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.pstate .nv-i { width: 14px; height: 14px; }
.pstate.err { color: var(--danger); }
.pfield { display: flex; flex-direction: column; gap: 6px; }
.pl { display: flex; align-items: center; gap: 5px; font: 500 12px/16px var(--font-sans); color: var(--ink-2); }
.pl em { display: inline-flex; align-items: center; justify-content: center; width: 13px; height: 13px; border-radius: 50%; background: var(--fill-2); color: var(--ink-3); font: 400 9px/1 var(--font-sans); font-style: normal; }
.pin, .pta { width: 100%; border: 0; outline: 0; border-radius: 9px; background: var(--fill-1); color: var(--ink); padding: 0 10px; height: 32px; font: 400 12.5px/1 var(--font-sans); }
.pta { height: auto; padding: 8px 10px; resize: vertical; line-height: 18px; }
.pin:focus, .pta:focus { background: var(--fill-2); }
.pin::placeholder, .pta::placeholder { color: var(--ink-4); }
.pchips { display: flex; flex-wrap: wrap; gap: 5px; }
.pchip { height: 27px; padding: 0 10px; border: 0; border-radius: 999px; background: var(--fill-1); color: var(--ink-2); font: 400 12px/1 var(--font-sans); cursor: pointer; transition: background var(--duration-fast), color var(--duration-fast); }
.pchip:hover { background: var(--fill-2); color: var(--ink); }
.pchip.on { background: var(--fill-3); color: var(--ink); font-weight: 500; }
.pfoot { display: flex; align-items: center; gap: 6px; padding-top: 2px; }
.pfoot .grow { flex: 1; }
.pfoot .nv-i { width: 13px; height: 13px; }
</style>
