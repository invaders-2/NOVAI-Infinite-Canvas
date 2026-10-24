<script setup>
// brief 弹窗：一键做同款 / 用这个开始都走这里。左示例、右表单（参考素材 + 字段 + 补充描述）。
// 提交 → POST /api/store/items/{kind}/{name}/launch → 写入画布种子并跳到画布（只预填，不自动发送）。
import { computed, onMounted, onBeforeUnmount, reactive, ref } from 'vue';
import NvIcon from '../../components/NvIcon.vue';
import StoreCover from './StoreCover.vue';
import { buildLaunchBody, launchStoreItem, openStoreCanvas, uploadReferences } from './storeData.js';

const props = defineProps({
    item: { type: Object, required: true },
    detail: { type: Object, default: null },
    preset: { type: Object, default: null },
});
const emit = defineEmits(['close']);

const MAX_FILE_MB = 20;
const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif';

const refsConfig = computed(() => {
    const refs = props.preset && props.preset.inputs ? props.preset.inputs.references : null;
    if (refs) return refs;
    if (props.detail && props.detail.tryForm) return props.detail.tryForm.references;
    return { min: 0, max: 3, roles: [] };
});
const fields = computed(() => {
    if (props.preset) return props.preset.inputs.fields;
    if (props.detail && props.detail.tryForm) return props.detail.tryForm.fields;
    return [];
});
const promptMax = computed(() => {
    if (props.preset) return props.preset.inputs.prompt.maxLength || 500;
    if (props.detail && props.detail.tryForm) return props.detail.tryForm.prompt.maxLength || 500;
    return 500;
});
const showUpload = computed(() => refsConfig.value.max > 0 || refsConfig.value.min > 0);
const media = computed(() => {
    if (props.preset && props.preset.cover) return props.preset.cover;
    if (props.detail && props.detail.coverVideoUrl) return { kind: 'video', src: props.detail.coverVideoUrl, poster: props.detail.coverUrl };
    if (props.item.coverVideoUrl) return { kind: 'video', src: props.item.coverVideoUrl, poster: props.item.coverUrl };
    return { kind: 'image', src: (props.detail && props.detail.coverUrl) || props.item.coverUrl, poster: '' };
});
const mediaAspect = computed(() => {
    const aspect = props.preset && props.preset.aspect ? props.preset.aspect : '3/4';
    const [w, h] = String(aspect).split('/').map(Number);
    return w > 0 && h > 0 ? { aspectRatio: w + ' / ' + h } : { aspectRatio: '3 / 4' };
});

const refFiles = ref([]);          // { name, preview, url, uploading, error }
const fieldValues = reactive({});
const prompt = ref('');
const uploading = ref(false);
const submitting = ref(false);
const error = ref('');
const fileInput = ref(null);

const refCount = computed(() => refFiles.value.length);
const canSubmit = computed(() => {
    if (submitting.value || uploading.value) return false;
    if (showUpload.value && refCount.value < refsConfig.value.min) return false;
    return true;
});
const footerHint = computed(() => {
    if (!showUpload.value) return '这个能力不需要参考素材';
    const min = refsConfig.value.min;
    const max = refsConfig.value.max;
    if (min > 0) return '至少添加 ' + min + ' 张图片' + (max ? '（最多 ' + max + ' 张）' : '');
    return '参考素材（选填）' + (max ? '，最多 ' + max + ' 张' : '');
});

function fieldModel(field) { return fieldValues[field.id] != null ? fieldValues[field.id] : ''; }

function triggerPick() { if (fileInput.value) fileInput.value.click(); }

function pickFiles(event) {
    const files = Array.from((event.target && event.target.files) || []);
    event.target.value = '';
    addFiles(files);
}

function addFiles(files) {
    error.value = '';
    for (const file of files) {
        const max = refsConfig.value.max;
        if (max > 0 && refFiles.value.length >= max) { error.value = '最多只能添加 ' + max + ' 张图片'; break; }
        if (!/^image\/(jpeg|png|webp|gif)$/i.test(file.type)) { error.value = '只支持 JPEG / PNG / WebP / GIF'; continue; }
        if (file.size > MAX_FILE_MB * 1024 * 1024) { error.value = '单张图片不能超过 ' + MAX_FILE_MB + 'MB'; continue; }
        addOne(file);
    }
}

