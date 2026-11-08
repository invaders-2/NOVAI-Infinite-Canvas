<script setup>
// 应用市场详情弹窗（居中，不全屏）。
//   市场条目：/api/store/items/{kind}/{name} 拉详情；可「添加到助手」（install）、「在新画布里使用」（launch → 新画布 + 画布助手自动发送）；
//             有模板（preset_gallery）时点模板直接用它开画布；有表单（try_form）时先填表单再开。curation 停用的条目只能看。
//   内置技能：新建画布，并把「请使用技能「X」」带进画布助手输入框（不自动发送，等用户补充需求）。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import { fetchItemDetail, launchStoreItem, openStoreCanvas, buildLaunchBody, uploadReferences } from './storeData.js';
import { openCanvasUrl } from '../../lib/bridge.js';
import { toast } from '../../lib/store.js';
import { ICONS } from '../../lib/icons.js';

const props = defineProps({ source: { type: String, default: 'store' }, item: { type: Object, required: true } });
const emit = defineEmits(['close', 'installed']);

const isStore = computed(() => props.source === 'store');
const d = ref(null);
const loading = ref(false);
const installing = ref(false);
const launching = ref('');
const installed = ref(!!props.item.installed);
const fields = ref({});
const note = ref('');
const refs = ref([]);
const uploading = ref(false);
const fileEl = ref(null);

const view = computed(() => d.value || props.item);
const available = computed(() => !isStore.value || props.item.storeAvailable !== false);
const cover = computed(() => isStore.value ? (view.value.posterUrl || view.value.coverUrl || '') : '');
const coverVideo = computed(() => isStore.value ? (view.value.coverVideoUrl || '') : '');
const title = computed(() => isStore.value ? view.value.displayName : view.value.name);
const desc = computed(() => isStore.value ? (view.value.description || view.value.marketingLine) : view.value.description);
const guide = computed(() => (d.value && d.value.guide) || null);
const presets = computed(() => (d.value && d.value.presetGallery && d.value.presetGallery.presets || []).slice(0, 12));
const useCases = computed(() => (guide.value && guide.value.useCases || []).filter(u => u.title).slice(0, 4));
const tryForm = computed(() => d.value && d.value.tryForm);
const refMax = computed(() => { const n = tryForm.value && tryForm.value.references && tryForm.value.references.max; return n > 0 ? Math.min(n, 6) : 6; });
const kindLabel = computed(() => !isStore.value ? 'NOVAI 内置技能' : props.item.builtin ? '官方技能' : props.item.kind === 'app' ? '应用' : '技能');

// 封面是原图尺寸（详情大图不拉伸铺满）：小图最多放大 1.5 倍，避免 200×200 的封面糊掉
const coverSize = ref(null);
function onCoverLoad(e) {
    const img = e && e.target;
    const w = img && img.naturalWidth;
    const h = img && img.naturalHeight;
    if (w > 0 && h > 0) coverSize.value = { w, h };
}
const coverStyle = computed(() => {
    const size = coverSize.value;
    if (!size) return {};
    return { maxWidth: Math.round(size.w * 1.5) + 'px', maxHeight: Math.round(size.h * 1.5) + 'px' };
});
// 竖版海报走竖框：横框 contain 会把 853×1280 的图缩到只有框高（316px），两边全是空底
const coverTall = computed(() => !!coverSize.value && coverSize.value.h > coverSize.value.w);

async function loadDetail() {
    if (!isStore.value) return;
    loading.value = true;
    try {
        d.value = await fetchItemDetail(props.item.kind, props.item.name);
        installed.value = !!d.value.installed;
    } catch (e) { /* 拉不到详情就用目录条目里的字段 */ }
    finally { loading.value = false; }
}

