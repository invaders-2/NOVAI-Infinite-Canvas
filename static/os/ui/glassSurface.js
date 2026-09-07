// ============================================================================
// NOVAI OS · Glass Surface Primitive (glassSurface.js)
// 生成 6 层 DOM 玻璃材质：bg / refraction / highlight / border / shadow / content
// 材质等级：ultraThin | thin | regular | thick
//
// 依赖：os-tokens.css + os-glass.css（由宿主页面引入）
// 字体：默认走 --font-system（D4=B）；本模块不引用 --font-display
// ============================================================================

const LAYERS = ["bg", "refraction", "highlight", "border", "shadow"];

/**
 * 创建一个玻璃容器节点。
 * @param {Object} options
 * @param {('ultraThin'|'thin'|'regular'|'thick')} [options.tier='regular'] 材质等级
 * @param {string} [options.variant=''] 附加变体类（button/input/panel/menu/...）
 * @param {string} [options.className=''] 额外 class
 * @param {Node|string|null} [options.content=null] 内容节点或 HTML 字符串
 * @param {boolean} [options.inactive=false] 非激活态（降 blur，R10）
 * @returns {HTMLElement} 根 glass 节点，附 .setContent(node) 方法
 */
export function createGlassSurface(options = {}) {
  const {
    tier = "regular",
    variant = "",
    className = "",
    content = null,
    inactive = false,
  } = options;

  const root = document.createElement("div");
  root.className = `os-glass os-glass--${tier}`;
  if (variant) root.classList.add(`os-glass--${variant}`);
  if (className) root.classList.add(className);
  if (inactive) root.classList.add("os-glass--inactive");

  for (const name of LAYERS) {
    const layer = document.createElement("div");
    layer.className = `os-glass__${name}`;
    root.appendChild(layer);
  }

  const contentEl = document.createElement("div");
  contentEl.className = "os-glass__content";
  if (content !== null) {
    if (typeof content === "string") contentEl.innerHTML = content;
    else if (content instanceof Node) contentEl.appendChild(content);
  }
  root.appendChild(contentEl);

  /** 替换内容区 */
  root.setContent = (node) => {
    contentEl.innerHTML = "";
    if (node instanceof Node) contentEl.appendChild(node);
    else if (typeof node === "string") contentEl.innerHTML = node;
    return root;
  };

  /** 设置材质等级 */
  root.setTier = (next) => {
    root.classList.remove(
      "os-glass--ultraThin",
      "os-glass--thin",
      "os-glass--regular",
      "os-glass--thick"
    );
    root.classList.add(`os-glass--${next}`);
    return root;
  };

  return root;
}

export default createGlassSurface;
