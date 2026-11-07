<script setup>
// 「配置/协议可更新」弹窗：列新增模型（对话/图像/视频/音频）、参数更新（按模型列改动字段）、协议变更、版本与官方文档，
// 一键 POST /api/providers/protocol-update/apply，成功后自动用已保存的 Key 跑一次连接验证并展示结果。
import { computed, inject, reactive, ref, watch } from 'vue';
import NvIcon from '../../../../components/NvIcon.vue';
import ApiDialog from '../kit/ApiDialog.vue';

const store = inject('apiStore');
const S = store.S;
const report = reactive({ phase: 'idle', error: '', applied: null, changes: [], params: [], addedTotal: 0, verify: null });
// 打开时把这条更新存下来：更新成功后它会从清单里消失，弹窗仍要能显示结果
const snap = ref(null);

const busy = computed(() => ['applying', 'refreshing', 'verifying'].includes(report.phase));
const done = computed(() => report.phase === 'done');
const providerName = computed(() => {
    const it = S.providers.find(p => String(p.id) === String(S.updateDlg));
    return (snap.value && snap.value.name) || (it && (it.name || it.id)) || S.updateDlg || '';
});
const versionText = computed(() => {
    const it = snap.value;
    if (!it) return '';
    const from = it.current_version === undefined || it.current_version === null || it.current_version === '' ? 0 : it.current_version;
    const to = it.latest_version;
    if (to === undefined || to === null || to === '') return '';
    return `版本 ${from} → ${to}`;
});
const GROUPS = [
    { key: 'chat', label: '对话' },
    { key: 'image', label: '图像' },
    { key: 'video', label: '视频' },
    { key: 'audio', label: '音频' },
];
const groups = computed(() => {
    const added = (report.applied && report.applied.added_models) || (snap.value && snap.value.new_models) || {};
    return GROUPS
        .map(g => ({ key: g.key, label: g.label, items: Array.isArray(added[g.key]) ? added[g.key] : [] }))
        .filter(g => g.items.length);
});
const changes = computed(() => {
    if (report.changes.length) return report.changes;
    return (snap.value && Array.isArray(snap.value.protocol_changes)) ? snap.value.protocol_changes : [];
});

// 参数更新（本次写入的模型参数改动）：字段名可读化，过长的值由样式截断 + title 展示全文
const PARAM_FIELDS = { ratios: '比例', resolutions: '分辨率', qualities: '质量', n_max: '张数', durations: '时长', modes: '方式' };
const MODE_LABELS = {
    text_to_video: '文生视频', image_to_video: '图生视频', start_end_to_video: '首尾帧', reference_to_video: '参考视频',
    reference_image_to_image: '参考图', video_extend: '视频延长', digital_human: '数字人',
};
function fieldLabel(field) { return PARAM_FIELDS[String(field || '').toLowerCase()] || String(field || ''); }
function paramValue(field, value) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (!text) return '—';
    if (String(field || '').toLowerCase() !== 'modes') return text;
    return text.split(',').map(part => part.trim()).filter(Boolean).map(part => MODE_LABELS[part] || part).join('、');
}
const paramGroups = computed(() => {
    const list = report.params.length ? report.params
        : ((snap.value && Array.isArray(snap.value.parameter_changes)) ? snap.value.parameter_changes : []);
    // 模型类型（图像 / 视频）来自同一条更新的 model_caps；接口没给就不显示标签
    const kinds = new Map(((snap.value && Array.isArray(snap.value.model_caps)) ? snap.value.model_caps : [])
        .map(item => [String(item.model || ''), item.kind === 'video' ? '视频' : '图像']));
    const order = [];
    const map = new Map();
    list.forEach(change => {
        if (!change) return;
        const model = String(change.model || '');
        if (!map.has(model)) {
            map.set(model, { model, kind: kinds.get(model) || '', items: [] });
            order.push(model);
        }
        map.get(model).items.push({
            field: change.field,
            label: fieldLabel(change.field),
            from: paramValue(change.field, change.from),
            to: paramValue(change.field, change.to),
            note: String(change.note || ''),
        });
    });
    return order.map(model => map.get(model));
});
const paramCount = computed(() => paramGroups.value.reduce((n, g) => n + g.items.length, 0));
const primaryText = computed(() => {
    if (report.phase === 'applying') return '正在更新…';
    if (report.phase === 'refreshing') return '正在刷新平台…';
    if (report.phase === 'verifying') return '正在验证连接…';
    if (done.value) return '已更新';
    return '更新并验证';
});
const resultKind = computed(() => {
    if (report.phase === 'failed' || (report.verify && report.verify.state === 'fail')) return 'bad';
    if (report.verify && report.verify.state === 'skip') return 'note';
    return 'ok';
});
const resultText = computed(() => {
    if (!report.verify) return '';
    const v = report.verify;
    if (v.state === 'ok') return `已更新 · 验证通过（${v.count} 个模型）`;
    if (v.state === 'skip') return `已更新 · ${v.text}`;
    return `已更新 · 验证未通过：${v.text}`;
});

