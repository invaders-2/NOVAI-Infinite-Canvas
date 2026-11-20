<script setup>
// 社区作品详情左侧的只读预览：按真实节点坐标铺开，可平移 / 缩放 / 点选；
// 选中节点弹出上游、提示词与参数，视频和音频能播，图片能放大看。只读，不写回任何东西。
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import { mediaUrl } from '../../lib/community.js';

const props = defineProps({
    payload: { type: Object, default: () => ({}) },
    tip: { type: String, default: '只读预览 · 点节点看提示词' },
});

/* ───────── 节点 / 连线 ───────── */
const stage = ref(null);
const view = reactive({ x: 0, y: 0, z: 1 });

const nodes = computed(() => {
    const list = props.payload && Array.isArray(props.payload.nodes) ? props.payload.nodes : [];
    return list.filter(n => n && n.id);
});
const connections = computed(() => (props.payload && Array.isArray(props.payload.connections) ? props.payload.connections : []));
const byId = computed(() => {
    const map = {};
    nodes.value.forEach(n => { map[n.id] = n; });
    return map;
});
const edges = computed(() => connections.value
    .map(edge => {
        const from = byId.value[edge && (edge.from || edge.source)];
        const to = byId.value[edge && (edge.to || edge.target)];
        return from && to ? { from, to } : null;
    })
    .filter(Boolean));
// 分组只是个区域：单独画一枚标签，避免一整块底盖住组里的节点
const drawNodes = computed(() => nodes.value.filter(n => String(n.kind || '') !== 'group'));
const groupNodes = computed(() => nodes.value.filter(n => String(n.kind || '') === 'group'));

