<script setup>
// 我的资料：改本机（LAN）昵称 / 头像。头像只接受 emoji 或 data:image（后端 200×1024 字节上限）。
// 上传图片先进入取景裁切（拖动 / 缩放），确定后按取景画成 256×256，再按 JPEG 质量循环压到 200KB 以内，
// 避免请求被后端打回；原图留在内存里，本次会话可以「重新裁切」。
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import NvIcon from '../components/NvIcon.vue';
import { toast } from '../lib/store.js';

const props = defineProps({
    nickname: { type: String, default: '' },
    avatar: { type: String, default: '' },
});
const emit = defineEmits(['close', 'saved']);

const AVATAR_LIMIT = 200 * 1024;
const PREVIEW = 240;       // 取景圆直径（和 CSS 的 240 保持一致，导出按 256/240 换算坐标）
const AVATAR_SIZE = 256;   // 最终头像边长
const CROP_MAX = 4;        // 最大放大倍数（1x = 原图刚好铺满圆）
const initialAvatar = String(props.avatar || '').trim();
const initialNick = String(props.nickname || '').trim();

const avatarDraft = ref(initialAvatar);
const emojiDraft = ref(initialAvatar.startsWith('data:') ? '' : initialAvatar);
const nickDraft = ref(initialNick);
const error = ref('');
const saving = ref(false);
const compressing = ref(false);
const sizeNote = ref('');
const fileEl = ref(null);

// 取景：cropImg 是本次会话保留的原图（「重新裁切」直接用），ox / oy 是图片左上角在 240 预览框里的 px
const cropImg = ref(null);
const cropSrc = ref('');
const cropMode = ref(false);
const cropDrag = ref(false);
const cropStage = ref(null);
const cropView = reactive({ zoom: 1, ox: 0, oy: 0 });
const dragFrom = { x: 0, y: 0, ox: 0, oy: 0 };
/** 进裁切前的头像：取消时原样退回去 */
let avatarBeforeCrop = initialAvatar;

const previewImg = computed(() => (avatarDraft.value.startsWith('data:') ? avatarDraft.value : ''));

// 1x = 短边撑满预览圆（cover），所以任何缩放都不会在圆里留白
const cropDraw = computed(() => {
    const img = cropImg.value;
    if (!img || !img.width || !img.height) return { w: 0, h: 0 };
    const base = PREVIEW / Math.min(img.width, img.height);
    return { w: img.width * base * cropView.zoom, h: img.height * base * cropView.zoom };
});
// 用绝对定位的 px 摆图（不用 transform）：导出时按同一套数字换算，预览和产物才能逐像素对上
const cropImgStyle = computed(() => ({
    left: cropView.ox + 'px',
    top: cropView.oy + 'px',
    width: cropDraw.value.w + 'px',
    height: cropDraw.value.h + 'px',
}));
const previewText = computed(() => {
    const t = avatarDraft.value.trim();
    if (t && !t.startsWith('data:')) return t;
    return [...(nickDraft.value.trim() || '我')][0];
});
const busy = computed(() => saving.value || compressing.value);

function onEmojiInput(event) {
    const value = event.target.value;
    emojiDraft.value = value;
    const text = value.trim();
    if (text) { avatarDraft.value = text; sizeNote.value = ''; }
    else if (!avatarDraft.value.startsWith('data:')) avatarDraft.value = '';
}

function pickFile() { if (!busy.value && fileEl.value) fileEl.value.click(); }

function loadImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        // objectURL 留给预览用，调用方负责在换图 / 卸载时回收
        img.onload = () => resolve({ img, url });
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('读取图片失败，换一张试试')); };
        img.src = url;
    });
}

/** 位移夹住：图片任何时候都要盖满预览圆，不留白 */
function clampCrop() {
    const d = cropDraw.value;
    if (!d.w) return;
    cropView.ox = Math.min(0, Math.max(PREVIEW - d.w, cropView.ox));
    cropView.oy = Math.min(0, Math.max(PREVIEW - d.h, cropView.oy));
}

