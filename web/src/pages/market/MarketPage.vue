<script setup>
// 应用市场（2026-11 按原型重做）：推荐 / 技能 / 插件 / 应用 / 已安装。
// 数据全部是真的：
//   市场条目 → /api/store/catalog（curation 里停用的条目显示「即将上线」，不能安装 / 启动）
//   官方 / 内置技能（后端从技能注册表并进 catalog，builtin=true）与市场技能同一套卡片渲染
//   插件 → 联网搜索开关（/api/agent/web-access）+ MCP 服务（/api/mcp/servers；启用要二次确认，交给设置页）
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import MarketDetail from './MarketDetail.vue';
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

/* ── 轮播（coverflow） ── */
const cf = ref(0);
let timer = 0;
function cfGo(i) { const n = SHOWCASE.length; if (n) cf.value = (i + n) % n; }
function cfStyle(i) {
    const n = SHOWCASE.length;
    let d = i - cf.value;
    if (d > n / 2) d -= n;
    if (d < -n / 2) d += n;
    const a = Math.abs(d);
    // 步长 / 后退距离 / 倾角 / 缩放都走 .cf 上的变量，窄屏由媒体查询单独调
    return {
        transform: `translateX(calc(-50% + ${d} * var(--cf-step))) translateZ(${a ? 'var(--cf-z)' : '0px'}) rotateY(calc(${-d} * var(--cf-tilt))) scale(${a ? 'var(--cf-scale)' : 1})`,
        zIndex: 10 - a,
        filter: a ? 'brightness(.7)' : 'none',
        '--cf-o': a > 1 ? 0 : 1,
        '--cf-pe': a > 1 ? 'none' : 'auto',
    };
}
const hovering = ref(false);
function autoplay() {
    clearInterval(timer);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    timer = setInterval(() => {
        if (state.active === 'store' && tab.value === 'rec' && !searching.value && !document.hidden && !hovering.value && !detail.value) cfGo(cf.value + 1);
    }, 5000);
}
function showcaseGo(it) {
    if (it.to === 'skills') openSettings('skills');
    else navigate(it.to);
}
function cfClick(i, it) { if (i === cf.value) showcaseGo(it); else { cfGo(i); autoplay(); } }

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
function onFocus(e) { if (e.detail && e.detail.id === 'store') loadPlugins(); }
watch(() => state.settingsOpen, open => { if (!open && state.active === 'store') loadPlugins(); });
onMounted(() => { load(); autoplay(); window.addEventListener('novai-page-focus', onFocus); });
onBeforeUnmount(() => { clearInterval(timer); window.removeEventListener('novai-page-focus', onFocus); });
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
                        <div class="mk-sh"><h2>最新上线</h2>
                            <div class="ar"><button type="button" class="flip" aria-label="上一张" @click="cfGo(cf - 1); autoplay()"><NvIcon name="chevr" /></button><button type="button" aria-label="下一张" @click="cfGo(cf + 1); autoplay()"><NvIcon name="chevr" /></button></div>
                        </div>
                        <div class="cf" @mouseenter="hovering = true" @mouseleave="hovering = false">
                            <div v-for="(it, i) in SHOWCASE" :key="it.id" class="cf-card" :class="{ on: i === cf }" :style="cfStyle(i)" role="button" :tabindex="i === cf ? 0 : -1" :aria-label="it.title" @click="cfClick(i, it)" @keydown.enter="cfClick(i, it)">
                                <img :src="it.cover" alt="" loading="lazy" decoding="async">
                                <span class="t"><b>{{ it.title }}</b><small>{{ it.desc }}</small></span>
                                <span class="cat"><NvIcon :name="it.icon" />{{ it.tag }}</span>
                            </div>
                        </div>
                        <div class="cf-dots"><button v-for="(it, i) in SHOWCASE" :key="it.id" type="button" :class="{ on: i === cf }" :aria-label="'第 ' + (i + 1) + ' 张'" @click="cfGo(i); autoplay()"></button></div>
                    </section>

                    <section v-if="storeSkills.length" class="mk-sec">
                        <div class="mk-sh"><h2>精选技能</h2><button type="button" class="more" @click="setTab('skill')">查看全部<NvIcon name="chevr" /></button></div>
                        <div class="sk-grid">
                            <button v-for="it in byAvail(storeSkills).slice(0, 9)" :key="it.name" type="button" class="sk" @click="openStore(it)">
                                <span class="ico"><img v-if="it.coverUrl" :src="it.coverUrl" alt="" loading="lazy" decoding="async" @error="e => (e.target.style.visibility = 'hidden')"><NvIcon v-else :name="skillIcon(it)" /></span>
                                <span class="tx"><b>{{ it.displayName }}</b><small>{{ it.marketingLine || it.description }}</small></span>
                                <span v-if="it.builtin" class="st">官方{{ it.installed ? ' · 已添加' : '' }}</span>
                                <span v-else-if="!it.storeAvailable" class="st">即将上线</span>
                                <span v-else-if="it.installed" class="st">已添加</span>
                                <span v-else class="go"><NvIcon name="chevr" /></span>
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
                            <button v-for="it in byAvail(storeApps).slice(0, 4)" :key="it.name" type="button" class="app" @click="openStore(it)">
                                <span class="acv"><img v-if="it.coverUrl" :src="it.coverUrl" alt="" loading="lazy" decoding="async" @error="e => (e.target.style.visibility = 'hidden')"><span v-if="!it.storeAvailable" class="soon">即将上线</span></span>
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
                                <button v-for="it in skillList" :key="it.name" type="button" class="sk" @click="openStore(it)">
                                    <span class="ico"><img v-if="it.coverUrl" :src="it.coverUrl" alt="" loading="lazy" decoding="async" @error="e => (e.target.style.visibility = 'hidden')"><NvIcon v-else :name="skillIcon(it)" /></span>
                                    <span class="tx"><b>{{ it.displayName }}</b><small>{{ it.marketingLine || it.description }}</small></span>
                                    <span v-if="it.builtin" class="st">官方{{ it.installed ? ' · 已添加' : '' }}</span>
                                    <span v-else-if="!it.storeAvailable" class="st">即将上线</span>
                                    <span v-else-if="it.installed" class="st">已添加</span>
                                    <span v-else class="go"><NvIcon name="chevr" /></span>
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
                            <button v-for="it in appList" :key="it.name" type="button" class="app" @click="openStore(it)">
                                <span class="acv"><img v-if="it.coverUrl" :src="it.coverUrl" alt="" loading="lazy" decoding="async" @error="e => (e.target.style.visibility = 'hidden')"><span v-if="!it.storeAvailable" class="soon">即将上线</span></span>
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
                            <button v-for="it in installedStore.filter(hitStore)" :key="it.kind + it.name" type="button" class="sk" @click="openStore(it)">
                                <span class="ico"><img v-if="it.coverUrl" :src="it.coverUrl" alt="" loading="lazy" decoding="async" @error="e => (e.target.style.visibility = 'hidden')"><NvIcon v-else :name="skillIcon(it)" /></span>
                                <span class="tx"><b>{{ it.displayName }}</b><small>{{ it.marketingLine || it.description }}</small></span>
                                <span class="go"><NvIcon name="chevr" /></span>
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