function num(n, key, fallback) { const v = Number(n && n[key]); return Number.isFinite(v) ? v : fallback; }
const rectOf = n => ({ x: num(n, 'x', 0), y: num(n, 'y', 0), w: num(n, 'w', 260), h: num(n, 'h', 200) });
function rectStyle(n) {
    const r = rectOf(n);
    return { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' };
}
function edgePath(edge) {
    const a = rectOf(edge.from);
    const b = rectOf(edge.to);
    const ay = a.y + a.h / 2, by = b.y + b.h / 2;
    const ax = a.x + a.w / 2, bx = b.x + b.w / 2;
    const dx = Math.max(60, Math.abs(bx - ax) / 2);
    const sx = bx >= ax ? ax + a.w / 2 : ax - a.w / 2;
    const ex = bx >= ax ? bx - b.w / 2 : bx + b.w / 2;
    const c1 = sx + (bx >= ax ? dx : -dx);
    const c2 = ex + (bx >= ax ? -dx : dx);
    return 'M' + (a.x + a.w / 2) + ',' + ay + ' C' + c1 + ',' + ay + ' ' + c2 + ',' + by + ' ' + (b.x + b.w / 2) + ',' + by;
}

/* ───────── 节点内容 ───────── */
const mediaOf = n => {
    if (!n) return '';
    if (typeof n.url === 'string' && n.url) return mediaUrl(n.url);
    const gen = (n.data && n.data.gen) || {};
    const hist = Array.isArray(gen.hist) ? gen.hist : [];
    const index = Number.isFinite(Number(gen.hi)) ? Number(gen.hi) : hist.length - 1;
    const picked = hist[index] || hist[hist.length - 1];
    return picked && picked.url ? mediaUrl(picked.url) : '';
};
const isVideoUrl = url => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(String(url || ''));
const isAudioUrl = url => /\.(m4a|mp3|wav|aac|ogg|flac)(\?|$)/i.test(String(url || ''));
// 音频节点以前会走进 <img>，变成一张破图；这里按扩展名定媒体类型，kind 只作兜底
function mediaKindOf(n) {
    const kind = String((n && n.kind) || '');
    if (kind === 'group' || kind === 'timeline' || kind === 'text') return '';
    const url = mediaOf(n);
    if (isAudioUrl(url)) return 'audio';
    if (isVideoUrl(url)) return 'video';
    if (url) return 'image';
    return '';
}
const isViewable = n => ['image', 'video'].includes(mediaKindOf(n));
// 媒体按需从作者节点现拉，偶发失败先自动重试一次，仍失败就退成节点占位，别露破图
const mediaBroken = ref(new Set());
const mediaRetried = ref(new Set());
const mediaSrc = n => {
    if (!n || !n.id || mediaBroken.value.has(n.id)) return '';
    const base = mediaOf(n);
    if (!base) return '';
    return mediaRetried.value.has(n.id) ? base + (base.includes('?') ? '&' : '?') + 'r=1' : base;
};
const videoSrc = n => {
    const base = mediaSrc(n);
    if (!base || base.includes('#')) return base;
    return base + '#t=0.1';
};
function mediaError(n) {
    if (!n || !n.id) return;
    if (mediaRetried.value.has(n.id)) { mediaBroken.value.add(n.id); return; }
    setTimeout(() => mediaRetried.value.add(n.id), 4000);
}

const titleOf = n => {
    const gen = (n && n.data && n.data.gen) || {};
    return String((gen && gen.title) || (n && n.title) || (n && n.text) || (n && n.kind) || '节点');
};
const textOf = n => String((n && n.text) || '');
const promptOf = n => String(((n && n.data && n.data.gen && n.data.gen.prompt) || '') || '');
const kindIcon = n => {
    const kind = String((n && n.kind) || '');
    if (kind === 'text') return 'type';
    if (kind === 'video') return 'video';
    if (kind === 'audio') return 'music';
    if (kind === 'timeline') return 'film';
    if (kind === 'group') return 'group';
    if (kind === 'table') return 'table';
    if (kind === 'image') return 'image';
    return 'box';
};
const KIND_LABEL = { text: '文本', image: '图片', video: '视频', audio: '音频', group: '分组', timeline: '时间线', table: '表格' };
const kindLabel = n => KIND_LABEL[String((n && n.kind) || '')] || (n && n.kind ? String(n.kind) : '节点');

function clipTotal(n) {
    const clips = Array.isArray(n && n.clips) ? n.clips : [];
    return clips.reduce((sum, c) => sum + Math.max(0, (Number(c.outPoint) || 0) - (Number(c.inPoint) || 0)), 0);
}
function noteOf(n) {
    const kind = String((n && n.kind) || '');
    if (kind === 'group') return ((n.children || []).length) + ' 个素材';
    if (kind === 'timeline') {
        const clips = Array.isArray(n.clips) ? n.clips : [];
        const total = clipTotal(n);
        return clips.length + ' 段剪辑' + (total ? ' · ' + total.toFixed(1) + 's' : '');
    }
    if (kind === 'audio') return '音频';
    if (kind === 'text') return '文本';
    return '';
}
function fileNameOf(n) {
    const raw = String(mediaOf(n) || '').split('?')[0].split('/').pop() || '';
    try { return decodeURIComponent(raw); } catch (e) { return raw; }
}

/* ───────── 选中与浮层 ───────── */
const selId = ref('');
const sel = computed(() => byId.value[selId.value] || null);
const upstream = computed(() => (selId.value ? edges.value.filter(e => e.to.id === selId.value).map(e => e.from) : []));

// 浮层优先贴节点下方，下方放不下就翻到上方：两边都给节点让位，也不压左下缩放条
const panelStyle = computed(() => {
    const n = sel.value, el = stage.value;
    if (!n || !el) return null;
    const box = el.getBoundingClientRect();
    const r = rectOf(n);
    const width = Math.min(420, Math.max(220, box.width - 32));
    let left = view.x + (r.x + r.w / 2) * view.z - width / 2;
    left = Math.max(12, Math.min(Math.max(12, box.width - width - 12), left));
    const gap = 12, footer = 58;
    const nodeTop = view.y + r.y * view.z;
    const nodeBottom = nodeTop + r.h * view.z;
    const belowRoom = box.height - footer - (nodeBottom + gap);
    const aboveRoom = nodeTop - gap - 10;
    if (belowRoom >= 110) return { left: left + 'px', top: (nodeBottom + gap) + 'px', width: width + 'px', maxHeight: belowRoom + 'px' };
    if (aboveRoom >= 110) return { left: left + 'px', bottom: (box.height - nodeTop + gap) + 'px', width: width + 'px', maxHeight: aboveRoom + 'px' };
    // 超大节点上下都放不下：贴着缩放条浮在底部，宁可盖住节点下半截也要能读
    return { left: left + 'px', bottom: footer + 'px', width: width + 'px', maxHeight: Math.min(360, box.height - footer - 10) + 'px' };
});

const selIsText = computed(() => String((sel.value && sel.value.kind) || '') === 'text');
function bodyOf(n) {
    if (!n) return '';
    if (String(n.kind || '') === 'text') return textOf(n) || promptOf(n);
    return promptOf(n);
}
const selBody = computed(() => bodyOf(sel.value));
const showPromptBlock = computed(() => {
    const kind = String((sel.value && sel.value.kind) || '');
    return kind !== 'group' && kind !== 'timeline';
});
const PROMPT_EMPTY = '这个节点没有单独记录提示词，内容可能在它上游的文本节点里';
const selDesc = computed(() => {
    const n = sel.value;
    if (!n) return '';
    const kind = String(n.kind || '');
    if (kind === 'group' || kind === 'timeline' || kind === 'audio') return noteOf(n);
    if (['text', 'image', 'video', 'table'].includes(kind) || mediaKindOf(n)) return '';
    return kind ? '这种节点暂时只显示标题' : '';
});
const selParams = computed(() => {
    const n = sel.value;
    if (!n) return [];
    const params = (n.data && n.data.gen && n.data.gen.params) || {};
    const out = [];
    const push = value => {
        const text = String(value == null ? '' : value).trim();
        if (text && out.indexOf(text) < 0) out.push(text);
    };
    push(params.ratio || n.ratio);
    push(params.size);
    push(params.res);
    if (params.dur != null && params.dur !== '') push(typeof params.dur === 'number' ? params.dur + 's' : params.dur);
    push(params.mode);
    const count = Number(params.count);
    if (Number.isFinite(count) && count > 0) push(count + (mediaKindOf(n) === 'video' ? ' 条' : ' 张'));
    push(params.kind);
    return out;
});
const selModel = computed(() => String((sel.value && sel.value.data && sel.value.data.gen && sel.value.data.gen.params && sel.value.data.gen.params.model) || ''));

const copied = ref('');
let copyTimer = 0;
function legacyCopy(value) {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
}
async function copySel() {
    const value = bodyOf(sel.value);
    if (!value) return;
    let ok = false;
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(value);
            ok = true;
        } else {
            ok = legacyCopy(value);
        }
    } catch (e) {
        ok = legacyCopy(value);
    }
    if (!ok) return;
    copied.value = selId.value;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied.value = ''; }, 1400);
}

