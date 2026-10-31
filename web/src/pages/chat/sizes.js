// 尺寸数据与规则（原样移植自旧 gpt-chat.html：SIZE_OPTIONS / MODEL_SIZE_PRESETS / getSizeOptionsForModel /
// normalizeChatCustomSize / chatSizeFromPrompt），纯函数，不依赖 window。
// 7 个常用比例 × 1k/2k/4k；像素取官方 APIMart gpt-image-2 size×resolution 映射表的第一组
// （/tmp/novai-official-docs/text/apimart_gpt_image_2_generation_md.txt:380-422），
// 与 main.py 的 CHAT_RATIO_SIZE_OPTIONS 同值，一致性由 tests/test_chat_size_parity.js 守住。
export const SIZE_OPTIONS = {
    square: [['1024x1024','1k'], ['2048x2048','2k'], ['2880x2880','4k']],
    portrait: [['1024x1536','1k'], ['1360x2048','2k'], ['2336x3520','4k']],
    portrait43: [['768x1024','1k'], ['1536x2048','2k'], ['2480x3312','4k']],
    landscape43: [['1024x768','1k'], ['2048x1536','2k'], ['3312x2480','4k']],
    landscape: [['1536x1024','1k'], ['2048x1360','2k'], ['3520x2336','4k']],
    story: [['864x1536','1k'], ['1152x2048','2k'], ['2160x3840','4k']],
    wide: [['1536x864','1k'], ['2048x1152','2k'], ['3840x2160','4k']]
};

function apimartChatSizeSubset(keys, levels = []) {
    const out = {};
    keys.forEach(key => {
        const sizes = SIZE_OPTIONS[key] || [];
        out[key] = levels.length ? sizes.filter(item => levels.includes(item[1])) : sizes;
    });
    return out;
}

const QWEN_IMAGE_SIZE_PRESET = {
    square: [['1024x1024','1k'], ['2048x2048','2k']],
    landscape43: [['1152x864','1k'], ['2048x1536','2k']],
    portrait43: [['864x1152','1k'], ['1536x2048','2k']],
    wide: [['1280x720','1k'], ['2048x1152','2k']],
    story: [['720x1280','1k'], ['1152x2048','2k']],
    landscape: [['1248x832','1k'], ['2048x1360','2k']],
    portrait: [['832x1248','1k'], ['1360x2048','2k']]
};
const APIMART_CHAT_IMAGE_SIZE_KEYS = ['square','portrait','landscape','portrait43','landscape43','story','wide'];

