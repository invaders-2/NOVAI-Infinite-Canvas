<script setup>
// 应用市场（2026-11 按原型重做）：推荐 / 技能 / 插件 / 应用 / 已安装。
// 数据全部是真的：
//   市场条目 → /api/store/catalog（curation 里停用的条目显示「即将上线」，不能安装 / 启动）
//   官方 / 内置技能（后端从技能注册表并进 catalog，builtin=true）与市场技能同一套卡片渲染
//   插件 → 联网搜索开关（/api/agent/web-access）+ MCP 服务（/api/mcp/servers；启用要二次确认，交给设置页）
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import MarketDetail from './MarketDetail.vue';
import CoverMedia from './CoverMedia.vue';
import { fetchCatalog } from './storeData.js';
import { SHOWCASE } from './showcase.js';
import { navigate } from '../../lib/bridge.js';
import { state, toast } from '../../lib/store.js';
import { ICONS } from '../../lib/icons.js';

const TABS = [
    { id: 'rec', label: '推荐' },
    { id: 'skill', label: '技能' },
    { id: 'plugin', label: '插件' },
    { id: 'app', label: '应用' },
];
const tab = ref('rec');
const q = ref('');
const cat = ref('');
const loading = ref(true);
const failed = ref(false);
const catalog = ref({ items: [], categories: [], featured: [] });
const web = ref(null);
const mcp = ref([]);
const mcpBusy = ref('');
const detail = ref(null);   // { source: 'store' | 'builtin', item }

async function load() {
    loading.value = true; failed.value = false;
    const jobs = [
        fetchCatalog().then(c => { catalog.value = c; }).catch(() => { failed.value = true; }),
        loadPlugins(),
    ];
    await Promise.all(jobs);
    loading.value = false;
}
async function loadPlugins() {
    try { const r = await fetch('/api/agent/web-access'); if (r.ok) web.value = Boolean((await r.json()).enabled); } catch (e) {}
    try { const r = await fetch('/api/mcp/servers', { headers: { Accept: 'application/json' } }); if (r.ok) { const d = await r.json(); mcp.value = Array.isArray(d && d.servers) ? d.servers : []; } } catch (e) {}
}

const visible = computed(() => catalog.value.items.filter(it => it.storeVisible));
const storeSkills = computed(() => visible.value.filter(it => it.kind === 'skill'));
// 应用目前全部在 curation 里停用：有封面的按应用卡展示（即将上线），没封面的是第三方连接器（飞书、Notion…）单独一栏
const allApps = computed(() => catalog.value.items.filter(it => it.kind === 'app' && (it.storeVisible || !it.storeAvailable)));
const storeApps = computed(() => allApps.value.filter(it => it.coverUrl));
const connectors = computed(() => allApps.value.filter(it => !it.coverUrl));
// 可用的排前面，即将上线的放后面；同样可用时官方 / 内置技能排前面
const byAvail = list => [...list].sort((a, b) => (Number(b.storeAvailable) - Number(a.storeAvailable)) || (Number(!!b.builtin) - Number(!!a.builtin)));
const catsWithItems = computed(() => catalog.value.categories.filter(c => storeSkills.value.some(it => it.businessScenario === c.id)));

function hit(text) { const n = q.value.trim().toLowerCase(); return !n || String(text || '').toLowerCase().includes(n); }
const hitStore = it => hit([it.displayName, it.description, it.marketingLine, it.category, ...(it.searchTerms || [])].join(' '));
const skillList = computed(() => byAvail(storeSkills.value.filter(it => (!cat.value || it.businessScenario === cat.value) && hitStore(it))));
const appList = computed(() => byAvail(storeApps.value.filter(hitStore)));
const connList = computed(() => connectors.value.filter(hitStore));
const pluginList = computed(() => mcp.value.filter(s => hit(s.name + ' ' + (s.description || ''))));
const installedStore = computed(() => visible.value.filter(it => it.installed));
const installedCount = computed(() => installedStore.value.length + (web.value ? 1 : 0) + mcp.value.filter(s => s.enabled).length);
const searching = computed(() => !!q.value.trim());

function setTab(id) { tab.value = id; cat.value = ''; const el = document.querySelector('.mk'); if (el) el.scrollTo({ top: 0 }); }