/* ───────── 视频：同一时间只放一个 ───────── */
const videoEls = new Map();
const vstate = reactive({});
function setVideo(id, el) { if (el) videoEls.set(id, el); else videoEls.delete(id); }
function vget(id) { return vstate[id] || null; }
function setV(id, patch) {
    const prev = vstate[id] || { cur: 0, dur: 0, playing: false };
    vstate[id] = { cur: prev.cur, dur: prev.dur, playing: prev.playing, ...patch };
}
function vcur(id) { const s = vget(id); return s ? s.cur.toFixed(1) + 's' : '0.0s'; }
function vdur(id) { const s = vget(id); return s && s.dur ? s.dur.toFixed(1) + 's' : ''; }
function vpct(id) { const s = vget(id); return s && s.dur ? Math.min(100, Math.max(0, s.cur / s.dur * 100)) : 0; }
function isPlaying(id) { const s = vget(id); return !!(s && s.playing); }
function safePlay(el) { const p = el.play(); if (p && typeof p.catch === 'function') p.catch(() => {}); }
function pauseVideos(except) { videoEls.forEach((el, id) => { if (id !== except) el.pause(); }); }
function onVideoMeta(id, event) {
    const el = event.target;
    setV(id, { dur: Number.isFinite(el.duration) ? el.duration : 0, cur: el.currentTime || 0 });
}
function onVideoTime(id, event) {
    const el = event.target;
    const prev = vget(id);
    setV(id, { cur: el.currentTime || 0, dur: Number.isFinite(el.duration) ? el.duration : (prev ? prev.dur : 0) });
}
function onVideoState(id, event) { setV(id, { playing: !event.target.paused }); }
function toggleVideo(id) {
    const el = videoEls.get(id);
    if (!el) return;
    if (el.paused) {
        pauseVideos(id);
        pauseAudio();
        safePlay(el);
    } else {
        el.pause();
    }
}

/* ───────── 音频：单实例，换一个先停上一个 ───────── */
const audioId = ref('');
const audioEl = ref(null);
const astate = reactive({ cur: 0, dur: 0, playing: false });
const audioElement = () => (Array.isArray(audioEl.value) ? audioEl.value[0] : audioEl.value);
function pauseAudio() { const el = audioElement(); if (el) el.pause(); }
function onAudioMeta(event) {
    const el = event.target;
    astate.dur = Number.isFinite(el.duration) ? el.duration : 0;
    astate.cur = el.currentTime || 0;
}
function onAudioTime(event) {
    const el = event.target;
    astate.cur = el.currentTime || 0;
    if (Number.isFinite(el.duration)) astate.dur = el.duration;
}
function onAudioState(event) { astate.playing = !event.target.paused; }
function toggleAudio(id) {
    if (audioId.value !== id) {
        audioId.value = id;
        astate.cur = 0;
        astate.dur = 0;
        astate.playing = false;
        pauseVideos();
        nextTick(() => { const el = audioElement(); if (el) safePlay(el); });
        return;
    }
    const el = audioElement();
    if (!el) return;
    if (el.paused) { pauseVideos(); safePlay(el); } else el.pause();
}
const acur = computed(() => astate.cur.toFixed(1) + 's');
const adur = computed(() => (astate.dur ? astate.dur.toFixed(1) + 's' : ''));
const apct = computed(() => (astate.dur ? Math.min(100, Math.max(0, astate.cur / astate.dur * 100)) : 0));

/* ───────── 大图查看 ───────── */
const mediaNodes = computed(() => nodes.value.filter(isViewable));
const lbIndex = ref(-1);
const lbOpen = computed(() => lbIndex.value >= 0 && lbIndex.value < mediaNodes.value.length);
const lbNode = computed(() => (lbOpen.value ? mediaNodes.value[lbIndex.value] : null));
const lbUrl = computed(() => (lbNode.value ? mediaOf(lbNode.value) : ''));
const lbIsVideo = computed(() => (lbNode.value ? mediaKindOf(lbNode.value) === 'video' : false));
function openLB(n) {
    const index = mediaNodes.value.findIndex(item => item.id === (n && n.id));
    if (index < 0) return;
    pauseVideos();
    pauseAudio();
    lbIndex.value = index;
}
function closeLB() { lbIndex.value = -1; }
function lbGo(step) {
    const total = mediaNodes.value.length;
    if (total) lbIndex.value = (lbIndex.value + step + total) % total;
}
// capture 阶段拦下 Esc / 方向键：否则 Esc 会继续冒到详情弹窗，把整个详情一起关掉
function onLBKey(event) {
    if (!lbOpen.value) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeLB();
    } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopImmediatePropagation();
        lbGo(-1);
    } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopImmediatePropagation();
        lbGo(1);
    }
}
watch(lbOpen, open => {
    if (typeof window === 'undefined') return;
    if (open) window.addEventListener('keydown', onLBKey, true);
    else window.removeEventListener('keydown', onLBKey, true);
});

