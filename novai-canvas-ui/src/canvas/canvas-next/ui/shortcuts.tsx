/**
 * 快捷键的唯一事实来源：画布的键盘派发（CanvasApp.dispatchShortcut）、帮助弹窗（showKeys）、
 * 菜单和工具提示里的键位文案（keyHint）全部读这张表，改键位只改这里，说明不会再和实际行为漂移。
 * 平台差异只体现在 mac / win 两组显示标签上：绑定本身两端都认（⇧⌘Z 和 Ctrl+Y 都能重做）。
 */
import { alignSelection, copySelection, deleteSelection, duplicate } from "../actions";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { outOf } from "../model";
import { hiddenIds, isStack, stackSelection } from "../stack";
import type { CanvasStore } from "../store";
import { openPointEdit } from "./editors/registry";
import { groupSelection, ungroup } from "./LegacyNodes";
import { closePop, ModalHead, modalOpen, openModal, popOpen } from "./overlay";
import { runNodes } from "./StackNode";
import { isTyping } from "./Viewport";
import { openSearch, toggleCmt } from "./Chrome";
import { applyTheme, followsShellTheme, requestShellTheme } from "./theme";
import type { Ctl } from "./ctx";

const GROUPS = [
  { id: "edit", label: "编辑与选择" },
  { id: "align", label: "多选对齐" },
  { id: "gen", label: "生成与助手" },
  { id: "view", label: "视图与画布" },
  { id: "pointer", label: "鼠标与触控" },
] as const;
type GroupId = (typeof GROUPS)[number]["id"];

export type Shortcut = {
  id: string;
  group: GroupId;
  /** 帮助里的一行说明；少数条目要看画布偏好（左键拖动空白是框选还是平移），允许传函数 */
  label: string | ((leftDrag: "select" | "pan") => string);
  /** 一个 token 一个 <kbd>：mac 用 ⌘⌥⇧⌫↵ 这样的符号，win / linux 用键名 */
  mac: string[];
  win: string[];
  /** canvas（默认）：输入框和弹窗里让位；noTyping：只让位输入框；always：哪里都生效 */
  gate?: "canvas" | "noTyping" | "always";
  /** 键盘绑定；鼠标 / 触控手势只有说明，不参与派发 */
  match?: (e: KeyboardEvent) => boolean;
  run?: (ctl: Ctl, e: KeyboardEvent) => boolean;
};

const nav = typeof navigator === "undefined" ? null : (navigator as Navigator & { userAgentData?: { platform?: string } });
export const IS_MAC = !!(nav && /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform || ""));

const mod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey;
const low = (e: KeyboardEvent) => e.key.toLowerCase();
/** 平台的主修饰键符号：给表里还没有的键位（如文本文档里的 ⌘B / Ctrl+B）拼文案用 */
export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";

/* ---------- 视图概览（Z）：和旧画布一样先适应全部节点，再按一次回到原视图 ---------- */
let overviewView: { k: number; x: number; y: number } | null = null;
let overviewOff: (() => void) | null = null;
function toggleOverview(ctl: Ctl) {
  const store = ctl.store;
  if (overviewView) {
    store.setView(overviewView); overviewView = null; overviewOff?.(); overviewOff = null;
    store.toast("已回到原来的视图"); return;
  }
  if (!store.state.doc.nodes.length) { store.toast("画布上还没有节点"); return; }
  overviewView = { ...store.state.view };
  // 不用动画：概览的适应动画会盖掉紧接着的「再按一次回到原视图」
  ctl.fitTo(store.state.doc.nodes, 60, 1, false);
  // 点一下画布就算退出概览（旧画布同样，按 Z 再进）
  const onDown = () => { overviewView = null; off(); };
  const off = () => { removeEventListener("pointerdown", onDown, true); if (overviewOff === off) overviewOff = null; };
  overviewOff?.(); overviewOff = off; addEventListener("pointerdown", onDown, true);
  store.toast("概览：按 Z 回到原来的视图");
}