/* ── 轮播（大图 hero + 缩略图条）：进度条走完自动切下一张，悬停 / 打开详情时暂停 ── */
const cf = ref(0);
const tick = ref(0);
const hovering = ref(false);
const cur = computed(() => SHOWCASE[cf.value] || SHOWCASE[0]);
const heroPaused = computed(() => hovering.value || !!detail.value || searching.value || tab.value !== 'rec');
function cfGo(i) { const n = SHOWCASE.length; if (n) cf.value = (i + n) % n; }
function autoplay() { tick.value++; }
function showcaseGo(it) {
    if (it.to === 'skills') openSettings('skills');
    else navigate(it.to);
}

/* ── 详情 ── */
function openStore(it) { detail.value = { source: 'store', item: it }; }
function onInstalled({ kind, name, installed }) {
    const it = catalog.value.items.find(x => x.kind === kind && x.name === name);
    if (it) it.installed = installed;
}

/* ── 插件 ── */
function openSettings(tabId) { state.settingsTab = tabId; state.settingsOpen = true; }
async function toggleWeb() {
    const next = !web.value;
    try {
        const r = await fetch('/api/agent/web-access', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }) });
        if (!r.ok) throw new Error();
        web.value = Boolean((await r.json()).enabled);
        toast(web.value ? '已开启联网搜索' : '已关闭联网搜索');
    } catch (e) { toast('切换失败，请稍后再试', { danger: true, icon: 'alert' }); }
}
async function toggleMcp(s) {
    // 启用 MCP 服务需要二次确认（会在本机启动它的命令），统一交给设置页处理
    if (!s.enabled) { openSettings('mcp'); return; }
    if (mcpBusy.value) return;
    mcpBusy.value = s.name;
    try {
        const r = await fetch('/api/mcp/servers/' + encodeURIComponent(s.name) + '/disable', { method: 'POST', headers: { Accept: 'application/json' } });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.detail || '');
        mcp.value = mcp.value.map(row => row.name === s.name ? (body.server || { ...row, enabled: false }) : row);
        toast('已停用 ' + s.name);
    } catch (e) { toast((e && e.message) || '停用失败', { danger: true, icon: 'alert' }); }
    finally { mcpBusy.value = ''; }
}

const skillIcon = s => (s && s.icon && ICONS[s.icon] ? s.icon : 'wand2');
// 封面视频：列表卡只在悬停时播（48px 也不预加载），离开就暂停；轮播只播当前这张
function playCover(e) { const v = e.currentTarget.querySelector('video'); if (v) v.play().catch(() => {}); }
function pauseCover(e) { const v = e.currentTarget.querySelector('video'); if (v) v.pause(); }
function onFocus(e) { if (e.detail && e.detail.id === 'store') loadPlugins(); }
watch(() => state.settingsOpen, open => { if (!open && state.active === 'store') loadPlugins(); });
onMounted(() => { load(); autoplay(); window.addEventListener('novai-page-focus', onFocus); });
onBeforeUnmount(() => { window.removeEventListener('novai-page-focus', onFocus); });
</script>

