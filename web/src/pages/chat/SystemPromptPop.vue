<script setup>
// 系统提示词弹层：角色库（内置 + 自存，点选即填入文本框；另存为 / 删除自存角色）、
// 记忆库（开关启用、全局 / 本对话切换、删除、按作用域添加 —— 服务端自动注入，不进文本框）、文本框（清空 / 保存）。
import { ref, nextTick } from 'vue';
import ChIcon from './ChIcon.vue';
import { S } from './chatState.js';
import { L, activePersona, personaStatus, applyPersona, onPromptInput, clearPrompt, savePrompt, savePersona, deleteActivePersona } from './library.js';
import { memoryStatus, setMemoryScope, addMemory, toggleMemory, switchMemoryScope, deleteMemory } from './library.js';

const emit = defineEmits(['close']);
const saveOpen = ref(false);
const nameIn = ref(null);
const name = ref('');
const memText = ref('');
const memIn = ref(null);

function toggleSave(force) {
    saveOpen.value = typeof force === 'boolean' ? force : !saveOpen.value;
    if (saveOpen.value) {
        name.value = String((activePersona.value && activePersona.value.name) || '');
        nextTick(() => nameIn.value && nameIn.value.focus());
    }
}
async function submitSave() {
    if (!String(name.value || '').trim() && String(S.systemPrompt || '').trim()) { nameIn.value && nameIn.value.focus(); }
    if (await savePersona(name.value)) toggleSave(false);
}
async function submitMem() {
    if (!memText.value.trim()) { memIn.value && memIn.value.focus(); return; }
    if (await addMemory(memText.value)) memText.value = '';
}
function save() { savePrompt(); emit('close'); }
</script>

<template>
    <div class="nv-glass-pop sys" role="dialog" aria-label="系统提示词">
        <div class="sh">
            <b>系统提示词</b>
            <button type="button" class="nv-icon-btn sm round" title="关闭" aria-label="关闭" @click="emit('close')"><ChIcon name="x" /></button>
        </div>
        <div class="chips">
            <span v-if="!L.personasLoaded" class="hint">角色库加载中…</span>
            <button v-for="p in L.personas" :key="p.id" type="button" class="chip" :class="{ on: p.id === S.activePersonaId, mine: !p.builtin }"
                :title="p.description || p.name || ''" @click="applyPersona(p.id)">{{ p.name || '未命名角色' }}</button>
        </div>
        <div class="pfoot">
            <span class="st" :class="{ flash: !!L.personaFlash }">{{ personaStatus }}</span>
            <div class="pa">
                <button type="button" class="mini" title="把当前内容另存为角色" @click="toggleSave()"><ChIcon name="save" />另存为</button>
                <button v-if="activePersona && !activePersona.builtin" type="button" class="mini dng" title="删除当前角色" @click="deleteActivePersona"><ChIcon name="trash" />删除</button>
            </div>
        </div>
        <Transition name="fold">
            <div v-if="saveOpen" class="savebox">
                <input ref="nameIn" v-model="name" type="text" class="inp" placeholder="角色名称" maxlength="40" @keydown.enter="submitSave" @keydown.esc.stop="toggleSave(false)" />
                <button type="button" class="mini pri" :disabled="L.saving" @click="submitSave"><span v-if="L.saving" class="spin"></span>保存</button>
                <button type="button" class="mini" @click="toggleSave(false)">取消</button>
            </div>
        </Transition>
        <div class="mem">
            <div class="mh"><span class="t">记忆库</span><span class="ms">{{ memoryStatus }}</span></div>
            <span v-if="!L.memories.length" class="hint">暂无记忆，在下方添加一条长期使用偏好</span>
            <TransitionGroup v-else tag="div" name="mr" class="mlist">
                <div v-for="m in L.memories" :key="m.id" class="mr" :class="{ off: m.enabled === false }">
                    <button type="button" class="nv-switch sw" :class="{ 'is-on': m.enabled !== false }" :title="m.enabled === false ? '已停用（点击启用）' : '已启用（点击停用）'"
                        :aria-pressed="m.enabled !== false" @click="toggleMemory(m)"></button>
                    <span class="tx" :title="m.content">{{ m.content }}</span>
                    <button type="button" class="sc" :class="{ g: m.scope !== 'conversation' }" :title="m.scope === 'conversation' ? '仅当前对话生效 · 点击切为全局' : '全局生效 · 点击切为本对话'"
                        @click="switchMemoryScope(m)">{{ m.scope === 'conversation' ? '本对话' : '全局' }}</button>
                    <button type="button" class="md" title="删除" aria-label="删除" @click="deleteMemory(m)"><ChIcon name="trash" /></button>
                </div>
            </TransitionGroup>
            <div class="madd">
                <span class="seg" data-glide="button" data-glide-active="is-on">
                    <button type="button" :class="{ 'is-on': L.memoryScope === 'global' }" @click="setMemoryScope('global')">全局</button>
                    <button type="button" :class="{ 'is-on': L.memoryScope === 'conversation' }" @click="setMemoryScope('conversation')">本对话</button>
                </span>
                <input ref="memIn" v-model="memText" type="text" class="inp" placeholder="添加长期记忆，例如：回答用中文、少用术语" maxlength="1000" @keydown.enter="submitMem" />
                <button type="button" class="mini pri" :disabled="L.adding" @click="submitMem">添加</button>
            </div>
        </div>
        <textarea class="ta" :value="S.systemPrompt" placeholder="例如：你是一个专业图片创作助手，回答要简洁，并优先给出可执行步骤。" @input="onPromptInput($event.target.value)"></textarea>
        <div class="acts">
            <button type="button" class="nv-btn sm ghost" @click="clearPrompt">清空</button>
            <button type="button" class="nv-btn sm primary" @click="save">保存</button>
        </div>
    </div>