// 模型专用尺寸映射：根据模型自动匹配其 API 支持的尺寸
// 键名按匹配优先级排列，model name 包含键名即命中
export const MODEL_SIZE_PRESETS = {
    'gpt-image-2.5-ext': apimartChatSizeSubset(APIMART_CHAT_IMAGE_SIZE_KEYS),
    'hy-image-v3.5-preview': apimartChatSizeSubset(APIMART_CHAT_IMAGE_SIZE_KEYS),
    'flux-3-image-klein': apimartChatSizeSubset(APIMART_CHAT_IMAGE_SIZE_KEYS),
    'flux-3-image': apimartChatSizeSubset(APIMART_CHAT_IMAGE_SIZE_KEYS),
    'grok-imagine-2.0-ext': apimartChatSizeSubset(APIMART_CHAT_IMAGE_SIZE_KEYS, ['1k']),
    'grok-imagine-image-2.0': apimartChatSizeSubset(APIMART_CHAT_IMAGE_SIZE_KEYS, ['1k','2k']),
    'grok-imagine-image-quality': apimartChatSizeSubset(APIMART_CHAT_IMAGE_SIZE_KEYS, ['1k','2k']),
    'grok-imagine-image': apimartChatSizeSubset(APIMART_CHAT_IMAGE_SIZE_KEYS, ['1k','2k']),
    'grok-imagine-1.5': apimartChatSizeSubset(APIMART_CHAT_IMAGE_SIZE_KEYS, ['1k']),
    'qwen-image-2.0': QWEN_IMAGE_SIZE_PRESET,
    'qwen-image-3.0': QWEN_IMAGE_SIZE_PRESET,
    'z-image-turbo': QWEN_IMAGE_SIZE_PRESET,
    'wan2.7-image-pro': apimartChatSizeSubset(APIMART_CHAT_IMAGE_SIZE_KEYS),
    'wan2.7-image': apimartChatSizeSubset(APIMART_CHAT_IMAGE_SIZE_KEYS, ['1k','2k']),
    'imagen-4.0-apimart': apimartChatSizeSubset(['square','landscape43','portrait43','wide','story'], ['1k']),
    // ── OpenAI ──
    'gpt-image-2': {
        square: [['1024x1024','1k'], ['2048x2048','2k'], ['2880x2880','4k']],
        portrait: [['1024x1536','1k'], ['1360x2048','2k'], ['2336x3520','4k']],
        portrait43: [['768x1024','1k'], ['1536x2048','2k'], ['2480x3312','4k']],
        landscape43: [['1024x768','1k'], ['2048x1536','2k'], ['3312x2480','4k']],
        landscape: [['1536x1024','1k'], ['2048x1360','2k'], ['3520x2336','4k']],
        story: [['864x1536','1k'], ['1152x2048','2k'], ['2160x3840','4k']],
        wide: [['1536x864','1k'], ['2048x1152','2k'], ['3840x2160','4k']]
    },
    'gpt-image-1': {
        square: [['1024x1024','1k']],
        portrait: [['1024x1536','1k']],
        landscape: [['1536x1024','1k']]
    },
    'dall-e-3': {
        square: [['1024x1024','1k']],
        portrait: [['1024x1792','1k']],
        landscape: [['1792x1024','1k']]
    },
    'dall-e-2': {
        square: [['1024x1024','1k'], ['512x512','small'], ['256x256','tiny']],
        portrait: [['512x768','1k']],
        landscape: [['768x512','1k']]
    },

    // ── Nano Banana (Gemini 出图) ──
    'nano-banana': {
        square: [['1024x1024','1k'], ['2048x2048','2k'], ['4096x4096','4k']],
        portrait: [['1024x1536','1k'], ['2048x3072','2k'], ['4096x6144','4k']],
        landscape: [['1536x1024','1k'], ['3072x2048','2k'], ['6144x4096','4k']],
        portrait916: [['720x1280','1k'], ['1080x1920','2k'], ['2160x3840','4k']],
        landscape916: [['1280x720','1k'], ['1920x1080','2k'], ['3840x2160','4k']],
        portrait43: [['1024x1365','1k'], ['2048x2730','2k'], ['3072x4096','4k']],
        landscape43: [['1365x1024','1k'], ['2730x2048','2k'], ['4096x3072','4k']]
    },
    'nano-banana-2': {
        square: [['1024x1024','1k'], ['2048x2048','2k'], ['4096x4096','4k']],
        portrait: [['1024x1536','1k'], ['2048x3072','2k'], ['4096x6144','4k']],
        landscape: [['1536x1024','1k'], ['3072x2048','2k'], ['6144x4096','4k']],
        portrait916: [['720x1280','1k'], ['1080x1920','2k'], ['2160x3840','4k']],
        landscape916: [['1280x720','1k'], ['1920x1080','2k'], ['3840x2160','4k']],
        portrait43: [['1024x1365','1k'], ['2048x2730','2k'], ['3072x4096','4k']],
        landscape43: [['1365x1024','1k'], ['2730x2048','2k'], ['4096x3072','4k']]
    },
    'nano-banana-pro': {
        square: [['1024x1024','1k'], ['2048x2048','2k'], ['4096x4096','4k']],
        portrait: [['1024x1536','1k'], ['2048x3072','2k'], ['4096x6144','4k']],
        landscape: [['1536x1024','1k'], ['3072x2048','2k'], ['6144x4096','4k']],
        portrait916: [['720x1280','1k'], ['1080x1920','2k'], ['2160x3840','4k']],
        landscape916: [['1280x720','1k'], ['1920x1080','2k'], ['3840x2160','4k']],
        portrait43: [['1024x1365','1k'], ['2048x2730','2k'], ['3072x4096','4k']],
        landscape43: [['1365x1024','1k'], ['2730x2048','2k'], ['4096x3072','4k']]
    },

    // ── Seedream (火山引擎) ──
    'seedream-5.0': {
        square: [['2048x2048','2k'], ['3072x3072','3k']],
        portrait: [['1536x2048','2k'], ['2304x3072','3k']],
        landscape: [['2048x1536','2k'], ['3072x2304','3k']],
        portrait916: [['1152x2048','2k'], ['1728x3072','3k']],
        landscape916: [['2048x1152','2k'], ['3072x1728','3k']],
        portrait43: [['1536x2048','2k'], ['2304x3072','3k']],
        landscape43: [['2048x1536','2k'], ['3072x2304','3k']]
    },
    'seedream-4.5': {
        square: [['2048x2048','2k'], ['4096x4096','4k']],
        portrait: [['1536x2048','2k'], ['3072x4096','4k']],
        landscape: [['2048x1536','2k'], ['4096x3072','4k']],
        portrait916: [['1152x2048','2k'], ['2304x4096','4k']],
        landscape916: [['2048x1152','2k'], ['4096x2304','4k']],
        portrait43: [['1536x2048','2k'], ['3072x4096','4k']],
        landscape43: [['2048x1536','2k'], ['4096x3072','4k']]
    },
    'seedream-4.0': {
        square: [['1024x1024','1k'], ['2048x2048','2k']],
        portrait: [['832x1216','1k'], ['1664x2432','2k']],
        landscape: [['1216x832','1k'], ['2432x1664','2k']],
        portrait43: [['928x1216','1k'], ['1856x2432','2k']],
        landscape43: [['1216x928','1k'], ['2432x1856','2k']]
    },
    'seedream-3.0': {
        square: [['1024x1024','1k'], ['2048x2048','2k']],
        portrait: [['832x1216','1k'], ['1664x2432','2k']],
        landscape: [['1216x832','1k'], ['2432x1664','2k']],
        portrait43: [['928x1216','1k'], ['1856x2432','2k']],
        landscape43: [['1216x928','1k'], ['2432x1856','2k']]
    },

    // ── Flux ──
    'flux': {
        square: [['1024x1024','1k'], ['1536x1536','2k']],
        portrait: [['832x1216','1k'], ['1024x1536','2k']],
        landscape: [['1216x832','1k'], ['1536x1024','2k']],
        portrait916: [['768x1344','1k'], ['1024x1792','2k']],
        landscape916: [['1344x768','1k'], ['1792x1024','2k']],
        portrait43: [['896x1216','1k'], ['1152x1536','2k']],
        landscape43: [['1216x896','1k'], ['1536x1152','2k']]
    },

    // ── SDXL ──
    'sdxl': {
        square: [['1024x1024','1k']],
        portrait: [['896x1152','1k']],
        landscape: [['1152x896','1k']],
        portrait916: [['768x1344','1k']],
        landscape916: [['1344x768','1k']],
        portrait43: [['896x1152','1k']],
        landscape43: [['1152x896','1k']]
    },
    'stable-diffusion-xl': {
        square: [['1024x1024','1k']],
        portrait: [['896x1152','1k']],
        landscape: [['1152x896','1k']],
        portrait916: [['768x1344','1k']],
        landscape916: [['1344x768','1k']]
    },

    // ── SD 1.5 / 2.1 ──
    'stable-diffusion-2': {
        square: [['768x768','1k']],
        portrait: [['768x1152','1k']],
        landscape: [['1152x768','1k']]
    },
    'stable-diffusion': {
        square: [['512x512','1k']],
        portrait: [['512x768','1k']],
        landscape: [['768x512','1k']]
    },

    // ── Midjourney ──
    'midjourney': {
        square: [['1024x1024','1k']],
        portrait: [['832x1216','1k']],
        landscape: [['1216x832','1k']],
        portrait916: [['768x1344','1k']],
        landscape916: [['1344x768','1k']],
        portrait43: [['896x1216','1k']],
        landscape43: [['1216x896','1k']]
    },

    // ── Ideogram ──
    'ideogram': {
        square: [['1024x1024','1k']],
        portrait: [['896x1152','1k']],
        landscape: [['1152x896','1k']],
        portrait916: [['768x1344','1k']],
        landscape916: [['1344x768','1k']],
        portrait43: [['896x1216','1k']],
        landscape43: [['1216x896','1k']]
    },

    // ── Kolors ──
    'kolors': {
        square: [['1024x1024','1k'], ['2048x2048','2k']],
        portrait: [['768x1024','1k'], ['1536x2048','2k']],
        landscape: [['1024x768','1k'], ['2048x1536','2k']]
    },

    // ── Hunyuan ──
    'hunyuan': {
        square: [['1024x1024','1k']],
        portrait: [['768x1024','1k']],
        landscape: [['1024x768','1k']]
    },

    // ── Recraft ──
    'recraft': {
        square: [['1024x1024','1k']],
        portrait: [['1024x1536','1k']],
        landscape: [['1536x1024','1k']]
    },

    // ── Playground ──
    'playground': {
        square: [['1024x1024','1k']],
        portrait: [['832x1216','1k']],
        landscape: [['1216x832','1k']]
    }
};