/* ---------- 多选对齐（Alt + A/D/W/S/H/V）：按物理键位 e.code 判，Mac 上 ⌥A 会输出「å」 ---------- */
type AlignMode = "left" | "right" | "top" | "bottom" | "hcenter" | "vcenter";
const ALIGN_LABEL: Record<AlignMode, string> = { left: "左对齐", right: "右对齐", top: "顶对齐", bottom: "底对齐", hcenter: "水平居中", vcenter: "垂直居中" };
function alignNodes(store: CanvasStore, mode: AlignMode): boolean {
  const nodes = [...store.state.ui.sel].map((id) => store.node(id)).filter((n): n is CanvasNode => !!n);
  if (nodes.length < 2) return false;
  store.snapshot();
  // 左 / 顶对齐复用 actions 里已有的实现；右 / 底 / 居中按同一套外框算（alignSelection 只收了 left / top / hgap）
  if (mode === "left") alignSelection(store, "left");
  else if (mode === "top") alignSelection(store, "top");
  else {
    const minX = Math.min(...nodes.map((n) => n.x)), maxX = Math.max(...nodes.map((n) => n.x + n.w));
    const minY = Math.min(...nodes.map((n) => n.y)), maxY = Math.max(...nodes.map((n) => n.y + n.h));
    nodes.forEach((n) => {
      const x = mode === "right" ? maxX - n.w : mode === "hcenter" ? Math.round((minX + maxX - n.w) / 2) : n.x;
      const y = mode === "bottom" ? maxY - n.h : mode === "vcenter" ? Math.round((minY + maxY - n.h) / 2) : n.y;
      if (x !== n.x || y !== n.y) store.updateNode(n.id, (q) => ({ ...q, x, y }), { history: false });
    });
    store.toast(`已${ALIGN_LABEL[mode]} ${nodes.length} 个节点`);
  }
  return true;
}

const zoomTo = (ctl: Ctl, times: number) => { const r = ctl.rect(); ctl.zoomAt(ctl.store.state.view.k * times, r.left + r.width / 2, r.top + r.height / 2); };