/** 居中 + 最小缩放 = 双击 / 重置的落点 */
function centerCrop() {
    cropView.zoom = 1;
    const d = cropDraw.value;
    cropView.ox = (PREVIEW - d.w) / 2;
    cropView.oy = (PREVIEW - d.h) / 2;
    clampCrop();
}

/** 以预览框内 (px,py) 为不动点缩放：指针 / 手指下面的那块内容不跟着跑 */
function zoomCropTo(next, px = PREVIEW / 2, py = PREVIEW / 2) {
    const zoom = Math.min(CROP_MAX, Math.max(1, next));
    if (Math.abs(zoom - cropView.zoom) < 1e-4) return;
    const ratio = zoom / cropView.zoom;
    cropView.ox = px - (px - cropView.ox) * ratio;
    cropView.oy = py - (py - cropView.oy) * ratio;
    cropView.zoom = zoom;
    clampCrop();
}

function onCropWheel(event) {
    // deltaMode 折算成像素再夹一道：触控板 / 高精度滚轮的偶发大 delta 会一帧跳到上下限
    const raw = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaMode === 2 ? event.deltaY * 800 : event.deltaY;
    const dy = Math.max(-180, Math.min(180, raw));
    const rect = cropStage.value && cropStage.value.getBoundingClientRect();
    const px = rect ? event.clientX - rect.left : PREVIEW / 2;
    const py = rect ? event.clientY - rect.top : PREVIEW / 2;
    zoomCropTo(cropView.zoom * Math.exp(-dy * .0022), px, py);
}

function onCropSlider(event) {
    zoomCropTo(Number(event.target.value));
}

function onCropDown(event) {
    if (event.button !== 0) return;
    cropDrag.value = true;
    dragFrom.x = event.clientX; dragFrom.y = event.clientY;
    dragFrom.ox = cropView.ox; dragFrom.oy = cropView.oy;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
}

function onCropMove(event) {
    if (!cropDrag.value) return;
    cropView.ox = dragFrom.ox + event.clientX - dragFrom.x;
    cropView.oy = dragFrom.oy + event.clientY - dragFrom.y;
    clampCrop();
}

function onCropUp(event) {
    if (!cropDrag.value) return;
    cropDrag.value = false;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch (e) { /* 指针不在这个元素上了 */ }
}

/** 按当前取景把圆里那块画成方形：预览 240 → 导出 size，同一个比例，圆外自然被画布裁掉 */
function renderCrop(size) {
    const img = cropImg.value;
    const d = cropDraw.value;
    if (!img || !d.w) throw new Error('图片还没准备好，稍后再试');
    const k = size / PREVIEW;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前浏览器不支持图片压缩');
    ctx.fillStyle = '#ffffff';   // JPEG 没有透明通道：先铺白底，避免透明区域变黑
    ctx.fillRect(0, 0, size, size);
    // 落点 = 预览坐标 × (size/240)，所以取景拖到哪、导出就是哪
    ctx.drawImage(img, cropView.ox * k, cropView.oy * k, d.w * k, d.h * k);
    return canvas;
}

// 质量从 0.92 往下调；还不够小再降尺寸，保证 dataURL 总长（UTF-8 字节）≤ 200KB
function compressCrop() {
    for (const size of [AVATAR_SIZE, 224, 192, 160, 128]) {
        const canvas = renderCrop(size);
        for (let q = 0.92; q >= 0.3; q -= 0.08) {
            const data = canvas.toDataURL('image/jpeg', q);
            if (data.length <= AVATAR_LIMIT) return { data, size };
        }
    }
    throw new Error('这张图片压缩后仍超过 200KB，换一张试试');
}