watch(() => S.updateDlg, id => {
    Object.assign(report, { phase: 'idle', error: '', applied: null, changes: [], params: [], addedTotal: 0, verify: null });
    snap.value = id ? store.updateOf(id) : null;
}, { immediate: true });

function close() { store.closeUpdate(); }
async function start() {
    if (!S.updateDlg || busy.value) return;
    try {
        await store.applyUpdate(S.updateDlg, report);
    } catch (e) {
        report.phase = 'failed';
        report.error = String((e && e.message) || e);
    }
}
</script>

<template>
    <ApiDialog :open="!!S.updateDlg" width="520px" height="min(660px, calc(100vh - 32px))" label="配置/协议更新" @close="close">
        <div class="pu">
            <header class="pu-h">
                <span class="pu-ico"><NvIcon name="refresh2" /></span>
                <div class="pu-t">
                    <b>配置/协议更新</b>
                    <span class="pu-sub">{{ providerName }}<span v-if="versionText" class="pu-sep"> · </span><span v-if="versionText" class="pu-ver">{{ versionText }}</span></span>
                </div>
                <button type="button" class="nv-icon-btn round" aria-label="关闭" @click="close"><NvIcon name="x" /></button>
            </header>

            <div class="pu-b">
                <p v-if="report.error" class="pu-block bad">{{ report.error }}</p>
                <p v-else-if="done" class="pu-block" :class="resultKind">{{ resultText }}</p>

                <section class="pu-sec">
                    <h5>新增模型<em v-if="groups.length">{{ groups.reduce((n, g) => n + g.items.length, 0) }} 个</em></h5>
                    <div v-for="g in groups" :key="g.key" class="pu-grp">
                        <span class="pu-gk">{{ g.label }}</span>
                        <div class="pu-chips"><span v-for="m in g.items" :key="m" class="pu-chip">{{ m }}</span></div>
                    </div>
                    <p v-if="!groups.length" class="pu-none">没有新增模型</p>
                </section>

                <section v-if="paramGroups.length" class="pu-sec">
                    <h5>参数更新<em>{{ paramCount }} 项</em></h5>
                    <div v-for="g in paramGroups" :key="g.model" class="pu-pm">
                        <div class="pu-pmh">
                            <span class="pu-pmn">{{ g.model }}</span>
                            <span v-if="g.kind" class="pu-pmk">{{ g.kind }}</span>
                        </div>
                        <ul class="pu-pml">
                            <li v-for="(c, i) in g.items" :key="i">
                                <span class="pu-pf">{{ c.label }}</span>
                                <span class="pu-pv" :title="c.from">{{ c.from }}</span>
                                <span class="pu-parrow">→</span>
                                <span class="pu-pv to" :title="c.to">{{ c.to }}</span>
                                <em v-if="c.note" class="pu-pnote">{{ c.note }}</em>
                            </li>
                        </ul>
                    </div>
                </section>

                <section v-if="changes.length" class="pu-sec">
                    <h5>协议变更<em>{{ changes.length }} 项</em></h5>
                    <ul class="pu-chg">
                        <li v-for="(c, i) in changes" :key="i">
                            <b>{{ c.field }}</b>
                            <span class="pu-arrow">{{ c.from }} → {{ c.to }}</span>
                            <em v-if="c.note">{{ c.note }}</em>
                        </li>
                    </ul>
                </section>

                <p v-if="snap && snap.summary" class="pu-sum">{{ snap.summary }}</p>
                <div v-if="snap && snap.docs_url" class="pu-doc">
                    <a :href="snap.docs_url" target="_blank" rel="noopener noreferrer">查看官方文档<NvIcon name="ext" /></a>
                </div>
            </div>

            <footer class="pu-f">
                <span v-if="!done" class="pu-note">更新只增量合并：模型与参数一起合并，不会删掉你已有的模型，也不会动 Key 和自定义名称。</span>
                <span v-else class="pu-note">已是最新，之后可在平台详情里点「测试连接」再验证。</span>
                <div class="pu-acts">
                    <button type="button" class="nv-btn sm" @click="close">稍后</button>
                    <button type="button" class="nv-btn sm primary" :disabled="busy || done" @click="start">
                        <span v-if="busy" class="spin pu-spin"></span><NvIcon v-else name="refresh2" />{{ primaryText }}
                    </button>
                </div>
            </footer>
        </div>
    </ApiDialog>
