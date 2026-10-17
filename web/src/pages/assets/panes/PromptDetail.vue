<script setup>
// 提示词详情：预览（正向 / 负向 + 字数、参数表）、编辑、新增；删除需再点一次确认；只读库不可编辑
import { reactive, ref, watch, computed } from 'vue';
import NvIcon from '../../../components/NvIcon.vue';
import { run } from '../lib/state.js';
import * as P from '../lib/prompts.js';

const props = defineProps({ item: { type: Object, default: null }, readonly: { type: Boolean, default: false } });
const X = P.P;
const form = reactive({ name: '', scene: '', positive: '', negative: '' });
const saving = ref(false);
const mode = computed(() => (X.create && !props.readonly ? 'create' : !props.item ? 'empty' : X.edit && !props.readonly ? 'edit' : 'view'));
watch(() => [mode.value, props.item && props.item.id], () => {
    const src = mode.value === 'edit' ? props.item : {};
    form.name = src.name || ''; form.scene = src.scene || ''; form.positive = src.positive || ''; form.negative = src.negative || '';
}, { immediate: true });
const params = computed(() => (props.item && props.item.params && typeof props.item.params === 'object' ? Object.entries(props.item.params) : []));
async function save() {
    saving.value = true;
    try { await run(mode.value === 'create' ? P.saveCreate({ ...form }) : P.saveEdit(props.item.id, { ...form })); } finally { saving.value = false; }
}
</script>

<template>
    <aside class="am-det">
        <template v-if="mode === 'create' || mode === 'edit'">
            <div class="am-ph">
                <div class="pt"><b>{{ mode === 'create' ? '新增提示词' : '编辑提示词' }}</b><span>{{ mode === 'create' ? '保存到当前提示词库' : '在当前库内保存' }}</span></div>
                <div class="pa">
                    <button type="button" class="nv-btn sm primary" :disabled="saving" @click="save"><span v-if="saving" class="am-spin"></span><NvIcon v-else name="check" />保存</button>
                    <button type="button" class="am-ib" title="取消" @click="P.cancelEdit()"><NvIcon name="x" /></button>
                </div>
            </div>
            <div class="am-dsc">
                <div class="am-form">
                    <label><span>名称</span><input v-model="form.name" class="am-inp" type="text" placeholder="提示词名称"></label>
                    <label><span>用途说明</span><textarea v-model="form.scene" class="am-txa" placeholder="用途说明"></textarea></label>
                    <label><span>正向提示词</span><textarea v-model="form.positive" class="am-txa tall" placeholder="正向提示词"></textarea></label>
                    <label><span>负向提示词</span><textarea v-model="form.negative" class="am-txa" placeholder="负向提示词"></textarea></label>
                </div>
            </div>
        </template>
        <template v-else-if="mode === 'empty'">
            <div class="am-ph"><div class="pt"><b>提示词预览</b><span>选择一条提示词查看全文</span></div></div>
            <div class="am-dsc"><div class="am-empty"><NvIcon name="type" /><span>暂无可预览提示词</span></div></div>
        </template>
        <template v-else>
            <div class="am-ph">
                <div class="pt"><b>提示词预览</b><span>{{ P.categoryLabel(item.category || 'custom') }}</span></div>
                <div class="pa">
                    <button type="button" class="am-ib" :disabled="readonly" title="编辑" @click="P.startEdit(item.id)"><NvIcon name="pencil" /></button>
                    <button type="button" class="am-ib dng" :class="{ cf: X.pendingDelete === item.id }" :disabled="readonly" :title="X.pendingDelete === item.id ? '再次点击确认删除' : '删除'" @click="run(P.deleteOne(item.id))"><NvIcon name="trash" /></button>
                </div>
            </div>
            <div class="am-dsc">
                <div class="hd">
                    <div class="ttl">{{ item.name || '提示词' }}</div>
                    <div class="scn">{{ item.scene || '未填写用途说明' }}</div>
                </div>
                <section class="blk">
                    <div class="bh"><span>正向提示词</span><em>{{ String(item.positive || '').length }} 字符</em></div>
                    <textarea class="bb" readonly spellcheck="false" :value="item.positive || '未填写'"></textarea>
                </section>
                <section class="blk">
                    <div class="bh"><span>负向提示词</span><em>{{ String(item.negative || '').length }} 字符</em></div>
                    <textarea class="bb neg" readonly spellcheck="false" :value="item.negative || '未填写'"></textarea>
                </section>
                <div v-if="params.length" class="params">
                    <div v-for="[k, v] in params" :key="k" class="prm"><b>{{ k }}</b><span>{{ v }}</span></div>
                </div>
            </div>
        </template>
    </aside>
</template>

<style scoped>
.tall { min-height: 120px !important; }
.hd { display: flex; flex-direction: column; gap: 4px; }
.ttl { font: 500 15px/22px var(--font-sans); letter-spacing: -.01em; }
.scn { font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.blk { display: flex; flex-direction: column; gap: 6px; }
.bh { display: flex; justify-content: space-between; font: 500 11.5px/16px var(--font-sans); color: var(--ink-2); }
.bh em { font: 400 10.5px/16px var(--font-mono); font-style: normal; color: var(--ink-4); }
.bb { width: 100%; min-height: 110px; padding: 10px 12px; border: 0; outline: 0; resize: vertical; border-radius: 10px; background: var(--fill-1); font: 400 11.5px/18px var(--font-mono); color: var(--ink); }
.bb.neg { color: var(--ink-3); min-height: 72px; }
.params { display: flex; flex-direction: column; gap: 2px; }
.prm { display: flex; justify-content: space-between; gap: 12px; min-height: 28px; align-items: center; font: 400 11.5px/16px var(--font-sans); }
.prm b { font-weight: 500; color: var(--ink-2); }
.prm span { font-family: var(--font-mono); color: var(--ink); text-align: right; word-break: break-all; }
</style>
