<script setup>
// 生成信息卡（提示词 + 模型 / 平台 / 比例 / 尺寸 / 生成时间）+ 来源画布行。
// 资产库 / 本地上传用 item.generation（「生成自」一行，点了在画布中定位）；画布资产用 gen_* 字段和 used_in（「用在 N 个画布」）。
import { computed } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import { copyText, formatDate } from '../lib/util.js';
import { setStatus } from '../lib/state.js';
import { openCanvasAtNode } from '../lib/canvas.js';

const props = defineProps({
    prompt: { type: String, default: '' },
    model: { type: String, default: '' },
    provider: { type: String, default: '' },
    ratio: { type: String, default: '' },
    size: { type: String, default: '' },
    at: { type: [Number, String], default: 0 },
    refsTitle: { type: String, default: '' },
    refs: { type: Array, default: () => [] },     // [{ id, kind, node, title }]
    refIcon: { type: String, default: 'chevr' },
});
const has = computed(() => !!(props.prompt || props.model));
const chips = computed(() => [
    props.model ? ['模型', props.model, true] : null,
    props.provider ? ['平台', props.provider] : null,
    props.ratio ? ['比例', props.ratio] : null,
    props.size ? ['尺寸', props.size] : null,
    props.at ? ['生成于', formatDate(props.at)] : null,
].filter(Boolean));
async function copy() { setStatus((await copyText(props.prompt)) ? '已复制提示词' : '复制失败'); }
</script>

<template>
    <div v-if="has" class="am-sec">
        <div class="am-sech">
            <b><NvIcon name="sparkles" />生成信息</b>
            <button v-if="prompt" type="button" class="am-mini" @click="copy"><NvIcon name="copy" />复制提示词</button>
        </div>
        <div v-if="prompt" class="am-gp">{{ prompt }}</div>
        <div v-if="chips.length" class="am-gch">
            <span v-for="c in chips" :key="c[0]" :class="{ mm: c[2] }" :title="String(c[1])"><em>{{ c[0] }}</em>{{ c[1] }}</span>
        </div>
    </div>
    <div v-else-if="size" class="am-gch plain"><span><em>尺寸</em>{{ size }}</span><span><em>来源</em>上传 / 导入</span></div>
    <slot />
    <div v-if="refs.length" class="am-use">
        <span class="uh">{{ refsTitle }}</span>
        <button v-for="r in refs" :key="r.id + ':' + (r.node || '')" type="button" class="ur" @click="openCanvasAtNode(r.id, r.kind, r.node)">
            <NvIcon :name="r.kind === 'smart' ? 'sparkles' : 'grid9'" /><span>{{ r.title || '未命名画布' }}</span><NvIcon :name="refIcon" />
        </button>
    </div>
</template>