/* 轮播：中间一张最大，两侧略小、后退并朝外倾斜
   宽 36.3% 内容宽、步长 103.6%（补偿透视把平面位移放大的部分）：三张卡 + 3~4px 细缝正好铺满内容区，三张都完整可见 */
.cf { position: relative; aspect-ratio: 4.9; perspective: 1000px; --cf-step: 103.6%; --cf-z: -120px; --cf-tilt: 12deg; --cf-scale: .91; }
.cf-card { position: absolute; top: 0; left: 50%; width: 36.3%; height: 100%; border-radius: 16px; overflow: hidden; background: var(--fill-1); cursor: pointer; outline: none; box-shadow: var(--shadow-float);
  opacity: var(--cf-o, 1); pointer-events: var(--cf-pe, auto);
  transition: transform .55s cubic-bezier(.2,.8,.2,1), opacity .55s, filter .55s, box-shadow .2s; will-change: transform; }
.cf-card:focus-visible { box-shadow: var(--shadow-pop); }
.cf-card img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cf-card::after { content: ""; position: absolute; inset: 34% 0 0; background: linear-gradient(transparent, rgba(0,0,0,.72)); pointer-events: none; }
.cf-card .t { position: absolute; left: 18px; right: 124px; bottom: 15px; z-index: 1; color: #fff; }
.cf-card .t b { display: block; font: 600 15px/21px var(--font-sans); letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cf-card .t small { display: block; font: 400 11px/15px var(--font-sans); opacity: .8; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cf-card .cat { position: absolute; right: 14px; bottom: 15px; z-index: 1; height: 22px; padding: 0 9px; border-radius: 11px; background: rgba(255,255,255,.16); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); color: #fff; font: 400 10.5px/1 var(--font-sans); display: flex; align-items: center; gap: 4px; white-space: nowrap; }
.cf-card .cat .nv-i { width: 11px; height: 11px; }
.soon { position: absolute; left: 12px; top: 12px; z-index: 1; height: 22px; padding: 0 9px; border-radius: 11px; background: rgba(0,0,0,.45); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); color: #fff; font: 400 11px/22px var(--font-sans); }
.cf-dots { display: flex; justify-content: center; gap: 5px; margin-top: 18px; }
.cf-dots button { width: 5px; height: 5px; padding: 0; border: 0; border-radius: 3px; background: var(--fill-3); cursor: pointer; transition: width .3s, background .3s; }
.cf-dots button.on { width: 18px; background: var(--ink); }

/* 技能：三列列表 */
.sk-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px 28px; }
.sk { display: flex; align-items: center; gap: 14px; padding: 12px 10px; border: 0; border-radius: 14px; background: transparent; text-align: left; min-width: 0; cursor: pointer; color: var(--ink); transition: background var(--duration-fast); }
.sk:hover { background: var(--fill-1); }
.sk .ico { width: 48px; height: 48px; border-radius: 14px; background: var(--fill-1); display: flex; align-items: center; justify-content: center; flex-shrink: 0; overflow: hidden; color: var(--ink); }
.sk:hover .ico { background: var(--fill-2); }
.sk .ico .nv-i { width: 20px; height: 20px; }
.sk .ico img { width: 100%; height: 100%; object-fit: cover; }
.sk .tx { flex: 1; min-width: 0; }
.sk b { display: block; font: 600 14px/19px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sk small { display: block; font: 400 12px/16px var(--font-sans); color: var(--ink-3); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sk .go { color: var(--ink-4); display: inline-flex; transition: transform .2s, color .2s; }
.sk .go .nv-i { width: 15px; height: 15px; }
.sk:hover .go { color: var(--ink); transform: translateX(3px); }
.sk .st { font: 400 11px/1 var(--font-sans); color: var(--ink-3); flex-shrink: 0; }

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
  .sk-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cf-card { border-radius: 14px; }
  .cf-card .t { left: 14px; right: 16px; bottom: 12px; }
  .cf-card .t b { font: 600 13.5px/19px var(--font-sans); }
  .cf-card .t small { font: 400 10.5px/14px var(--font-sans); }
  .cf-card .cat { top: 12px; right: 12px; bottom: auto; height: 20px; padding: 0 8px; font: 400 10px/1 var(--font-sans); }
}
@media (max-width: 720px) {
  .mk-in { width: calc(100% - 32px); padding-top: calc(var(--tbh, 0px) + 20px); }
  .mk-search { width: 100%; order: 3; }
  .sk-grid { grid-template-columns: minmax(0, 1fr); }
  /* 手机上一屏一卡：不把邻卡切在窗口边缘 */
  .cf { aspect-ratio: 1.78; perspective: none; --cf-step: 0%; --cf-z: 0px; --cf-tilt: 0deg; --cf-scale: 1; }
  .cf-card { width: 100%; border-radius: 16px; opacity: 0; pointer-events: none; }
  .cf-card.on { opacity: 1; pointer-events: auto; }
  .cf-card .t { left: 16px; right: 16px; bottom: 14px; }
  .cf-card .t b { font: 600 15px/21px var(--font-sans); }
  .cf-card .t small { font: 400 11px/15px var(--font-sans); }
  .cf-card .cat { top: 14px; right: 14px; bottom: auto; height: 22px; padding: 0 9px; font: 400 10.5px/1 var(--font-sans); }
  .cf-dots { margin-top: 14px; }
}
@media (prefers-reduced-motion: reduce) { .cf-card { transition: none; } }
</style>