export const SHORTCUTS: Shortcut[] = [
  /* ---------- 编辑与选择 ---------- */
  {
    id: "esc", group: "edit", label: "取消当前操作 / 关闭弹层", mac: ["Esc"], win: ["Esc"], gate: "always",
    match: (e) => e.key === "Escape",
    run: (ctl) => {
      const store = ctl.store; const st = store.state;
      if (modalOpen() || popOpen()) return true; // 由弹层自己处理
      if (st.ui.pick) { store.setUI({ pick: null }); return true; }
      if (st.ui.agentPick) { store.setUI({ agentPick: false }); return true; }
      if (st.ui.cmtMode) { toggleCmt(ctl); return true; }
      if (st.ui.drawer) { store.setUI({ drawer: null }); return true; }
      if (st.ui.editCell) { store.setUI({ editCell: null }); return true; }
      if (st.ui.editText) { (document.getElementById("txtEdit") as HTMLTextAreaElement | null)?.blur(); return true; }
      store.setUI({ sel: new Set(), edge: null }); return true;
    },
  },
  {
    id: "undo", group: "edit", label: "撤销", mac: ["⌘", "Z"], win: ["Ctrl", "Z"],
    match: (e) => mod(e) && !e.shiftKey && !e.altKey && low(e) === "z",
    run: (ctl, e) => { e.preventDefault(); ctl.store.undo(); return true; },
  },
  {
    id: "redo", group: "edit", label: "重做", mac: ["⇧", "⌘", "Z"], win: ["Ctrl", "Y"],
    match: (e) => mod(e) && !e.altKey && ((e.shiftKey && low(e) === "z") || (!e.shiftKey && low(e) === "y")),
    run: (ctl, e) => { e.preventDefault(); ctl.store.redo(); return true; },
  },
  {
    id: "copy", group: "edit", label: "复制选中的节点", mac: ["⌘", "C"], win: ["Ctrl", "C"],
    match: (e) => mod(e) && !e.shiftKey && !e.altKey && low(e) === "c",
    run: (ctl) => { copySelection(ctl.store); return true; },
  },
  {
    id: "paste", group: "edit", label: "粘贴节点 / 剪贴板图片（含截图）", mac: ["⌘", "V"], win: ["Ctrl", "V"],
    // 粘贴走浏览器的 paste 事件（CanvasApp 里），键盘派发不重复处理，否则会贴两次
  },
  {
    id: "duplicate", group: "edit", label: "原地复制一份选中节点", mac: ["⌘", "D"], win: ["Ctrl", "D"],
    match: (e) => mod(e) && !e.shiftKey && !e.altKey && low(e) === "d",
    run: (ctl, e) => { e.preventDefault(); duplicate(ctl.store); return true; },
  },
  {
    id: "selectAll", group: "edit", label: "选中全部节点", mac: ["⌘", "A"], win: ["Ctrl", "A"],
    match: (e) => mod(e) && !e.shiftKey && !e.altKey && low(e) === "a",
    run: (ctl, e) => {
      e.preventDefault(); const st = ctl.store.state; const hidden = hiddenIds(st.doc.nodes);
      ctl.store.setUI({ sel: new Set(st.doc.nodes.filter((n) => !hidden.has(n.id)).map((n) => n.id)) }); return true;
    },
  },
  {
    id: "group", group: "edit", label: "编组", mac: ["⌘", "G"], win: ["Ctrl", "G"],
    match: (e) => mod(e) && !e.shiftKey && !e.altKey && low(e) === "g",
    run: (ctl, e) => { e.preventDefault(); groupSelection(ctl.store); return true; },
  },
  {
    id: "ungroup", group: "edit", label: "取消分组", mac: ["⇧", "⌘", "G"], win: ["Ctrl", "Shift", "G"],
    match: (e) => mod(e) && e.shiftKey && !e.altKey && low(e) === "g",
    run: (ctl, e) => { e.preventDefault(); ungroup(ctl.store); return true; },
  },
  {
    id: "delete", group: "edit", label: "删除选中的节点 / 连线", mac: ["⌫"], win: ["Del"],
    match: (e) => e.key === "Delete" || e.key === "Backspace",
    run: (ctl) => { closePop(); deleteSelection(ctl.store); return true; },
  },
  {
    id: "nudge", group: "edit", label: "微调选中节点（按住 Shift 每次 10px）", mac: ["←", "↑", "→", "↓"], win: ["←", "↑", "→", "↓"],
    match: (e) => e.key.startsWith("Arrow"),
    run: (ctl, e) => {
      const store = ctl.store; const st = store.state; if (!st.ui.sel.size) return false;
      e.preventDefault(); const d = e.shiftKey ? 10 : 1;
      const [dx, dy] = ({ ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] } as Record<string, number[]>)[e.key];
      // 堆叠里的成员跟着堆叠一起移动（取消堆叠后相对位置不变）
      const moving = new Set(st.ui.sel); st.ui.sel.forEach((id) => { const g = store.node(id); if (isStack(g)) (g!.children || []).forEach((c) => moving.add(c)); });
      if (!e.repeat) store.snapshot();
      store.mutate((doc) => ({ ...doc, nodes: doc.nodes.map((n) => (moving.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n)) }));
      return true;
    },
  },

  /* ---------- 多选对齐（旧画布 Alt + A/D/W/S/H/V） ---------- */
  { id: "alignLeft", group: "align", label: "左对齐", mac: ["⌥", "A"], win: ["Alt", "A"], match: alignKey("KeyA"), run: alignRun("left") },
  { id: "alignRight", group: "align", label: "右对齐", mac: ["⌥", "D"], win: ["Alt", "D"], match: alignKey("KeyD"), run: alignRun("right") },
  { id: "alignTop", group: "align", label: "顶对齐", mac: ["⌥", "W"], win: ["Alt", "W"], match: alignKey("KeyW"), run: alignRun("top") },
  { id: "alignBottom", group: "align", label: "底对齐", mac: ["⌥", "S"], win: ["Alt", "S"], match: alignKey("KeyS"), run: alignRun("bottom") },
  { id: "alignHCenter", group: "align", label: "水平居中", mac: ["⌥", "H"], win: ["Alt", "H"], match: alignKey("KeyH"), run: alignRun("hcenter") },
  { id: "alignVCenter", group: "align", label: "垂直居中", mac: ["⌥", "V"], win: ["Alt", "V"], match: alignKey("KeyV"), run: alignRun("vcenter") },

  /* ---------- 生成与助手 ---------- */
  {
    id: "run", group: "gen", label: "一键运行分组 / 选中的多个节点", mac: ["⌘", "↵"], win: ["Ctrl", "Enter"],
    match: (e) => mod(e) && !e.altKey && e.key === "Enter",
    run: (ctl, e) => {
      const store = ctl.store; const st = store.state;
      const sel = [...st.ui.sel].map((id) => store.node(id)).filter((n): n is CanvasNode => !!n);
      if (sel.length > 1 || (sel.length === 1 && sel[0].kind === "group")) { e.preventDefault(); runNodes(ctl, sel); return true; }
      return false;
    },
  },
  {
    id: "promptSend", group: "gen", label: "在提示词框里生成", mac: ["⌘", "↵"], win: ["Ctrl", "Enter"],
    // 提示词框自己拦住 ⌘↵（PromptEditor.onKeyDown 里 stopPropagation），画布这层收不到，不重复派发
  },
  {
    id: "agent", group: "gen", label: "打开 / 收起 Agent 面板", mac: ["⌘", "J"], win: ["Ctrl", "J"], gate: "always",
    match: (e) => mod(e) && !e.shiftKey && !e.altKey && low(e) === "j",
    run: (ctl, e) => { e.preventDefault(); const ui = ctl.store.state.ui; ctl.store.setUI({ agentOpen: !ui.agentOpen, agentFull: false }); return true; },
  },
  {
    id: "pointEdit", group: "gen", label: "指向编辑：图上圈改 / 点节点给 Agent", mac: ["⌘", "I"], win: ["Ctrl", "I"],
    match: (e) => mod(e) && !e.shiftKey && !e.altKey && low(e) === "i",
    run: (ctl, e) => {
      e.preventDefault(); const store = ctl.store; const st = store.state;
      const one = st.ui.sel.size === 1 ? store.node([...st.ui.sel][0]) : null;
      if (one && one.kind === "image" && outOf(one)?.url) { openPointEdit(one.id); store.toast("在图上圈出要改的地方，再写改法"); return true; }
      if (st.ui.agentPick) { store.setUI({ agentPick: false }); return true; }
      store.setUI({ agentOpen: true, agentPick: true }); store.toast("点画布上的节点加入 Agent 上下文，Esc 结束"); return true;
    },
  },
  {
    id: "voice", group: "gen", label: "语音输入（再按一次结束）", mac: ["V"], win: ["V"],
    match: (e) => !mod(e) && !e.altKey && !e.repeat && low(e) === "v",
    run: (ctl, e) => {
      e.preventDefault(); const store = ctl.store; const was = store.state.ui.agentOpen;
      if (!was) store.setUI({ agentOpen: true });
      setTimeout(() => (document.getElementById("aMic") as HTMLButtonElement | null)?.click(), was ? 0 : 120); return true;
    },
  },
  {
    id: "search", group: "gen", label: "节点搜索", mac: ["⌘", "F"], win: ["Ctrl", "F"], gate: "always",
    match: (e) => mod(e) && !e.shiftKey && !e.altKey && low(e) === "f",
    run: (ctl, e) => { e.preventDefault(); openSearch(ctl); return true; },
  },

  /* ---------- 视图与画布 ---------- */
  {
    id: "zoomIn", group: "view", label: "放大画布", mac: ["⌘", "+"], win: ["Ctrl", "+"],
    match: (e) => mod(e) && !e.altKey && (e.key === "=" || e.key === "+"),
    run: (ctl, e) => { e.preventDefault(); zoomTo(ctl, 1.2); return true; },
  },
  {
    id: "zoomOut", group: "view", label: "缩小画布", mac: ["⌘", "−"], win: ["Ctrl", "−"],
    match: (e) => mod(e) && !e.altKey && e.key === "-",
    run: (ctl, e) => { e.preventDefault(); zoomTo(ctl, 1 / 1.2); return true; },
  },
  {
    id: "fit", group: "view", label: "适应画布：全部节点放进视野", mac: ["⇧", "1"], win: ["Shift", "1"],
    match: (e) => !mod(e) && !e.altKey && (e.key === "!" || (e.shiftKey && e.code === "Digit1")),
    run: (ctl) => { ctl.fitTo(ctl.store.state.doc.nodes); return true; },
  },
  {
    id: "overview", group: "view", label: "概览：缩小到能看见全部节点，再按一次回到原视图", mac: ["Z"], win: ["Z"],
    match: (e) => !mod(e) && !e.altKey && !e.repeat && low(e) === "z",
    run: (ctl, e) => { e.preventDefault(); toggleOverview(ctl); return true; },
  },
  {
    id: "theme", group: "view", label: "切换深浅色", mac: ["⇧", "⌘", "L"], win: ["Ctrl", "Shift", "L"], gate: "noTyping",
    match: (e) => mod(e) && e.shiftKey && !e.altKey && low(e) === "l",
    run: (ctl, e) => {
      e.preventDefault(); const store = ctl.store; const pref = store.state.ui.theme === "light" ? "dark" : "light";
      if (followsShellTheme()) requestShellTheme(pref);
      else { store.setUI({ themePref: pref }); try { localStorage.setItem("novai-canvas-theme", pref); } catch { /* 忽略 */ } applyTheme(store); }
      store.toast(pref === "light" ? "已切换到浅色" : "已切换到深色"); return true;
    },
  },
  {
    id: "assets", group: "view", label: "打开 / 关闭素材库", mac: ["A"], win: ["A"],
    match: (e) => !mod(e) && !e.altKey && !e.repeat && low(e) === "a",
    run: (ctl, e) => { e.preventDefault(); const ui = ctl.store.state.ui; ctl.store.setUI({ drawer: ui.drawer === "assets" ? null : "assets" }); return true; },
  },
  {
    id: "stack", group: "view", label: "把选中的节点收成一叠", mac: ["⇧", "S"], win: ["Shift", "S"],
    match: (e) => !mod(e) && !e.altKey && e.shiftKey && low(e) === "s",
    run: (ctl, e) => { if (ctl.store.state.ui.sel.size < 2) return false; e.preventDefault(); stackSelection(ctl.store); return true; },
  },
  {
    id: "comment", group: "view", label: "评论模式", mac: ["C"], win: ["C"],
    match: (e) => !mod(e) && !e.altKey && low(e) === "c",
    run: (ctl) => { toggleCmt(ctl); return true; },
  },
  {
    id: "help", group: "view", label: "打开这张快捷键表", mac: ["?"], win: ["?"],
    match: (e) => !mod(e) && !e.altKey && e.key === "?",
    run: (ctl) => { showKeys(ctl.store); return true; },
  },

  /* ---------- 鼠标与触控（说明只在帮助里出现，实际行为在 Viewport） ---------- */
  { id: "marquee", group: "pointer", mac: ["拖动"], win: ["拖动"], label: (d) => (d === "select" ? `空白处拖动 = 框选节点（Shift / ${MOD_KEY} 追加）` : `Shift / ${MOD_KEY} + 空白处拖动 = 框选节点`) },
  { id: "pan", group: "pointer", mac: ["拖动"], win: ["拖动"], label: (d) => (d === "select" ? "中键 / 空格 + 拖动 = 平移画布（触控板双指滑动同样是平移）" : "空白处拖动 = 平移画布（中键 / 空格同样）") },
  { id: "wheel", group: "pointer", mac: ["滚轮"], win: ["滚轮"], label: "鼠标滚轮 = 以指针为中心缩放；触控板双指 = 平移，捏合 = 缩放" },
  { id: "altDrag", group: "pointer", mac: ["⌥", "拖动"], win: ["Alt", "拖动"], label: "拖动节点时复制一份，原节点留在原处" },
  { id: "altDragEdges", group: "pointer", mac: ["⌥", "⇧", "拖动"], win: ["Alt", "Shift", "拖动"], label: "复制节点并保留输入连线" },
  { id: "dblBlank", group: "pointer", mac: ["双击"], win: ["双击"], label: "空白处双击 = 快速添加节点" },
  { id: "dblMedia", group: "pointer", mac: ["双击"], win: ["双击"], label: "图片 / 视频双击 = 全屏查看" },
  { id: "dblTitle", group: "pointer", mac: ["双击"], win: ["双击"], label: "双击节点标题 = 重命名" },
  { id: "ctxNode", group: "pointer", mac: ["右键"], win: ["右键"], label: "节点右键 = 节点菜单（复制 / 分组 / 对齐 / 删除）" },
  { id: "dragToLib", group: "pointer", mac: ["拖动"], win: ["拖动"], label: "把节点拖到左侧素材库 = 存入素材库" },
];

