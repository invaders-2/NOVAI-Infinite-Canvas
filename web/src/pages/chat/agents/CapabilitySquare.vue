<script setup>
// 「全部智能体 / 全部技能」：对话页正文区内的整页网格视图（输入框仍在底部）。
// 标题 + 右上搜索框 + 一行平台筛选 + 4 列卡片网格；available:false 的卡片标「即将上线」且不可点。
// 加载 / 空 / 错误态齐备：列表接口不可用时给可读空态 + 重试，不白屏、不写死假数据。
import { ref, computed, onMounted } from 'vue';
import ChIcon from '../ChIcon.vue';
import { ICONS } from '../../../lib/icons.js';
import { CAP, loadCapabilities, kindTitle, kindUnit, searchPlaceholder } from './capState.js';
import { LIST as PLATFORMS, platformsOf, isPlatformTag, loadPlatforms } from './platforms.js';
import OpenClawSetupBanner from './OpenClawSetupBanner.vue';

const props = defineProps({ kind: { type: String, default: 'agent' } });
const emit = defineEmits(['pick', 'close']);

const search = ref('');
const platform = ref('all');

const unit = computed(() => kindUnit(props.kind));
const title = computed(() => kindTitle(props.kind));
const ph = computed(() => searchPlaceholder(props.kind));

// 当前类目的全部能力（kind 缺省按 agent 归一化，见 capabilityApi.normalizeCapability）
const all = computed(() => CAP.list.filter(c => c.kind === props.kind));

// 平台筛选：全部平台 + 固定顺序的平台；亚马逊后端未上线 → 置灰并标「即将上线」
const filters = computed(() => PLATFORMS.map(p => Object.assign({}, p, { count: p.id === 'all' ? all.value.length : all.value.filter(c => platformsOf(c.tags).some(x => x.id === p.id)).length })));

const filtered = computed(() => {
    const q = search.value.trim().toLowerCase();
    const pid = platform.value;
    return all.value.filter(c => {
        if (pid !== 'all' && !platformsOf(c.tags).some(p => p.id === pid)) return false;
        if (!q) return true;
        const hay = [c.name, c.description, c.category].concat(c.tags, c.deliverables.map(d => d.label + d.kind)).join(' ').toLowerCase();
        return hay.includes(q);
    });
});

function iconKey(a) {
    const k = String((a && a.icon) || '').trim();
    return ICONS[k] ? k : '';
}
function charIcon(a) {
    const k = String((a && a.icon) || '').trim();
    return k && !ICONS[k] && k.length <= 2 ? k : '';
}
function cardPlatforms(a) { return platformsOf(a.tags).slice(0, 3); }
function categoryTag(a) {
    const other = a.tags.find(t => !isPlatformTag(t));
    return other || a.category || '';
}
function pick(a) {
    if (!a || !a.available) return;
    emit('pick', a);
}
function choosePlatform(p) {
    if (p.soon) return;
    platform.value = p.id;
}

onMounted(() => { loadCapabilities(); loadPlatforms(); });
</script>

