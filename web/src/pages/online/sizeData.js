// 在线生图尺寸表。预置像素 = 官方 size×resolution 映射表（APIMart gpt-image-2 generation，
// 15 比例 × 1k/2k/4k），与 static/js/smart-canvas.js 的 SIZE_MAP 逐格一致；
// 带两组等价像素的 1k 格子取比例精确的第一组（第二组见 main.py APIMART_OFFICIAL_PIXELS）。
// 三处（前端 SIZE_MAP / 本文件 / main.py _AGENT_SMART_SIZE_MAP）的一致性由 tests/test_size_map_parity.js 守住。
export const SIZE_OPTIONS = {
    square: [
        ['1024x1024', '1k'],
        ['2048x2048', '2k'],
        ['2880x2880', '4k']
    ],
    portrait: [
        ['1024x1536', '1k'],
        ['1360x2048', '2k'],
        ['2336x3520', '4k']
    ],
    portrait43: [
        ['768x1024', '1k'],
        ['1536x2048', '2k'],
        ['2480x3312', '4k']
    ],
    landscape43: [
        ['1024x768', '1k'],
        ['2048x1536', '2k'],
        ['3312x2480', '4k']
    ],
    landscape: [
        ['1536x1024', '1k'],
        ['2048x1360', '2k'],
        ['3520x2336', '4k']
    ],
    story: [
        ['864x1536', '1k'],
        ['1152x2048', '2k'],
        ['2160x3840', '4k']
    ],
    wide: [
        ['1536x864', '1k'],
        ['2048x1152', '2k'],
        ['3840x2160', '4k']
    ],
    ultrawide: [
        ['2016x864', '1k'],
        ['2688x1152', '2k'],
        ['3840x1648', '4k']
    ],
    ultratall: [
        ['864x2016', '1k'],
        ['1152x2688', '2k'],
        ['1648x3840', '4k']
    ],
    portrait12: [
        ['1024x2048', '1k'],
        ['1344x2688', '2k'],
        ['1920x3840', '4k']
    ],
    landscape21: [
        ['2048x1024', '1k'],
        ['2688x1344', '2k'],
        ['3840x1920', '4k']
    ],
    landscape54: [
        ['1280x1024', '1k'],
        ['2560x2048', '2k'],
        ['3216x2576', '4k']
    ],
    portrait45: [
        ['1024x1280', '1k'],
        ['2048x2560', '2k'],
        ['2576x3216', '4k']
    ],
    // 官方 1k 还列了一组非 16 对齐的等价像素（1881x836 / 887x1774），bounds 策略（边长 /16）
    // 会把它们吸附掉；这里取官方另一组 3:1 / 1:3 精确且 /16 的像素。
    landscape31: [
        ['1536x512', '1k'],
        ['3072x1024', '2k'],
        ['3840x1280', '4k']
    ],
    portrait13: [
        ['512x1536', '1k'],
        ['1024x3072', '2k'],
        ['1280x3840', '4k']
    ]
};