/* ───────── 视口：平移 / 缩放 / 点选 ───────── */
function fit() {
    const el = stage.value;
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (!nodes.value.length) { view.z = 1; view.x = box.width / 2; view.y = box.height / 2; return; }
    const rects = nodes.value.map(rectOf);
    const minX = Math.min(...rects.map(r => r.x));
    const maxX = Math.max(...rects.map(r => r.x + r.w));
    const minY = Math.min(...rects.map(r => r.y));
    const maxY = Math.max(...rects.map(r => r.y + r.h));
    const padX = 80, padY = 80;
    const z = Math.min(1.15, Math.max(0.15, Math.min((box.width - padX) / Math.max(1, maxX - minX), (box.height - padY) / Math.max(1, maxY - minY))));
    view.z = z;
    view.x = (box.width - (maxX - minX) * z) / 2 - minX * z;
    view.y = (box.height - (maxY - minY) * z) / 2 - minY * z;
}
function zoomAt(z, cx, cy) {
    const next = Math.min(2, Math.max(0.1, z));
    view.x = cx - (cx - view.x) * next / view.z;
    view.y = cy - (cy - view.y) * next / view.z;
    view.z = next;
}
function zoomTo(percent) {
    const el = stage.value;
    if (!el) return;
    const box = el.getBoundingClientRect();
    zoomAt(percent / 100, box.width / 2, box.height / 2);
}

let pan = null;
let lastClick = { id: '', at: 0 };
const swallow = () => {};
// 控件自己接管指针，别拖成平移；空白处点一下就取消选中
function onDown(event) {
    if (event.button !== 0 || (event.target.closest && event.target.closest('.cpr-panel, .cv-zoom, .cpr-play, .cpr-audio-bar'))) return;
    pan = {
        sx: event.clientX,
        sy: event.clientY,
        ox: view.x,
        oy: view.y,
        moved: false,
        node: event.target.closest ? event.target.closest('[data-nid]') : null,
    };
    stage.value.setPointerCapture(event.pointerId);
}
function onMove(event) {
    if (!pan) return;
    const dx = event.clientX - pan.sx, dy = event.clientY - pan.sy;
    if (!pan.moved && Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
    if (pan.moved) { view.x = pan.ox + dx; view.y = pan.oy + dy; }
}
function onUp() {
    if (pan && !pan.moved) {
        const id = pan.node ? String(pan.node.dataset.nid || '') : '';
        const node = id ? byId.value[id] : null;
        const now = Date.now();
        // 指针捕获会把 dblclick 的 target 换成舞台，所以双击自己判
        if (node && isViewable(node) && lastClick.id === id && now - lastClick.at < 340) {
            lastClick = { id: '', at: 0 };
            selId.value = id;
            openLB(node);
        } else {
            selId.value = id;
            lastClick = { id, at: now };
        }
    }
    pan = null;
}
function onWheel(event) {
    event.preventDefault();
    const box = stage.value.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey || (Math.abs(event.deltaY) >= 40 && !event.deltaX)) {
        zoomAt(view.z * Math.exp(-event.deltaY * 0.0015), event.clientX - box.left, event.clientY - box.top);
    } else {
        view.x -= event.deltaX;
        view.y -= event.deltaY;
    }
}
const pct = computed(() => Math.round(view.z * 100));

/* ───────── 生命周期 ───────── */
let observer = null;
onMounted(() => {
    nextTick(() => requestAnimationFrame(fit));
    if (typeof ResizeObserver !== 'undefined' && stage.value) {
        observer = new ResizeObserver(() => fit());
        observer.observe(stage.value);
    }
});
onBeforeUnmount(() => {
    if (observer) observer.disconnect();
    if (typeof window !== 'undefined') window.removeEventListener('keydown', onLBKey, true);
    clearTimeout(copyTimer);
    pauseVideos();
    pauseAudio();
});
watch(() => props.payload, () => {
    selId.value = '';
    closeLB();
    pauseVideos();
    pauseAudio();
    nextTick(() => requestAnimationFrame(fit));
}, { deep: false });
</script>

