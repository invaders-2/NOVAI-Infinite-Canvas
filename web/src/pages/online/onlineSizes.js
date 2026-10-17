// 在线生图尺寸逻辑（移植自 static/online.html：enumSizeOptions / currentSizeOptions / resPixelLimitFor /
// nearestUsableLevel / updateSizeUI / currentSize）。纯函数，状态由调用方传入。
import { SIZE_OPTIONS, MODEL_SIZE_PRESETS } from './sizeData.js';
import { NovaSizePolicy } from './sizePolicy.js';

// 比例 key 必须与 sizeData.js 的 SIZE_OPTIONS 键一一对应（官方 APIMart gpt-image-2 的 15 个预置比例）
export const RATIOS = [
    { id: 'square', i18n: 'online.square', label: '1:1 方图', w: 12, h: 12 },
    { id: 'portrait', i18n: 'online.portrait', label: '2:3 竖图', w: 9, h: 13 },
    { id: 'landscape', i18n: 'online.landscape', label: '3:2 横图', w: 13, h: 9 },
    { id: 'portrait43', label: '3:4 竖图', w: 10, h: 13 },
    { id: 'landscape43', label: '4:3 横图', w: 13, h: 10 },
    { id: 'story', i18n: 'online.story', label: '9:16 竖屏', w: 8, h: 14 },
    { id: 'wide', i18n: 'online.wide', label: '16:9 宽屏', w: 14, h: 8 },
    { id: 'ultrawide', label: '21:9 超宽', w: 14, h: 6 },
    { id: 'ultratall', label: '9:21 超高', w: 6, h: 14 },
    { id: 'landscape21', label: '2:1 长横', w: 14, h: 7 },
    { id: 'portrait12', label: '1:2 长竖', w: 7, h: 14 },
    { id: 'landscape54', label: '5:4 横图', w: 12, h: 10 },
    { id: 'portrait45', label: '4:5 竖图', w: 10, h: 12 },
    { id: 'landscape31', label: '3:1 长横', w: 12, h: 4 },
    { id: 'portrait13', label: '1:3 长竖', w: 4, h: 12 },
];
// Gemini 官方 14 比例里不在上面 15 键表内的 4 个（1:4/1:8/4:1/8:1，官方表见
// /tmp/novai-official-docs/text/gemini_image_generation.txt:4642-4738）。只被 Gemini 系预设引用，
// supportedRatios 按预设过滤，所以不会污染其它模型的比例下拉。
export const EXTRA_RATIOS = [
    { id: 'portrait14', label: '1:4 长竖', w: 4, h: 14 },
    { id: 'portrait18', label: '1:8 长竖', w: 3, h: 16 },
    { id: 'landscape41', label: '4:1 长横', w: 14, h: 4 },
    { id: 'landscape81', label: '8:1 长横', w: 16, h: 3 },
];
// 档位按官方补全：Gemini 3.1 Flash Image 的 512px(0.5K)、火山 Seedream 5.0 pro/flash 的 1.5K、
// 5.0 lite 的 3K（text/gemini_image_generation.txt:1517-1520,4632+；text/volcengine_ark_image_api.txt:138-470）。
export const RES_LONG_SIDE = { '0.5k': 768, '1k': 1536, '1.5k': 1920, '2k': 2048, '3k': 3072, '4k': 3840 };
export const RES_LEVELS = ['0.5k', '1k', '1.5k', '2k', '3k', '4k'];
const RES_PIXEL_LIMIT_FALLBACK = { '0.5k': 262144, '1k': 1572864, '1.5k': 3145728, '2k': 4194304, '3k': 9437184, '4k': 8294400 };

export function parseSizeValue(value) {
    const match = String(value || '').trim().match(/^(\d+)\s*[xX*]\s*(\d+)$/);
    return match ? { width: match[1], height: match[2] } : null;
}