async function onFile(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type || !file.type.startsWith('image/')) { error.value = '请选择图片文件'; return; }
    error.value = '';
    compressing.value = true;
    try {
        const { img, url } = await loadImage(file);
        if (cropSrc.value) URL.revokeObjectURL(cropSrc.value);
        cropImg.value = img;
        cropSrc.value = url;
        emojiDraft.value = '';
        avatarBeforeCrop = avatarDraft.value;
        // 新图从居中 + 最小缩放开始，取景由用户拖 / 缩放决定
        centerCrop();
        cropMode.value = true;
    } catch (e) {
        error.value = (e && e.message) || '图片处理失败，换一张试试';
    } finally {
        compressing.value = false;
    }
}

function reenterCrop() {
    if (!cropImg.value || busy.value) return;
    avatarBeforeCrop = avatarDraft.value;
    cropMode.value = true;
    clampCrop();   // 沿用上次取景，只保证它还在合法范围里
}

function cancelCrop() {
    if (compressing.value) return;
    avatarDraft.value = avatarBeforeCrop;
    cropMode.value = false;
    error.value = '';
}

function confirmCrop() {
    if (compressing.value) return;
    error.value = '';
    compressing.value = true;
    try {
        const out = compressCrop();
        avatarDraft.value = out.data;
        emojiDraft.value = '';
        sizeNote.value = '已裁切 ' + out.size + '×' + out.size + ' · ' + Math.max(1, Math.round(out.data.length / 1024)) + ' KB';
        cropMode.value = false;
    } catch (e) {
        error.value = (e && e.message) || '图片处理失败，换一张试试';
    } finally {
        compressing.value = false;
    }
}

function detailOf(data, status) {
    const detail = data && (data.detail || data.message);
    if (typeof detail === 'string' && detail) return detail;
    if (Array.isArray(detail) && detail[0] && detail[0].msg) return String(detail[0].msg);
    return '保存失败（HTTP ' + status + '）';
}

async function save() {
    if (busy.value) return;
    const nickname = nickDraft.value.trim();
    if (!nickname) { error.value = '昵称不能为空'; return; }
    error.value = '';
    saving.value = true;
    try {
        const res = await fetch('/api/lan/me', {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ nickname, avatar: avatarDraft.value }),
        });
        let data = null;
        try { data = await res.json(); } catch (e) {}
        if (!res.ok) throw new Error(detailOf(data, res.status));
        toast('资料已更新', { icon: 'check' });
        emit('saved', (data && data.me) || null);
        emit('close');
    } catch (e) {
        error.value = (e && e.message) || '保存失败，请重试';
    } finally {
        saving.value = false;
    }
}

function close() { if (!saving.value) emit('close'); }
function onKey(event) {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    // 裁切中先退裁切（回到进裁切前的头像），别一按 Esc 连整张弹窗一起关掉
    if (cropMode.value) { cancelCrop(); return; }
    close();
}
onMounted(() => document.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => {
    document.removeEventListener('keydown', onKey, true);
    if (cropSrc.value) URL.revokeObjectURL(cropSrc.value);
});
</script>