<template>
    <div ref="stage" class="cpr" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @wheel="onWheel">
        <div class="cpr-world" :style="{ transform: 'translate(' + view.x + 'px, ' + view.y + 'px) scale(' + view.z + ')' }">
            <svg class="cpr-edges" width="1" height="1">
                <path v-for="(edge, i) in edges" :key="i" :d="edgePath(edge)" />
            </svg>

            <div v-for="g in groupNodes" :key="g.id" class="cpr-gtag" :class="{ on: g.id === selId }" :data-nid="g.id"
                 :style="{ left: rectOf(g).x + 'px', top: rectOf(g).y + 'px' }">
                <NvIcon name="group" />{{ titleOf(g) }}<em>{{ (g.children || []).length }} 个素材</em>
            </div>

            <div v-for="n in drawNodes" :key="n.id" class="cpr-node" :class="['k-' + (n.kind || 'image'), { on: n.id === selId }]" :style="rectStyle(n)" :data-nid="n.id">
                <span class="al"><NvIcon :name="kindIcon(n)" /><span class="t">{{ titleOf(n) }}</span></span>

                <template v-if="n.kind === 'text'">
                    <div class="im"><div class="tx">{{ textOf(n) }}</div></div>
                </template>

                <template v-else-if="n.kind === 'timeline'">
                    <div class="im tl">
                        <NvIcon name="film" />
                        <b>{{ titleOf(n) }}</b>
                        <span>{{ noteOf(n) }}</span>
                        <div class="bars"><i v-for="(clip, ci) in (n.clips || [])" :key="clip.id || ci"></i></div>
                    </div>
                </template>

                <template v-else-if="mediaKindOf(n) === 'video'">
                    <div v-if="!videoSrc(n)" class="im"><div class="ph"><NvIcon name="video" /><span>{{ titleOf(n) }}</span></div></div>
                    <div v-else class="im">
                        <video :src="videoSrc(n)" :ref="el => setVideo(n.id, el)" muted loop playsinline preload="metadata"
                               @loadedmetadata="onVideoMeta(n.id, $event)" @durationchange="onVideoMeta(n.id, $event)"
                               @timeupdate="onVideoTime(n.id, $event)" @play="onVideoState(n.id, $event)" @pause="onVideoState(n.id, $event)"
                               @error="mediaError(n)"></video>
                        <div class="cpr-vbar">
                            <button type="button" class="cpr-play" :aria-label="isPlaying(n.id) ? '暂停' : '播放'"
                                    @pointerdown.stop @click.stop="toggleVideo(n.id)">
                                <NvIcon :name="isPlaying(n.id) ? 'pause' : 'play'" />
                            </button>
                            <span class="extras">
                                <span class="t">{{ vcur(n.id) }}</span>
                                <span class="trk"><i :style="{ width: vpct(n.id) + '%' }"></i></span>
                                <span class="t">{{ vdur(n.id) }}</span>
                            </span>
                        </div>
                    </div>
                </template>

                <template v-else-if="mediaKindOf(n) === 'audio'">
                    <div class="im au cpr-audio">
                        <div class="ah"><span class="ai"><NvIcon name="music" /></span><b>{{ titleOf(n) }}</b></div>
                        <span class="fn mono">{{ fileNameOf(n) }}</span>
                        <div class="cpr-audio-bar" :class="{ on: audioId === n.id }" @pointerdown.stop>
                            <button type="button" :aria-label="(audioId === n.id && astate.playing) ? '暂停' : '播放'" @click.stop="toggleAudio(n.id)">
                                <NvIcon :name="(audioId === n.id && astate.playing) ? 'pause' : 'play'" />
                                <span>{{ (audioId === n.id && astate.playing) ? '暂停' : '播放' }}</span>
                            </button>
                            <span class="t">{{ audioId === n.id ? acur : '' }}</span>
                            <span class="trk"><i :style="{ width: (audioId === n.id ? apct : 0) + '%' }"></i></span>
                            <span class="t">{{ audioId === n.id ? adur : '' }}</span>
                        </div>
                        <audio v-if="audioId === n.id" ref="audioEl" :src="mediaOf(n)" preload="metadata"
                               @loadedmetadata="onAudioMeta" @durationchange="onAudioMeta" @timeupdate="onAudioTime"
                               @play="onAudioState" @pause="onAudioState" @ended="onAudioState"></audio>
                    </div>
                </template>

                <template v-else-if="mediaKindOf(n) === 'image'">
                    <div v-if="mediaSrc(n)" class="im"><img :src="mediaSrc(n)" alt="" draggable="false" loading="lazy" @error="mediaError(n)" /></div>
                    <div v-else class="im"><div class="ph"><NvIcon :name="kindIcon(n)" /><span>{{ promptOf(n) || titleOf(n) }}</span></div></div>
                </template>

                <template v-else>
                    <div class="im"><div class="ph"><NvIcon :name="kindIcon(n)" /><span>{{ promptOf(n) || titleOf(n) }}</span></div></div>
                </template>
            </div>
        </div>

        <span v-if="tip" class="cpr-tip"><NvIcon name="eye" />{{ tip }}</span>

        <div v-if="sel && panelStyle" class="cpr-panel" :style="panelStyle" role="dialog" aria-label="节点详情" @pointerdown.stop="swallow" @wheel.stop="swallow">
            <div class="hd">
                <span class="ki"><NvIcon :name="kindIcon(sel)" /></span>
                <b :title="titleOf(sel)">{{ titleOf(sel) }}</b>
                <span class="kd">{{ kindLabel(sel) }}</span>
                <span class="sp"></span>
                <button v-if="selBody" type="button" class="cp" @click="copySel">
                    <NvIcon :name="copied === sel.id ? 'check' : 'copy'" />{{ copied === sel.id ? '已复制' : '复制' }}
                </button>
            </div>

            <div class="refs">
                <span v-for="u in upstream" :key="u.id" class="ref"><NvIcon :name="kindIcon(u)" />{{ titleOf(u) }}</span>
                <span v-if="!upstream.length" class="ref muted">没有上游输入</span>
            </div>

            <template v-if="showPromptBlock">
                <p v-if="selBody" class="prompt" :class="{ long: selIsText }">{{ selBody }}</p>
                <p v-else class="prompt muted">{{ PROMPT_EMPTY }}</p>
            </template>

            <p v-if="sel.kind === 'audio'" class="file mono">{{ fileNameOf(sel) }}</p>
            <p v-if="selDesc" class="dsc">{{ selDesc }}</p>

            <div v-if="selParams.length || selModel" class="prm">
                <span v-for="p in selParams" :key="p" class="chip">{{ p }}</span>
                <span v-if="selModel" class="mdl mono">{{ selModel }}</span>
            </div>

            <div v-if="isViewable(sel)" class="acts">
                <button type="button" class="btn" @click="openLB(sel)"><NvIcon name="expand" />放大查看</button>
            </div>
        </div>

        <div class="cv-zoom" @pointerdown.stop>
            <button type="button" title="适应画布" aria-label="适应画布" @click="fit"><NvIcon name="fit" /></button>
            <input type="range" min="10" max="200" :value="pct" aria-label="缩放" @input="zoomTo(+$event.target.value)" />
            <button type="button" title="重置为 100%" @click="zoomTo(100)">{{ pct }}%</button>
        </div>
    </div>

    <Teleport to="#nv-layer">
        <Transition name="cpr-lb">
            <div v-if="lbOpen" class="cpr-lb" role="dialog" aria-modal="true" aria-label="媒体预览" @click.self="closeLB">
                <video v-if="lbIsVideo" class="media" :src="lbUrl" controls autoplay playsinline preload="metadata" @click.stop></video>
                <img v-else class="media" :src="lbUrl" alt="" draggable="false" @click.stop />
                <button type="button" class="lb-x" title="关闭（Esc）" aria-label="关闭" @click.stop="closeLB"><NvIcon name="x" /></button>
                <button v-if="mediaNodes.length > 1" type="button" class="lb-nav prev" title="上一个（←）" aria-label="上一个" @click.stop="lbGo(-1)"><NvIcon name="arrowl" /></button>
                <button v-if="mediaNodes.length > 1" type="button" class="lb-nav next" title="下一个（→）" aria-label="下一个" @click.stop="lbGo(1)"><NvIcon name="arrowr" /></button>
                <span class="lb-meta">{{ titleOf(lbNode || {}) }}<em>{{ lbIndex + 1 }} / {{ mediaNodes.length }}</em></span>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.cpr { position: relative; width: 100%; height: 100%; overflow: hidden; background: var(--canvas); cursor: grab; touch-action: none; }