</template>

<style scoped>
.pu { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.pu-h { display: flex; align-items: flex-start; gap: 12px; padding: 20px 20px 12px 22px; flex: none; }
.pu-ico { width: 30px; height: 30px; border-radius: 9px; background: var(--fill-2); display: inline-flex; align-items: center; justify-content: center; color: var(--ink); flex: none; }
.pu-ico .nv-i { width: 15px; height: 15px; }
.pu-t { flex: 1; min-width: 0; }
.pu-t b { display: block; font: 500 15px/22px var(--font-sans); color: var(--ink); letter-spacing: -.01em; }
.pu-sub { display: block; margin-top: 1px; font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); overflow-wrap: anywhere; }
.pu-sep, .pu-ver { display: inline; }
.pu-b { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 4px 22px 12px; display: flex; flex-direction: column; gap: 14px; scrollbar-width: thin; }
.pu-block { margin: 0; padding: 10px 12px; border-radius: 10px; font: 400 12.5px/19px var(--font-sans); overflow-wrap: anywhere; }
.pu-block.ok { background: var(--success-fill); color: var(--success); }
.pu-block.bad { background: var(--danger-fill); color: var(--danger); }
.pu-block.note { background: var(--fill-2); color: var(--ink-2); }
.pu-sec { display: flex; flex-direction: column; gap: 8px; }
.pu-sec h5 { display: flex; align-items: baseline; gap: 8px; margin: 0; font: 500 12px/16px var(--font-sans); color: var(--ink-2); }
.pu-sec h5 em { font: 400 11px/14px var(--font-mono); color: var(--ink-3); font-style: normal; letter-spacing: .04em; }
.pu-grp { display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; border-radius: 10px; background: var(--fill-1); }
.pu-gk { flex: none; width: 28px; font: 400 11px/20px var(--font-sans); color: var(--ink-3); }
.pu-chips { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.pu-chip { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 6px; background: var(--fill-2); font: 400 11px/1 var(--font-mono); color: var(--ink); }
.pu-none { margin: 0; font: 400 12px/18px var(--font-sans); color: var(--ink-3); }
.pu-pm { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: 10px; background: var(--fill-1); }
.pu-pmh { display: flex; align-items: center; gap: 6px; min-width: 0; }
.pu-pmn { font: 500 11.5px/16px var(--font-mono); color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pu-pmk { height: 16px; padding: 0 6px; border-radius: 8px; background: var(--fill-2); font: 400 10px/16px var(--font-sans); color: var(--ink-3); flex: none; }
.pu-pml { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.pu-pml li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; min-width: 0; font: 400 11.5px/17px var(--font-sans); }
.pu-pf { flex: none; min-width: 44px; white-space: nowrap; color: var(--ink-3); }
.pu-pv { min-width: 0; max-width: 172px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font: 400 11px/17px var(--font-mono); color: var(--ink-2); }
.pu-pv.to { color: var(--ink); }
.pu-parrow { flex: none; font: 400 11px/17px var(--font-mono); color: var(--ink-4); }
.pu-pnote { flex-basis: 100%; min-width: 0; padding-left: 50px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font: normal 400 11px/16px var(--font-sans); color: var(--ink-3); }
.pu-chg { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.pu-chg li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; padding: 8px 10px; border-radius: 10px; background: var(--fill-1); font: 400 12px/18px var(--font-sans); color: var(--ink); }
.pu-chg b { font: 500 11px/16px var(--font-mono); letter-spacing: .02em; color: var(--ink-2); }
.pu-arrow { font: 400 11.5px/16px var(--font-mono); color: var(--ink); }
.pu-chg em { flex-basis: 100%; font: normal 400 11.5px/17px var(--font-sans); color: var(--ink-3); }
.pu-sum { margin: 0; font: 400 12.5px/19px var(--font-sans); color: var(--ink-2); overflow-wrap: anywhere; }
.pu-doc a { display: inline-flex; align-items: center; gap: 5px; font: 400 12px/18px var(--font-sans); color: var(--ink); text-decoration: none; }
.pu-doc a:hover { text-decoration: underline; }
.pu-doc .nv-i { width: 12px; height: 12px; color: var(--ink-3); }
.pu-f { flex: none; display: flex; flex-direction: column; gap: 10px; padding: 12px 22px 18px; }
.pu-note { font: 400 11px/16px var(--font-sans); color: var(--ink-3); }
.pu-acts { display: flex; justify-content: flex-end; gap: 8px; }
.pu-spin { width: 12px; height: 12px; }
@media (prefers-reduced-motion: reduce) { .pu-spin { animation: none; } }
</style>