/** Alt + 物理键位：Mac 的 ⌥ 组合会改变 e.key，只能用 e.code 判 */
function alignKey(code: string) {
  return (e: KeyboardEvent) => e.altKey && !mod(e) && !e.shiftKey && e.code === code;
}
function alignRun(mode: AlignMode) {
  return (ctl: Ctl, e: KeyboardEvent) => { if (ctl.store.state.ui.sel.size < 2) return false; e.preventDefault(); return alignNodes(ctl.store, mode); };
}

/** 帮助 / 菜单里显示的键位文案：mac 直接连写（⇧⌘Z），win 用 + 连接（Ctrl+Shift+Z） */
export function keyHint(id: string): string {
  const s = SHORTCUTS.find((x) => x.id === id);
  if (!s) return "";
  return IS_MAC ? s.mac.join("") : s.win.join("+");
}

/** 键盘派发：默认 gate 是 canvas（输入框 / 弹窗里让位，和重构前 CanvasApp 里那句 if (isTyping() || modalOpen()) return 一致），返回是否已经处理 */
export function dispatchShortcut(ctl: Ctl, e: KeyboardEvent): boolean {
  for (const s of SHORTCUTS) {
    if (!s.match) continue;
    const gate = s.gate ?? "canvas";
    if (gate === "canvas" && (isTyping() || modalOpen())) continue;
    if (gate === "noTyping" && isTyping()) continue;
    if (!s.match(e)) continue;
    if (s.run?.(ctl, e)) return true;
  }
  return false;
}