function addOne(file) {
    const entry = reactive({ name: file.name, preview: '', url: '', uploading: true, error: '' });
    refFiles.value.push(entry);
    const reader = new FileReader();
    reader.onload = e => { entry.preview = String(e.target && e.target.result || ''); };
    reader.readAsDataURL(file);
    uploading.value = true;
    uploadReferences([file]).then(list => {
        const uploaded = list[0];
        if (!uploaded || !uploaded.url) throw new Error('上传失败');
        entry.url = uploaded.url;
        entry.uploading = false;
    }).catch(e => {
        entry.error = '上传失败';
        entry.uploading = false;
        error.value = (file.name || '图片') + ' 上传失败，请重试';
    }).finally(() => {
        uploading.value = refFiles.value.some(item => item.uploading);
    });
}

function removeRef(index) {
    refFiles.value.splice(index, 1);
    error.value = '';
}

function onDrop(event) {
    const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
    if (files.length) addFiles(files);
}

function composeFallbackPrompt() {
    const bits = [];
    const base = props.preset
        ? (props.preset.agent && props.preset.agent.prompt)
        : ((props.detail && (props.detail.starterPrompt || props.detail.description)) || props.item.description);
    if (base) bits.push(base);
    for (const field of fields.value) {
        const value = String(fieldValues[field.id] || '').trim();
        if (value) bits.push(field.label + '：' + value);
    }
    const extra = prompt.value.trim();
    if (extra) bits.push(extra);
    const refs = refFiles.value.filter(item => item.url).map(item => item.name).filter(Boolean);
    if (refs.length) bits.push('参考素材：' + refs.join('、'));
    return bits.join('\n\n');
}

async function submit() {
    if (!canSubmit.value || submitting.value) return;
    error.value = '';
    if (refFiles.value.some(item => !item.url)) { error.value = '还有图片没上传完，稍等一下'; return; }
    submitting.value = true;
    const promptText = composeFallbackPrompt();
    try {
        const body = buildLaunchBody({
            kind: props.item.kind,
            name: props.item.name,
            presetId: props.preset ? props.preset.id : '',
            prompt: prompt.value.trim(),
            fields: fields.value.reduce((acc, field) => {
                const value = String(fieldValues[field.id] || '').trim();
                if (field.id && value) acc[field.id] = value;
                return acc;
            }, {}),
            references: refFiles.value.map(item => ({ name: item.name, url: item.url, kind: 'image' })),
        });
        const result = await launchStoreItem(props.item.kind, props.item.name, body);
        const finalPrompt = result.prompt || promptText || props.detail && props.detail.starterPrompt || '';
        // 市场 brief 是唯一允许自动发送的入口：写下 autoSend:true + 后端给的 skill_ref，画布侧消费一次
        const opened = openStoreCanvas(result.canvasId, finalPrompt, result.project, { autoSend: true, skillRef: result.skillRef });
        if (!opened) throw new Error('没有拿到画布 id');
        emit('close');
    } catch (e) {
        error.value = (e && e.message) || '启动失败，请重试';
    } finally {
        submitting.value = false;
    }
}

function onKey(event) {
    if (event.key === 'Escape') { event.stopPropagation(); emit('close'); }
}
onMounted(() => {
    document.addEventListener('keydown', onKey, true);
    document.body.classList.add('store-brief-open');
});
onBeforeUnmount(() => {
    document.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('store-brief-open');
});
</script>