async function toggleInstall() {
    if (installing.value || !available.value) return;
    installing.value = true;
    const next = !installed.value;
    try {
        const res = await fetch('/api/store/items/' + encodeURIComponent(props.item.kind) + '/' + encodeURIComponent(props.item.name) + '/install', { method: next ? 'POST' : 'DELETE', headers: { Accept: 'application/json' } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || ('HTTP ' + res.status));
        installed.value = typeof data.installed === 'boolean' ? data.installed : next;
        emit('installed', { kind: props.item.kind, name: props.item.name, installed: installed.value });
        toast(installed.value ? `已把「${title.value}」添加到画布助手` : `已移除「${title.value}」`, { icon: 'check' });
    } catch (e) { toast((e && e.message) || '操作失败', { danger: true, icon: 'alert' }); }
    finally { installing.value = false; }
}

async function launch(presetId = '', prompt = '') {
    if (launching.value || !available.value) return;
    launching.value = presetId || prompt || 'main';
    try {
        const body = buildLaunchBody({ prompt: prompt || note.value, fields: fields.value, references: refs.value, presetId, kind: props.item.kind, name: props.item.name });
        const r = await launchStoreItem(props.item.kind, props.item.name, body);
        if (!r.canvasId) throw new Error('没有拿到画布');
        openStoreCanvas(r.canvasId, r.prompt, r.project, { autoSend: true, skillRef: r.skillRef });
        emit('close');
    } catch (e) { toast((e && e.message) || '启动失败', { danger: true, icon: 'alert' }); }
    finally { launching.value = ''; }
}

async function useBuiltin() {
    if (launching.value) return;
    launching.value = 'main';
    try {
        const s = props.item;
        const res = await fetch('/api/canvases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: String(s.name || '技能').slice(0, 60), icon: 'layers', kind: 'classic', project: 'default' }) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const c = data && data.canvas;
        if (!c) throw new Error('no canvas');
        const agent = `请使用技能「${s.name}」（技能 ID：${s.id}）来完成。` + (note.value.trim() ? '\n' + note.value.trim() : '');
        try { localStorage.setItem('novai_canvas_seed:' + c.id, JSON.stringify({ v: 1, agent, autoSend: !!note.value.trim(), skillRef: String(s.id || '') })); } catch (e) {}
        openCanvasUrl('/static/canvas.html?id=' + encodeURIComponent(c.id) + '&project=' + encodeURIComponent(c.project || 'default'));
        emit('close');
    } catch (e) { toast('创建画布失败，请检查服务是否在运行', { danger: true, icon: 'alert' }); }
    finally { launching.value = ''; }
}

async function addRefs(list) {
    const files = Array.from(list || []).filter(f => /^image\//.test(f.type)).slice(0, Math.max(0, refMax.value - refs.value.length));
    if (!files.length) return;
    uploading.value = true;
    try { refs.value = refs.value.concat(await uploadReferences(files)); }
    catch (e) { toast('上传失败', { danger: true, icon: 'alert' }); }
    finally { uploading.value = false; if (fileEl.value) fileEl.value.value = ''; }
}

function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); emit('close'); } }
onMounted(() => { loadDetail(); window.addEventListener('keydown', onKey, true); });
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
    <Teleport to="#nv-layer">
        <div class="md-scrim" @mousedown.self="emit('close')">
            <div class="md" role="dialog" aria-modal="true" :aria-label="title">
                <header class="md-h">
                    <div class="tt"><h3>{{ title }}</h3><p>{{ kindLabel }}<template v-if="isStore && view.category"> · {{ view.category }}</template></p></div>
                    <button type="button" class="nv-icon-btn sm round" aria-label="关闭" @click="emit('close')"><NvIcon name="x" /></button>
                </header>
                <div class="md-b">
                    <div v-if="cover || coverVideo" class="cv" :class="{ tall: coverTall && !coverVideo }">
                        <video v-if="coverVideo" :src="coverVideo" :poster="cover" autoplay muted loop playsinline></video>
                        <img v-else :src="cover" alt="" :style="coverStyle" @load="onCoverLoad">
                        <span v-if="!available" class="soon">即将上线</span>
                    </div>
                    <div v-else-if="!isStore || view.builtin" class="cv ico"><NvIcon :name="view.icon && ICONS[view.icon] ? view.icon : 'wand2'" /></div>

                    <p class="desc">{{ desc }}</p>
                    <div class="meta">
                        <span class="tag">{{ isStore && !view.builtin ? '市场' : '官方' }}</span>
                        <span class="tag" :class="{ dim: !available }">{{ available ? '可用' : '即将上线' }}</span>
                        <span v-if="installed" class="tag"><NvIcon name="check" />已添加到助手</span>
                        <template v-if="!isStore"><span v-for="t in (view.tags || []).slice(0, 4)" :key="t" class="tag">{{ t }}</span></template>
                    </div>

                    <div v-if="loading" class="nv-skel ld"></div>

                    <template v-if="guide && guide.summary">
                        <h4>它能做什么</h4>
                        <p class="txt">{{ guide.summary }}</p>
                    </template>
                    <template v-if="guide && guide.steps && guide.steps.length">
                        <h4>使用步骤</h4>
                        <ol class="steps"><li v-for="(s, i) in guide.steps.slice(0, 6)" :key="i"><b>{{ s.title }}</b><span v-if="s.description">{{ s.description }}</span></li></ol>
                    </template>
                    <template v-if="!isStore && view.deliverables && view.deliverables.length">
                        <h4>会交付</h4>
                        <div class="meta"><span v-for="(x, i) in view.deliverables" :key="i" class="tag">{{ typeof x === 'string' ? x : (x.label || x.name || x.kind) }}</span></div>
                    </template>

                    <template v-if="available && presets.length">
                        <h4>选一个模板直接开始</h4>
                        <div class="pg">
                            <button v-for="p in presets" :key="p.id" type="button" class="pv" :disabled="!!launching" @click="launch(p.id)">
                                <span class="pm" :style="{ aspectRatio: p.aspect || '3/4' }">
                                    <img v-if="p.cover && p.cover.kind !== 'video' && p.cover.src" :src="p.cover.src" alt="" loading="lazy">
                                    <video v-else-if="p.cover && p.cover.src" :src="p.cover.src" :poster="p.cover.poster" muted loop playsinline preload="metadata" @mouseenter="e => e.target.play()" @mouseleave="e => e.target.pause()"></video>
                                    <span v-if="launching === p.id" class="busy"><span class="spin"></span></span>
                                </span>
                                <b>{{ p.title }}</b>
                            </button>
                        </div>
                    </template>

                    <template v-if="available && useCases.length">
                        <h4>试试这样说</h4>
                        <div class="uc">
                            <button v-for="u in useCases" :key="u.title" type="button" :disabled="!!launching" @click="launch('', u.prompt || u.title)">
                                <b>{{ u.title }}</b><span v-if="u.description">{{ u.description }}</span><NvIcon name="arrowr" />
                            </button>
                        </div>
                    </template>

                    <template v-if="available">
                        <h4>{{ isStore ? '告诉它你想做什么' : '先说说你想做什么（可选）' }}</h4>
                        <div v-if="tryForm && tryForm.fields.length" class="fm">
                            <label v-for="f in tryForm.fields" :key="f.id || f.label"><span>{{ f.label || f.id }}</span>
                                <input v-model="fields[f.id || f.label]" class="inp" :placeholder="f.placeholder" :maxlength="f.maxLength || undefined">
                            </label>
                        </div>
                        <textarea v-model="note" class="inp ta" rows="3" :placeholder="isStore ? '补充描述，例如风格、用途、尺寸…' : '例如：给这双鞋做一套电商主图'"></textarea>
                        <div v-if="isStore" class="refs">
                            <span v-for="(r, i) in refs" :key="r.url" class="rf"><img :src="r.url" alt=""><button type="button" aria-label="移除" @click="refs.splice(i, 1)"><NvIcon name="x" /></button></span>
                            <button v-if="refs.length < refMax" type="button" class="rf add" :disabled="uploading" @click="fileEl && fileEl.click()"><span v-if="uploading" class="spin"></span><NvIcon v-else name="plus" /></button>
                            <span class="hint">参考图（可选）</span>
                            <input ref="fileEl" type="file" accept="image/*" multiple hidden @change="e => addRefs(e.target.files)">
                        </div>
                    </template>
                    <p v-else class="txt dim">这个{{ props.item.kind === 'app' ? '应用' : '技能' }}还在适配，暂时不能在画布里运行，上线后会出现在这里。</p>
                </div>
                <footer class="md-f">
                    <template v-if="isStore">
                        <button type="button" class="nv-btn sm" :disabled="!available || installing" @click="toggleInstall">
                            <span v-if="installing" class="spin"></span><NvIcon v-else :name="installed ? 'check' : 'plus'" />{{ installed ? '已添加到助手' : '添加到助手' }}
                        </button>
                        <button type="button" class="nv-btn sm primary" :disabled="!available || !!launching" @click="launch()">
                            <span v-if="launching === 'main'" class="spin"></span>{{ available ? '在新画布里使用' : '即将上线' }}<NvIcon v-if="available && launching !== 'main'" name="arrowr" />
                        </button>
                    </template>
                    <button v-else type="button" class="nv-btn sm primary" :disabled="!!launching" @click="useBuiltin">
                        <span v-if="launching" class="spin"></span>在新画布里使用<NvIcon v-if="!launching" name="arrowr" />
                    </button>
                </footer>
            </div>
        </div>
    </Teleport>
