// ============================================================================
// NOVAI OS · Icon System (osIcon.js)
// ⛔ FROZEN — Design System / Material Baseline v1.0（2026-09-08, 1d9c0fa）
//    本文件是 NOVAI OS 唯一的 Icon 真实来源。完整基线见
//    docs/NOVAI_OS_DESIGN_BASELINE.md
//    · 需要新图标 → 追加进 PATHS，禁止引入第二套图标库
//    · 禁止实心 / 粗黑 / Emoji / 卡通 / 彩色系统图标 / 跨库混搭
//    · 后续 Phase 一律通过 createIcon() 消费，不得自建图标体系
//
// 统一线性图标：Linear / Outline / Stroke 风格
//   - 不使用实心图标 / 粗黑图标 / 卡通图标 / 彩色系统图标
//   - 不混搭不同图标库
//   - Thin / Clean / Rounded / Minimal / System-level
//
// Stroke 规范（尺寸 → stroke-width；32px 以上不超过 1.8）：
//   16px → 1.4 | 18px → 1.5 | 20px → 1.6 | 24px → 1.7 | 32px+ → 1.8
//   统一：stroke-linecap: round; stroke-linejoin: round
// 尺寸体系：12 / 14 / 16 / 18 / 20 / 24 / 32 / 48 / 64
//   建议：Small control 14–16 / Button icon 16–18 / Toolbar 18–20 /
//         Menu 16–18 / Dock 24–32 / Desktop App Icon 48–64
// 颜色 Token：--icon-primary / --icon-secondary / --icon-tertiary / --icon-disabled
//             青柠底（Send Button）用 --icon-on-brand
// 无边框原则：0 border / 0 hairline / 0 focus outline / 0 container ring
// ============================================================================

const STROKE_WIDTH = {
  12: 1.2, 14: 1.3, 16: 1.4, 18: 1.5,
  20: 1.6, 24: 1.7, 32: 1.8, 48: 1.8, 64: 1.8,
};

const ICON_SIZES = [12, 14, 16, 18, 20, 24, 32, 48, 64];

// 24×24 viewBox 线性路径（stroke 风格，fill=none）
const PATHS = {
  // Send：线性上箭头（细线 + round cap/join，视觉居中）—— 替代原字体字符 ↑
  send: '<path d="M12 19.5V5"/><path d="M5.5 11.5 12 5l6.5 6.5"/>',
  // Close：细线 X
  close: '<path d="M6.5 6.5l11 11"/><path d="M17.5 6.5l-11 11"/>',
  // Search：线性放大镜
  search: '<circle cx="11" cy="11" r="6.2"/><path d="M20 20l-4.6-4.6"/>',
  // Add：轻量 +
  add: '<path d="M12 5.5v13"/><path d="M5.5 12h13"/>',
  // Delete：线性垃圾桶
  delete:
    '<path d="M4.5 7h15"/>' +
    '<path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/>' +
    '<path d="M6.5 7l.8 12.1a1.2 1.2 0 0 0 1.2 1.1h7a1.2 1.2 0 0 0 1.2-1.1L17.5 7"/>' +
    '<path d="M10.5 10.5v6"/><path d="M13.5 10.5v6"/>',
  // Back / Forward：Chevron 风格（不用粗箭头）
  chevronLeft: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  chevronRight: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
  // AI Assistant：极简几何线性 symbol（菱形轮廓 + 内核）
  //   不用机器人头像 / 魔法棒 / 星星堆叠 / 放射光芒；
  //   Idle 为中性黑白灰（--icon-*），只有"工作时"外围才出现青柠 glow / beam / flow。
  ai:
    '<path d="M12 2.8 21.2 12 12 21.2 2.8 12 12 2.8z"/>' +
    '<circle cx="12" cy="12" r="3.4"/>',
  // Settings
  settings:
    '<circle cx="12" cy="12" r="3.1"/>' +
    '<path d="M19.1 14.6a1.5 1.5 0 0 0 .3 1.7l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.5 1.5 0 0 0-1.7-.3 1.5 1.5 0 0 0-.9 1.4v.2a1.9 1.9 0 1 1-3.8 0v-.1a1.5 1.5 0 0 0-1-1.4 1.5 1.5 0 0 0-1.7.3l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.5 1.5 0 0 0 .3-1.7 1.5 1.5 0 0 0-1.4-.9h-.2a1.9 1.9 0 1 1 0-3.8h.1a1.5 1.5 0 0 0 1.4-1 1.5 1.5 0 0 0-.3-1.7l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.5 1.5 0 0 0 1.7.3h.1a1.5 1.5 0 0 0 .9-1.4v-.2a1.9 1.9 0 1 1 3.8 0v.1a1.5 1.5 0 0 0 .9 1.4 1.5 1.5 0 0 0 1.7-.3l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.5 1.5 0 0 0-.3 1.7v.1a1.5 1.5 0 0 0 1.4.9h.2a1.9 1.9 0 1 1 0 3.8h-.1a1.5 1.5 0 0 0-1.4.9z"/>',
  // Check
  check: '<path d="M4.5 12.5l5 5 10-10.5"/>',
  // Minus
  minus: '<path d="M5.5 12h13"/>',
  // ---------- Phase 3 · Window Controls（中性线性，禁止红黄绿圆点） ----------
  // Minimize：靠下的一条横线（读作"收下去"，与居中的 minus 语义区分）
  minimize: '<path d="M5.5 17.5h13"/>',
  // Maximize：单个圆角方框（空框，未最大化）
  maximize: '<rect x="4.6" y="4.6" width="14.8" height="14.8" rx="2.4"/>',
  // Restore：前窗 + 后窗上沿（经典"向下还原"，双窗错位）
  restore:
    '<rect x="4.6" y="8.6" width="10.8" height="10.8" rx="2"/>' +
    '<path d="M8.6 8.6V6.4a1.8 1.8 0 0 1 1.8-1.8h7.2a1.8 1.8 0 0 1 1.8 1.8v7.2a1.8 1.8 0 0 1-1.8 1.8h-2.2"/>',
  // ---------- Phase 2 · 第一方 App 图标（同为线性 stroke 语言，视觉重量一致） ----------
  // Image Generation：相框 + 取景点 + 地平线
  image:
    '<rect x="3.2" y="4.8" width="17.6" height="14.4" rx="2.6"/>' +
    '<circle cx="8.4" cy="9.6" r="1.5"/>' +
    '<path d="M4.4 18.2l4.6-4.8 3.2 3.4 2.8-3 4.6 4.4"/>',
  // Infinite Canvas：视口四角 + 中心节点
  canvas:
    '<path d="M4 9.2V6.6A2.6 2.6 0 0 1 6.6 4h2.6"/>' +
    '<path d="M14.8 4h2.6A2.6 2.6 0 0 1 20 6.6v2.6"/>' +
    '<path d="M20 14.8v2.6a2.6 2.6 0 0 1-2.6 2.6h-2.6"/>' +
    '<path d="M9.2 20H6.6A2.6 2.6 0 0 1 4 17.4v-2.6"/>' +
    '<circle cx="12" cy="12" r="2.2"/>',
  // Assets / Launcher：四宫格
  grid:
    '<rect x="4" y="4" width="7" height="7" rx="1.6"/>' +
    '<rect x="13" y="4" width="7" height="7" rx="1.6"/>' +
    '<rect x="4" y="13" width="7" height="7" rx="1.6"/>' +
    '<rect x="13" y="13" width="7" height="7" rx="1.6"/>',
  // Chat：对话气泡
  chat:
    '<path d="M20 12.6c0 3.6-3.6 6.5-8 6.5a9.6 9.6 0 0 1-2.4-.3L5.6 20.8l1.3-3.4A6.9 6.9 0 0 1 4 12.6c0-3.6 3.6-6.5 8-6.5s8 2.9 8 6.5z"/>',
  // Workflow：两节点 + 连线
  workflow:
    '<rect x="3.6" y="4.2" width="6.8" height="5.2" rx="1.6"/>' +
    '<rect x="13.6" y="14.6" width="6.8" height="5.2" rx="1.6"/>' +
    '<path d="M7 9.4v4a1.8 1.8 0 0 0 1.8 1.8h4.8"/>',
};

