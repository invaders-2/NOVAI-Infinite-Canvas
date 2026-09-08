// ============================================================================
// NOVAI OS · Iframe Focus Bridge (osIframeBridge.js)
// 解决 Phase 3 的关键风险：**点击 iframe 内部能不能把父窗口激活**。
//
// 方案 A（默认，已采用）：同源直连
//   已验证 builtinApps 的 6 个入口全是 /static/*.html —— 与父页同源。
//   因此 frame.contentDocument 可直接访问，在 iframe 的 document 上挂
//   **capture 阶段**的 pointerdown / focusin / keydown 监听即可。
//
//   为什么用 capture 而不是 bubble：
//     业务页面随时可能 stopPropagation，capture 阶段先于页面自身逻辑拿到事件，
//     保证"点任何地方都能激活窗口"。
//
//   为什么**不** preventDefault：
//     我们只要"顺便"通知窗口管理器，不干预业务页交互。
//     一 preventDefault 就会破坏画布拖拽、输入框聚焦等既有行为。
//
//   业务页面**零改动**。
//
// ⚠️ 关键陷阱（已踩过一次，别再踩）：
//   frame.src 赋值后**同步**读 contentDocument，拿到的是 about:blank 的
//   初始文档（非 null！）。真实页面导航时这个 document 会被**整体丢弃**，
//   挂在上面的监听随之蒸发 —— 表现为"点 iframe 完全没反应"。
//   → 因此：① 识别并跳过 about:blank / 仍在 loading 的文档；
//           ② 每次 load 都重新 wire（导航会换 document）。
//
// 方案 B（降级）：shield
//   当 contentDocument 取不到（跨域 / 沙箱）时，Frame 会改为在 iframe 上方盖
//   一层透明 shield（仅在该窗口未聚焦时显示），点击 shield → 聚焦 → 撤掉。
//   代价是每次切换焦点会吞掉一次点击，只在跨域时使用。
//
// 方案 C（已否决）：往业务页注入上报脚本 —— 要改 6+ 个 Legacy 页面，
//   属于 Phase 5 才该做的迁移污染。
// ============================================================================

const EVENTS = ["pointerdown", "focusin", "keydown"];

/**
 * 给 iframe 挂焦点桥。
 * @param {HTMLIFrameElement} frame
 * @param {() => void} onFocus 通知父窗口"我被点了"
 * @returns {{ mode: 'same-origin'|'shield'|'pending'|'none', detach: Function }}
 *   mode 供 Frame 判断是否需要启用 shield 降级。
 */
export function attachIframeFocus(frame, onFocus) {
  const handle = {
    mode: "none",
    detach() {},
  };

  if (!frame || typeof onFocus !== "function") return handle;

  let currentDoc = null;
  let currentWin = null;
  let currentHandler = null;

  function unwire() {
    if (currentDoc && currentHandler) {
      for (const type of EVENTS) {
        currentDoc.removeEventListener(type, currentHandler, true);
      }
    }
    if (currentWin && currentHandler) {
      currentWin.removeEventListener("focus", currentHandler, true);
    }
    currentDoc = null;
    currentWin = null;
    currentHandler = null;
  }

  function wire(doc, win) {
    if (currentDoc === doc) return; // 同一个 document 不重复挂
    unwire();
    currentDoc = doc;
    currentWin = win || null;
    currentHandler = () => onFocus();
    // capture 阶段：赶在业务页任何 stopPropagation 之前
    for (const type of EVENTS) {
      doc.addEventListener(type, currentHandler, true);
    }
    // 兜底：iframe 的 window 获得焦点（业务页内部 focus() 也会触发）
    if (currentWin) currentWin.addEventListener("focus", currentHandler, true);
    handle.mode = "same-origin";
  }

  /**
   * 读取"可用的"内容文档。
   * about:blank 初始文档 / 仍在 loading 的文档一律视为不可用 ——
   * 它们会在真实导航时被替换，挂监听等于白挂。
   */
  function readDoc() {
    let doc = null;
    let win = null;
    try {
      doc = frame.contentDocument;
      win = frame.contentWindow;
    } catch (err) {
      return null; // 跨域访问抛 SecurityError
    }
    if (!doc || !win) return null;
    let href = "";
    try {
      href = doc.location ? String(doc.location.href) : "";
    } catch (err) {
      href = "";
    }
    if (!href || href === "about:blank") return null;
    if (doc.readyState === "loading") return null;
    return { doc, win };
  }

  function tryWire() {
    const got = readDoc();
    if (!got) return false;
    wire(got.doc, got.win);
    return true;
  }

  function onLoad() {
    // 每一次 load 都重新 wire：导航会替换 document，旧监听会失效
    if (!tryWire()) handle.mode = "shield";
  }

  frame.addEventListener("load", onLoad);

  // 已经加载好了（缓存 / 复用）就直接挂；否则等 load
  if (!tryWire()) handle.mode = "pending";

  handle.detach = () => {
    frame.removeEventListener("load", onLoad);
    unwire();
    handle.mode = "none";
    handle.detach = () => {};
  };

  return handle;
}

export default attachIframeFocus;