<template>
    <Teleport to="body">
        <div class="brief-root" role="dialog" aria-modal="true" :aria-label="String(item.displayName || item.name)">
            <div class="brief-scrim" @click="emit('close')"></div>
            <div class="brief-panel">
                <button type="button" class="brief-close" title="关闭" aria-label="关闭" @click="emit('close')">
                    <NvIcon name="close" />
                </button>
                <div class="brief-media" :style="mediaAspect">
                    <StoreCover :src="media.src" :poster="media.poster" :type="media.kind" :alt="item.displayName" :label="item.displayName" autoplay />
                    <div class="brief-media-cap">
                        <span class="brief-media-kind">{{ preset ? preset.title : item.displayName }}</span>
                        <span v-if="preset && preset.description" class="brief-media-desc">{{ preset.description }}</span>
                    </div>
                </div>
                <div class="brief-body">
                    <h2 class="brief-title">{{ preset ? preset.title : item.displayName }}</h2>
                    <p class="brief-sub">{{ preset ? preset.description : (item.marketingLine || item.description) }}</p>

                    <div v-if="showUpload" class="brief-block">
                        <div class="brief-label">
                            参考素材
                            <span class="brief-count">{{ refFiles.length }}<template v-if="refsConfig.max"> / {{ refsConfig.max }}</template></span>
                        </div>
                        <div class="brief-drop" :class="{ 'is-dragging': false }" role="button" tabindex="0"
                             @click="triggerPick" @keydown.enter.prevent="triggerPick" @dragover.prevent @drop.prevent="onDrop">
                            <NvIcon name="image" />
                            <div class="brief-drop-text">
                                <b>点击选择或拖入图片</b>
                                <span>JPEG / PNG / WebP / GIF · 每张 ≤ {{ MAX_FILE_MB }}MB</span>
                            </div>
                            <input ref="fileInput" type="file" :accept="ACCEPT" multiple hidden @change="pickFiles" />
                        </div>
                        <div v-if="refFiles.length" class="brief-thumbs">
                            <div v-for="(file, index) in refFiles" :key="file.name + index" class="brief-thumb">
                                <img v-if="file.preview" :src="file.preview" :alt="file.name" />
                                <span v-else class="brief-thumb-ph">{{ (file.name || '·').slice(0, 1) }}</span>
                                <span v-if="file.uploading" class="brief-thumb-mask">上传中…</span>
                                <button type="button" class="brief-thumb-x" title="移除" aria-label="移除" @click.stop="removeRef(index)">
                                    <NvIcon name="close" />
                                </button>
                            </div>
                        </div>
                    </div>

                    <div v-for="field in fields" :key="field.id" class="brief-block">
                        <label class="brief-label" :for="'store-field-' + field.id">{{ field.label }}</label>
                        <textarea v-if="field.maxLength > 200" :id="'store-field-' + field.id" v-model="fieldValues[field.id]"
                                  class="brief-input" rows="3" :maxlength="field.maxLength || undefined" :placeholder="field.placeholder"></textarea>
                        <input v-else :id="'store-field-' + field.id" v-model="fieldValues[field.id]"
                               class="brief-input" type="text" :maxlength="field.maxLength || undefined" :placeholder="field.placeholder" />
                    </div>

                    <div class="brief-block">
                        <label class="brief-label" for="store-brief-prompt">补充描述<span class="brief-optional">（可选，最多 {{ promptMax }} 字）</span></label>
                        <textarea id="store-brief-prompt" v-model="prompt" class="brief-input" rows="3"
                                  :maxlength="promptMax || undefined" placeholder="还想补充什么？例如风格、时长、平台…"></textarea>
                    </div>

                    <p v-if="error" class="brief-error">{{ error }}</p>

                    <div class="brief-foot">
                        <span class="brief-hint">{{ footerHint }}</span>
                        <button type="button" class="nv-btn" @click="emit('close')">取消</button>
                        <button type="button" class="nv-btn primary" :disabled="!canSubmit" @click="submit">
                            {{ submitting ? '正在创建画布…' : '开始创作' }}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </Teleport>
</template>