<template>
    <Teleport to="#nv-layer">
        <div class="pd-scrim" @mousedown.self="close">
            <div class="pd" role="dialog" aria-modal="true" aria-labelledby="pd-title">
                <div class="pd-hd">
                    <h3 id="pd-title">我的资料</h3>
                    <button type="button" class="pd-x" aria-label="关闭" @click="close"><NvIcon name="x" /></button>
                </div>
                <div class="pd-body">
                    <!-- 裁切态：240 圆形取景，拖动 / 滚轮 / 滑块决定最终头像的取景 -->
                    <div v-if="cropMode" class="pd-crop" data-pd="crop">
                        <div ref="cropStage" class="pd-crop-stage" :class="{ dragging: cropDrag }" data-pd="crop-stage"
                             @pointerdown="onCropDown" @pointermove="onCropMove" @pointerup="onCropUp" @pointercancel="onCropUp"
                             @wheel.prevent="onCropWheel" @dblclick="centerCrop">
                            <img v-if="cropSrc" :src="cropSrc" alt="" draggable="false" :style="cropImgStyle" @dragstart.prevent />
                        </div>
                        <div class="pd-crop-tools">
                            <button type="button" class="pd-btn" data-pd="crop-reset" @click="centerCrop">重置</button>
                            <input class="pd-range" type="range" min="1" :max="CROP_MAX" step="0.01" :value="cropView.zoom"
                                   aria-label="缩放取景" data-pd="crop-zoom" @input="onCropSlider" />
                            <span class="pd-crop-zoom">{{ Math.round(cropView.zoom * 100) }}%</span>
                        </div>
                        <p class="pd-hint">拖动图片移动取景；滚轮 / 双指捏合或滑块缩放；双击预览回到居中</p>
                    </div>
                    <div v-else class="pd-avatar-row">
                        <span class="pd-av" aria-hidden="true"><img v-if="previewImg" :src="previewImg" alt="" /><template v-else>{{ previewText }}</template></span>
                        <div class="pd-avatar-side">
                            <span class="pd-lb">头像</span>
                            <div class="pd-inline">
                                <input class="pd-inp emoji" :value="emojiDraft" maxlength="8" placeholder="输入一个 emoji，例如 🐼" autocomplete="off" :disabled="busy" @input="onEmojiInput" />
                                <button type="button" class="pd-btn" :disabled="busy" @click="pickFile">{{ compressing ? '处理中…' : '上传图片' }}</button>
                            </div>
                            <p class="pd-hint">
                                <span>{{ sizeNote || '上传图片后可拖动 / 缩放取景，确认后按圆形裁成 256×256，并压到 200KB 以内' }}</span>
                                <button v-if="cropImg && !busy" type="button" class="pd-link" data-pd="recrop" @click="reenterCrop">重新裁切</button>
                            </p>
                        </div>
                        <input ref="fileEl" type="file" accept="image/*" hidden data-pd="file" @change="onFile" />
                    </div>
                    <label class="pd-field">
                        <span class="pd-lb">昵称</span>
                        <input v-model="nickDraft" class="pd-inp" maxlength="40" placeholder="本机用户" autocomplete="off" :disabled="saving" />
                        <span class="pd-hint">{{ nickDraft.length }}/40</span>
                    </label>
                    <p v-if="error" class="pd-error">{{ error }}</p>
                </div>
                <div class="pd-ft">
                    <template v-if="cropMode">
                        <button type="button" class="pd-btn" data-pd="crop-cancel" :disabled="compressing" @click="cancelCrop">取消</button>
                        <button type="button" class="pd-btn primary" data-pd="crop-confirm" :disabled="compressing" @click="confirmCrop">{{ compressing ? '处理中…' : '确定' }}</button>
                    </template>
                    <template v-else>
                        <button type="button" class="pd-btn" :disabled="saving" @click="close">取消</button>
                        <button type="button" class="pd-btn primary" :disabled="busy" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
                    </template>
                </div>
            </div>
        </div>
    </Teleport>
</template>