<template>
    <div class="mk">
        <div class="mk-in">
            <header class="mk-head">
                <h1>应用市场</h1>
                <span class="sp"></span>
                <label class="mk-search"><NvIcon name="search" /><input v-model="q" type="search" placeholder="搜索技能、插件、应用" autocomplete="off" aria-label="搜索技能、插件、应用"></label>
                <button type="button" class="mk-inst" :class="{ on: tab === 'installed' }" @click="setTab('installed')">已安装 <em>{{ installedCount }}</em></button>
            </header>
            <nav class="mk-tabs" aria-label="市场分类">
                <button v-for="t in TABS" :key="t.id" type="button" :class="{ on: tab === t.id }" :aria-pressed="tab === t.id" @click="setTab(t.id)">{{ t.label }}</button>
            </nav>

            <div v-if="loading" class="mk-skel"><div class="nv-skel big"></div><div class="row"><div class="nv-skel"></div><div class="nv-skel"></div><div class="nv-skel"></div></div></div>
            <div v-else-if="failed" class="mk-empty"><b>应用市场加载失败</b><span>请确认 NOVAI 服务正在运行</span><button type="button" class="nv-btn sm" @click="load">重试</button></div>

            <template v-else>
                <!-- 推荐 -->
                <template v-if="tab === 'rec' && !searching">
                    <section v-if="SHOWCASE.length" class="mk-sec">
                        <div class="mk-sh"><h2>最新模型</h2>
                            <div class="ar"><button type="button" class="flip" aria-label="上一张" @click="cfGo(cf - 1); autoplay()"><NvIcon name="chevr" /></button><button type="button" aria-label="下一张" @click="cfGo(cf + 1); autoplay()"><NvIcon name="chevr" /></button></div>
                        </div>
                        <div class="hero" :class="{ paused: heroPaused }" @mouseenter="hovering = true" @mouseleave="hovering = false">
                            <div v-for="(it, i) in SHOWCASE" :key="it.id" class="hs" :class="{ on: i === cf }" aria-hidden="true">
                                <video v-if="it.video && i === cf" :src="it.video" :poster="it.cover" autoplay muted loop playsinline preload="auto"></video>
                                <img v-else :src="it.cover" alt="" :loading="i === 0 ? 'eager' : 'lazy'" decoding="async">
                            </div>
                            <div :key="'t' + cf" class="hero-tx">
                                <span class="tag"><NvIcon :name="cur.icon" />{{ cur.tag }} · {{ cur.maker }}</span>
                                <h3>{{ cur.title }}</h3>
                                <p>{{ cur.desc }}</p>
                                <button type="button" class="go" @click="showcaseGo(cur)">立即体验<NvIcon name="chevr" /></button>
                            </div>
                            <div class="rail" role="tablist" aria-label="切换模型">
                                <button v-for="(it, i) in SHOWCASE" :key="it.id" type="button" role="tab" :aria-selected="i === cf" :aria-label="it.title" :class="{ on: i === cf }" @click="cfGo(i); autoplay()">
                                    <img :src="it.cover" alt="" loading="lazy" decoding="async">
                                    <i v-if="i === cf" :key="cf + '-' + tick" class="bar" :style="{ animationDuration: (it.dur || 5.5) + 's' }" @animationend="cfGo(cf + 1)"></i>
                                </button>
                            </div>
                        </div>
                    </section>

                    <section v-if="storeSkills.length" class="mk-sec">
                        <div class="mk-sh"><h2>精选技能</h2><button type="button" class="more" @click="setTab('skill')">查看全部<NvIcon name="chevr" /></button></div>
                        <div class="sk-grid">
                            <button v-for="it in byAvail(storeSkills).slice(0, 8)" :key="it.name" type="button" class="sk" @mouseenter="playCover" @mouseleave="pauseCover" @click="openStore(it)">
                                <span class="ico"><CoverMedia :item="it" :icon="skillIcon(it)" /><span v-if="it.builtin" class="st">官方{{ it.installed ? ' · 已添加' : '' }}</span><span v-else-if="!it.storeAvailable" class="st">即将上线</span><span v-else-if="it.installed" class="st">已添加</span></span>
                                <span class="tx"><b>{{ it.displayName }}</b><small>{{ it.marketingLine || it.description }}</small></span>
                            </button>
                        </div>
                    </section>

                    <section class="mk-sec">
                        <div class="mk-sh"><h2>插件</h2><button type="button" class="more" @click="setTab('plugin')">查看全部<NvIcon name="chevr" /></button></div>
                        <div class="pl-grid">
                            <div class="pl">
                                <div class="top"><span class="ico"><NvIcon name="globe" /></span><div class="nm"><b>联网搜索</b><span class="by">NOVAI 内置</span></div></div>
                                <p>让画布助手搜索公开网页、读取网页正文，查资料、找参考时用。</p>
                                <div class="ft"><span class="tools">2 个工具</span><button type="button" class="nv-btn sm" :class="{ primary: !web }" :disabled="web === null" @click="toggleWeb"><NvIcon v-if="web" name="check" />{{ web ? '已开启' : '开启' }}</button></div>
                            </div>
                            <div v-for="s in mcp.slice(0, 2)" :key="s.name" class="pl">
                                <div class="top"><span class="ico"><NvIcon name="plug" /></span><div class="nm"><b>{{ s.name }}</b><span class="by">MCP 服务</span></div></div>
                                <p>{{ s.description || (s.enabled ? '已接入画布助手，可以直接调用它的工具。' : '还没启用，启用后画布助手才能调用。') }}</p>
                                <div class="ft"><span class="tools">{{ s.enabled ? (s.tool_count || 0) + ' 个工具' : '未启用' }}</span><button type="button" class="nv-btn sm" :class="{ primary: !s.enabled }" :disabled="mcpBusy === s.name" @click="toggleMcp(s)">{{ s.enabled ? '停用' : '启用' }}</button></div>
                            </div>
                            <button type="button" class="pl add" @click="openSettings('mcp')">
                                <span class="ico"><NvIcon name="plus" /></span><b>添加 MCP 服务</b><p>接入本机或远程的 MCP 服务，给画布助手更多工具</p>
                            </button>
                        </div>
                    </section>

                    <section v-if="storeApps.length" class="mk-sec">
                        <div class="mk-sh"><h2>应用</h2><button type="button" class="more" @click="setTab('app')">查看全部<NvIcon name="chevr" /></button></div>
                        <div class="ap-grid">
                            <button v-for="it in byAvail(storeApps).slice(0, 4)" :key="it.name" type="button" class="app" @mouseenter="playCover" @mouseleave="pauseCover" @click="openStore(it)">
                                <span class="acv"><CoverMedia :item="it" /><span v-if="!it.storeAvailable" class="soon">即将上线</span></span>
                                <b>{{ it.displayName }}</b><small>{{ it.marketingLine || it.description }}</small>
                            </button>
                        </div>
                    </section>
                </template>

                <!-- 技能（推荐页搜索时也走这里） -->
                <template v-else-if="tab === 'skill' || (tab === 'rec' && searching)">
                    <section class="mk-sec">
                        <div class="mk-sh"><h2>{{ searching ? '搜索结果' : '全部技能' }}</h2></div>
                        <div v-if="catsWithItems.length" class="chipbar">
                            <button type="button" :class="{ on: !cat }" @click="cat = ''">全部</button>
                            <button v-for="c in catsWithItems" :key="c.id" type="button" :class="{ on: cat === c.id }" @click="cat = c.id">{{ c.label }}</button>
                        </div>
                        <template v-if="skillList.length">
                            <div class="sk-grid">
                                <button v-for="it in skillList" :key="it.name" type="button" class="sk" @mouseenter="playCover" @mouseleave="pauseCover" @click="openStore(it)">
                                    <span class="ico"><CoverMedia :item="it" :icon="skillIcon(it)" /><span v-if="it.builtin" class="st">官方{{ it.installed ? ' · 已添加' : '' }}</span><span v-else-if="!it.storeAvailable" class="st">即将上线</span><span v-else-if="it.installed" class="st">已添加</span></span>
                                <span class="tx"><b>{{ it.displayName }}</b><small>{{ it.marketingLine || it.description }}</small></span>
                            </button>
                            </div>
                        </template>
                        <div v-if="!skillList.length" class="mk-empty"><b>没有找到相关技能</b><span>换个关键词试试</span></div>
                    </section>
                </template>

                <!-- 插件 -->
                <template v-else-if="tab === 'plugin'">
                    <section class="mk-sec">
                        <div class="mk-sh"><h2>插件</h2><button type="button" class="more" @click="openSettings('mcp')">在设置里管理<NvIcon name="chevr" /></button></div>
                        <p class="lead">插件就是 MCP 服务，启用后画布助手能调用它们提供的工具。</p>
                        <div class="pl-grid">
                            <div v-if="hit('联网搜索 网页')" class="pl">
                                <div class="top"><span class="ico"><NvIcon name="globe" /></span><div class="nm"><b>联网搜索</b><span class="by">NOVAI 内置</span></div></div>
                                <p>让画布助手搜索公开网页、读取网页正文，查资料、找参考时用。</p>
                                <div class="ft"><span class="tools">2 个工具</span><button type="button" class="nv-btn sm" :class="{ primary: !web }" :disabled="web === null" @click="toggleWeb"><NvIcon v-if="web" name="check" />{{ web ? '已开启' : '开启' }}</button></div>
                            </div>
                            <div v-for="s in pluginList" :key="s.name" class="pl">
                                <div class="top"><span class="ico"><NvIcon name="plug" /></span><div class="nm"><b>{{ s.name }}</b><span class="by">MCP 服务{{ s.transport ? ' · ' + s.transport : '' }}</span></div></div>
                                <p>{{ s.description || (s.enabled ? '已接入画布助手，可以直接调用它的工具。' : '还没启用，启用后画布助手才能调用。') }}</p>
                                <div class="ft"><span class="tools">{{ s.enabled ? (s.tool_count || 0) + ' 个工具' : '未启用' }}</span><button type="button" class="nv-btn sm" :class="{ primary: !s.enabled }" :disabled="mcpBusy === s.name" @click="toggleMcp(s)">{{ s.enabled ? '停用' : '启用' }}</button></div>
                            </div>
                            <button type="button" class="pl add" @click="openSettings('mcp')">
                                <span class="ico"><NvIcon name="plus" /></span><b>添加 MCP 服务</b><p>接入本机或远程的 MCP 服务，给画布助手更多工具</p>
                            </button>
                        </div>
                    </section>
                </template>

                <!-- 应用 -->
                <template v-else-if="tab === 'app'">
                    <section class="mk-sec">
                        <div class="mk-sh"><h2>应用</h2></div>
                        <div v-if="appList.length" class="ap-grid">
                            <button v-for="it in appList" :key="it.name" type="button" class="app" @mouseenter="playCover" @mouseleave="pauseCover" @click="openStore(it)">
                                <span class="acv"><CoverMedia :item="it" /><span v-if="!it.storeAvailable" class="soon">即将上线</span></span>
                                <b>{{ it.displayName }}</b><small>{{ it.marketingLine || it.description }}</small>
                            </button>
                        </div>
                        <div v-else class="mk-empty"><b>{{ searching ? '没有找到相关应用' : '暂时还没有应用' }}</b></div>
                    </section>
                    <section v-if="connList.length" class="mk-sec">
                        <div class="mk-sh"><h2>连接器</h2></div>
                        <p class="lead">把常用工具接进来，在画布里取材、交付和通知。</p>
                        <div class="conn">
                            <button v-for="it in connList" :key="it.name" type="button" class="cn" @click="openStore(it)"><span class="lt">{{ (it.displayName || it.name).slice(0, 1) }}</span><b>{{ it.displayName }}</b><span>{{ it.storeAvailable ? '可用' : '即将开放' }}</span></button>
                        </div>
                    </section>
                </template>

                <!-- 已安装 -->
                <template v-else>
                    <section class="mk-sec">
                        <div class="mk-sh"><h2>已安装</h2></div>
                        <div v-if="installedStore.length" class="sk-grid">
                            <button v-for="it in installedStore.filter(hitStore)" :key="it.kind + it.name" type="button" class="sk" @mouseenter="playCover" @mouseleave="pauseCover" @click="openStore(it)">
                                <span class="ico"><CoverMedia :item="it" :icon="skillIcon(it)" /></span>
                                <span class="tx"><b>{{ it.displayName }}</b><small>{{ it.marketingLine || it.description }}</small></span>
                            </button>
                        </div>
                        <div class="pl-grid" :style="{ marginTop: installedStore.length ? '16px' : '0' }">
                            <div v-if="web" class="pl">
                                <div class="top"><span class="ico"><NvIcon name="globe" /></span><div class="nm"><b>联网搜索</b><span class="by">NOVAI 内置</span></div></div>
                                <p>让画布助手搜索公开网页、读取网页正文。</p>
                                <div class="ft"><span class="tools">2 个工具</span><button type="button" class="nv-btn sm" @click="toggleWeb">关闭</button></div>
                            </div>
                            <div v-for="s in mcp.filter(x => x.enabled)" :key="s.name" class="pl">
                                <div class="top"><span class="ico"><NvIcon name="plug" /></span><div class="nm"><b>{{ s.name }}</b><span class="by">MCP 服务</span></div></div>
                                <p>{{ s.description || '已接入画布助手，可以直接调用它的工具。' }}</p>
                                <div class="ft"><span class="tools">{{ (s.tool_count || 0) + ' 个工具' }}</span><button type="button" class="nv-btn sm" :disabled="mcpBusy === s.name" @click="toggleMcp(s)">停用</button></div>
                            </div>
                        </div>
                        <div v-if="!installedCount" class="mk-empty"><b>还没有安装任何东西</b><span>在「技能」里把常用的技能添加到画布助手</span></div>
                    </section>
                </template>
            </template>
        </div>
        <MarketDetail v-if="detail" :source="detail.source" :item="detail.item" @close="detail = null" @installed="onInstalled" />
    </div>
