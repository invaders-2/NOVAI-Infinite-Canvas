<script setup>
// 输入框下方的技能面板（空状态点「技能」展开）：搜索 + 导入技能 + 左侧分类 + 右侧双列卡片。
// 分类标签照参考截图固定；卡片数据全部来自 GET /api/capabilities 的 skill 部分，
// 分类筛选与类型徽标由能力定义里的 skill_type / usage_count 驱动，缺省归为「系统技能」，不写死技能名与数量。
import { ref, computed } from 'vue';
import ChIcon from '../ChIcon.vue';
import { ICONS } from '../../../lib/icons.js';
import { CAP, loadCapabilities, skillTypeOf, skillTypeLabel, skillUsageOf } from './capState.js';
import { exportSkill, importSkillMarkdown } from './capabilityApi.js';
import { toast } from '../../../lib/store.js';

const emit = defineEmits(['pick', 'close']);
// 没有订阅数据源（后端不返回 subscribe），不摆一个永远是空的分类
const CATS = [
    { id: 'all', label: '全部技能' },
    { id: 'common', label: '常用技能' },
    { id: 'mine', label: '我的技能' },
    { id: 'system', label: '系统技能' },
];
const cat = ref('all');
const search = ref('');
const fileInput = ref(null);
const conflict = ref(null);
const importing = ref(false);

const skills = computed(() => CAP.list.filter(c => c.kind === 'skill'));
const groups = computed(() => ({
    all: skills.value,
    // 常用 = 真实跑过的技能（usage_count 来自服务端运行记录），按次数从多到少
    common: skills.value.filter(s => skillUsageOf(s) > 0).sort((a, b) => skillUsageOf(b) - skillUsageOf(a)),
    mine: skills.value.filter(s => skillTypeOf(s) === 'mine'),
    system: skills.value.filter(s => skillTypeOf(s) === 'system'),
}));
const counts = computed(() => {
    const out = {};
    Object.keys(groups.value).forEach(k => { out[k] = groups.value[k].length; });
    return out;
});
const list = computed(() => {
    const q = search.value.trim().toLowerCase();
    const base = groups.value[cat.value] || [];
    if (!q) return base;
    return base.filter(s => [s.name, s.description, s.category].concat(s.tags || []).join(' ').toLowerCase().includes(q));
});

// 空态按分类说明原因，不拿假数据凑
const EMPTY = {
    all: { title: '暂无技能', sub: '服务就绪后这里会列出全部技能' },
    common: { title: '还没有常用技能', sub: '跑过技能之后，这里按使用次数排' },
    mine: { title: '还没有导入的技能', sub: '点右上角「导入技能」选一份技能 JSON' },
    system: { title: '暂无系统技能', sub: '服务就绪后这里会列出系统技能' },
};
const emptyState = computed(() => EMPTY[cat.value] || EMPTY.all);

function iconKey(s) { const k = String((s && s.icon) || '').trim(); return ICONS[k] ? k : ''; }
function charIcon(s) { const k = String((s && s.icon) || '').trim(); return k && !ICONS[k] && k.length <= 2 ? k : ''; }
function pick(s) { if (s && s.available) emit('pick', s); }

