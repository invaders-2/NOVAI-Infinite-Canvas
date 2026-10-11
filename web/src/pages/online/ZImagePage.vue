<script setup>
// Z-Image（页面 id: zimage，替换旧 static/zimage.html）。
// 控制台：提示词、引擎来源（本地 / ModelScope，记在 zimage_engine_mode）、尺寸、生成（处理中）、系统就绪 / 排队 x/y；
// 图库：pending 占位卡、常驻批量操作条、加载更多 / 加载失败；大图预览与在线生图共用。
// 接口照旧：本地 POST /api/generate {prompt,width,height,type:'zimage',client_id}；
// 云端 GET /api/config/token → POST /generate {prompt,api_key,resolution}；GET /api/history?type=zimage；
// 新图推送：/ws/stats 的 new_image（data.type === 'zimage'）。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import ArchiveGrid from './ArchiveGrid.vue';
import ImageLightbox from './ImageLightbox.vue';
import { state, t, toast } from '../../lib/store.js';
import { fetchHistory, downloadUrl, extOf, clientId } from './download.js';

const PAGE_SIZE = 15;
const MS_TOKEN_KEY = 'modelscope_api_token';
const ENGINE_MODE_KEY = 'zimage_engine_mode';
const CLIENT_ID = clientId();

const root = ref(null);
const prompt = ref('');
const width = ref(1024);
const height = ref(1024);
const engine = ref((() => { try { return localStorage.getItem(ENGINE_MODE_KEY) === 'cloud' ? 'cloud' : 'local'; } catch (e) { return 'local'; } })());
const loading = ref(false);
const pending = ref([]);
const history = ref([]);
const shown = ref(0);
const status = ref('first');
const lbIndex = ref(-1);

const queued = computed(() => state.queue.total > 0);
const statusText = computed(() => (queued.value ? `排队中 ${state.queue.position}/${state.queue.total}` : t('studio.ready', '系统就绪')));
const btnText = computed(() => (engine.value === 'local' ? t('studio.renderLocal', '本地生成') : t('studio.renderCloud', '云端生成')));
const visible = computed(() => history.value.slice(0, shown.value));
const hasMore = computed(() => shown.value < history.value.length);
const entries = computed(() => visible.value.flatMap(item => (item.images || []).filter(Boolean).map((url, i) => ({ url, prompt: item.prompt || '', item, sub: i }))));

function switchEngine(mode) {
    engine.value = mode;
    try { localStorage.setItem(ENGINE_MODE_KEY, mode); } catch (e) {}
}
function addCard(item) {
    if (!item || !item.images || !item.images[0]) return;
    if (history.value.some(h => String(h.timestamp) === String(item.timestamp))) return;
    history.value.unshift(item);
    shown.value++;
}
function dims() { return { w: parseInt(width.value, 10), h: parseInt(height.value, 10) }; }

async function handleRender() {
    const text = prompt.value.trim();
    if (!text) { toast('请输入提示词', { danger: true, icon: 'alert' }); return; }
    if (loading.value) return;
    if (engine.value === 'local') runLocal(text); else runCloud(text);
}

// ModelScope：优先用 API 设置里集中管理的 Token（服务端）；localStorage 仅作旧版兜底
async function runCloud(text) {
    let apiKey = '';
    try { const data = await fetch('/api/config/token').then(r => r.json()); if (data.token) apiKey = data.token; } catch (e) {}
    if (apiKey) { try { localStorage.removeItem(MS_TOKEN_KEY); } catch (e) {} }
    else { try { apiKey = localStorage.getItem(MS_TOKEN_KEY) || ''; } catch (e) {} }
    if (!apiKey) { toast(t('studio.modelscopeTokenRequired', '需要 ModelScope Token，请在侧边栏 API Token 中设置。'), { danger: true, icon: 'alert', duration: 4200 }); return; }
    const p = { key: 'c' + Date.now(), label: 'ModelScope 生成中' };
    loading.value = true; pending.value = [p, ...pending.value];
    try {
        const { w, h } = dims();
        const res = await fetch('/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: text, api_key: apiKey, resolution: `${w}x${h}` }) });
        const data = await res.json();
        if (res.ok && data.url) addCard({ timestamp: Date.now(), prompt: text, images: [data.url], type: 'cloud' });
        else throw new Error((data.detail && data.detail.errors && data.detail.errors.message) || (typeof data.detail === 'string' && data.detail) || '云端生成失败');
    } catch (e) {
        toast((e && e.message) || '云端生成失败', { danger: true, icon: 'alert' });
    } finally {
        pending.value = pending.value.filter(x => x !== p); loading.value = false;
    }
}

async function runLocal(text) {
    const p = { key: 'l' + Date.now(), label: '本地生成中' };
    loading.value = true; pending.value = [p, ...pending.value];
    try {
        const { w, h } = dims();
        const res = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: text, width: w, height: h, type: 'zimage', client_id: CLIENT_ID }) });
        const data = await res.json();
        if (data.images && data.images.length > 0) addCard(data);
    } catch (e) {
        toast('本地生成失败', { danger: true, icon: 'alert' });
    } finally {
        pending.value = pending.value.filter(x => x !== p); loading.value = false;
    }
}

