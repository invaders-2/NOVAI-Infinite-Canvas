// 设置页「能力覆盖」用的官方尺寸词表（原在线生图页的尺寸词表；
// 在线生图页 2026-11 已下线，只把设置页需要的最小常量搬到公共目录）。
// 比例 key 与官方 APIMart gpt-image-2 的预置比例一一对应。
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
// Gemini 官方 14 比例里不在上面 15 键表内的 4 个（1:4/1:8/4:1/8:1）；只给 Gemini 系模型用。
export const EXTRA_RATIOS = [
    { id: 'portrait14', label: '1:4 长竖', w: 4, h: 14 },
    { id: 'portrait18', label: '1:8 长竖', w: 3, h: 16 },
    { id: 'landscape41', label: '4:1 长横', w: 14, h: 4 },
    { id: 'landscape81', label: '8:1 长横', w: 16, h: 3 },
];
// 档位按官方补全：Gemini 3.1 Flash Image 的 512px(0.5K)、火山 Seedream 5.0 pro/flash 的 1.5K、
// 5.0 lite 的 3K。
export const RES_LEVELS = ['0.5k', '1k', '1.5k', '2k', '3k', '4k'];