function openImport() {
    const el = fileInput.value;
    if (!el) return;
    el.value = '';
    el.click();
}
async function submitImport(markdown, overwrite) {
    if (importing.value) return;
    importing.value = true;
    try {
        const res = await importSkillMarkdown(markdown, overwrite);
        if (res.ok) {
            await loadCapabilities(true);
            cat.value = 'mine';
            conflict.value = null;
            toast('已导入「' + ((res.skill && res.skill.name) || '技能') + '」', { icon: 'check' });
            return;
        }
        if (res.conflict && !overwrite) {
            conflict.value = { markdown: markdown, message: res.error || '已存在同名技能' };
            return;
        }
        toast(res.error || '技能导入失败', { icon: 'alert', danger: true });
    } finally {
        importing.value = false;
    }
}
async function onImportFile(e) {
    const file = e && e.target && e.target.files && e.target.files[0];
    if (!file) return;
    if (!/\.md$/i.test(file.name || '')) { toast('请选择 .md 格式的 SKILL.md', { icon: 'alert', danger: true }); return; }
    const text = await file.text();
    await submitImport(text, false);
}
async function confirmOverwrite() {
    if (!conflict.value) return;
    await submitImport(conflict.value.markdown, true);
}
function cancelOverwrite() {
    if (!importing.value) conflict.value = null;
}
async function exportCard(skill) {
    if (!skill || !skill.id) return;
    const res = await exportSkill(skill.id);
    if (!res.ok) { toast(res.error || '导出失败', { icon: 'alert', danger: true }); return; }
    const url = URL.createObjectURL(res.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = res.filename || (skill.id + '.md');
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast('已导出 ' + (res.filename || (skill.id + '.md')), { icon: 'download' });
}
</script>

<template>
    <section class="skp" aria-label="技能面板">
        <header class="skp-hd">
            <label class="skp-sc">
                <ChIcon name="search" />
                <input v-model="search" type="text" placeholder="请输入想搜索的技能名称或描述" aria-label="搜索技能" />
                <button v-if="search" type="button" class="clr" title="清空" aria-label="清空" @click="search = ''"><ChIcon name="x" /></button>
            </label>
            <button type="button" class="nv-btn sm skp-import" @click="openImport"><ChIcon name="upload" />导入 SKILL.md</button>
            <input ref="fileInput" class="skp-file" type="file" accept=".md,text/markdown" aria-hidden="true" tabindex="-1" @change="onImportFile" />
            <button type="button" class="nv-icon-btn sm round" title="收起技能面板" aria-label="收起技能面板" @click="emit('close')"><ChIcon name="x" /></button>
        </header>

        <div class="skp-body">
            <nav class="skp-rail" role="tablist" aria-label="技能分类">
                <button v-for="c in CATS" :key="c.id" type="button" role="tab" :aria-selected="cat === c.id" :class="{ on: cat === c.id }" @click="cat = c.id">
                    <span>{{ c.label }}</span>
                    <em v-if="counts[c.id]">{{ counts[c.id] }}</em>
                </button>
            </nav>

            <div class="skp-main">
                <div v-if="CAP.loading && !CAP.loaded" class="skp-state">
                    <span class="spin"></span>
                    <p>正在加载技能…</p>
                </div>
                <div v-else-if="CAP.error" class="skp-state err">
                    <ChIcon name="alert" />
                    <p>{{ CAP.error }}</p>
                </div>
                <div v-else-if="!list.length" class="skp-state">
                    <ChIcon name="wand2" />
                    <p>{{ emptyState.title }}</p>
                    <span class="sub">{{ emptyState.sub }}</span>
                </div>
                <div v-else class="skp-grid">
                    <div v-for="s in list" :key="s.id" class="skp-card" :class="{ off: !s.available }" role="button"
                         :tabindex="s.available ? 0 : -1" @click="s.available && pick(s)" @keydown.enter.prevent="s.available && pick(s)">
                        <span class="ic">
                            <ChIcon v-if="iconKey(s)" :name="iconKey(s)" />
                            <em v-else-if="charIcon(s)">{{ charIcon(s) }}</em>
                            <ChIcon v-else name="wand2" />
                        </span>
                        <span class="tx">
                            <span class="tt"><b>{{ s.name }}</b><em class="badge">{{ skillTypeLabel(skillTypeOf(s)) }}</em></span>
                            <span class="ds">{{ s.description || '暂无描述' }}</span>
                        </span>
                        <span v-if="!s.available" class="soon">即将上线</span>
                        <span class="skp-actions">
                            <button type="button" class="skp-act" title="导出 SKILL.md" aria-label="导出 SKILL.md" @click.stop="exportCard(s)"><ChIcon name="download" />导出 SKILL.md</button>
                            <button type="button" class="skp-act" title="导入 SKILL.md" aria-label="导入 SKILL.md" @click.stop="openImport"><ChIcon name="upload" />导入 SKILL.md</button>
                        </span>
                    </div>
                </div>
            </div>
        </div>

        <Teleport to="body">
            <div v-if="conflict" class="skp-confirm-root" role="dialog" aria-modal="true" aria-labelledby="skp-confirm-title">
                <div class="skp-confirm-scrim" @click="cancelOverwrite"></div>
                <div class="skp-confirm">
                    <h3 id="skp-confirm-title">已存在同名技能，覆盖？</h3>
                    <p>{{ conflict.message }}</p>
                    <div class="skp-confirm-foot">
                        <button type="button" class="nv-btn" :disabled="importing" @click="cancelOverwrite">取消</button>
                        <button type="button" class="skp-confirm-danger" :disabled="importing" @click="confirmOverwrite">{{ importing ? '覆盖中…' : '覆盖' }}</button>
                    </div>
                </div>
            </div>
        </Teleport>
    </section>
</template>

<style scoped>
.skp { max-height: min(460px, 56vh); display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 16px;
    background: var(--glass-strong); backdrop-filter: blur(44px) saturate(190%); -webkit-backdrop-filter: blur(44px) saturate(190%);
    box-shadow: var(--shadow-rim), var(--shadow-lift); }
.skp-hd { flex: none; display: flex; align-items: center; gap: 8px; }
.skp-sc { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px; border-radius: 11px; background: var(--fill-1); color: var(--ink-3); transition: background var(--duration-fast); }
.skp-sc:focus-within { background: var(--fill-2); }
.skp-sc .nv-i { width: 14px; height: 14px; flex: none; }
.skp-sc input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--ink); font: 400 13px/1 var(--font-sans); }
.skp-sc input::placeholder { color: var(--ink-4); }
.skp-sc .clr { flex: none; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--ink-4); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.skp-sc .clr:hover { color: var(--ink); background: var(--fill-2); }
.skp-sc .clr .nv-i { width: 11px; height: 11px; }
.skp-import { flex: none; }
.skp-import .nv-i { width: 13px; height: 13px; }
.skp-file { display: none; }
.skp-body { flex: 1; min-height: 0; display: flex; gap: 10px; }
.skp-rail { flex: none; width: 128px; display: flex; flex-direction: column; gap: 2px; padding-right: 6px; overflow-y: auto; }
.skp-rail button { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; border: 0; border-radius: 9px; background: transparent; color: var(--ink-3); font: 400 12.5px/1 var(--font-sans); text-align: left; cursor: pointer; transition: background var(--duration-fast), color var(--duration-fast); }
.skp-rail button:hover { background: var(--fill-1); color: var(--ink-2); }
.skp-rail button.on { background: var(--fill-2); color: var(--ink); font-weight: 500; }
.skp-rail button em { margin-left: auto; font: 400 10.5px/1 var(--font-mono); font-style: normal; color: var(--ink-4); }
.skp-rail button.on em { color: var(--ink-3); }
.skp-main { flex: 1; min-width: 0; overflow-y: auto; overscroll-behavior: contain; padding-right: 2px; }
.skp-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.skp-card { position: relative; display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; padding: 12px; border: 0; border-radius: 14px; text-align: left; color: var(--ink); cursor: pointer;
    background: var(--fill-1); transition: background var(--duration-fast), transform var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out); }