</template>

<style scoped>
.mk { position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden; color: var(--ink); }
.mk-in { width: min(1240px, calc(100% - 96px)); margin: 0 auto; padding: calc(var(--tbh, 0px) + 28px) 0 96px; }
.mk-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.mk-head h1 { margin: 0; font: 600 22px/30px var(--font-sans); letter-spacing: -.015em; }
.sp { flex: 1; }
.mk-search { display: flex; align-items: center; gap: 8px; width: 240px; height: 34px; padding: 0 12px; border-radius: 17px; background: var(--fill-1); color: var(--ink-3); }
.mk-search .nv-i { width: 14px; height: 14px; }
.mk-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; font: 400 12.5px/1 var(--font-sans); color: var(--ink); }
.mk-search input::placeholder { color: var(--ink-4); }
.mk-search input::-webkit-search-cancel-button { display: none; }
.mk-inst { height: 34px; padding: 0 14px; border: 0; border-radius: 17px; background: var(--fill-1); font: 500 12.5px/1 var(--font-sans); color: var(--ink); cursor: pointer; }
.mk-inst em { font-style: normal; color: var(--ink-3); margin-left: 3px; }
.mk-inst:hover, .mk-inst.on { background: var(--fill-2); }
.mk-tabs { display: flex; gap: 2px; margin-top: 10px; flex-wrap: wrap; }
.mk-tabs button { height: 30px; padding: 0 14px; border: 0; border-radius: 15px; background: transparent; font: 500 13px/1 var(--font-sans); color: var(--ink-3); cursor: pointer; transition: background var(--duration-fast), color var(--duration-fast); }
.mk-tabs button:hover { color: var(--ink); }
.mk-tabs button.on { background: var(--fill-2); color: var(--ink); }