</template>

<style scoped>
.md-scrim { position: fixed; inset: 0; z-index: 2150; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); font-family: var(--font-sans); color: var(--ink); animation: md-fade var(--duration-base) var(--ease-out); }
.md { width: min(680px, 100%); max-height: min(820px, calc(100vh - 48px)); display: flex; flex-direction: column; border-radius: 22px; background: var(--solid); box-shadow: var(--shadow-dialog); overflow: hidden; animation: nv-dialog-in var(--duration-slow) var(--ease-sheet) both; }
.md-h { display: flex; align-items: flex-start; gap: 12px; padding: 20px 18px 10px 24px; flex: none; }
.md-h .tt { flex: 1; min-width: 0; }
.md-h h3 { margin: 0; font: 600 17px/24px var(--font-sans); letter-spacing: -.01em; }
.md-h p { margin: 2px 0 0; font: 400 12px/17px var(--font-sans); color: var(--ink-3); }
.md-b { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 24px 18px; }
.md-f { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px 16px; flex: none; }
.md-f .nv-btn .nv-i { width: 13px; height: 13px; }
/* 详情大图：contain 居中 + 软底，不拉伸铺满（小图不放大超过原图 1.5 倍，见 coverStyle） */
.cv { position: relative; aspect-ratio: 16 / 8; border-radius: 14px; overflow: hidden; background: var(--fill-1); margin-bottom: 16px; display: flex; align-items: center; justify-content: center; }
.cv img { width: 100%; height: 100%; object-fit: contain; display: block; }
.cv video { width: 100%; height: 100%; object-fit: cover; display: block; }
.cv.tall { aspect-ratio: 3 / 4; width: auto; max-width: calc(460px * 3 / 4); max-height: 460px; margin-left: auto; margin-right: auto; }
.cv.ico { aspect-ratio: auto; height: 120px; display: flex; align-items: center; justify-content: center; color: var(--ink-2); }
.cv.ico .nv-i { width: 36px; height: 36px; }
.soon { position: absolute; left: 12px; top: 12px; height: 22px; padding: 0 9px; border-radius: 11px; background: rgba(0,0,0,.45); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); color: #fff; font: 400 11px/22px var(--font-sans); }
.desc { margin: 0; font: 400 13px/21px var(--font-sans); color: var(--ink); white-space: pre-wrap; }
.meta { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 2px; }
.tag { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 9px; border-radius: 11px; background: var(--fill-1); font: 400 11px/1 var(--font-sans); color: var(--ink-2); }
.tag .nv-i { width: 11px; height: 11px; }
.tag.dim { color: var(--ink-4); }
.ld { height: 80px; margin-top: 14px; border-radius: 12px; }
h4 { margin: 22px 0 10px; font: 600 13px/18px var(--font-sans); }
.txt { margin: 0; font: 400 12.5px/20px var(--font-sans); color: var(--ink-2); white-space: pre-wrap; }
.txt.dim { margin-top: 18px; color: var(--ink-3); }
.steps { margin: 0; padding: 0 0 0 18px; display: flex; flex-direction: column; gap: 6px; font: 400 12.5px/19px var(--font-sans); color: var(--ink-2); }
.steps b { font-weight: 500; color: var(--ink); margin-right: 6px; }
.pg { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 12px; }
.pv { border: 0; padding: 0; background: transparent; text-align: left; cursor: pointer; color: var(--ink); min-width: 0; }
.pv:disabled { cursor: default; }
.pm { position: relative; display: block; width: 100%; max-height: 200px; border-radius: 12px; overflow: hidden; background: var(--fill-1); transition: transform .2s, box-shadow .2s; }
.pv:hover .pm { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
.pm img, .pm video { width: 100%; height: 100%; object-fit: cover; display: block; }
.pm .busy { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.35); color: #fff; }
.pv b { display: block; margin-top: 6px; font: 500 12px/16px var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.uc { display: flex; flex-direction: column; gap: 6px; }
.uc button { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: 10px; padding: 10px 12px; border: 0; border-radius: 12px; background: var(--fill-1); text-align: left; cursor: pointer; color: var(--ink); }
.uc button:hover { background: var(--fill-2); }
.uc b { font: 500 12.5px/18px var(--font-sans); }
.uc span { grid-column: 1; font: 400 11.5px/16px var(--font-sans); color: var(--ink-3); }
.uc .nv-i { grid-column: 2; grid-row: 1 / span 2; width: 14px; height: 14px; color: var(--ink-3); }
.fm { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 10px; }
.fm label { display: flex; flex-direction: column; gap: 5px; font: 500 11.5px/16px var(--font-sans); color: var(--ink-2); }
.inp { width: 100%; box-sizing: border-box; height: 34px; padding: 0 12px; border: 0; outline: 0; border-radius: 10px; background: var(--fill-1); color: var(--ink); font: 400 12.5px/1 var(--font-sans); }
.inp:focus { background: var(--fill-2); }
.inp::placeholder { color: var(--ink-4); }
.ta { height: auto; padding: 10px 12px; line-height: 19px; resize: vertical; min-height: 72px; }
.refs { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.rf { position: relative; width: 52px; height: 52px; border-radius: 10px; overflow: hidden; background: var(--fill-1); flex: none; }
.rf img { width: 100%; height: 100%; object-fit: cover; }
.rf button { position: absolute; right: 3px; top: 3px; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 9px; background: rgba(0,0,0,.55); color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.rf button .nv-i { width: 10px; height: 10px; }
.rf.add { border: 0; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--ink-3); }
.rf.add:hover { background: var(--fill-2); color: var(--ink); }
.rf.add .nv-i { width: 16px; height: 16px; }
.refs .hint { font: 400 11.5px/1 var(--font-sans); color: var(--ink-4); }
.spin { width: 12px; height: 12px; border-radius: 50%; border: 1.5px solid currentColor; border-right-color: transparent; display: inline-block; animation: md-rot .8s linear infinite; }
@keyframes md-rot { to { transform: rotate(360deg); } }
@keyframes md-fade { from { opacity: 0; } }
@media (max-width: 560px) { .fm { grid-template-columns: 1fr; } .md-b { padding: 6px 18px 16px; } }
</style>