<style scoped>
/* 弹窗层级介于用户菜单（1500）和设置弹窗（2200）之间：设置弹窗永远能盖住它 */
.pd-scrim { position: fixed; inset: 0; z-index: 1700; background: var(--scrim); backdrop-filter: var(--material-thin); -webkit-backdrop-filter: var(--material-thin); display: flex; align-items: center; justify-content: center; padding: 16px; color: var(--ink); font-family: var(--font-sans); }
.pd { width: 440px; max-width: 100%; max-height: calc(100vh - 32px); display: flex; flex-direction: column; border: 0; border-radius: 20px; background: var(--solid); color: var(--ink); box-shadow: var(--shadow-dialog); overflow: hidden; animation: pd-in .2s var(--ease-out); }
@keyframes pd-in { from { opacity: 0; transform: translateY(6px) scale(.99); } }
.pd-hd { display: flex; align-items: center; gap: 10px; padding: 20px 16px 10px 22px; }
.pd-hd h3 { margin: 0; flex: 1; font: 500 16px/24px var(--font-sans); letter-spacing: -.01em; }
.pd-x { width: 30px; height: 30px; border: 0; border-radius: 15px; background: transparent; color: var(--ink-3); display: flex; align-items: center; justify-content: center; cursor: pointer; flex: none; }
.pd-x:hover { background: var(--fill-1); color: var(--ink); }
.pd-x .nv-i { width: 16px; height: 16px; }
.pd-body { padding: 2px 22px 16px; display: flex; flex-direction: column; gap: 16px; overflow-y: auto; }
.pd-avatar-row { display: flex; align-items: flex-start; gap: 14px; }
.pd-av { width: 64px; height: 64px; flex: 0 0 64px; border-radius: 50%; overflow: hidden; background: var(--fill-1); color: var(--ink); display: inline-flex; align-items: center; justify-content: center; font: 500 28px/1 var(--font-sans); }
.pd-av img { width: 100%; height: 100%; object-fit: cover; display: block; }
/* 裁切态：圆形取景靠底色 + 柔和投影分层，不画边框；图片用绝对定位 px 摆放，和导出坐标系一致 */
.pd-crop { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.pd-crop-stage { position: relative; width: 240px; height: 240px; flex: none; border-radius: 50%; overflow: hidden; background: var(--fill-1); box-shadow: 0 10px 28px -12px rgba(0, 0, 0, .28); cursor: grab; touch-action: none; user-select: none; }
.pd-crop-stage.dragging { cursor: grabbing; }
.pd-crop-stage img { position: absolute; display: block; max-width: none; pointer-events: none; -webkit-user-drag: none; }
.pd-crop-tools { display: flex; align-items: center; gap: 10px; width: 100%; max-width: 280px; }
.pd-range { flex: 1; min-width: 0; height: 20px; margin: 0; background: transparent; accent-color: var(--accent); cursor: pointer; }
.pd-crop-zoom { min-width: 40px; text-align: right; font: 400 11px/16px var(--font-sans); color: var(--ink-3); font-variant-numeric: tabular-nums; }
.pd-link { border: 0; padding: 0; background: transparent; color: var(--accent); font: 500 11px/16px var(--font-sans); cursor: pointer; }
.pd-link:hover { text-decoration: underline; }
.pd-hint .pd-link { margin-left: 8px; }
.pd-avatar-side { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.pd-inline { display: flex; align-items: center; gap: 8px; }
.pd-lb { font: 500 12px/16px var(--font-sans); color: var(--ink-2); }
.pd-inp { width: 100%; height: 38px; padding: 0 12px; border: 0; outline: none; border-radius: 10px; background: var(--fill-1); color: var(--ink); font: 400 13px/1.2 var(--font-sans); transition: background var(--duration-fast) var(--ease-out); }
.pd-inp:focus { background: var(--fill-2); }
.pd-inp::placeholder { color: var(--ink-4); }
.pd-inp.emoji { flex: 1; min-width: 0; }
.pd-field { display: flex; flex-direction: column; gap: 7px; }
.pd-btn { height: 34px; padding: 0 14px; border: 0; border-radius: 10px; background: var(--fill-1); color: var(--ink); font: 500 13px/1 var(--font-sans); cursor: pointer; white-space: nowrap; transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out); }
.pd-btn:hover { background: var(--fill-2); }
.pd-btn:disabled { opacity: .5; cursor: default; }
.pd-btn.primary { background: var(--accent); color: var(--on-accent); }
.pd-btn.primary:hover { opacity: .9; }
.pd-hint { margin: 0; font: 400 11px/16px var(--font-sans); color: var(--ink-4); }
.pd-error { margin: 0; font: 400 12px/18px var(--font-sans); color: var(--danger); }
.pd-ft { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 22px 18px; }
@media (prefers-reduced-motion: reduce) { .pd { animation: none; } }
</style>