</template>

<style scoped>
.sys { position: absolute; z-index: 40; width: 440px; max-width: calc(100% - 32px); max-height: calc(100% - 80px); overflow-y: auto; padding: 18px 18px 16px; border-radius: 18px; display: flex; flex-direction: column; gap: 12px; }
.sh { display: flex; align-items: center; justify-content: space-between; }
.sh b { font: 500 15px/20px var(--font-sans); color: var(--ink); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { height: 26px; padding: 0 10px; border: 0; border-radius: 999px; background: var(--fill-1); color: var(--ink-2); font: 400 12px/1 var(--font-sans); white-space: nowrap; cursor: pointer; transition: background var(--duration-fast), color var(--duration-fast); }
.chip:hover { background: var(--fill-2); color: var(--ink); }
.chip.mine::before { content: ""; display: inline-block; width: 4px; height: 4px; margin-right: 6px; vertical-align: 2px; border-radius: 50%; background: currentColor; opacity: .5; }
.chip.on { background: var(--accent); color: var(--on-accent); }
.hint { font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.pfoot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.st { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 400 11.5px/16px var(--font-sans); color: var(--ink-3); }
.st.flash { color: var(--danger); }
.pa { display: flex; gap: 6px; flex: none; }
.mini { height: 24px; padding: 0 9px; border: 0; border-radius: 7px; display: inline-flex; align-items: center; gap: 5px; background: var(--fill-1); color: var(--ink-2); font: 500 11.5px/1 var(--font-sans); cursor: pointer; white-space: nowrap; flex: none; transition: background var(--duration-fast), color var(--duration-fast); }
.mini:hover:not(:disabled) { background: var(--fill-2); color: var(--ink); }
.mini:disabled { opacity: .6; cursor: default; }
.mini .nv-i { width: 12px; height: 12px; }
.mini .spin { width: 10px; height: 10px; }
.mini.dng { color: var(--danger); background: var(--danger-fill); }
.mini.pri { background: var(--accent); color: var(--on-accent); height: 28px; padding: 0 11px; }
.savebox { display: flex; gap: 6px; align-items: center; }
.inp { flex: 1; min-width: 0; height: 28px; padding: 0 10px; border: 0; outline: 0; border-radius: 8px; background: var(--fill-1); color: var(--ink); font: 400 12.5px/1 var(--font-sans); }
.inp::placeholder { color: var(--ink-4); }
.inp:focus { background: var(--fill-2); box-shadow: none; }
.mem { border-radius: 12px; background: var(--fill-1); padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.mh { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.mh .t { font: 500 12.5px/18px var(--font-sans); color: var(--ink); }
.mh .ms { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 400 11px/1 var(--font-mono); color: var(--ink-3); letter-spacing: .02em; }
.mlist { display: flex; flex-direction: column; max-height: 200px; overflow-y: auto; }
.mr { display: flex; align-items: center; gap: 10px; min-height: 32px; }
.sw { transform: scale(.86); }
.mr .tx { flex: 1; min-width: 0; font: 400 12.5px/1.4 var(--font-sans); color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mr.off .tx { color: var(--ink-4); }
.sc { height: 20px; padding: 0 7px; border: 0; border-radius: 6px; background: var(--solid); color: var(--ink-2); font: 400 11px/1 var(--font-sans); cursor: pointer; flex: none; }
.sc.g { background: var(--accent); color: var(--on-accent); }
.md { width: 22px; height: 22px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--ink-3); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.md:hover { color: var(--danger); background: var(--danger-fill); }
.md .nv-i { width: 13px; height: 13px; }
.madd { display: flex; align-items: center; gap: 6px; padding-top: 4px; }
.madd .inp { background: var(--solid); font-size: 12px; }
.seg { position: relative; display: inline-flex; gap: 2px; padding: 2px; border-radius: 999px; background: var(--fill-2); flex: none; --nv-glide-bg: var(--solid); }
.seg button { height: 24px; padding: 0 9px; border: 0; border-radius: 999px; background: transparent; color: var(--ink-3); font: 500 11.5px/1 var(--font-sans); cursor: pointer; white-space: nowrap; }
.seg button.is-on { background: var(--solid); color: var(--ink); }
.seg :deep(.nv-glide-pill) { border-radius: 999px; }
.ta { min-height: 92px; max-height: 40vh; resize: vertical; padding: 10px 12px; border: 0; outline: 0; border-radius: 10px; background: var(--fill-1); color: var(--ink); font: 400 12.5px/20px var(--font-sans); flex: none; }
.ta::placeholder { color: var(--ink-4); }
.ta:focus { background: var(--fill-2); box-shadow: none; }
.acts { display: flex; justify-content: flex-end; gap: 6px; }
.fold-enter-active, .fold-leave-active { transition: opacity .16s var(--ease-out), transform .16s var(--ease-out); }
.fold-enter-from, .fold-leave-to { opacity: 0; transform: translateY(-4px); }
.mr-enter-active, .mr-leave-active { transition: opacity .18s var(--ease-out), transform .18s var(--ease-out); }
.mr-enter-from, .mr-leave-to { opacity: 0; transform: translateX(6px); }
</style>