.mk-sec { margin-top: 36px; }
.mk-sh { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.mk-sh h2 { margin: 0; font: 600 18px/24px var(--font-sans); letter-spacing: -.01em; }
.mk-sh .ar { display: flex; gap: 4px; }
.mk-sh .ar button, .more { border: 0; background: transparent; cursor: pointer; color: var(--ink-3); display: inline-flex; align-items: center; justify-content: center; }
.mk-sh .ar button { width: 32px; height: 32px; border-radius: 16px; }
.mk-sh .ar button:hover { background: var(--fill-1); color: var(--ink); }
.mk-sh .ar .nv-i { width: 16px; height: 16px; }
.flip .nv-i { transform: scaleX(-1); }
.more { gap: 2px; font: 400 12px/1 var(--font-sans); height: 28px; padding: 0 6px; border-radius: 8px; }
.more:hover { color: var(--ink); }
.more .nv-i { width: 13px; height: 13px; }
.lead { margin: -6px 0 16px; font: 400 12.5px/18px var(--font-sans); color: var(--ink-3); }
.sub { margin: 4px 0 8px; font: 400 11px/14px var(--font-mono); letter-spacing: .05em; color: var(--ink-3); }
.sk-grid + .sub { margin-top: 22px; }

/* 轮播：整宽大图 + 左下文案 + 右下缩略图条（进度条走完切下一张） */
.hero { position: relative; aspect-ratio: 2.6; border-radius: 22px; overflow: hidden; background: #0b0b0c; box-shadow: var(--shadow-float); isolation: isolate; }
.hs { position: absolute; inset: 0; opacity: 0; transition: opacity .9s ease; }
.hs.on { opacity: 1; }
.hs img { width: 100%; height: 100%; object-fit: cover; display: block; transform: scale(1.06); transition: transform 7s linear; }
.hs.on img { transform: scale(1); }
.hs video { width: 100%; height: 100%; object-fit: cover; display: block; }
.hero::after { content: ""; position: absolute; inset: 0; z-index: 1; pointer-events: none;
  background: linear-gradient(90deg, rgba(0,0,0,.64) 0%, rgba(0,0,0,.28) 40%, transparent 64%), linear-gradient(0deg, rgba(0,0,0,.5) 0%, transparent 42%); }
.hero-tx { position: absolute; left: 40px; bottom: 38px; z-index: 2; max-width: 44%; color: #fff; animation: hero-in .6s cubic-bezier(.2,.8,.2,1) both; }
.hero-tx .tag { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 10px; border-radius: 12px; background: rgba(255,255,255,.16); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); font: 500 11px/1 var(--font-sans); }
.hero-tx .tag .nv-i { width: 12px; height: 12px; }
.hero-tx h3 { margin: 14px 0 6px; font: 600 34px/40px var(--font-sans); letter-spacing: -.02em; }
.hero-tx p { margin: 0; font: 400 14px/21px var(--font-sans); opacity: .84; }
.hero-tx .go { margin-top: 18px; height: 36px; padding: 0 14px 0 18px; border: 0; border-radius: 18px; background: #fff; color: #111; font: 600 13px/1 var(--font-sans); display: inline-flex; align-items: center; gap: 4px; cursor: pointer; transition: transform .2s; }
.hero-tx .go:hover { transform: translateX(2px); }
.hero-tx .go .nv-i { width: 14px; height: 14px; }
.rail { position: absolute; right: 22px; bottom: 22px; z-index: 2; display: flex; gap: 6px; padding: 6px; border-radius: 16px; background: rgba(18,18,20,.34); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); }
.rail button { position: relative; width: 64px; height: 40px; padding: 0; border: 0; border-radius: 10px; overflow: hidden; cursor: pointer; background: #222; opacity: .5; transition: opacity .25s, transform .25s; }
.rail button:hover { opacity: .85; }
.rail button.on { opacity: 1; transform: translateY(-2px); }
.rail img { width: 100%; height: 100%; object-fit: cover; display: block; }
.rail .bar { position: absolute; left: 0; bottom: 0; width: 100%; height: 3px; background: #fff; transform-origin: left; animation: hero-bar 5.5s linear both; }
.hero.paused .bar { animation-play-state: paused; }
@keyframes hero-bar { from { transform: scaleX(0); } }
@keyframes hero-in { from { opacity: 0; transform: translateY(10px); } }
.soon { position: absolute; left: 12px; top: 12px; z-index: 1; height: 22px; padding: 0 9px; border-radius: 11px; background: rgba(0,0,0,.45); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); color: #fff; font: 400 11px/22px var(--font-sans); }
.sk .ico video, .app .acv video { width: 100%; height: 100%; object-fit: cover; display: block; }

/* 技能：封面卡片 */
.sk-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 24px 16px; }
.sk { display: flex; flex-direction: column; gap: 10px; padding: 0; border: 0; background: transparent; text-align: left; min-width: 0; cursor: pointer; color: var(--ink); }
.sk .ico { position: relative; width: 100%; aspect-ratio: 4 / 3; border-radius: 16px; overflow: hidden; background: linear-gradient(145deg, var(--fill-1), var(--fill-2)); display: flex; align-items: center; justify-content: center; color: var(--ink-2); transition: transform .25s, box-shadow .25s; }
.sk:hover .ico { transform: translateY(-3px); box-shadow: var(--shadow-lift); }
.sk .ico img, .sk .ico video { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .6s cubic-bezier(.2,.8,.2,1); }
.sk:hover .ico img, .sk:hover .ico video { transform: scale(1.04); }
.sk .ico .nv-i { width: 28px; height: 28px; }
.sk .tx { min-width: 0; padding: 0 2px; }
.sk b { display: block; font: 600 14px/19px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sk small { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font: 400 12px/17px var(--font-sans); color: var(--ink-3); margin-top: 4px; }
.sk .st { position: absolute; left: 10px; top: 10px; z-index: 1; height: 22px; padding: 0 9px; border-radius: 11px; background: rgba(0,0,0,.42); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); color: #fff; font: 500 11px/22px var(--font-sans); white-space: nowrap; }

/* 插件卡 */
.pl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.pl { border: 0; border-radius: 16px; background: var(--solid); box-shadow: var(--shadow-float); padding: 16px; display: flex; flex-direction: column; gap: 10px; min-width: 0; text-align: left; color: var(--ink); }
.pl .top { display: flex; align-items: center; gap: 12px; }
.pl .ico { width: 40px; height: 40px; border-radius: 12px; background: var(--fill-1); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.pl .ico .nv-i { width: 18px; height: 18px; }
.pl .nm { min-width: 0; }
.pl b { font: 600 14px/19px var(--font-sans); display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pl .by { font: 400 11px/14px var(--font-sans); color: var(--ink-4); display: block; margin-top: 2px; }
.pl p { margin: 0; font: 400 12px/18px var(--font-sans); color: var(--ink-3); flex: 1; }
.pl .ft { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pl .tools { font: 400 11px/1 var(--font-sans); color: var(--ink-4); }
.pl.add { cursor: pointer; background: var(--fill-1); box-shadow: none; justify-content: center; }
.pl.add:hover { background: var(--fill-2); }
.pl.add .ico { background: var(--solid); }
.pl.add p { flex: none; }

/* 应用卡 */
.ap-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 18px 14px; }
.app { border: 0; padding: 0; background: transparent; text-align: left; min-width: 0; cursor: pointer; color: var(--ink); }
.app .acv { position: relative; display: block; aspect-ratio: 16 / 10; border-radius: 14px; overflow: hidden; background: var(--fill-1); transition: transform .2s, box-shadow .2s; }
.app:hover .acv { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
.app .acv img { width: 100%; height: 100%; object-fit: cover; display: block; }
.app b { display: block; font: 600 13px/18px var(--font-sans); margin-top: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.app small { display: block; font: 400 12px/16px var(--font-sans); color: var(--ink-3); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.conn { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
.cn { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 0; border-radius: 12px; background: var(--fill-1); min-width: 0; text-align: left; cursor: pointer; color: var(--ink); }
.cn:hover { background: var(--fill-2); }
.cn .lt { width: 30px; height: 30px; border-radius: 9px; background: var(--solid); display: flex; align-items: center; justify-content: center; font: 600 12px/1 var(--font-sans); flex-shrink: 0; }
.cn b { flex: 1; min-width: 0; font: 500 12.5px/1 var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cn span:last-child { font: 400 11px/1 var(--font-sans); color: var(--ink-4); }
.chipbar { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
.chipbar button { height: 28px; padding: 0 12px; border: 0; border-radius: 14px; background: var(--fill-1); font: 500 12px/1 var(--font-sans); color: var(--ink-3); cursor: pointer; }
.chipbar button:hover { color: var(--ink); }
.chipbar button.on { background: var(--accent); color: var(--on-accent); }
.mk-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 56px 0; color: var(--ink-3); font: 400 12px/18px var(--font-sans); }
.mk-empty b { font: 500 14px/20px var(--font-sans); color: var(--ink); }
.mk-empty .nv-btn { margin-top: 8px; }
.mk-skel { margin-top: 36px; display: flex; flex-direction: column; gap: 24px; }
.mk-skel .big { height: 300px; border-radius: 18px; }
.mk-skel .row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
.mk-skel .row .nv-skel { height: 72px; border-radius: 14px; }

/* 721–1023：三张卡沿用基准比例（36.3% / step / scale / z / aspect 都不动），只收紧文字和内边距 */
@media (max-width: 980px) {
  .sk-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .hero { aspect-ratio: 2; }
  .hero-tx { left: 28px; bottom: 84px; max-width: 70%; }
  .hero-tx h3 { font: 600 28px/34px var(--font-sans); }
  .rail { left: 22px; right: auto; bottom: 18px; }
}
@media (max-width: 720px) {
  .mk-in { width: calc(100% - 32px); padding-top: calc(var(--tbh, 0px) + 20px); }
  .mk-search { width: 100%; order: 3; }
  .sk-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 12px; }
  .hero { aspect-ratio: 1.15; border-radius: 18px; }
  .hero-tx { left: 18px; right: 18px; bottom: 74px; max-width: none; }
  .hero-tx h3 { font: 600 24px/30px var(--font-sans); margin-top: 10px; }
  .hero-tx p { font: 400 13px/19px var(--font-sans); }
  .hero-tx .go { margin-top: 12px; height: 32px; }
  .rail { left: 50%; right: auto; transform: translateX(-50%); bottom: 14px; gap: 4px; padding: 4px; border-radius: 12px; }
  .rail button { width: 40px; height: 28px; border-radius: 8px; }
}
@media (prefers-reduced-motion: reduce) { .hs, .hs img, .hero-tx { transition: none; animation: none; } }
</style>
