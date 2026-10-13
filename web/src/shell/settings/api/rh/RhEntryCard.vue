<script setup>
// RunningHub 应用 / 工作流卡片：缩略图（点了上传）、名称、运行路径、备注、编辑 / 删除
import { ref, computed, watch } from 'vue';
import NvIcon from '../../../../components/NvIcon.vue';
import ExtIcon from '../kit/ExtIcon.vue';
import { rhEntryThumbnailCandidates } from './rh-utils.js';

const props = defineProps({ entry: Object, kind: String });
const emit = defineEmits(['thumb', 'update', 'edit', 'remove']);

// 缩略图：自定义 thumbnail 优先，失败后依次尝试 /static/runninghub 下的内置图，全失败显示图标
const sources = computed(() => {
    const cands = rhEntryThumbnailCandidates(props.kind, props.entry);
    const own = String((props.entry && props.entry.thumbnail) || '').trim();
    return own ? [own, ...cands] : cands;
});
const srcIdx = ref(0);
watch(sources, () => { srcIdx.value = 0; });
const src = computed(() => sources.value[srcIdx.value] || '');
const path = computed(() => (props.kind === 'app' ? `/run/ai-app/${props.entry.id}` : `/run/workflow/${props.entry.id}`));
</script>

<template>
    <div class="rc">
        <button type="button" class="rc-thumb" :class="{ empty: !src }" title="上传缩略图" aria-label="上传缩略图" @click="emit('thumb')">
            <img v-if="src" :src="src" alt="" @error="srcIdx++">
            <NvIcon v-else :name="kind === 'app' ? 'sparkles' : 'workflow'" />
        </button>
        <div class="rc-mn">
            <input class="rc-title" :value="entry.title || ''" :placeholder="kind === 'app' ? 'AI 应用名称' : '工作流名称'" aria-label="名称" @input="emit('update', 'title', $event.target.value)">
            <div class="rc-id"><NvIcon name="hash" /><span>{{ path }}</span></div>
            <textarea class="rc-note" rows="1" :value="entry.note || ''" placeholder="备注、用途、参数说明" aria-label="备注" @input="emit('update', 'note', $event.target.value)"></textarea>
        </div>
        <div class="rc-ac">
            <button type="button" class="nv-icon-btn sm" :title="kind === 'app' ? '编辑应用参数' : '编辑工作流'" :aria-label="kind === 'app' ? '编辑应用参数' : '编辑工作流'" @click="emit('edit')"><ExtIcon name="sliders" /></button>
            <button type="button" class="nv-icon-btn sm danger" title="删除" aria-label="删除" @click="emit('remove')"><NvIcon name="trash" /></button>
        </div>
    </div>
</template>

<style scoped>
.rc { display: flex; gap: 12px; padding: 10px; border-radius: 12px; background: var(--solid); align-items: flex-start; }
.rc-thumb { width: 64px; height: 64px; border-radius: 10px; flex: none; border: 0; padding: 0; overflow: hidden; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--ink-3); background: var(--fill-1); transition: transform var(--duration-fast) var(--ease-out); }
.rc-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.rc-thumb:hover { transform: scale(1.03); }
.rc-thumb .nv-i { width: 16px; height: 16px; }
.rc-mn { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.rc-title { height: 22px; margin: 0 -4px; padding: 0 4px; border: 0; outline: 0; border-radius: 6px; background: transparent; color: var(--ink); font: 500 12.5px/17px var(--font-sans); min-width: 0; transition: background var(--duration-fast); }
.rc-title:hover { background: var(--fill-1); }
.rc-title:focus { background: var(--fill-1); }
.rc-id { display: flex; align-items: center; gap: 4px; font: 400 10.5px/14px var(--font-mono); color: var(--ink-3); min-width: 0; }
.rc-id span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rc-id .nv-i { width: 11px; height: 11px; }
.rc-note { resize: vertical; min-height: 28px; max-height: 120px; border: 0; outline: 0; font: 400 11.5px/16px var(--font-sans); color: var(--ink-2); padding: 6px 8px; border-radius: 7px; background: var(--fill-1); transition: background var(--duration-fast); }
.rc-note::placeholder { color: var(--ink-4); }
.rc-note:focus { background: var(--fill-2); }
.rc-ac { display: flex; flex-direction: column; gap: 4px; }
.rc-ac .nv-i { width: 14px; height: 14px; }
.nv-icon-btn.danger { color: var(--danger); }
</style>