<style scoped>
.brief-root { position: fixed; inset: 0; z-index: var(--z-dialog); display: flex; align-items: center; justify-content: center; padding: var(--space-7); }
.brief-scrim { position: absolute; inset: 0; background: var(--scrim); backdrop-filter: var(--material-regular); -webkit-backdrop-filter: var(--material-regular); animation: nv-fade var(--duration-slow) var(--ease-out) both; }
.brief-panel { position: relative; display: flex; width: min(980px, calc(100vw - 48px)); max-height: min(700px, calc(100vh - 48px)); border-radius: var(--radius-2xl); overflow: hidden; background: var(--glass-strong); color: var(--ink); backdrop-filter: var(--material-thick); -webkit-backdrop-filter: var(--material-thick); box-shadow: var(--shadow-dialog); animation: brief-in var(--duration-slow) var(--ease-sheet) both; }
@keyframes brief-in { from { opacity: 0; transform: translateY(12px) scale(.985); } to { opacity: 1; transform: none; } }
.brief-close { position: absolute; right: var(--space-5); top: var(--space-5); z-index: 3; width: var(--control-md); height: var(--control-md); border: 0; border-radius: 50%; background: var(--accent); color: var(--on-accent); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: var(--shadow-float); }
.brief-close .nv-i { width: 14px; height: 14px; }
.brief-media { position: relative; flex: 0 0 42%; background: var(--fill-2); max-height: 100%; }
.brief-media .store-cover { position: absolute; inset: 0; }
.brief-media-cap { position: absolute; left: 0; right: 0; bottom: 0; padding: var(--space-8) var(--space-6) var(--space-6); background: linear-gradient(to top, color-mix(in srgb, var(--ink) 68%, transparent), transparent); color: var(--on-accent); display: flex; flex-direction: column; gap: var(--space-2); }
.brief-media-kind { color: var(--on-accent); font: 500 15px/20px var(--font-sans); }
.brief-media-desc { color: color-mix(in srgb, var(--on-accent) 82%, transparent); font: 400 12px/17px var(--font-sans); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.brief-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--space-5); padding: var(--space-7) var(--space-7) var(--space-6); overflow: auto; scrollbar-width: thin; }
.brief-title { margin: 0; color: var(--ink); font: 500 20px/26px var(--font-sans); letter-spacing: -0.015em; padding-right: var(--space-8); }
.brief-sub { margin: 0; color: var(--ink-3); font: 400 12.5px/19px var(--font-sans); }
.brief-block { display: flex; flex-direction: column; gap: var(--space-3); }
.brief-label { display: flex; align-items: center; justify-content: space-between; color: var(--ink); font: 500 12px/17px var(--font-sans); }
.brief-optional { font-weight: 400; color: var(--ink-4); margin-left: var(--space-1); }
.brief-count { color: var(--ink-3); font: 400 10.5px/1 var(--font-mono); }
.brief-drop { display: flex; align-items: center; gap: var(--space-5); padding: var(--space-5); border-radius: var(--radius-lg); background: var(--fill-1); color: var(--ink-3); cursor: pointer; transition: background var(--duration-base) var(--ease-out); }
.brief-drop:hover { background: var(--fill-2); }
.brief-drop .nv-i { width: 20px; height: 20px; flex-shrink: 0; }
.brief-drop-text { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
.brief-drop-text b { color: var(--ink); font: 500 12.5px/17px var(--font-sans); }
.brief-drop-text span { color: var(--ink-4); font: 400 11px/15px var(--font-sans); }
.brief-thumbs { display: flex; flex-wrap: wrap; gap: var(--space-4); }
.brief-thumb { position: relative; width: 64px; height: 64px; border-radius: var(--radius-md); overflow: hidden; background: var(--fill-2); }
.brief-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.brief-thumb-ph { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--ink-3); font: 500 16px/1 var(--font-sans); }
.brief-thumb-mask { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--ink) 55%, transparent); color: var(--on-accent); font: 500 10px/1 var(--font-sans); }
.brief-thumb-x { position: absolute; right: var(--space-1); top: var(--space-1); width: 18px; height: 18px; border: 0; border-radius: 50%; background: color-mix(in srgb, var(--ink) 55%, transparent); color: var(--on-accent); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.brief-thumb-x .nv-i { width: 9px; height: 9px; }
.brief-input { width: 100%; box-sizing: border-box; min-height: 36px; padding: 9px 11px; border: 0; border-radius: var(--radius-md); background: var(--fill-1); color: var(--ink); font: 400 12.5px/18px var(--font-sans); outline: none; resize: vertical; transition: background var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out); }
.brief-input:focus { background: var(--fill-2); box-shadow: inset 0 1px 2px color-mix(in srgb, var(--ink) 8%, transparent); }
.brief-input::placeholder { color: var(--ink-4); }
.brief-error { margin: 0; color: var(--danger); font: 400 11.5px/16px var(--font-sans); }
.brief-foot { display: flex; align-items: center; gap: var(--space-5); margin-top: auto; padding-top: var(--space-1); }
.brief-hint { flex: 1; min-width: 0; color: var(--ink-3); font: 400 11px/16px var(--font-sans); }
.brief-foot .nv-btn { border: 0; height: var(--control-md); padding: 0 14px; }
@media (max-width: 860px) {
    .brief-panel { flex-direction: column; overflow: auto; }
    .brief-media { flex: 0 0 auto; height: 220px; }
}
</style>