/** 帮助弹窗：按分组排版，每条一个键位标签，内容全部来自上面的表 */
export function showKeys(store?: CanvasStore) {
  const leftDrag = store?.state.ui.leftDrag ?? "select";
  openModal(() => <>
    <ModalHead title="快捷键" icon="grid" />
    <div className="mbd">
      {GROUPS.map((g) => {
        const rows = SHORTCUTS.filter((s) => s.group === g.id);
        if (!rows.length) return null;
        return <section key={g.id} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11.5, color: "var(--fg3)", padding: "6px 0 2px" }}>{g.label}</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 28px" }}>
            {rows.map((s) => <div key={s.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "5px 0", fontSize: 12.5 }}>
              <span style={{ color: "var(--fg)" }}>{typeof s.label === "function" ? s.label(leftDrag) : s.label}</span>
              <span style={{ display: "inline-flex", gap: 4, flexShrink: 0 }}>
                {(IS_MAC ? s.mac : s.win).map((t, i) => <kbd key={i} style={{ font: "11.5px var(--mono)", color: "var(--fg2)", background: "rgba(var(--ink),.07)", borderRadius: 6, padding: "2px 6px" }}>{t}</kbd>)}
              </span>
            </div>)}
          </div>
        </section>;
      })}
    </div>
  </>);
}