// Gemini 图片官方「宽高比 × 分辨率」像素表（14 比例 × 1K/2K/4K），
// 出处 /tmp/novai-official-docs/text/gemini_image_generation.txt:4632-4738；
// Gemini 3.1 Flash Image 另有 512px(0.5K) 档（同文:4740-4874）；3.1 Flash Lite / 2.5 Flash 仅 1K 由后端强制。
const GEMINI_OFFICIAL_14 = {
    square: [['1024x1024','1k'], ['2048x2048','2k'], ['4096x4096','4k']],
    portrait14: [['512x2048','1k'], ['1024x4096','2k'], ['2048x8192','4k']],
    portrait18: [['384x3072','1k'], ['768x6144','2k'], ['1536x12288','4k']],
    portrait: [['848x1264','1k'], ['1696x2528','2k'], ['3392x5056','4k']],
    landscape: [['1264x848','1k'], ['2528x1696','2k'], ['5056x3392','4k']],
    portrait43: [['896x1200','1k'], ['1792x2400','2k'], ['3584x4800','4k']],
    landscape41: [['2048x512','1k'], ['4096x1024','2k'], ['8192x2048','4k']],
    landscape43: [['1200x896','1k'], ['2400x1792','2k'], ['4800x3584','4k']],
    portrait45: [['928x1152','1k'], ['1856x2304','2k'], ['3712x4608','4k']],
    landscape54: [['1152x928','1k'], ['2304x1856','2k'], ['4608x3712','4k']],
    landscape81: [['3072x384','1k'], ['6144x768','2k'], ['12288x1536','4k']],
    story: [['768x1376','1k'], ['1536x2752','2k'], ['3072x5504','4k']],
    wide: [['1376x768','1k'], ['2752x1536','2k'], ['5504x3072','4k']],
    ultrawide: [['1584x672','1k'], ['3168x1344','2k'], ['6336x2688','4k']]
};
// Gemini 3.1 Flash Image 的 512px(0.5K) 像素（同文:4749-4874）
const GEMINI_HALF_K = {
    square: '512x512', portrait14: '256x1024', portrait18: '192x1536', portrait: '424x632',
    landscape: '632x424', portrait43: '448x600', landscape41: '1024x256', landscape43: '600x448',
    portrait45: '464x576', landscape54: '576x464', landscape81: '1536x192', story: '384x688',
    wide: '688x384', ultrawide: '792x168'
};
function geminiPreset(withHalfK) {
    const out = {};
    Object.keys(GEMINI_OFFICIAL_14).forEach(key => {
        const tiers = GEMINI_OFFICIAL_14[key];
        out[key] = withHalfK && GEMINI_HALF_K[key] ? [[GEMINI_HALF_K[key], '0.5k']].concat(tiers) : tiers.slice();
    });
    return out;
}

// 火山方舟 Seedream 官方「分辨率档位 × 宽高比」参考像素，
// 出处 /tmp/novai-official-docs/text/volcengine_ark_image_api.txt:152-209,292-349,361-401,413-470：
// 5.0 pro/flash=1K/1.5K/2K（无 3K）、5.0 lite=2K/3K/4K、4.5=2K/4K、4.0=1K/2K/4K；
// 官方方式 1 只列 1:1/4:3/3:4/16:9/9:16/3:2/2:3/21:9 八个比例。
const SEEDREAM_50_PRO_FLASH = {
    square: [['1024x1024','1k'], ['1536x1536','1.5k'], ['2048x2048','2k']],
    landscape43: [['1152x864','1k'], ['1792x1344','1.5k'], ['2368x1776','2k']],
    portrait43: [['864x1152','1k'], ['1344x1792','1.5k'], ['1776x2368','2k']],
    wide: [['1424x800','1k'], ['2048x1152','1.5k'], ['2816x1584','2k']],
    story: [['800x1424','1k'], ['1152x2048','1.5k'], ['1584x2816','2k']],
    landscape: [['1248x832','1k'], ['1872x1248','1.5k'], ['2496x1664','2k']],
    portrait: [['832x1248','1k'], ['1248x1872','1.5k'], ['1664x2496','2k']],
    ultrawide: [['1568x672','1k'], ['2352x1008','1.5k'], ['3136x1344','2k']]
};
const SEEDREAM_50_LITE = {
    square: [['2048x2048','2k'], ['3072x3072','3k'], ['4096x4096','4k']],
    landscape43: [['2304x1728','2k'], ['3456x2592','3k'], ['4704x3520','4k']],
    portrait43: [['1728x2304','2k'], ['2592x3456','3k'], ['3520x4704','4k']],
    wide: [['2848x1600','2k'], ['4096x2304','3k'], ['5504x3040','4k']],
    story: [['1600x2848','2k'], ['2304x4096','3k'], ['3040x5504','4k']],
    landscape: [['2496x1664','2k'], ['3744x2496','3k'], ['4992x3328','4k']],
    portrait: [['1664x2496','2k'], ['2496x3744','3k'], ['3328x4992','4k']],
    ultrawide: [['3136x1344','2k'], ['4704x2016','3k'], ['6240x2656','4k']]
};

