// ============================================================================
// NOVAI OS · Icon System (osIcon.js)
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
  // AI Assistant：极简几何线性 symbol（默认黑白灰；AI 工作时才加青柠光效）
  ai:
    '<circle cx="12" cy="12" r="3.2"/>' +
    '<path d="M12 3.6v2.1"/><path d="M12 18.3v2.1"/>' +
    '<path d="M3.6 12h2.1"/><path d="M18.3 12h2.1"/>' +
    '<path d="M6.3 6.3l1.5 1.5"/><path d="M16.2 16.2l1.5 1.5"/>' +
    '<path d="M17.7 6.3l-1.5 1.5"/><path d="M7.8 16.2l-1.5 1.5"/>',
  // Settings
  settings:
    '<circle cx="12" cy="12" r="3.1"/>' +
    '<path d="M19.1 14.6a1.5 1.5 0 0 0 .3 1.7l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.5 1.5 0 0 0-1.7-.3 1.5 1.5 0 0 0-.9 1.4v.2a1.9 1.9 0 1 1-3.8 0v-.1a1.5 1.5 0 0 0-1-1.4 1.5 1.5 0 0 0-1.7.3l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.5 1.5 0 0 0 .3-1.7 1.5 1.5 0 0 0-1.4-.9h-.2a1.9 1.9 0 1 1 0-3.8h.1a1.5 1.5 0 0 0 1.4-1 1.5 1.5 0 0 0-.3-1.7l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.5 1.5 0 0 0 1.7.3h.1a1.5 1.5 0 0 0 .9-1.4v-.2a1.9 1.9 0 1 1 3.8 0v.1a1.5 1.5 0 0 0 .9 1.4 1.5 1.5 0 0 0 1.7-.3l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.5 1.5 0 0 0-.3 1.7v.1a1.5 1.5 0 0 0 1.4.9h.2a1.9 1.9 0 1 1 0 3.8h-.1a1.5 1.5 0 0 0-1.4.9z"/>',
  // Check
  check: '<path d="M4.5 12.5l5 5 10-10.5"/>',
  // Minus
  minus: '<path d="M5.5 12h13"/>',
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