.skp-card:hover:not(.off) { background: var(--fill-2); transform: translateY(-1px); box-shadow: var(--shadow-float); }
.skp-card.off { opacity: .58; cursor: default; }
.skp-actions { grid-column: 1 / -1; display: flex; gap: 6px; padding-top: 2px; }
.skp-act { border: 0; height: 24px; padding: 0 8px; border-radius: var(--radius-pill); background: var(--fill-2); color: var(--ink-3); display: inline-flex; align-items: center; gap: 4px; font: 400 10.5px/1 var(--font-sans); cursor: pointer; transition: background var(--duration-fast), color var(--duration-fast); }
.skp-act:hover { background: var(--accent); color: var(--on-accent); }
.skp-act .nv-i { width: 11px; height: 11px; }
.skp-card .ic { grid-row: 1; width: 30px; height: 30px; border-radius: 9px; background: var(--glass-strong); color: var(--ink-2); display: inline-flex; align-items: center; justify-content: center; box-shadow: var(--shadow-float); }
.skp-card .ic .nv-i { width: 15px; height: 15px; }
.skp-card .ic em { font: 500 14px/1 var(--font-sans); font-style: normal; }
.skp-card .tx { grid-row: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; align-self: center; }
.skp-card .tt { display: flex; align-items: center; gap: 6px; min-width: 0; }
.skp-card .tt b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 13px/18px var(--font-sans); color: var(--ink); }
.skp-card .badge { flex: none; padding: 2px 6px; border-radius: 6px; background: var(--fill-2); color: var(--ink-2); font: 400 10px/1 var(--font-mono); font-style: normal; }
.skp-card .ds { grid-column: 1 / -1; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font: 400 11.5px/17px var(--font-sans); color: var(--ink-3); }
.skp-card .soon { position: absolute; right: 8px; top: 8px; padding: 2px 6px; border-radius: 999px; background: var(--fill-2); color: var(--ink-3); font: 400 10px/1 var(--font-sans); }
.skp-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 160px; text-align: center; }
.skp-state .nv-i { width: 20px; height: 20px; color: var(--ink-4); }
.skp-state p { margin: 0; font: 400 13px/20px var(--font-sans); color: var(--ink-2); }
.skp-state .sub { font: 400 11.5px/17px var(--font-sans); color: var(--ink-4); }
.skp-state.err p { color: var(--danger); }
.skp-confirm-root { position: fixed; inset: 0; z-index: 4000; display: flex; align-items: center; justify-content: center; padding: 24px; }
.skp-confirm-scrim { position: absolute; inset: 0; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); }
.skp-confirm { position: relative; width: min(440px, calc(100vw - 48px)); display: flex; flex-direction: column; gap: 12px; padding: 22px; border-radius: var(--radius-xl); background: var(--solid); box-shadow: var(--shadow-dialog); color: var(--ink); animation: nv-dialog-in var(--duration-slow) var(--ease-sheet) both; }
.skp-confirm h3 { margin: 0; font: 500 16px/24px var(--font-sans); letter-spacing: -0.01em; }
.skp-confirm p { margin: 0; color: var(--ink-3); font: 400 12px/18px var(--font-sans); }
.skp-confirm-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.skp-confirm-danger { border: 0; height: var(--control-md); padding: 0 16px; border-radius: var(--radius-md); background: var(--danger); color: var(--on-accent); font: 500 12.5px/1 var(--font-sans); cursor: pointer; }
.skp-confirm-danger:disabled { opacity: .6; cursor: default; }
@media (max-width: 640px) { .skp-rail { width: 104px; } .skp-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