export const RATIOS = [
    { key: 'square', label: '1:1', sub: '正方形' },
    { key: 'portrait', label: '2:3', sub: '竖图' },
    { key: 'landscape', label: '3:2', sub: '横图' },
    { key: 'portrait43', label: '3:4', sub: '竖图' },
    { key: 'landscape43', label: '4:3', sub: '横图' },
    { key: 'story', label: '9:16', sub: '竖屏' },
    { key: 'wide', label: '16:9', sub: '宽屏' },
];
export const RATIO_KEYS = ['square', 'portrait', 'portrait43', 'landscape43', 'landscape', 'story', 'wide'];
export const RATIO_LABELS = { square: '1:1', portrait: '2:3', portrait43: '3:4', landscape43: '4:3', landscape: '3:2', story: '9:16', wide: '16:9' };
export const LEVELS = ['1k', '2k', '4k'];

export function getSizeOptionsForModel(model) {
    const m = String(model || '').toLowerCase();
    // Gemini 图模型的官方模型名不含 "nano-banana"，先按别名映射，避免 4K 回落到通用表被缩水
    if (m.includes('gemini-3-pro-image')) return MODEL_SIZE_PRESETS['nano-banana-pro'];
    if (m.includes('gemini-3.1-flash-image')) return MODEL_SIZE_PRESETS['nano-banana-2'];
    for (const [key, sizes] of Object.entries(MODEL_SIZE_PRESETS)) {
        if (m.includes(key)) return sizes;
    }
    return SIZE_OPTIONS;
}

