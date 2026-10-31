<script setup>
// 首页：一句话开始。功能与旧 home.html 一一对应——
//   输入框（Agent / 图片 / 视频 三种方式、参考图上传≤6 张、粘贴 / 拖入、回车发送）、8 个技能（点一下搭节点 / 星芒交给 Agent）、
//   最近项目（新建 + 最近 4 张，点开直接进画布）、模板（分类 + 节点示意封面）、更多工具、局域网访问条、队列状态。
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import { state, toast } from '../../lib/store.js';
import { navigate, openCanvasUrl } from '../../lib/bridge.js';
import { useGlide } from '../../lib/glide.js';
import { CATS, TEMPLATES, TEMPLATE_MAP, SKILLS, MODES, MODE_KEY, SEED_PREFIX } from './templates.js';
import { diagram, templateKind, formatUpdateTime } from './layout.js';

/* ───────── 问候语 ───────── */
const h = new Date().getHours();
const greeting = (h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好') + '，今天想创作点什么';

/* ───────── 输入框 ───────── */
const EXAMPLES = {
    agent: ['给这双鞋做一套电商主图，白底 + 户外场景', '一句话剧情：雨夜便利店的相遇，出 9 宫格分镜', '为新品茶饮做一张竖版海报，夏日清爽感', '把这张人像做成三种风格的写真'],
    image: ['清晨海边的咖啡馆，胶片质感', '极简白色展台上的香水瓶，柔和棚拍光', '赛博朋克风格的雨夜街道，霓虹倒影'],
    video: ['镜头缓慢推近一杯冒着热气的咖啡', '产品在转台上缓慢旋转，光线在表面流动', '航拍清晨的山谷，云雾缓缓流动'],
};
const savedMode = (() => { try { return localStorage.getItem(MODE_KEY); } catch (e) { return null; } })();
const mode = ref(MODES.some(m => m.id === savedMode) ? savedMode : 'agent');
const text = ref('');
const refs = ref([]);           // {id, url, name, preview, loading}
const busy = ref(false);
const sendPhase = ref('');      // '' | loading | done
const focus = ref(false);
const drag = ref(false);
const shaking = ref(false);
const inputEl = ref(null);
const fileEl = ref(null);
const composerEl = ref(null);
const segEl = ref(null);
const segGlide = useGlide(segEl, 'button');

const modeInfo = computed(() => MODES.find(m => m.id === mode.value) || MODES[0]);
const uploading = computed(() => refs.value.some(r => r.loading));
const canSend = computed(() => !busy.value && !uploading.value && (text.value.trim().length > 0 || refs.value.length > 0));

// 空输入时轮播示例：旧文字上移淡出，新文字从下方进入（Text States）
const ex = reactive({ i: 0, phase: '' });
const exText = computed(() => { const list = EXAMPLES[mode.value] || EXAMPLES.agent; return list[ex.i % list.length]; });
function swapPhase(obj, apply) {
    obj.phase = 'out';
    setTimeout(() => { apply && apply(); obj.phase = 'pre'; setTimeout(() => { obj.phase = ''; }, 40); }, 150);
}
let exTimer = null;
const hint = reactive({ phase: '', text: '⇧↵ 换行' });
function setHint(v) { if (hint.text === v) return; swapPhase(hint, () => { hint.text = v; }); }
watch([text, sendPhase], () => {
    setHint(sendPhase.value === 'loading' ? '正在建画布…' : sendPhase.value === 'done' ? '已打开画布' : (text.value ? '↵ 发送' : '⇧↵ 换行'));
});

function pickMode(id) {
    mode.value = id;
    try { localStorage.setItem(MODE_KEY, id); } catch (e) {}
    ex.i = 0;
    segGlide.refresh();
    inputEl.value && inputEl.value.focus();
}
function autoGrow() {
    const el = inputEl.value; if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(200, Math.max(56, el.scrollHeight)) + 'px';
}
function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
}
function onPaste(e) {
    const files = Array.from((e.clipboardData && e.clipboardData.items) || []).map(it => (it.kind === 'file' ? it.getAsFile() : null)).filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); }
}
function hasFiles(e) { const ty = e.dataTransfer && e.dataTransfer.types; return !!(ty && Array.from(ty).includes('Files')); }
let dragDepth = 0;
function onDragEnter(e) { if (hasFiles(e)) { dragDepth++; drag.value = true; e.preventDefault(); } }
function onDragOver(e) { if (hasFiles(e)) e.preventDefault(); }
function onDragLeave() { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) drag.value = false; }
function onDrop(e) { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; drag.value = false; addFiles(e.dataTransfer.files); }