// 真实模型名 → 预设 key。模型 ID 既有 "nano-banana-pro" 这种点号命名，也有 Lovart 的
// "generate_image_nano_banana_pro" / "generate_image_seedream_v5_pro" 下划线命名；
// 顺序敏感：pro/lite 必须排在通用 key 之前，否则会被子串匹配吞掉。
const MODEL_PRESET_ALIASES = [
    ['nano_banana_2_lite', 'nano-banana-2'],
    ['nano-banana-2-lite', 'nano-banana-2'],
    ['nano_banana_pro', 'nano-banana-pro'],
    ['nano-banana-pro', 'nano-banana-pro'],
    ['gemini-3-pro-image', 'nano-banana-pro'],
    ['nano_banana_2', 'nano-banana-2'],
    ['nano-banana-2', 'nano-banana-2'],
    ['gemini-3.1-flash-image', 'nano-banana-2'],
    ['nano_banana', 'nano-banana'],
    ['nano-banana', 'nano-banana'],
    ['gemini-2.5-flash-image', 'nano-banana'],
    ['seedream_v5_pro', 'seedream-5.0-pro'],
    ['seedream-5.0-pro', 'seedream-5.0-pro'],
    ['seedream-5-0-pro', 'seedream-5.0-pro'],
    ['seedream_v5_lite', 'seedream-5.0-lite'],
    ['seedream-5.0-lite', 'seedream-5.0-lite'],
    ['seedream-5-0-lite', 'seedream-5.0-lite'],
    ['seedream_v5_flash', 'seedream-5.0'],
    ['seedream-5.0-flash', 'seedream-5.0'],
    ['seedream-5-0-flash', 'seedream-5.0'],
    ['seedream_v5', 'seedream-5.0'],
    ['seedream-5.0', 'seedream-5.0'],
    ['seedream-5-0', 'seedream-5.0'],
    ['seedream_5', 'seedream-5.0'],
    ['seedream-5', 'seedream-5.0'],
    ['seedream_v4_5', 'seedream-4.5'],
    ['seedream-4.5', 'seedream-4.5'],
    ['seedream-4-5', 'seedream-4.5'],
    ['seedream_v4', 'seedream-4.0'],
    ['seedream-4.0', 'seedream-4.0'],
    ['seedream-4-0', 'seedream-4.0'],
    ['seedream_4', 'seedream-4.0'],
    ['seedream-4', 'seedream-4.0'],
    ['seedream_v3', 'seedream-3.0'],
    ['seedream-3.0', 'seedream-3.0'],
    ['seedream-3', 'seedream-3.0'],
];

export function getSizeOptionsForModel(model) {
    const m = String(model || '').toLowerCase();
    for (const [needle, key] of MODEL_PRESET_ALIASES) {
        if (m.includes(needle) && MODEL_SIZE_PRESETS[key]) return MODEL_SIZE_PRESETS[key];
    }
    for (const [key, sizes] of Object.entries(MODEL_SIZE_PRESETS)) {
        if (m.includes(key)) return sizes;
    }
    return SIZE_OPTIONS;
}

// enum 模型：可用尺寸只认策略枚举（按方向归组 + tiers 档位，取比例最接近的；该方向该档位没有就不列）
export function enumSizeOptions(model) {
    const options = NovaSizePolicy.enumOptions(model);
    if (!options) return null;
    const tiers = NovaSizePolicy.policy(model).tiers || [];
    const pool = [];
    options.forEach(value => {
        const pair = parseSizeValue(value);
        if (!pair) return;
        const width = Number(pair.width), height = Number(pair.height);
        for (let i = 0; i < tiers.length; i++) {
            if (width * height <= Number(tiers[i].maxPixels)) {
                pool.push({ value, ratio: width / height, tier: String(tiers[i].id || '').toLowerCase(), orientation: width === height ? 'square' : (width > height ? 'landscape' : 'portrait') });
                return;
            }
        }
    });
    const result = {};
    Object.keys(SIZE_OPTIONS).forEach(key => {
        const nominal = parseSizeValue(SIZE_OPTIONS[key][0][0]);
        if (!nominal) return;
        const width = Number(nominal.width), height = Number(nominal.height);
        const ratio = width / height;
        const group = pool.filter(item => item.orientation === (width === height ? 'square' : (width > height ? 'landscape' : 'portrait')));
        if (!group.length) return;
        const sizes = [];
        tiers.forEach(tier => {
            const id = String(tier.id || '').toLowerCase();
            const candidates = group.filter(item => item.tier === id);
            if (!candidates.length) return;
            let best = candidates[0];
            candidates.forEach(item => { if (Math.abs(Math.log(item.ratio / ratio)) < Math.abs(Math.log(best.ratio / ratio))) best = item; });
            sizes.push([best.value, id]);
        });
        if (sizes.length) result[key] = sizes;
    });
    return result;
}