<template>
    <section class="sq" :data-kind="kind" aria-label="能力选择">
        <header class="hd">
            <div class="tt">
                <b>{{ title }}</b>
                <span>{{ CAP.loading && !CAP.loaded ? '加载中…' : all.length + ' 个' + unit }}</span>
            </div>
            <label class="sc">
                <ChIcon name="search" />
                <input v-model="search" type="text" :placeholder="ph" :aria-label="ph" />
                <button v-if="search" type="button" class="clr" title="清空" aria-label="清空" @click="search = ''"><ChIcon name="x" /></button>
            </label>
            <button type="button" class="nv-icon-btn sm round" title="返回对话" aria-label="返回对话" @click="emit('close')"><ChIcon name="x" /></button>
        </header>

        <div class="pf" role="group" aria-label="平台筛选">
            <button v-for="p in filters" :key="p.id" type="button" class="nv-chip" :class="{ on: platform === p.id }"
                :disabled="p.soon" :aria-pressed="platform === p.id" @click="choosePlatform(p)">
                <svg class="nv-i" viewBox="0 0 24 24" aria-hidden="true" v-html="p.icon"></svg>
                <span>{{ p.name }}</span>
                <em v-if="p.soon">即将上线</em>
            </button>
        </div>

        <div class="oc-hint"><OpenClawSetupBanner /></div>

        <div class="body">
            <div v-if="CAP.loading && !CAP.loaded" class="state">
                <span class="spin"></span>
                <p>正在加载{{ unit }}…</p>
            </div>
            <div v-else-if="CAP.error" class="state err">
                <ChIcon name="alert" />
                <p>{{ CAP.error }}</p>
                <span class="sub">能力服务暂未就绪，可稍后重试</span>
                <button type="button" class="nv-btn sm" @click="loadCapabilities(true)">重试</button>
            </div>
            <div v-else-if="!all.length" class="state">
                <ChIcon name="box" />
                <p>暂无可用{{ unit }}</p>
                <span class="sub">服务就绪后这里会列出全部{{ unit }}</span>
            </div>
            <div v-else-if="!filtered.length" class="state">
                <ChIcon name="search" />
                <p>没有匹配的{{ unit }}</p>
                <button type="button" class="nv-btn sm ghost" @click="search = ''; platform = 'all'">清空筛选</button>
            </div>
            <div v-else class="grid" :data-cap-count="filtered.length">
                <button v-for="a in filtered" :key="a.id" type="button" class="cc" :class="{ off: !a.available }"
                    :disabled="!a.available" :data-cap-id="a.id" :data-available="a.available ? '1' : '0'"
                    :title="a.unavailable_reason || a.description" @click="pick(a)">
                    <span class="ic">
                        <ChIcon v-if="iconKey(a)" :name="iconKey(a)" />
                        <em v-else-if="charIcon(a)">{{ charIcon(a) }}</em>
                        <ChIcon v-else name="sparkles" />
                    </span>
                    <span class="tx">
                        <b>{{ a.name }}</b>
                        <span class="ds">{{ a.description || '暂无描述' }}</span>
                    </span>
                    <span class="ft">
                        <span class="pfs">
                            <svg v-for="p in cardPlatforms(a)" :key="p.id" class="nv-i pf-i" viewBox="0 0 24 24" aria-hidden="true" :title="p.name" v-html="p.icon"></svg>
                            <em v-if="!cardPlatforms(a).length">通用</em>
                        </span>
                        <span v-if="categoryTag(a)" class="ctg">{{ categoryTag(a) }}</span>
                    </span>
                    <span v-if="!a.available" class="soon">即将上线</span>
                </button>
            </div>
        </div>
    </section>
</template>