const SVG_NS = "http://www.w3.org/2000/svg";

function normalizeSize(size) {
  return ICON_SIZES.indexOf(size) >= 0 ? size : 20;
}

function appendPaths(svg, markup) {
  // 用 DOMParser 保证在 SVG 命名空间下创建元素（跨浏览器可靠）
  const doc = new DOMParser().parseFromString(
    '<svg xmlns="' + SVG_NS + '">' + markup + "</svg>",
    "image/svg+xml"
  );
  const nodes = Array.prototype.slice.call(doc.documentElement.childNodes);
  nodes.forEach(function (n) {
    svg.appendChild(document.importNode(n, true));
  });
}

/**
 * 创建统一线性图标（SVG 元素）。
 * @param {Object} options
 * @param {string} [options.name='send'] 图标名（见 ICON_NAMES）
 * @param {number} [options.size=20] 尺寸，仅允许 12/14/16/18/20/24/32/48/64
 * @param {string} [options.color='var(--icon-primary)'] 颜色 Token
 * @param {number|null} [options.strokeWidth=null] 覆盖默认 stroke；null = 按尺寸规范
 * @param {string} [options.className=''] 额外 class
 * @returns {SVGElement}
 */
export function createIcon(options) {
  const opts = options || {};
  const name = opts.name || "send";
  const size = normalizeSize(opts.size);
  const color = opts.color || "var(--icon-primary)";
  const strokeOverride = opts.strokeWidth;
  const className = opts.className || "";
  const sw = strokeOverride != null ? strokeOverride : STROKE_WIDTH[size];
  const markup = PATHS[name] || PATHS.send;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", color);
  svg.setAttribute("stroke-width", String(sw));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (className) svg.setAttribute("class", className);
  appendPaths(svg, markup);
  return svg;
}

/** 可用图标名 */
export const ICON_NAMES = Object.keys(PATHS);

/** 尺寸 → stroke-width 规范表 */
export const STROKE_SPEC = STROKE_WIDTH;

/** 允许的尺寸体系 */
export const ALLOWED_ICON_SIZES = ICON_SIZES;

export default createIcon;