function apimartSizeSubset(keys, levels = []) {
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

const APIMART_IMAGE_SIZE_KEYS = ['square','portrait','landscape','portrait43','landscape43','story','wide'];
const APIMART_FLUX3_SIZE_KEYS = ['ultrawide','landscape21','wide','landscape','landscape43','landscape54','square','portrait45','portrait43','portrait','story','portrait12','ultratall'];
const APIMART_GROK_SIZE_KEYS = ['square','portrait43','landscape43','story','wide','portrait','landscape','portrait12','landscape21'];

// 模型专用尺寸映射：根据模型自动匹配其 API 支持的尺寸
// 键名按匹配优先级排列，model name 包含键名即命中（更具体的 key 排在通用 key 前面）
export const MODEL_SIZE_PRESETS = {
    'gpt-image-2.5-ext': apimartSizeSubset(['square','wide','story','landscape43','portrait43','landscape','portrait','landscape54','portrait45','ultrawide']),
    'hy-image-v3.5-preview': apimartSizeSubset(['square','portrait','landscape','portrait43','landscape43','portrait45','landscape54','story','wide','ultrawide']),
    'flux-3-image-klein': apimartSizeSubset(APIMART_FLUX3_SIZE_KEYS),
    'flux-3-image': apimartSizeSubset(APIMART_FLUX3_SIZE_KEYS),
    'grok-imagine-2.0-ext': apimartSizeSubset(APIMART_IMAGE_SIZE_KEYS, ['1k']),
    'grok-imagine-image-2.0': apimartSizeSubset(APIMART_GROK_SIZE_KEYS, ['1k','2k']),
    'grok-imagine-image-quality': apimartSizeSubset(APIMART_GROK_SIZE_KEYS, ['1k','2k']),
    'grok-imagine-image': apimartSizeSubset(APIMART_GROK_SIZE_KEYS, ['1k','2k']),
    'grok-imagine-1.5': apimartSizeSubset(APIMART_IMAGE_SIZE_KEYS, ['1k']),
    'qwen-image-2.0': QWEN_IMAGE_SIZE_PRESET,
    'qwen-image-3.0': QWEN_IMAGE_SIZE_PRESET,
    'z-image-turbo': QWEN_IMAGE_SIZE_PRESET,
    'wan2.7-image-pro': apimartSizeSubset(APIMART_IMAGE_SIZE_KEYS),
    'wan2.7-image': apimartSizeSubset(APIMART_IMAGE_SIZE_KEYS, ['1k','2k']),
    'imagen-4.0-apimart': apimartSizeSubset(['square','landscape43','portrait43','wide','story'], ['1k']),
    // ── OpenAI ──
    // 官方映射表同款（13 比例 × 1k/2k/4k），与 SIZE_OPTIONS / 前端 SIZE_MAP 逐格一致
    'gpt-image-2': {
        square: [['1024x1024','1k'], ['2048x2048','2k'], ['2880x2880','4k']],
        portrait: [['1024x1536','1k'], ['1360x2048','2k'], ['2336x3520','4k']],
        portrait43: [['768x1024','1k'], ['1536x2048','2k'], ['2480x3312','4k']],
        landscape43: [['1024x768','1k'], ['2048x1536','2k'], ['3312x2480','4k']],
        landscape: [['1536x1024','1k'], ['2048x1360','2k'], ['3520x2336','4k']],
        story: [['864x1536','1k'], ['1152x2048','2k'], ['2160x3840','4k']],
        wide: [['1536x864','1k'], ['2048x1152','2k'], ['3840x2160','4k']],
        ultrawide: [['2016x864','1k'], ['2688x1152','2k'], ['3840x1648','4k']],
        ultratall: [['864x2016','1k'], ['1152x2688','2k'], ['1648x3840','4k']],
        portrait12: [['1024x2048','1k'], ['1344x2688','2k'], ['1920x3840','4k']],
        landscape21: [['2048x1024','1k'], ['2688x1344','2k'], ['3840x1920','4k']],
        landscape54: [['1280x1024','1k'], ['2560x2048','2k'], ['3216x2576','4k']],
        portrait45: [['1024x1280','1k'], ['2048x2560','2k'], ['2576x3216','4k']],
        landscape31: [['1536x512','1k'], ['3072x1024','2k'], ['3840x1280','4k']],
        portrait13: [['512x1536','1k'], ['1024x3072','2k'], ['1280x3840','4k']]
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

    // ── Gemini 出图（nano-banana 系）──
    // 官方 14 比例像素表；nano-banana-2 = Gemini 3.1 Flash Image，额外有 0.5K。
    // 更具体的 key 必须排在 'nano-banana' 前，否则子串匹配会互相吞掉。
    'nano-banana-pro': geminiPreset(false),
    'nano-banana-2': geminiPreset(true),
    'nano-banana': geminiPreset(false),

    // ── Seedream (火山引擎) ──
    // 官方逐模型档位：5.0 lite=2K/3K/4K、5.0 pro/flash=1K/1.5K/2K（无 3K）。
    'seedream-5.0-lite': SEEDREAM_50_LITE,
    'seedream-5.0-pro': SEEDREAM_50_PRO_FLASH,
    'seedream-5.0': SEEDREAM_50_PRO_FLASH,
    'seedream-4.5': {
        square: [['2048x2048','2k'], ['4096x4096','4k']],
        landscape43: [['2304x1728','2k'], ['4704x3520','4k']],
        portrait43: [['1728x2304','2k'], ['3520x4704','4k']],
        wide: [['2848x1600','2k'], ['5504x3040','4k']],
        story: [['1600x2848','2k'], ['3040x5504','4k']],
        landscape: [['2496x1664','2k'], ['4992x3328','4k']],
        portrait: [['1664x2496','2k'], ['3328x4992','4k']],
        ultrawide: [['3136x1344','2k'], ['6240x2656','4k']]
    },
    'seedream-4.0': {
        square: [['1024x1024','1k'], ['2048x2048','2k'], ['4096x4096','4k']],
        landscape43: [['1152x864','1k'], ['2304x1728','2k'], ['4704x3520','4k']],
        portrait43: [['864x1152','1k'], ['1728x2304','2k'], ['3520x4704','4k']],
        wide: [['1280x720','1k'], ['2848x1600','2k'], ['5504x3040','4k']],
        story: [['720x1280','1k'], ['1600x2848','2k'], ['3040x5504','4k']],
        landscape: [['1248x832','1k'], ['2496x1664','2k'], ['4992x3328','4k']],
        portrait: [['832x1248','1k'], ['1664x2496','2k'], ['3328x4992','4k']],
        ultrawide: [['1512x648','1k'], ['3136x1344','2k'], ['6240x2656','4k']]
    },
    'seedream-3.0': {
        square: [['1024x1024','1k'], ['2048x2048','2k']],
        portrait: [['832x1216','1k'], ['1664x2432','2k']],
        portrait43: [['928x1216','1k'], ['1856x2432','2k']],
        landscape43: [['1216x928','1k'], ['2432x1856','2k']],
        landscape: [['1216x832','1k'], ['2432x1664','2k']],
        story: [['768x1216','1k'], ['1536x2432','2k']],
        wide: [['1216x768','1k'], ['2432x1536','2k']]
    },

    // ── Flux ──
    'flux': {
        square: [['1024x1024','1k'], ['1536x1536','2k']],
        portrait: [['832x1216','1k'], ['1024x1536','2k']],
        portrait43: [['896x1216','1k'], ['1152x1536','2k']],
        landscape43: [['1216x896','1k'], ['1536x1152','2k']],
        landscape: [['1216x832','1k'], ['1536x1024','2k']],
        story: [['768x1344','1k'], ['1024x1792','2k']],
        wide: [['1344x768','1k'], ['1792x1024','2k']]
    },

    // ── SDXL ──
    'sdxl': {
        square: [['1024x1024','1k']],
        portrait: [['896x1152','1k']],
        portrait43: [['896x1152','1k']],
        landscape43: [['1152x896','1k']],
        landscape: [['1152x896','1k']],
        story: [['768x1344','1k']],
        wide: [['1344x768','1k']]
    },
    'stable-diffusion-xl': {
        square: [['1024x1024','1k']],
        portrait: [['896x1152','1k']],
        landscape: [['1152x896','1k']],
        story: [['768x1344','1k']],
        wide: [['1344x768','1k']]
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
        portrait43: [['896x1216','1k']],
        landscape43: [['1216x896','1k']],
        landscape: [['1216x832','1k']],
        story: [['768x1344','1k']],
        wide: [['1344x768','1k']]
    },

    // ── Ideogram ──
    'ideogram': {
        square: [['1024x1024','1k']],
        portrait: [['896x1152','1k']],
        portrait43: [['896x1216','1k']],
        landscape43: [['1216x896','1k']],
        landscape: [['1152x896','1k']],
        story: [['768x1344','1k']],
        wide: [['1344x768','1k']]
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