export function normalizeChatCustomSize(value) {
    const match = String(value || '').trim().match(/^([1-9]\d{2,3})\s*[xX×*]\s*([1-9]\d{2,3})$/);
    if (!match) return '';
    const w = Math.round(Number(match[1]));
    const h = Math.round(Number(match[2]));
    if (w < 256 || h < 256 || w > 8192 || h > 8192) return '';
    return `${w}x${h}`;
}

// label: auto | custom | 1k | 2k | 4k
export function sizeFor(opts, ratio, label, customSize) {
    if (label === 'auto') return '1024x1024';
    if (label === 'custom') return normalizeChatCustomSize(customSize) || '1024x1024';
    const options = opts[ratio] || opts.square;
    const match = options.find(([, item]) => item === label) || options[0];
    return match[0];
}

// 提示词里写了尺寸 / 比例时覆盖：显式 1k/2k/4k 只认「1024x1536」这种直接尺寸
export function chatSizeFromPrompt(message, fallbackSize, resolution, opts) {
    const text = String(message || '');
    const explicitResolution = LEVELS.includes(resolution);
    const direct = text.match(/(^|[^\d])([1-9]\d{2,4})\s*[xX×*]\s*([1-9]\d{2,4})(?!\d)/);
    if (direct) {
        const w = Number(direct[2]);
        const h = Number(direct[3]);
        if (w >= 256 && h >= 256) return `${w}x${h}`;
    }
    if (explicitResolution) return fallbackSize;
    const normalized = text.replace(/[：﹕∶]/g, ':').replace(/比/g, ':').replace(/[／/]/g, ':');
    const match = normalized.match(/(^|[^\d])(1|2|3|4|9|16)\s*:\s*(1|2|3|4|9|16)(?!\d)/);
    if (!match) return fallbackSize;
    const ratio = `${Number(match[2])}:${Number(match[3])}`;
    const ratioMap = { '1:1': 'square', '2:3': 'portrait', '3:2': 'landscape', '3:4': 'portrait43', '4:3': 'landscape43', '9:16': 'story', '16:9': 'wide' };
    const key = ratioMap[ratio];
    if (!key) return fallbackSize;
    const wants4k = /4\s*k|4K|超清|超高分辨率/i.test(text);
    const wants2k = /2\s*k|2K|高清|高分辨率/i.test(text);
    if (resolution === 'custom' && !wants4k && !wants2k) return fallbackSize;
    const fallbackEdge = Math.max(...String(fallbackSize || '').split(/[xX×*]/).map(n => Number(n) || 0));
    const targetLabel = wants4k ? '4k' : (wants2k ? '2k' : (resolution === 'auto' ? '1k' : (fallbackEdge >= 2400 ? '4k' : (fallbackEdge >= 1500 ? '2k' : '1k'))));
    return ((opts[key] || opts.square).find(([, label]) => label === targetLabel) || [])[0] || fallbackSize;
}