// 供应商级覆盖：把 /api/ai/size-policy 下发的 ratios / resolutions 合并到静态预设之上。
// 未声明 = 原样返回同一对象（默认行为与既有对象身份断言逐字节一致）。
function applyPolicyFilter(preset, model) {
    if (!preset) return preset;
    const ratioRestrict = typeof NovaSizePolicy.hasRatioOverride === 'function' && NovaSizePolicy.hasRatioOverride(model);
    const levelRestrict = typeof NovaSizePolicy.hasLevelOverride === 'function' && NovaSizePolicy.hasLevelOverride(model);
    if (!ratioRestrict && !levelRestrict) return preset;
    const out = {};
    Object.keys(preset).forEach(key => {
        if (ratioRestrict && !NovaSizePolicy.ratioAllowed(model, key)) return;
        const cells = (preset[key] || []).filter(item => !levelRestrict || NovaSizePolicy.levelAllowed(model, item[1]));
        if (cells.length) out[key] = cells;
    });
    return Object.keys(out).length ? out : preset;
}

// enum 模型用推导表（可能为空表），只有非 enum 模型才回落到写死的 presets
export function currentSizeOptions(model) { return applyPolicyFilter(enumSizeOptions(model) || getSizeOptionsForModel(model), model); }

export function resPixelLimitFor(model) {
    const limits = {};
    const tiers = NovaSizePolicy.policy(model).tiers;
    if (Array.isArray(tiers)) tiers.forEach(tier => {
        const id = String((tier && tier.id) || '').trim().toLowerCase();
        const maxPixels = Number(tier && tier.maxPixels);
        if (id && maxPixels > 0) limits[id] = maxPixels;
    });
    Object.keys(RES_PIXEL_LIMIT_FALLBACK).forEach(level => { if (!limits[level]) limits[level] = RES_PIXEL_LIMIT_FALLBACK[level]; });
    return limits;
}

// 落点：不高于请求档位的最高可用档位；没有更低档才往上取
export function nearestUsableLevel(levels, want) {
    const selectable = levels.filter(level => RES_LEVELS.indexOf(level) >= 0);
    if (!selectable.length) return '';
    const index = RES_LEVELS.indexOf(want);
    const below = selectable.filter(level => RES_LEVELS.indexOf(level) <= index).sort((a, b) => RES_LEVELS.indexOf(b) - RES_LEVELS.indexOf(a));
    if (below.length) return below[0];
    return selectable.sort((a, b) => RES_LEVELS.indexOf(a) - RES_LEVELS.indexOf(b))[0];
}

function modelLevelsOf(opts) {
    const set = new Set();
    Object.keys(opts).forEach(key => (opts[key] || []).forEach(([, level]) => set.add(level)));
    return set;
}

// 当前比例下可用的档位。自定义比例按模型拥有的档位算（旧版这里取 opts['custom'] 恒为空，档位全被置灰）
export function usableLevels(opts, ratio) {
    if (ratio === 'custom') {
        const all = Array.from(modelLevelsOf(opts)).filter(l => RES_LEVELS.includes(l));
        return all.length ? all : RES_LEVELS.slice();
    }
    return (opts[ratio] || []).map(([, level]) => level);
}