.cpr:active { cursor: grabbing; }
.cpr-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.cpr-edges { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.cpr-edges path { fill: none; stroke: var(--ink-4); stroke-width: 1.6; }

.cpr-node { position: absolute; border-radius: 14px; background: var(--solid); box-shadow: var(--shadow-float); cursor: pointer; }
.cpr-node.on { box-shadow: 0 0 0 1.5px var(--ink), var(--shadow-lift); }
.cpr-node .al { position: absolute; left: 2px; top: -19px; z-index: 2; display: flex; align-items: center; gap: 4px; max-width: 100%; font: 500 11px/1 var(--font-sans); color: var(--ink-2); pointer-events: none; }
.cpr-node .al .nv-i { width: 12px; height: 12px; flex: none; }
.cpr-node .al .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cpr-node .im { position: absolute; inset: 0; border-radius: 14px; overflow: hidden; background: var(--fill-1); }
.cpr-node .im img, .cpr-node .im video { width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }
.cpr-node .tx { height: 100%; overflow: hidden; padding: 14px 16px; font: 400 12px/1.65 var(--font-sans); color: var(--ink-2); white-space: pre-wrap; }
.cpr-node .ph { height: 100%; padding: 14px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; color: var(--ink-3); }
.cpr-node .ph .nv-i { width: 18px; height: 18px; flex: none; }
.cpr-node .ph span { font: 400 11.5px/1.6 var(--font-sans); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; }

.cpr-node .tl { padding: 16px 18px; display: flex; flex-direction: column; gap: 6px; color: var(--ink-3); }
.cpr-node .tl .nv-i { width: 20px; height: 20px; color: var(--ink-4); flex: none; }
.cpr-node .tl b { font: 600 13px/1.4 var(--font-sans); color: var(--ink); }
.cpr-node .tl span { font: 400 11.5px/1.5 var(--font-sans); }
.cpr-node .tl .bars { margin-top: auto; display: flex; align-items: stretch; gap: 4px; height: 26px; }
.cpr-node .tl .bars i { flex: 1; border-radius: 4px; background: var(--fill-2); }

.cpr-gtag { position: absolute; z-index: 1; height: 26px; padding: 0 10px; border-radius: 13px; display: inline-flex; align-items: center; gap: 5px; background: var(--glass-strong); backdrop-filter: var(--material-regular); -webkit-backdrop-filter: var(--material-regular); box-shadow: var(--shadow-float); font: 500 11.5px/1 var(--font-sans); color: var(--ink-2); white-space: nowrap; cursor: pointer; }
.cpr-gtag .nv-i { width: 12px; height: 12px; }
.cpr-gtag em { font: 400 11px/1 var(--font-sans); font-style: normal; color: var(--ink-3); }
.cpr-gtag.on { background: var(--fill-2); color: var(--ink); }

.cpr-vbar { position: absolute; left: 8px; right: 8px; bottom: 8px; display: flex; align-items: center; gap: 6px; pointer-events: none; }
.cpr-play { width: 30px; height: 30px; flex: none; padding: 0; border: 0; border-radius: 15px; background: rgba(0, 0, 0, .44); backdrop-filter: blur(14px) saturate(160%); -webkit-backdrop-filter: blur(14px) saturate(160%); color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; pointer-events: auto; }
.cpr-play .nv-i { width: 14px; height: 14px; }
.cpr-vbar .extras { display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 10px; border-radius: 13px; background: rgba(0, 0, 0, .44); backdrop-filter: blur(14px) saturate(160%); -webkit-backdrop-filter: blur(14px) saturate(160%); color: #fff; font: 400 10.5px/1 var(--font-sans); font-variant-numeric: tabular-nums; opacity: 0; transform: translateX(-6px); transition: opacity .16s var(--ease-out), transform .16s var(--ease-out); pointer-events: none; }
.cpr-node:hover .cpr-vbar .extras, .cpr-node.on .cpr-vbar .extras { opacity: 1; transform: none; }
.cpr-vbar .t { flex: none; }
.cpr-vbar .trk { width: 64px; height: 3px; border-radius: 2px; background: rgba(255, 255, 255, .3); position: relative; }
.cpr-vbar .trk i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 2px; background: #fff; }

.cpr-node .au { padding: 14px; display: flex; flex-direction: column; gap: 8px; background: var(--solid); }
.cpr-node .au .ah { display: flex; align-items: center; gap: 7px; min-width: 0; }
.cpr-node .au .ai { width: 30px; height: 30px; flex: none; border-radius: 15px; background: var(--fill-1); color: var(--ink-2); display: flex; align-items: center; justify-content: center; }
.cpr-node .au .ai .nv-i { width: 15px; height: 15px; }
.cpr-node .au .ah b { font: 500 12px/1.4 var(--font-sans); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cpr-node .au .fn { font: 400 10.5px/1.5 var(--font-mono); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cpr-node .au .cpr-audio-bar { margin-top: auto; display: flex; align-items: center; gap: 7px; height: 28px; }
.cpr-node .au .cpr-audio-bar button { flex: none; height: 28px; padding: 0 10px; border: 0; border-radius: 14px; background: var(--fill-2); color: var(--ink); display: inline-flex; align-items: center; gap: 5px; font: 500 11.5px/1 var(--font-sans); cursor: pointer; }
.cpr-node .au .cpr-audio-bar button:hover { background: var(--fill-3); }
.cpr-node .au .cpr-audio-bar button .nv-i { width: 13px; height: 13px; }
.cpr-node .au .cpr-audio-bar .t { font: 400 10.5px/1 var(--font-mono); color: var(--ink-3); font-variant-numeric: tabular-nums; }
.cpr-node .au .cpr-audio-bar .trk { flex: 1; height: 3px; border-radius: 2px; background: var(--fill-2); position: relative; }
.cpr-node .au .cpr-audio-bar .trk i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 2px; background: var(--ink-3); }
.cpr-node .au audio { display: none; }

.cpr-tip { position: absolute; left: 14px; top: 14px; z-index: 4; height: 28px; padding: 0 10px; border-radius: 14px; display: inline-flex; align-items: center; gap: 5px; background: var(--glass-strong); backdrop-filter: var(--material-regular); -webkit-backdrop-filter: var(--material-regular); box-shadow: var(--shadow-float); font: 400 11.5px/1 var(--font-sans); color: var(--ink-3); }
.cpr-tip .nv-i { width: 12px; height: 12px; }

.cpr-panel { position: absolute; z-index: 6; display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 18px; overflow: auto; overscroll-behavior: contain; cursor: default;
    background: color-mix(in srgb, var(--solid) 92%, transparent); backdrop-filter: var(--material-regular); -webkit-backdrop-filter: var(--material-regular); box-shadow: var(--shadow-pop); }
.cpr-panel .hd { display: flex; align-items: center; gap: 6px; min-width: 0; }
.cpr-panel .hd .ki { width: 20px; height: 20px; flex: none; border-radius: 10px; background: var(--fill-1); color: var(--ink-2); display: inline-flex; align-items: center; justify-content: center; }
.cpr-panel .hd .ki .nv-i { width: 12px; height: 12px; }
.cpr-panel .hd b { font: 600 12.5px/1.4 var(--font-sans); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cpr-panel .hd .kd { flex: none; height: 18px; padding: 0 6px; border-radius: 9px; background: var(--fill-1); color: var(--ink-3); font: 400 10.5px/18px var(--font-sans); }
.cpr-panel .hd .sp { flex: 1; }
.cpr-panel .hd .cp { flex: none; height: 24px; padding: 0 8px; border: 0; border-radius: 12px; background: var(--fill-1); color: var(--ink-3); display: inline-flex; align-items: center; gap: 4px; font: 400 11px/1 var(--font-sans); cursor: pointer; }
.cpr-panel .hd .cp:hover { background: var(--fill-2); color: var(--ink); }
.cpr-panel .hd .cp .nv-i { width: 12px; height: 12px; }

.cpr-panel .refs { display: flex; flex-wrap: wrap; gap: 5px; }
.cpr-panel .ref { height: 24px; padding: 0 9px; border-radius: 12px; background: var(--fill-1); color: var(--ink-2); font: 400 11.5px/1 var(--font-sans); display: inline-flex; align-items: center; gap: 5px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cpr-panel .ref .nv-i { width: 12px; height: 12px; flex: none; }
.cpr-panel .ref.muted { color: var(--ink-4); }
.cpr-panel .prompt { margin: 0; font: 400 12.5px/1.65 var(--font-sans); color: var(--ink-2); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 148px; overflow: auto; }
.cpr-panel .prompt.long { max-height: 240px; }
.cpr-panel .prompt.muted { color: var(--ink-3); }
.cpr-panel .file { margin: 0; font: 400 10.5px/1.5 var(--font-mono); color: var(--ink-3); overflow-wrap: anywhere; }
.cpr-panel .dsc { margin: 0; font: 400 11.5px/1.5 var(--font-sans); color: var(--ink-3); }
.cpr-panel .prm { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.cpr-panel .chip { height: 20px; padding: 0 7px; border-radius: 10px; background: var(--fill-1); color: var(--ink-2); font: 400 11px/20px var(--font-sans); }
.cpr-panel .mdl { font: 400 10.5px/1.5 var(--font-mono); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.cpr-panel .acts { display: flex; gap: 6px; }
.cpr-panel .btn { height: 28px; padding: 0 10px; border: 0; border-radius: 14px; background: var(--fill-2); color: var(--ink); display: inline-flex; align-items: center; gap: 5px; font: 500 12px/1 var(--font-sans); cursor: pointer; }
.cpr-panel .btn:hover { background: var(--fill-3); }
.cpr-panel .btn .nv-i { width: 13px; height: 13px; }

.cv-zoom { position: absolute; left: 14px; bottom: 14px; z-index: 5; height: 36px; padding: 0 6px; border-radius: 18px; display: flex; align-items: center; gap: 4px; background: var(--glass-strong); backdrop-filter: var(--material-thick); -webkit-backdrop-filter: var(--material-thick); box-shadow: var(--shadow-float); }
.cv-zoom button { height: 28px; min-width: 28px; padding: 0 5px; border: 0; border-radius: 14px; background: transparent; color: var(--ink-3); font: 400 12px/1 var(--font-sans); display: flex; align-items: center; justify-content: center; cursor: pointer; font-variant-numeric: tabular-nums; }
.cv-zoom button:hover { background: var(--fill-1); color: var(--ink); }
.cv-zoom .nv-i { width: 14px; height: 14px; }
.cv-zoom input { width: 88px; accent-color: var(--ink); }

.cpr-lb { position: fixed; inset: 0; z-index: 2600; display: flex; align-items: center; justify-content: center; padding: 56px 76px; background: rgba(10, 10, 10, .84); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); cursor: zoom-out; }
.cpr-lb .media { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 12px; box-shadow: 0 30px 80px -20px rgba(0, 0, 0, .6); cursor: default; background: rgba(0, 0, 0, .3); }
.cpr-lb .lb-x { position: absolute; right: 24px; top: 20px; width: 36px; height: 36px; border: 0; border-radius: 99px; background: rgba(255, 255, 255, .12); color: #fff; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.cpr-lb .lb-x:hover { background: rgba(255, 255, 255, .22); }
.cpr-lb .lb-x .nv-i { width: 16px; height: 16px; }
.cpr-lb .lb-nav { position: absolute; top: 50%; margin-top: -20px; width: 40px; height: 40px; border: 0; border-radius: 99px; background: rgba(255, 255, 255, .12); color: #fff; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.cpr-lb .lb-nav:hover { background: rgba(255, 255, 255, .22); }
.cpr-lb .lb-nav.prev { left: 20px; }
.cpr-lb .lb-nav.next { right: 20px; }
.cpr-lb .lb-nav .nv-i { width: 17px; height: 17px; }
.cpr-lb .lb-meta { position: absolute; left: 50%; bottom: 20px; transform: translateX(-50%); max-width: calc(100% - 48px); height: 30px; padding: 0 12px; border-radius: 15px; display: inline-flex; align-items: center; gap: 8px; background: rgba(20, 20, 20, .66); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); color: rgba(255, 255, 255, .86); font: 400 11.5px/1 var(--font-sans); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cpr-lb .lb-meta em { font: 400 11px/1 var(--font-mono); font-style: normal; color: rgba(255, 255, 255, .5); }
.cpr-lb-enter-active, .cpr-lb-leave-active { transition: opacity .2s var(--ease-out); }
.cpr-lb-enter-from, .cpr-lb-leave-to { opacity: 0; }

@media (max-width: 720px) { .cv-zoom input { display: none; } }
</style>