async function loadHistory() {
    status.value = 'first';
    try {
        history.value = await fetchHistory('zimage');
        shown.value = Math.min(PAGE_SIZE, history.value.length);
        status.value = 'idle';
    } catch (e) { console.error(e); status.value = 'error'; }
}
function loadMore() {
    if (status.value === 'error') { loadHistory(); return; }
    shown.value = Math.min(history.value.length, shown.value + PAGE_SIZE);
}
function removeHistory(list) {
    const set = new Set(list.map(String));
    const before = history.value.length;
    history.value = history.value.filter(h => !set.has(String(h.timestamp)));
    shown.value = Math.max(0, shown.value - (before - history.value.length));
}

function openItem(item) { const i = entries.value.findIndex(e => e.item === item && e.sub === 0); if (i >= 0) lbIndex.value = i; }
async function download(e) {
    try { await downloadUrl(e.url, `Art-${Date.now()}.${extOf(e.url)}`); }
    catch (err) { toast('下载失败', { danger: true, icon: 'alert' }); }
}
function reuse(e) {
    prompt.value = e.prompt || '';
    lbIndex.value = -1;
    if (root.value) root.value.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ───────── 新图推送（与旧页面一样自己连 /ws/stats；外壳若转发 new_image 也能接） ───────── */
function onNewImage(msg) {
    if (msg && msg.type === 'new_image' && msg.data && msg.data.type === 'zimage') addCard(msg.data);
}
function onMessage(e) { onNewImage(e && e.data); }
let ws = null, wsTimer = null, alive = true;
function openSocket() {
    if (!alive || typeof WebSocket === 'undefined' || !location.host) return;
    try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/stats?client_id=${encodeURIComponent(CLIENT_ID)}`); } catch (e) { return; }
    ws.onmessage = ev => { try { onNewImage(JSON.parse(ev.data)); } catch (err) {} };
    ws.onclose = () => { if (alive) wsTimer = setTimeout(openSocket, 5000); };
}

onMounted(() => {
    loadHistory();
    openSocket();
    window.addEventListener('message', onMessage);
});
onBeforeUnmount(() => {
    alive = false;
    clearTimeout(wsTimer);
    if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} }
    window.removeEventListener('message', onMessage);
});
</script>

<template>
    <div ref="root" class="zip">
        <div class="wrap">
            <section class="con">
                <div class="top">
                    <span class="eyebrow">{{ t('studio.unifiedConsole', '统一创作控制台') }}</span>
                    <span class="stat" :class="{ q: queued }"><i></i>{{ statusText }}</span>
                </div>
                <textarea v-model="prompt" class="zp" rows="2" :placeholder="t('studio.describeVision', '描述你想生成的画面...')"></textarea>
                <div class="bar">
                    <div class="f">
                        <span class="cap">{{ t('studio.engineSource', '引擎来源') }}</span>
                        <div class="nv-seg zseg" data-glide="button" data-glide-active="is-on" role="radiogroup" aria-label="引擎来源">
                            <button type="button" role="radio" :aria-checked="engine === 'local'" :class="{ 'is-on': engine === 'local' }" @click="switchEngine('local')"><NvIcon name="monitor" />{{ t('studio.local', '本地') }}</button>
                            <button type="button" role="radio" :aria-checked="engine === 'cloud'" :class="{ 'is-on': engine === 'cloud' }" @click="switchEngine('cloud')"><NvIcon name="cloud" />ModelScope</button>
                        </div>
                    </div>
                    <div class="f">
                        <span class="cap">{{ t('studio.dimensions', '尺寸') }}</span>
                        <div class="dim">
                            <input v-model="width" type="number" aria-label="宽度" />
                            <b>×</b>
                            <input v-model="height" type="number" aria-label="高度" />
                        </div>
                    </div>
                    <button type="button" class="go" :class="{ busy: loading }" :disabled="loading" @click="handleRender">
                        <span v-if="loading" class="spin"></span><NvIcon v-else name="bolt" />
                        {{ loading ? t('studio.processing', '处理中...') : btnText }}
                    </button>
                </div>
            </section>

            <ArchiveGrid class="gal" :items="visible" :pending="pending" :has-more="hasMore" :status="status" :title="t('online.archives', '归档')"
                @open="openItem" @load-more="loadMore" @removed="removeHistory">
                <template #badge="{ item }">
                    <span v-if="item.type === 'cloud'" class="ms"><img :src="'/static/images/modelscope.gif'" alt="ModelScope" /></span>
                </template>
            </ArchiveGrid>
        </div>

        <ImageLightbox v-model="lbIndex" :entries="entries" :prompt-label="'Z-Image · ' + t('studio.promptExecution', '提示词记录')" :reuse-label="t('studio.replicate', '复用')"
            @reuse="reuse" @download="download" />
    </div>
</template>

<style scoped>
.zip { position: absolute; inset: 0; overflow-y: auto; background: transparent; color: var(--ink); font-family: var(--font-sans); scrollbar-width: none; }
.zip::-webkit-scrollbar { display: none; }
.wrap { max-width: 1280px; margin: 0 auto; padding: 48px 24px 72px; display: flex; flex-direction: column; gap: 48px; }
.con { border-radius: 22px; background: var(--solid); box-shadow: var(--shadow-float); padding: 20px 22px 18px; display: flex; flex-direction: column; gap: 16px; }
.top { display: flex; align-items: center; gap: 8px; }
.stat { margin-left: auto; display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 10px; border-radius: 99px; background: var(--fill-1); font: 400 11px/1 var(--font-mono); letter-spacing: .03em; color: var(--ink-2); }
.stat i { width: 6px; height: 6px; border-radius: 50%; background: var(--ink); }
.stat.q i { background: var(--ink-3); animation: nv-breathe 1.2s var(--ease-in-out) infinite; }
.zp { width: 100%; min-height: 76px; padding: 0; border: 0; background: transparent; color: var(--ink); font: 400 18px/28px var(--font-sans); letter-spacing: -.005em; resize: none; outline: none; }
.zp::placeholder { color: var(--ink-4); }
.bar { display: flex; align-items: flex-end; gap: 28px; flex-wrap: wrap; }
.f { display: flex; flex-direction: column; gap: 6px; }
.cap { font: 400 11px/14px var(--font-sans); color: var(--ink-3); }
.zseg { --nv-glide-bg: var(--solid); }
.zseg button { height: 28px; padding: 0 12px; gap: 6px; }
.zseg .nv-i { width: 13px; height: 13px; }
.dim { display: inline-flex; align-items: center; gap: 6px; }
.dim input { width: 72px; height: 32px; padding: 0 10px; border: 0; border-radius: 8px; background: var(--fill-1); color: var(--ink); font: 400 12.5px/1 var(--font-mono); text-align: center; outline: none; -moz-appearance: textfield; transition: background var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out); }
.dim input::-webkit-inner-spin-button, .dim input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.dim input:hover { background: var(--fill-2); }
.dim input:focus { background: var(--fill-2); box-shadow: none; }
.dim b { font: 400 12px/1 var(--font-mono); color: var(--ink-3); }
.go { margin-left: auto; height: 44px; padding: 0 22px; border: 0; border-radius: 14px; background: var(--accent); color: var(--on-accent); display: inline-flex; align-items: center; justify-content: center; gap: 8px; font: 500 13.5px/1 var(--font-sans); box-shadow: var(--shadow-lift); white-space: nowrap; cursor: pointer; min-width: 168px; transition: transform var(--duration-base) var(--ease-out); }
.go:not(.busy):hover { transform: translateY(-1px); }
.go .nv-i { width: 16px; height: 16px; }
.go.busy { background: var(--fill-2); color: var(--ink-2); box-shadow: none; cursor: progress; }
.ms { position: absolute; left: 10px; top: 10px; z-index: 2; display: inline-flex; padding: 2px; border-radius: 99px; background: var(--glass-strong); box-shadow: var(--shadow-float); pointer-events: none; }
.ms img { height: 14px; width: auto; display: block; }
@media (max-width: 768px) { .go { width: 100%; margin-left: 0; } }
</style>
<style>
.zseg .nv-glide-pill { border-radius: 999px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
</style>