// 对应旧 updateSizeUI 的状态修正部分：比例不受支持时回落；档位失效时落到最近档并返回提示文案
export function normalizeSize(st) {
    const opts = currentSizeOptions(st.model);
    const keepRatio = st.ratio === 'custom' || (st.ratio === '' && st.resolution === 'custom');
    if (!keepRatio && !opts[st.ratio]) st.ratio = Object.keys(opts)[0] || 'square';
    const usable = usableLevels(opts, st.ratio);
    if (usable.length && RES_LEVELS.indexOf(st.resolution) >= 0 && usable.indexOf(st.resolution) < 0) {
        const target = nearestUsableLevel(usable, st.resolution);
        if (target) {
            const text = '该比例没有 ' + st.resolution.toUpperCase() + ' 尺寸，已切换到 ' + target.toUpperCase();
            st.resolution = target;
            return text;
        }
    }
    return '';
}

// 档位下拉：该 (比例, 档位) 没有合法尺寸就置灰并写明原因
export function resolutionOptions(model, ratio) {
    const opts = currentSizeOptions(model);
    const usable = usableLevels(opts, ratio);
    const levels = modelLevelsOf(opts);
    // 该模型完全没有的档位（如 gpt-image-2 的 0.5K/1.5K/3K）直接隐藏；模型有、该比例没有的置灰
    return RES_LEVELS.filter(level => levels.has(level)).map(level => {
        const enabled = usable.indexOf(level) >= 0;
        return { value: level, label: level.toUpperCase() + (enabled ? '' : '（该比例无此档位）'), disabled: !enabled };
    });
}

export function supportedRatios(model) { const opts = currentSizeOptions(model); return [...RATIOS, ...EXTRA_RATIOS].filter(r => !!opts[r.id]); }

function constrainSize(size, model) { return size ? NovaSizePolicy.constrain(size, model) : size; }

// 对应旧 currentSize()：返回 'WxH'，空串表示当前「比例 + 档位」在该模型下没有可用尺寸
export function computeSize(st) {
    if (st.resolution === 'custom') {
        const w = Number(st.customWidth), h = Number(st.customHeight);
        return constrainSize(w > 0 && h > 0 ? `${Math.round(w)}x${Math.round(h)}` : '', st.model);
    }
    const opts = currentSizeOptions(st.model);
    const options = opts[st.ratio] || [];
    if (st.ratio === 'custom') {
        const rw = Number(st.customRatioWidth), rh = Number(st.customRatioHeight);
        const parsed = rw > 0 && rh > 0 ? rw / rh : null;
        const longSide = RES_LONG_SIDE[st.resolution] || 1024;
        if (parsed) {
            const pixelLimit = resPixelLimitFor(st.model)[st.resolution] || (longSide * longSide);
            const rawWidth = parsed >= 1 ? longSide : Math.min(longSide * parsed, Math.sqrt(pixelLimit * parsed));
            const rawHeight = parsed >= 1 ? Math.min(longSide / parsed, Math.sqrt(pixelLimit / parsed)) : longSide;
            const width = Math.floor(rawWidth / 16) * 16;
            const height = Math.floor(rawHeight / 16) * 16;
            return constrainSize(`${Math.max(64, width)}x${Math.max(64, height)}`, st.model);
        }
    }
    const match = options.find(([, label]) => label === st.resolution);
    return match ? constrainSize(match[0], st.model) : '';
}

// 「复用」时把历史尺寸映射回比例 + 档位；查不到就返回自定义尺寸
export function matchSize(model, size) {
    const opts = currentSizeOptions(model);
    const ratio = Object.keys(opts).find(key => opts[key].some(([value]) => value === size)) || 'square';
    const res = opts[ratio] && (opts[ratio].find(([value]) => value === size) || [])[1];
    if (res) return { ratio, resolution: res };
    const parsed = parseSizeValue(size);
    return { resolution: 'custom', ratio: '', customWidth: parsed ? parsed.width : '', customHeight: parsed ? parsed.height : '' };
}
