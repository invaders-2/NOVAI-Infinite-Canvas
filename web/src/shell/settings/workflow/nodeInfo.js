// 工作流设置：节点 / 字段的静态信息与纯函数（照搬旧 static/js/comfyui-settings.js）
import { state, t } from '../../../lib/store.js';

export const TYPES = [
    { v: 'text', zh: '文本', en: 'Text' },
    { v: 'textarea', zh: '多行文本', en: 'Textarea' },
    { v: 'number', zh: '数字', en: 'Number' },
    { v: 'slider', zh: '滑块', en: 'Slider' },
    { v: 'dropdown', zh: '下拉框', en: 'Dropdown' },
    { v: 'image', zh: '图片', en: 'Image' },
    { v: 'video', zh: '视频', en: 'Video' },
    { v: 'audio', zh: '音频', en: 'Audio' },
    { v: 'boolean', zh: '开关', en: 'Switch' },
];
export function currentLang() { return state.lang === 'en' || (window.StudioI18n && window.StudioI18n.lang && window.StudioI18n.lang() === 'en') ? 'en' : 'zh'; }
export function typeLabel(type) {
    const item = TYPES.find(x => x.v === type);
    return item ? item[currentLang()] : type;
}
export function typeOptions() { return TYPES.map(x => ({ value: x.v, label: typeLabel(x.v) })); }

// 旧版用 emoji 图标，新版按分类换成线性图标
const CAT_ICON = { sampler: 'settings', loader: 'box', lora: 'bolt', prompt: 'type', vae: 'layers', image: 'image', output: 'save', latent: 'grid', controlnet: 'target', misc: 'circle' };
export const NODE_INFO = {
    KSampler: { label: '采样器', cat: 'sampler' },
    KSamplerAdvanced: { label: '采样器（高级）', cat: 'sampler' },
    SamplerCustom: { label: '自定义采样', cat: 'sampler' },
    CheckpointLoaderSimple: { label: '主模型加载', cat: 'loader' },
    UNETLoader: { label: 'UNet 加载', cat: 'loader' },
    VAELoader: { label: 'VAE 加载', cat: 'loader' },
    CLIPLoader: { label: 'CLIP 加载', cat: 'loader' },
    DualCLIPLoader: { label: '双 CLIP 加载', cat: 'loader' },
    LoraLoader: { label: 'LoRA 加载', cat: 'lora' },
    LoraLoaderModelOnly: { label: 'LoRA 加载（仅模型）', cat: 'lora' },
    CLIPTextEncode: { label: '提示词编码', cat: 'prompt' },
    CLIPTextEncodeFlux: { label: 'Flux 提示词', cat: 'prompt' },
    ConditioningCombine: { label: '条件合并', cat: 'prompt' },
    ConditioningConcat: { label: '条件拼接', cat: 'prompt' },
    VAEDecode: { label: 'VAE 解码', cat: 'vae' },
    VAEEncode: { label: 'VAE 编码', cat: 'vae' },
    LoadImage: { label: '图片加载', cat: 'image' },
    SaveImage: { label: '图片保存', cat: 'output' },
    PreviewImage: { label: '图片预览', cat: 'output' },
    ImageScale: { label: '图片缩放', cat: 'image' },
    EmptyLatentImage: { label: '空白潜空间', cat: 'latent' },
    LatentUpscaleBy: { label: '潜空间放大', cat: 'latent' },
    ControlNetApply: { label: 'ControlNet', cat: 'controlnet' },
    ControlNetLoader: { label: 'ControlNet 加载', cat: 'loader' },
    PrimitiveNode: { label: '常量', cat: 'misc' },
    Note: { label: '备注', cat: 'misc' },
};

const INPUT_LABELS = {
    text: '提示词文本', prompt: '提示词', positive: '正向条件', negative: '负向条件', seed: '随机种子', noise_seed: '噪声种子',
    steps: '采样步数', cfg: 'CFG 引导系数', sampler_name: '采样方法', scheduler: '调度器', denoise: '重绘强度', width: '宽度', height: '高度',
    batch_size: '批量大小', megapixels: '百万像素', strength_model: '模型强度', strength_clip: 'CLIP 强度', lora_name: 'LoRA 模型', ckpt_name: '主模型',
    vae_name: 'VAE 模型', clip_name: 'CLIP 模型', clip_name1: 'CLIP 模型 1', clip_name2: 'CLIP 模型 2', unet_name: 'UNet 模型',
    control_net_name: 'ControlNet 模型', image: '图片', images: '图片', mask: '蒙版', latent: '潜空间', value: '数值', string: '字符串',
    strength: '强度', guidance: '引导系数', resolution: '分辨率', filename_prefix: '文件名前缀', upscale_method: '放大方式', crop: '裁剪方式',
};

export function tf(key, vars, fallback) {
    let s = t(key, fallback);
    Object.entries(vars || {}).forEach(([k, v]) => { s = s.split('{' + k + '}').join(String(v)); });
    return s;
}
export function nodeLabel(node) {
    if (node && node._meta && node._meta.title) return node._meta.title;
    return (NODE_INFO[node && node.class_type] || {}).label || (node && node.class_type) || '未命名';
}
export function nodeSub(node) {
    const info = NODE_INFO[node.class_type];
    if (info && node._meta && node._meta.title) return info.label + ' · ' + node.class_type;
    return node.class_type || '';
}
export function nodeCat(node) { return (NODE_INFO[node && node.class_type] || {}).cat || 'misc'; }
export function nodeIcon(node) { return CAT_ICON[nodeCat(node)] || 'circle'; }
export function inputLabel(name) { return INPUT_LABELS[name] || name; }