<style scoped>
.sq { position: absolute; inset: 0; overflow-y: auto; overscroll-behavior: contain; }
.hd { display: flex; align-items: center; gap: 12px; width: min(1180px, calc(100% - 48px)); margin: 0 auto; padding: 20px 0 4px; }
.tt { flex: none; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.tt b { font: 500 17px/24px var(--font-sans); color: var(--ink); }
.tt span { font: 400 11px/1 var(--font-mono); letter-spacing: .03em; color: var(--ink-4); }
.sc { flex: 1; min-width: 0; max-width: 340px; margin-left: auto; display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; border-radius: 12px; background: var(--fill-1); color: var(--ink-3); transition: background var(--duration-fast); }
.sc:focus-within { background: var(--fill-2); }
.sc .nv-i { width: 14px; height: 14px; flex: none; }
.sc input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--ink); font: 400 13px/1 var(--font-sans); }
.sc input::placeholder { color: var(--ink-4); }
.sc .clr { flex: none; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--ink-4); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.sc .clr:hover { color: var(--ink); background: var(--fill-2); }
.sc .clr .nv-i { width: 11px; height: 11px; }
.pf { display: flex; flex-wrap: wrap; gap: 6px; width: min(1180px, calc(100% - 48px)); margin: 0 auto; padding: 12px 0 4px; }
.nv-chip { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 11px; border: 0; border-radius: 999px; background: transparent; color: var(--ink-3); font: 400 12.5px/1 var(--font-sans); cursor: pointer; white-space: nowrap; transition: background var(--duration-fast), color var(--duration-fast); }
.nv-chip .nv-i { width: 14px; height: 14px; flex: none; opacity: .8; }
.nv-chip:hover:not(:disabled) { background: var(--fill-1); color: var(--ink-2); }
.nv-chip.on { background: var(--fill-2); color: var(--ink); font-weight: 500; }
.nv-chip.on .nv-i { opacity: 1; }
.nv-chip em { font-style: normal; font: 400 10px/1 var(--font-mono); color: var(--ink-4); }
.nv-chip:disabled { color: var(--ink-4); cursor: default; }
.nv-chip:disabled .nv-i { opacity: .45; }
.oc-hint { width: min(1180px, calc(100% - 48px)); margin: 0 auto; padding: 10px 0 0; }
.body { width: min(1180px, calc(100% - 48px)); margin: 0 auto; padding: 8px 0 calc(var(--cmp-h, 120px) + 40px); }
.grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.cc { position: relative; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; padding: 14px; border: 0; border-radius: 16px; text-align: left; color: var(--ink); cursor: pointer;
    background: var(--glass-strong); backdrop-filter: blur(44px) saturate(190%); -webkit-backdrop-filter: blur(44px) saturate(190%); box-shadow: var(--shadow-rim), var(--shadow-float);
    transition: transform var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out), background var(--duration-fast); }
.cc:hover:not(:disabled) { transform: translateY(-2px); box-shadow: var(--shadow-rim), var(--shadow-lift); }
.cc:active:not(:disabled) { transform: translateY(0); }
.cc.off { cursor: default; opacity: .58; }
.ic { grid-row: 1; width: 34px; height: 34px; border-radius: 11px; background: var(--fill-1); color: var(--ink-2); display: inline-flex; align-items: center; justify-content: center; }
.ic .nv-i { width: 17px; height: 17px; }
.ic em { font: 500 15px/1 var(--font-sans); font-style: normal; }
.tx { grid-row: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; align-self: center; }
.tx b { font: 500 13.5px/19px var(--font-sans); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tx .ds { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font: 400 12px/17px var(--font-sans); color: var(--ink-3); }
.ft { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; margin-top: 10px; min-width: 0; }
.pfs { display: inline-flex; align-items: center; gap: 5px; min-width: 0; color: var(--ink-3); }
.pfs .pf-i { width: 13px; height: 13px; opacity: .75; }
.pfs em { font-style: normal; font: 400 11px/1 var(--font-sans); color: var(--ink-4); }
.ctg { margin-left: auto; flex: none; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 400 10.5px/1 var(--font-mono); letter-spacing: .02em; padding: 4px 8px; border-radius: 6px; background: var(--fill-1); color: var(--ink-3); }
.soon { position: absolute; right: 10px; top: 10px; padding: 3px 8px; border-radius: 999px; background: var(--fill-2); color: var(--ink-3); font: 400 10.5px/1 var(--font-sans); }
.state { display: flex; flex-direction: column; align-items: center; gap: 9px; padding: 20vh 16px 44px; text-align: center; }
.state .nv-i { width: 22px; height: 22px; color: var(--ink-4); }
.state p { margin: 0; font: 400 13px/20px var(--font-sans); color: var(--ink-2); }
.state .sub { font: 400 11.5px/17px var(--font-sans); color: var(--ink-4); }
.state .spin { color: var(--ink-4); }
.state.err p { color: var(--danger); }
@media (max-width: 1100px) { .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 860px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .hd, .pf, .body, .oc-hint { width: calc(100% - 32px); } }
@media (max-width: 560px) { .grid { grid-template-columns: minmax(0, 1fr); } .tt b { font-size: 15px; } }
</style>
