// ============================================================================
// NOVAI OS · App Launcher (osLauncher.js)
// App 启动面板：thick 玻璃 + 搜索框（glassInput）+ App 网格。
// 只消费 Phase 1 冻结资产：glassSurface / glassInput / createIcon。
// 不定义任何颜色、材质、blur、阴影。
// ============================================================================
import { createGlassSurface } from "../ui/glassSurface.js";
import { createGlassInput } from "../ui/glassInput.js";
import { createIcon } from "../icons/osIcon.js";

/**
 * @param {Object} options
 * @param {Array} options.apps
 * @param {(app: Object) => void} options.onLaunch
 * @param {() => void} [options.onClose]
 * @returns {{ node: HTMLElement, open: Function, close: Function, setApps: Function }}
 */
export function createLauncher({ apps = [], onLaunch = null, onClose = null } = {}) {
  const surface = createGlassSurface({ tier: "thick", variant: "launcher", className: "os-launcher" });

  const head = document.createElement("div");
  head.className = "os-launcher__head";

  const search = createGlassInput({ placeholder: "Search apps…", tier: "ultraThin" });
  search.classList.add("os-launcher__search");
  head.appendChild(search);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "os-launcher__close";
  closeBtn.setAttribute("aria-label", "Close launcher");
  closeBtn.appendChild(createIcon({ name: "close", size: 18, color: "var(--icon-secondary)" }));
  closeBtn.addEventListener("click", () => close());
  head.appendChild(closeBtn);

  const grid = document.createElement("div");
  grid.className = "os-launcher__grid";

  const empty = document.createElement("p");
  empty.className = "os-launcher__empty";
  empty.textContent = "No apps match.";

  let all = apps;

  function render(keyword = "") {
    const kw = keyword.trim().toLowerCase();
    const list = kw
      ? all.filter(
          (a) =>
            a.name.toLowerCase().includes(kw) ||
            a.id.toLowerCase().includes(kw) ||
            (a.desc || "").toLowerCase().includes(kw)
        )
      : all;

    grid.innerHTML = "";
    if (list.length === 0) {
      grid.appendChild(empty);
      return;
    }
    for (const app of list) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "os-launcher__cell";
      cell.dataset.appId = app.id;
      cell.setAttribute("aria-label", app.name);

      const glyph = document.createElement("span");
      glyph.className = "os-launcher__glyph";
      glyph.appendChild(createIcon({ name: app.icon, size: 32, color: "var(--icon-secondary)" }));
      cell.appendChild(glyph);

      const name = document.createElement("span");
      name.className = "os-launcher__name";
      name.textContent = app.name;
      cell.appendChild(name);

      const meta = document.createElement("span");
      meta.className = "os-launcher__meta";
      meta.textContent = app.source === "registry" ? `registry · v${app.version}` : "built-in";
      cell.appendChild(meta);

      cell.addEventListener("click", () => {
        close();
        if (onLaunch) onLaunch(app);
      });

      grid.appendChild(cell);
    }
  }

  function open() {
    surface.classList.add("is-open");
    render("");
    const native = search.querySelector(".os-input__native");
    if (native) native.focus();
  }

  function close() {
    surface.classList.remove("is-open");
    if (onClose) onClose();
  }

  // 搜索输入：只按关键字过滤，不引入新视觉
  const nativeInput = search.querySelector(".os-input__native");
  if (nativeInput) {
    nativeInput.addEventListener("input", (e) => render(e.target.value));
    nativeInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
      if (e.key === "Enter") {
        const first = grid.querySelector(".os-launcher__cell");
        if (first) first.click();
      }
    });
  }

  render("");

  // 把 head + grid 挂进 glass surface（此前遗漏，导致 Launcher 是空壳）
  const inner = document.createElement("div");
  inner.className = "os-launcher__inner";
  inner.appendChild(head);
  inner.appendChild(grid);
  surface.setContent(inner);

  surface.setAttribute("role", "dialog");
  surface.setAttribute("aria-label", "App Launcher");

  return {
    node: surface,
    open,
    close,
    setApps: (next) => {
      all = next;
      render(nativeInput ? nativeInput.value : "");
    },
  };
}

export default createLauncher;