// 连线输入（[nodeId, outputIndex]）不可配置
export function isLink(v) { return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number'; }
export function configurableInputs(node) { return Object.entries((node && node.inputs) || {}).filter(([, v]) => !isLink(v)); }

export function guessType(value, inputName) {
    const lc = (inputName || '').toLowerCase();
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return /strength|cfg|denoise/.test(lc) ? 'slider' : 'number';
    if (typeof value === 'string') {
        if (/prompt|text|description/.test(lc) || (value && value.length > 60)) return 'textarea';
        if (/video|movie|mp4|webm|mov|m4v|vhs/.test(lc) || /\.(mp4|webm|mov|m4v|avi|mkv)(\?|$)/i.test(value)) return 'video';
        if (/audio|sound|music|voice|wav|mp3/.test(lc) || /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(value)) return 'audio';
        if (/image|img|mask|filename|file/.test(lc) || /\.(png|jpe?g|webp|gif|bmp|tiff?)(\?|$)/i.test(value)) return 'image';
        return 'text';
    }
    return 'text';
}

export function fieldKind(f) {
    if (['image', 'video', 'audio'].includes(f.type)) return f.type;
    const key = `${f.input || ''} ${f.name || ''}`.toLowerCase();
    if (f.type === 'textarea' || /prompt|text|提示词|正向|负向/.test(key)) return 'prompt';
    return 'setting';
}
export function isMediaField(f) { return ['image', 'video', 'audio'].includes(fieldKind(f)); }
export function mediaFieldLabel(kind, count) {
    const labels = currentLang() === 'en' ? { image: 'Images', video: 'Videos', audio: 'Audio' } : { image: '图片', video: '视频', audio: '音频' };
    return `${labels[kind] || kind} ${count}`;
}
export function mediaAccept(kind) { return kind === 'video' ? 'video/*' : kind === 'audio' ? 'audio/*' : 'image/*'; }
export function mediaUploadText(kind) {
    if (kind === 'video') return t('comfy.clickUploadVideo', '点击上传视频');
    if (kind === 'audio') return t('comfy.clickUploadAudio', '点击上传音频');
    return t('comfy.clickUploadImage', '点击上传图片');
}
export function mediaUploadFailedText(kind) {
    if (kind === 'video') return t('comfy.videoUploadFailed', '视频上传失败');
    if (kind === 'audio') return t('comfy.audioUploadFailed', '音频上传失败');
    return t('comfy.imageUploadFailed', '图片上传失败');
}

export function randomValueForField(f) {
    const isFloat = Number(f.step) > 0 && Number(f.step) < 1;
    let min = Number.isFinite(Number(f.min)) ? Number(f.min) : null;
    let max = Number.isFinite(Number(f.max)) ? Number(f.max) : null;
    const name = `${f.input || ''} ${f.name || ''}`.toLowerCase();
    const looksSeed = name.includes('seed') || name.includes('noise') || name.includes('随机') || name.includes('噪');
    if (min === null) min = looksSeed ? 1 : 0;
    if (max === null || max <= min) max = looksSeed ? 1000000000000000 : 999999;
    let value = min + Math.random() * (max - min);
    if (isFloat) {
        const precision = Math.min(8, Math.max(1, (String(f.step).split('.')[1] || '').length || 2));
        value = Number(value.toFixed(precision));
    } else value = Math.floor(value);
    return value;
}
export function fieldSupportsRandom(f) { return !!f && f.type === 'number' && f.random_enabled === true; }

export function defaultMiniCards() {
    return { prompt: { x: 24, y: 30 }, image: { x: 24, y: 210 }, custom: { x: 280, y: 78 }, output: { x: 540, y: 120 } };
}
export function defaultMiniTestNodes() {
    return [
        { id: 'prompt_1', type: 'prompt', x: 36, y: 96, text: '' },
        { id: 'image_1', type: 'image', x: 36, y: 286, url: '', value: '' },
        { id: 'comfy_1', type: 'comfy', x: 330, y: 150 },
        { id: 'output_1', type: 'output', x: 670, y: 190 },
    ];
}

// 节点拓扑分层（从入度 0 的源节点向下游传播）
export function computeLayers(wf) {
    const ids = Object.keys(wf);
    const incoming = {}, outgoing = {};
    ids.forEach(id => { incoming[id] = new Set(); outgoing[id] = new Set(); });
    ids.forEach(id => {
        Object.values((wf[id] && wf[id].inputs) || {}).forEach(v => {
            if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && wf[v[0]]) { incoming[id].add(v[0]); outgoing[v[0]].add(id); }
        });
    });
    const layer = {};
    const visited = new Set();
    function dfs(id, lv) {
        if (visited.has(id)) return;
        if ((layer[id] || 0) < lv) layer[id] = lv; else layer[id] = layer[id] || lv;
        visited.add(id);
        outgoing[id].forEach(child => dfs(child, lv + 1));
    }
    ids.forEach(id => { if (incoming[id].size === 0) dfs(id, 0); });
    ids.forEach(id => { if (!(id in layer)) layer[id] = 0; });
    const buckets = {};
    ids.forEach(id => { (buckets[layer[id]] = buckets[layer[id]] || []).push(id); });
    return { layer, buckets, incoming };
}

export function sortNodeIds(ids) {
    return ids.slice().sort((a, b) => {
        const an = parseInt(a, 10), bn = parseInt(b, 10);
        if (!isNaN(an) && !isNaN(bn)) return an - bn;
        return a.localeCompare(b);
    });
}
