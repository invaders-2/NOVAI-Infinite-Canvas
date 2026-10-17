// 能力覆盖（provider.size_overrides）在设置页用到的选项与规整。
// 比例 / 档位词表直接取在线生图页的同一份官方集合（15 + 4 个官方比例、6 个档位），
// 不在设置页再抄一份；写盘用官方比例标签（SIZE_OVERRIDES.md 同时接受标签与画布内部 key）。
import { RATIOS, EXTRA_RATIOS, RES_LEVELS } from '../../../../pages/online/onlineSizes.js';

// RATIOS 的 label 形如 "16:9 宽屏"：空格前就是官方比例标签，后面是给人看的说明
export const SIZE_RATIOS = [...RATIOS, ...EXTRA_RATIOS].map(option => ({
    key: option.id,
    label: String(option.label || '').split(/\s+/)[0] || option.id,
}));
export const SIZE_LEVELS = RES_LEVELS.slice();

function listOf(value) { return Array.isArray(value) ? value.slice() : []; }

// 命中判定：官方标签和画布内部 key 都算（手写的 JSON 两种都可能出现）
export function matchesRatio(value, option) {
    const text = String(value == null ? '' : value).trim();
    return text === option.label || text === option.key;
}

export function matchesLevel(value, level) {
    return String(value == null ? '' : value).trim().toLowerCase() === level;
}

// 统一成官方标签（内部 key 会被换掉）+ 官方顺序；认不出的手写值原样留在末尾，不静默丢
export function orderRatios(values) {
    const list = listOf(values);
    const used = [];
    const out = [];
    SIZE_RATIOS.forEach(option => {
        const hits = list.filter(value => matchesRatio(value, option));
        if (!hits.length) return;
        used.push(...hits);
        out.push(option.label);
    });
    list.forEach(value => { if (used.indexOf(value) < 0) out.push(value); });
    return out;
}

export function orderLevels(values) {
    const list = listOf(values);
    const used = [];
    const out = [];
    SIZE_LEVELS.forEach(level => {
        const hits = list.filter(value => matchesLevel(value, level));
        if (!hits.length) return;
        used.push(...hits);
        out.push(level);
    });
    list.forEach(value => { if (used.indexOf(value) < 0) out.push(value); });
    return out;
}

export function toggleRatio(values, option) {
    const list = listOf(values);
    if (list.some(value => matchesRatio(value, option))) return orderRatios(list.filter(value => !matchesRatio(value, option)));
    return orderRatios(list.concat(option.label));
}

export function toggleLevel(values, level) {
    const list = listOf(values);
    if (list.some(value => matchesLevel(value, level))) return orderLevels(list.filter(value => !matchesLevel(value, level)));
    return orderLevels(list.concat(level));
}

export function extraRatios(values) {
    const list = listOf(values);
    return list.filter(value => !SIZE_RATIOS.some(option => matchesRatio(value, option)));
}

export function extraLevels(values) {
    const list = listOf(values);
    return list.filter(value => !SIZE_LEVELS.some(level => matchesLevel(value, level)));
}

function uniqueNames(value) {
    const out = [];
    listOf(value).forEach(item => {
        const name = String(item == null ? '' : item).trim();
        if (name && out.indexOf(name) < 0) out.push(name);
    });
    return out;
}

function overridesOf(provider) {
    const raw = provider && provider.size_overrides;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

// 模型下拉只列生图模型：后端 size_policy_table 只展开 image_models，视频模型的覆盖不会生效。
// 已存在但不在生图列表的覆盖（含老配置里的视频模型）作为 orphans 原样显示，可删、不丢数据。
export function modelChoices(provider) {
    const image = uniqueNames(provider && provider.image_models);
    const orphans = Object.keys(overridesOf(provider)).filter(model => model && image.indexOf(model) < 0);
    return { image, orphans };
}

// 「添加模型」只挑第一个还没覆盖的生图模型；没有生图模型时不给添加（不引导新建不生效的视频覆盖）
export function nextOverrideModel(provider) {
    const used = Object.keys(overridesOf(provider));
    const image = uniqueNames(provider && provider.image_models);
    return image.filter(model => used.indexOf(model) < 0)[0] || '';
}

// 数字输入：只留数字、去前导 0；空 / 0 = 不限制（返回 0，调用方删字段）
export function parseLimit(raw) {
    const digits = String(raw == null ? '' : raw).replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
    if (!digits) return 0;
    const number = Number(digits);
    return Number.isFinite(number) ? number : 0;
}
