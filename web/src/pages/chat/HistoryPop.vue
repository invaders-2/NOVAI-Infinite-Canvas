<script setup>
// 历史对话弹层：新建 / 切换 / 删除（悬停出现删除，点一次变「确认」，再点才删）
import { ref, onBeforeUnmount } from 'vue';
import ChIcon from './ChIcon.vue';
import { C, openConversation, newConversation, deleteConversation } from './session.js';
import { t } from '../../lib/store.js';

const emit = defineEmits(['close']);
const confirmId = ref('');
let timer = 0;
function askDelete(id) {
    if (confirmId.value === id) { clearTimeout(timer); confirmId.value = ''; deleteConversation(id); return; }
    confirmId.value = id;
    clearTimeout(timer);
    timer = setTimeout(() => { confirmId.value = ''; }, 3000);
}
onBeforeUnmount(() => clearTimeout(timer));
async function pick(id) { await openConversation(id); emit('close'); }
async function create() { await newConversation(); emit('close'); }
</script>

<template>
    <div class="nv-glass-pop hp" role="dialog" :aria-label="t('chat.history', '历史')">
        <div class="rh">
            <div><span class="k">{{ t('chat.historyTitle', '对话列表') }}</span><b>{{ t('chat.history', '历史') }}</b></div>
            <button type="button" class="nv-icon-btn sm round" title="关闭" aria-label="关闭" @click="emit('close')"><ChIcon name="x" /></button>
        </div>
        <button type="button" class="new" :title="t('chat.newConversation', '新对话')" @click="create"><ChIcon name="newchat" />{{ t('chat.new', '新建') }}</button>
        <div v-if="!C.conversations.length" class="empty">{{ t('chat.noHistory', '暂无历史') }}</div>
        <TransitionGroup v-else tag="div" name="th" class="list" data-glide=".th" data-glide-active="is-on">
            <div v-for="c in C.conversations" :key="c.id" class="th" :class="{ 'is-on': C.current && C.current.id === c.id }" @click="pick(c.id)">
                <b>{{ c.title || t('chat.newConversation', '新对话') }}</b>
                <span>{{ c.last_message || '' }}</span>
                <button type="button" class="del" :class="{ cf: confirmId === c.id }" :title="confirmId === c.id ? t('chat.deleteConfirm', '删除这条历史对话？') : t('chat.deleteTitle', '删除对话')"
                    :aria-label="t('chat.deleteTitle', '删除对话')" @click.stop="askDelete(c.id)">
                    <template v-if="confirmId === c.id">删除</template><ChIcon v-else name="x" />
                </button>
            </div>
        </TransitionGroup>
    </div>
</template>

<style scoped>
.hp { position: absolute; z-index: 40; width: 320px; max-height: min(560px, calc(100% - 80px)); padding: 16px 12px 12px; border-radius: 18px; display: flex; flex-direction: column; gap: 4px; }
.rh { display: flex; align-items: flex-start; justify-content: space-between; padding: 0 6px 10px; }
.rh .k { display: block; font: 400 11px/14px var(--font-mono); letter-spacing: .04em; color: var(--ink-3); text-transform: uppercase; }
.rh b { display: block; margin-top: 2px; font: 500 15px/20px var(--font-sans); color: var(--ink); }
.new { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 10px; margin-bottom: 8px; border: 0; border-radius: 10px; background: var(--fill-1); color: var(--ink); font: 500 12.5px/1 var(--font-sans); cursor: pointer; flex: none; transition: background var(--duration-fast); }
.new:hover { background: var(--fill-2); }
.new .nv-i { width: 15px; height: 15px; }
.list { position: relative; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.th { position: relative; display: flex; flex-direction: column; gap: 3px; padding: 9px 40px 9px 10px; border-radius: 10px; cursor: pointer; color: var(--ink); }
.th:hover { background: var(--fill-1); }
.th.is-on { background: var(--fill-2); }
.th b { font: 500 13px/18px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.th span { font: 400 11.5px/16px var(--font-sans); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 16px; }
.del { position: absolute; right: 8px; top: 50%; z-index: 2; min-width: 24px; height: 24px; margin-top: -12px; padding: 0 6px; border: 0; border-radius: 7px; cursor: pointer; background: var(--solid); color: var(--ink-3); box-shadow: var(--shadow-float);
    display: inline-flex; align-items: center; justify-content: center; font: 500 11px/1 var(--font-sans); opacity: 0; transition: opacity var(--duration-fast), background var(--duration-fast), color var(--duration-fast); }
.del .nv-i { width: 12px; height: 12px; }
.th:hover .del, .del:focus-visible, .del.cf { opacity: 1; }
.del:hover { color: var(--danger); }
.del.cf { background: var(--danger-fill); color: var(--danger); box-shadow: none; }
.empty { padding: 32px 12px; text-align: center; font: 400 12px/18px var(--font-sans); color: var(--ink-4); }
.th-leave-active { transition: opacity .18s var(--ease-out), transform .18s var(--ease-out); }
.th-leave-to { opacity: 0; transform: translateX(8px); }
.th-move { transition: transform .24s var(--ease-out); }
@media (hover: none) { .del { opacity: 1; } }
</style>