function addFiles(files) {
    let list = Array.from(files || []).filter(f => f && /^image\//.test(f.type));
    const room = 6 - refs.value.length;
    if (!list.length) return;
    if (room <= 0) { toast('最多 6 张参考图'); return; }
    if (list.length > room) toast('最多 6 张参考图，已取前 ' + room + ' 张');
    list = list.slice(0, room);
    const entries = list.map((f, i) => reactive({ id: 'r' + Date.now() + '_' + i, url: '', name: f.name || '参考图', preview: URL.createObjectURL(f), loading: true }));
    refs.value = refs.value.concat(entries);
    const form = new FormData();
    list.forEach(f => form.append('files', f, f.name || 'image.png'));
    fetch('/api/ai/upload', { method: 'POST', body: form })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(data => {
            const out = (data && data.files) || [];
            entries.forEach((entry, i) => {
                const f = out[i];
                if (f && f.url) { entry.url = f.url; entry.name = f.name || entry.name; entry.loading = false; }
                else refs.value = refs.value.filter(r => r !== entry);
            });
        })
        .catch(() => {
            refs.value = refs.value.filter(r => !entries.includes(r));
            toast('参考图上传失败，请重试', { danger: true, icon: 'alert' });
        });
}
function removeRef(id) { refs.value = refs.value.filter(r => r.id !== id); }
function readyRefs() { return refs.value.filter(r => r.url && !r.loading).map(r => ({ url: r.url, name: r.name })); }
function shake() {
    shaking.value = false;
    requestAnimationFrame(() => { shaking.value = true; setTimeout(() => { shaking.value = false; }, 420); });
    inputEl.value && inputEl.value.focus();
}

/* ───────── 画布：新建 / 打开 ───────── */
function canvasUrl(c) {
    const enc = encodeURIComponent(c.id);
    const project = encodeURIComponent(c.project || 'default');
    return (c.kind === 'smart' ? '/static/smart-canvas.html' : '/static/canvas.html') + '?id=' + enc + '&project=' + project;
}
function openCanvas(c) { openCanvasUrl(canvasUrl(c)); }
function timeTitle(prefix) { return prefix + ' ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
async function createCanvas(title) {
    const r = await fetch('/api/canvases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: String(title || '').slice(0, 60) || timeTitle('智能画布'), icon: 'layers', kind: 'smart', project: 'default' }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (!data || !data.canvas) throw new Error('no canvas');
    return data.canvas;
}
async function launch(title, seed) {
    if (busy.value) return;
    busy.value = true; sendPhase.value = 'loading';
    try {
        const c = await createCanvas(title);
        if (seed) { try { localStorage.setItem(SEED_PREFIX + c.id, JSON.stringify(seed)); } catch (e) {} }
        text.value = ''; refs.value = [];
        nextTick(autoGrow);
        sendPhase.value = 'done';
        setTimeout(() => { sendPhase.value = ''; }, 900);
        openCanvas(c);
        loadRecent();
    } catch (e) {
        sendPhase.value = '';
        toast('创建画布失败，请检查服务是否在运行', { danger: true, icon: 'alert' });
    } finally {
        busy.value = false;
    }
}
// 把模板变成种子：首页的参考图放进 ref 节点、输入框文字放进 brief 节点
function seedFromTemplate(t, opts = {}) {
    const rs = readyRefs();
    const tx = text.value.trim();
    const nodes = t.nodes.map(n => {
        const copy = JSON.parse(JSON.stringify(n));
        if (copy.ref && rs.length) copy.images = rs;
        if (copy.brief) copy.text = tx;
        return copy;
    });
    const seed = { v: 1, nodes, toast: t.toast };
    if (opts.agent) {
        seed.agent = t.agent + (tx ? '\n\n补充要求：' + tx : '');
        seed.autoSend = Boolean(tx || rs.length);
        seed.toast = '';
    }
    return seed;
}
function useTemplate(id, opts) {
    const t = TEMPLATE_MAP[id];
    if (t) launch(timeTitle(t.title), seedFromTemplate(t, opts));
}
function submit() {
    if (busy.value) return;
    if (uploading.value) { toast('参考图还在上传…'); return; }
    const tx = text.value.trim();
    const rs = readyRefs();
    if (!tx && !rs.length) { shake(); return; }
    const title = tx ? tx.replace(/\s+/g, ' ').slice(0, 20) : timeTitle('智能画布');
    const nodes = [];
    if (rs.length) nodes.push({ key: 'ref', type: 'image', title: '参考图', images: rs, col: 0 });
    if (mode.value === 'agent') {
        launch(title, { v: 1, nodes, agent: tx || '看看画布上的参考图，帮我规划可以做什么', autoSend: true });
        return;
    }
    if (!tx) { shake(); toast('写一句画面描述再发送'); return; }
    const video = mode.value === 'video';
    nodes.push({ key: 'gen', type: 'gen', title: video ? '视频' : '图片', prompt: tx, video, ratio: video ? '16:9' : '', inputs: rs.length ? ['ref'] : [], col: rs.length ? 1 : 0 });
    launch(title, { v: 1, nodes, autoRun: true });
}

/* ───────── 技能 ───────── */
const skills = SKILLS.map(s => ({ ...s, t: TEMPLATE_MAP[s.id], d: diagram(TEMPLATE_MAP[s.id]) }));
const peek = ref('');
let peekTimer = null;
function hoverSkill(id) { clearTimeout(peekTimer); peekTimer = setTimeout(() => { peek.value = id; }, 120); }
function leaveSkill() { clearTimeout(peekTimer); peek.value = ''; }

/* ───────── 最近项目 ───────── */
const recent = ref([]);
const recentLoaded = ref(false);
const canvasCount = ref(0);
async function loadRecent() {
    try {
        const r = await fetch('/api/recent-canvases', { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const list = await r.json();
        recent.value = Array.isArray(list) ? list.slice(0, 4) : [];
    } catch (e) { recent.value = []; }
    recentLoaded.value = true;
    try {
        const r = await fetch('/api/canvases', { cache: 'no-store' });
        const data = await r.json();
        canvasCount.value = Array.isArray(data && data.canvases) ? data.canvases.length : 0;
    } catch (e) {}
}
// Number Ticker：每一位滚到目标值
const tickDigits = computed(() => String(Math.min(999, canvasCount.value)).split('').map(Number));

/* ───────── 模板 ───────── */
const cat = ref('全部');
const tabsEl = ref(null);
const tabGlide = useGlide(tabsEl, '.nv-tab', { line: true });
const templates = computed(() => TEMPLATES.filter(t => cat.value === '全部' || t.cat === cat.value).map(t => ({ ...t, d: diagram(t), kind: templateKind(t) })));
function pickCat(c) { cat.value = c; tabGlide.refresh(); }

/* ───────── 更多工具 ───────── */
const TOOLS = [
    { route: 'online', icon: 'globe', title: '在线生图', desc: '文生图、图生图，多平台多模型' },
    { route: 'gpt-chat', icon: 'chat', title: 'GPT 对话', desc: '构思创意、优化提示词' },
    { route: 'asset-manager', icon: 'library', title: '素材库', desc: '管理生成作品、上传素材与提示词' },
];

/* ───────── 局域网访问条 ───────── */
const lan = reactive({ show: false, url: '', qr: '', qrOpen: false });
async function loadLan() {
    try { if (localStorage.getItem('lan_notice_closed') === '1') return; } catch (e) {}
    try {
        const data = await (await fetch('/api/lan-info')).json();
        if (!data || !data.available || !data.url) return;
        lan.url = data.url; lan.qr = data.qr_data_url || ''; lan.show = true;
    } catch (e) {}
}
function closeLan() { lan.show = false; try { localStorage.setItem('lan_notice_closed', '1'); } catch (e) {} }
function copyLan() { try { navigator.clipboard.writeText(lan.url); toast('已复制访问地址', { icon: 'check' }); } catch (e) {} }

/* ───────── 状态 ───────── */
const statusText = computed(() => (state.queue.position > 0 ? `排队中 ${state.queue.position}/${state.queue.total}` : state.queue.total > 0 ? `正在生成 ${state.queue.total} 个任务` : '系统就绪'));

function onFocusHome() { loadRecent(); }
onMounted(() => {
    autoGrow();
    loadRecent();
    loadLan();
    exTimer = setInterval(() => { if (!text.value && !busy.value) swapPhase(ex, () => { ex.i++; }); }, 3200);
    window.addEventListener('novai-home-focus', onFocusHome);
});
onBeforeUnmount(() => { clearInterval(exTimer); window.removeEventListener('novai-home-focus', onFocusHome); });
</script>

<template>
    <div class="home">
        <div class="home-in nv-enter">
            <!-- 局域网访问 -->
            <div v-if="lan.show" class="lan">
                <NvIcon name="wifi" />
                <span class="w5">手机 / iPad 访问</span>
                <button type="button" class="url" title="复制地址" @click="copyLan">{{ lan.url }}</button>
                <span class="grow"></span>
                <span class="qr-wrap" @mouseenter="lan.qrOpen = true" @mouseleave="lan.qrOpen = false">
                    <button type="button" class="nv-icon-btn sm" title="显示二维码" @click="lan.qrOpen = !lan.qrOpen"><NvIcon name="qr" /></button>
                    <div v-if="lan.qrOpen && lan.qr" class="qr-pop"><img :src="lan.qr" alt="访问二维码"><span>同一局域网下扫码打开</span></div>
                </span>
                <button type="button" class="nv-icon-btn sm" title="不再显示" @click="closeLan"><NvIcon name="x" /></button>
            </div>

            <header class="hero">
                <h1 class="display">{{ greeting }}</h1>
                <p class="p sub">写一句需求、选一个技能，画布上的节点会帮你搭好</p>
            </header>

            <div class="compose-col">
                <div ref="composerEl" class="nv-composer" :class="{ 'is-focus': focus, 'is-drag': drag, shake: shaking }"
                     @dragenter="onDragEnter" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
                    <div v-if="refs.length" class="refs">
                        <span v-for="r in refs" :key="r.id" class="hp-ref" :class="{ loading: r.loading }" :title="r.name" :style="{ backgroundImage: `url(${r.preview || r.url})` }">
                            <button type="button" class="x" aria-label="移除" @click="removeRef(r.id)"><NvIcon name="x" /></button>
                        </span>
                    </div>
                    <label for="hp-input" class="sr">需求</label>
                    <div class="ta-wrap">
                        <textarea id="hp-input" ref="inputEl" v-model="text" rows="1" @input="autoGrow" @keydown="onKey" @paste="onPaste" @focus="focus = true" @blur="focus = false"></textarea>
                        <div v-if="!text" class="tw-ph"><span class="swap" :class="ex.phase">{{ exText }}</span></div>
                    </div>
                    <div class="nv-composer-bar">
                        <button type="button" class="nv-icon-btn sm" :title="refs.length ? `参考图 ${refs.length}/6` : '添加参考图（也可粘贴或拖入）'" @click="fileEl.click()"><NvIcon name="clip" /></button>
                        <input ref="fileEl" type="file" accept="image/*" multiple hidden @change="addFiles($event.target.files); $event.target.value = ''">
                        <div ref="segEl" class="nv-seg" role="radiogroup" aria-label="生成方式">
                            <span class="thumb-slide" data-glide-pill></span>
                            <button v-for="m in MODES" :key="m.id" type="button" role="radio" :aria-checked="m.id === mode" :class="{ 'is-on': m.id === mode }" :title="m.tip" @click="pickMode(m.id)">{{ m.label }}</button>
                        </div>
                        <span class="hint"><span class="swap" :class="hint.phase">{{ hint.text }}</span></span>
                        <button type="button" class="nv-icon-btn send send-live send-morph" :class="{ on: canSend || sendPhase }" :disabled="!canSend && !sendPhase" aria-label="发送" @click="submit">
                            <span class="ico" :class="{ hide: sendPhase }"><NvIcon name="arrowup" /></span>
                            <span class="ico" :class="{ hide: sendPhase !== 'loading' }"><span class="spin"></span></span>
                            <span class="ico" :class="{ hide: sendPhase !== 'done' }"><NvIcon name="check" /></span>
                        </button>
                    </div>
                    <span class="beam-edge" aria-hidden="true"></span>
                    <div v-if="drag" class="drop-veil"><NvIcon name="image" />松手添加参考图</div>
                </div>

                <!-- 技能：点一下搭节点；右侧星芒交给 Agent -->
                <div class="skills">
                    <span v-for="s in skills" :key="s.id" class="skill-wrap" @mouseenter="hoverSkill(s.id)" @mouseleave="leaveSkill">
                        <button type="button" class="nv-link" :class="{ 'is-hot': peek === s.id }" @click="useTemplate(s.id)">{{ s.label }}</button>
                        <button type="button" class="agent-dot" :aria-label="'让 Agent 做' + s.label" title="让 Agent 做：打开画布并交给 Agent 规划执行" @click="useTemplate(s.id, { agent: true })"><NvIcon name="sparkles" /></button>
                        <div v-if="peek === s.id" class="skill-peek" role="tooltip">
                            <div class="diagram">
                                <svg viewBox="0 0 100 100" preserveAspectRatio="none"><path v-for="(w, i) in s.d.wires" :key="i" class="w" :d="w" vector-effect="non-scaling-stroke" /></svg>
                                <span v-for="(b, i) in s.d.boxes" :key="b.key" class="box" :class="{ g: b.gen }"
                                      :style="{ left: b.x + '%', top: b.y + '%', width: b.w + '%', height: b.h + '%', animationDelay: i * 45 + 'ms' }"></span>
                            </div>
                            <b>{{ s.label }}</b>
                            <span>{{ s.t.desc }} · 点击搭好节点</span>
                        </div>
                    </span>
                </div>
            </div>

            <!-- 最近项目 -->
            <section class="sec">
                <div class="head">
                    <h2 class="t2">最近项目</h2>
                    <button type="button" class="nv-link" @click="navigate('canvas')">
                        全部画布
                        <span v-if="canvasCount" class="ticker" aria-label="画布数量">
                            <span v-for="(d, n) in tickDigits" :key="n" class="col" :style="{ transform: `translateY(${-d * 1.25}em)`, transitionDelay: n * 80 + 'ms' }">
                                <span v-for="k in 10" :key="k">{{ k - 1 }}</span>
                            </span>
                        </span>
                        <NvIcon name="arrowr" class="arrow" />
                    </button>
                </div>
                <div class="gallery5">
                    <button type="button" class="nv-tile new" @click="launch(timeTitle('智能画布'), null)">
                        <span class="nv-tile-media"><NvIcon name="plus" :size="20" /></span>
                        <span class="nv-tile-title">新建画布</span>
                        <span class="nv-tile-sub">空白智能画布</span>
                    </button>
                    <template v-if="!recentLoaded">
                        <div v-for="i in 4" :key="'s' + i" class="skel-wrap loading" style="aspect-ratio: 4 / 3"><span class="skel"></span></div>
                    </template>
                    <template v-else>
                    <button v-for="c in recent" :key="c.id" type="button" class="nv-tile" @click="openCanvas(c)">
                        <span class="nv-tile-media">
                            <img v-if="c.thumbnail" class="thumb" :src="c.thumbnail" loading="lazy" alt="" @error="c.thumbnail = ''">
                            <NvIcon v-else name="layers" :size="22" />
                            <span class="nv-badge on-image">{{ c.kind === 'smart' ? '智能画布' : '智能画布BEAT' }}</span>
                        </span>
                        <span class="nv-tile-title">{{ c.title || c.name || '未命名画布' }}</span>
                        <span class="nv-tile-sub">更新于 {{ formatUpdateTime(c.updated_at || c.lastOpened) }}</span>
                    </button>
                    </template>
                </div>
            </section>

            <!-- 模板：列表为空时整块收起，后续逐项加入后再展示 -->
            <section v-if="templates.length" class="sec">
                <div class="head center">
                    <h2 class="t2">模板</h2>
                    <div ref="tabsEl" class="nv-tabs sliding" role="tablist">
                        <span class="tab-line" data-glide-pill></span>
                        <button v-for="c in CATS" :key="c" type="button" role="tab" class="nv-tab" :class="{ 'is-on': c === cat }" :aria-selected="c === cat" @click="pickCat(c)">{{ c }}</button>
                    </div>
                </div>
                <TransitionGroup name="tpl" tag="div" class="gallery4">
                    <button v-for="t in templates" :key="t.id" type="button" class="nv-tile tilt" @click="useTemplate(t.id)">
                        <span class="nv-tile-media tpl-media">
                            <svg class="tpl-wires" viewBox="0 0 100 100" preserveAspectRatio="none"><path v-for="(w, i) in t.d.wires" :key="i" class="wire" :d="w" vector-effect="non-scaling-stroke" /></svg>
                            <span v-for="b in t.d.boxes" :key="b.key" class="mini" :class="{ gen: b.gen }" :style="{ left: b.x + '%', top: b.y + '%', width: b.w + '%', height: b.h + '%' }">
                                <NvIcon v-if="b.video" name="play" class="mk" />
                            </span>
                            <span class="nv-badge"><NvIcon :name="t.kind.icon" class="sm" />{{ t.kind.label }}</span>
                            <span class="use-tpl"><NvIcon name="plus" />用这个模板</span>
                        </span>
                        <span class="nv-tile-title">{{ t.title }}</span>
                        <span class="nv-tile-sub">{{ t.d.count }} 个节点 · {{ t.desc }}</span>
                    </button>
                </TransitionGroup>
            </section>

            <!-- 更多工具 -->
            <section class="sec">
                <div class="head"><h2 class="t2">更多工具</h2></div>
                <div class="tool-row">
                    <button v-for="tl in TOOLS" :key="tl.route" type="button" class="tool-card" @click="navigate(tl.route)">
                        <span class="ic"><NvIcon :name="tl.icon" /></span>
                        <span><b>{{ tl.title }}</b><span>{{ tl.desc }}</span></span>
                    </button>
                </div>
            </section>

            <div class="status"><span class="dot" :class="{ busy: state.queue.total > 0 }"></span><span class="cap">{{ statusText }}</span></div>
        </div>
    </div>
</template>

<style scoped>
.home { position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden; }
.home-in { width: min(1080px, calc(100% - 96px)); margin: 0 auto; padding: 28px 0 64px; display: flex; flex-direction: column; }
.lan { margin-bottom: 44px; position: relative; }
.lan .url { border: 0; background: none; padding: 0; cursor: pointer; font: 400 12px/1 var(--font-mono); color: var(--ink-3); }
.lan .url:hover { color: var(--ink); }
.w5 { font-weight: 500; }
.grow { flex: 1; }
.qr-wrap { position: relative; }
.qr-pop { position: absolute; right: 0; top: calc(100% + 8px); z-index: 30; width: 184px; padding: 12px; border-radius: 14px; background: var(--solid); box-shadow: var(--shadow-pop); display: flex; flex-direction: column; align-items: center; gap: 8px; animation: nv-pop var(--duration-base) var(--ease-out) both; }
.qr-pop img { width: 160px; height: 160px; border-radius: 8px; background: #fff; }
.qr-pop span { font: 400 11px/16px var(--font-sans); color: var(--ink-3); }
.hero { text-align: center; margin-top: 36px; }
.hero .sub { margin-top: 8px; color: var(--ink-3); }
.compose-col { display: flex; flex-direction: column; align-items: center; gap: 22px; margin-top: 28px; }
.nv-composer { width: min(680px, 100%); }
.nv-composer.is-drag { box-shadow: var(--shadow-rim), var(--shadow-lift); }
.nv-composer.shake { animation: shake 400ms var(--ease-out); }
@keyframes shake { 20% { transform: translateX(-6px); } 40% { transform: translateX(5px); } 60% { transform: translateX(-3px); } 80% { transform: translateX(2px); } }
.refs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.hp-ref .x { border: 0; padding: 0; cursor: pointer; opacity: 0; transition: opacity var(--duration-fast); }
.hp-ref:hover .x { opacity: 1; }
.hp-ref .x :deep(.nv-i) { width: 10px; height: 10px; }
.ta-wrap { position: relative; }
.ta-wrap textarea { display: block; }
.ta-wrap .tw-ph { left: 0; top: 2px; right: 0; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.drop-veil { position: absolute; inset: 0; border-radius: inherit; background: var(--glass-strong); backdrop-filter: var(--material-thin); display: flex; align-items: center; justify-content: center; gap: 8px; font: 500 13px/1 var(--font-sans); color: var(--ink); pointer-events: none; }
.skills { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 34px; max-width: 980px; }
.skill-wrap .agent-dot { border: 0; padding: 0; cursor: pointer; }
.sec { margin-top: 64px; display: flex; flex-direction: column; gap: 18px; }
.sec:first-of-type { margin-top: 80px; }
.head.center { align-items: center; }
.nv-tile.new .nv-tile-media { color: var(--ink-3); }
.nv-tile.new:hover .nv-tile-media { color: var(--ink); }
.thumb { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transition: transform 600ms var(--ease-out); }
.nv-tile:hover .thumb { transform: scale(1.03); }
.tpl-media { background: var(--fill-1); }
.tpl-wires { position: absolute; inset: 0; width: 100%; height: 100%; }
.mini { display: flex; align-items: center; justify-content: center; }
.mini .mk { width: 12px; height: 12px; color: var(--ink-3); }
.tpl-media .nv-badge { left: 10px; top: 10px; }
.tpl-media .nv-badge .nv-i { width: 11px; height: 11px; }
.tool-card { border: 0; cursor: pointer; text-align: left; color: var(--ink); font: inherit; }
.status { display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 56px; }
.status .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ink); }
.status .dot.busy { animation: nv-breathe 1.6s var(--ease-in-out) infinite; }
.tpl-enter-active, .tpl-leave-active { transition: opacity 240ms var(--ease-out), transform 240ms var(--ease-out); }
.tpl-enter-from, .tpl-leave-to { opacity: 0; transform: translateY(6px); }
.tpl-leave-active { position: absolute; visibility: hidden; }
.tpl-move { transition: transform 320ms var(--ease-out); }
@media (max-width: 1100px) { .gallery5 { grid-template-columns: repeat(3, minmax(0, 1fr)); } .gallery4 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
