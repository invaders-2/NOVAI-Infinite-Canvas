/**
 * 分镜表的视图层（对齐「视频解析分镜」原型 v3）：
 *   节点标题右侧的视图下拉 / 全屏里的视图标签（··· 菜单、新建视图）/ 字段 · 筛选 · 分组 · 排序 /
 *   创意视图卡片墙 / 镜头详情抽屉。
 * 数据都在 TableData 上（views / activeView / types），这里只管界面；编辑一律写回原始行号。
 */
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type { CanvasEdge, CanvasNode } from "../../react-canvas/reactCanvasStore";
import { cloneParams, genOf, uid, withGen, type VideoParams } from "../model";
import {
  activeViewOf, COL_TYPE_LABEL, COL_TYPES, colTypeOf, FILTER_OPS, mediaRefsIn, normalizeAiColumns, ROLE_META, rolesOf, selectOptions, splitMulti,
  tableOf, TABLE_CELL_PREVIEW_W, TABLE_LIMITS, TABLE_VIEW_LIMIT, viewsOf, visibleCols, withTable, withViews,
  type ColRole, type ColType, type FilterOp, type TableData, type TableView, type TableViewDef,
} from "../table";
import type { CanvasStore } from "../store";
import { openAiColumnPanel } from "./TableAi";
import { openPop } from "./overlay";
import { useCtl, useS, type Ctl } from "./ctx";
import { Icon } from "./Icon";
import { PreviewImg } from "./thumb";

export type ViewCtl = {
  nodeId: string; views: TableViewDef[]; view: TableViewDef; columns: string[];
  saveViews: (fn: (vs: TableViewDef[], cur: TableViewDef) => { views: TableViewDef[]; active?: string }) => void;
  patchView: (p: Partial<TableViewDef>) => void; toast: (m: string) => void;
};
export function makeViewCtl(store: CanvasStore, nodeId: string, t: TableData): ViewCtl {
  const saveViews: ViewCtl["saveViews"] = (fn) => store.updateNode(nodeId, (n) => {
    const x = tableOf(n); const cur = activeViewOf(x); const out = fn(viewsOf(x).map((v) => ({ ...v })), cur);
    return withTable(n, withViews(x, out.views, out.active || cur.id));
  }, { history: true });
  const patchView = (p: Partial<TableViewDef>) => saveViews((vs, cur) => ({ views: vs.map((v) => (v.id === cur.id ? { ...v, ...p } : v)) }));
  return { nodeId, views: viewsOf(t), view: activeViewOf(t), columns: t.columns, saveViews, patchView, toast: (m) => store.toast(m) };
}
/** 弹层里的面板一直开着：每次渲染从文档里现取，别用打开那一刻的旧值 */
function useViewCtl(nodeId: string): ViewCtl | null {
  const store = useCtl().store;
  const node = useS((s) => s.doc.nodes.find((n) => n.id === nodeId));
  return node ? makeViewCtl(store, nodeId, tableOf(node)) : null;
}
const newViewId = () => "v" + Math.random().toString(36).slice(2, 8);
const stop = (e: SyntheticEvent) => e.stopPropagation();
const viewIcon = (type: TableView) => (type === "card" ? "layoutgrid" : "grid");

function addView(ctl: ViewCtl, type: TableView) {
  if (ctl.views.length >= TABLE_VIEW_LIMIT) return ctl.toast(`最多 ${TABLE_VIEW_LIMIT} 个视图`);
  const id = newViewId(); const n = ctl.views.filter((v) => v.type === type).length + 1;
  ctl.saveViews((vs) => ({ views: [...vs, { id, name: type === "card" ? `创意视图 ${n}` : `表格视图 ${n}`, type }], active: id }));
}

/* ---------- 节点：标题右侧的视图下拉 ---------- */
export function ViewMenuButton({ ctl }: { ctl: ViewCtl }) {
  const { views, view } = ctl;
  const open = (anchor: Element) => openPop(anchor, (close) => <>
    <div className="mh">视图</div>
    {views.map((v) => <button key={v.id} className={"mi" + (v.id === view.id ? " on" : "")} data-pick-view={v.id} onClick={() => { close(); if (v.id !== view.id) ctl.saveViews((vs) => ({ views: vs, active: v.id })); }}>
      <Icon name={viewIcon(v.type)} size="s" /><span style={{ flex: 1 }}>{v.name}</span></button>)}
  </>, "down", "right");
  return <button className="tview-btn" data-tview data-view={view.type} title="切换视图" onPointerDown={stop} onClick={(e) => { e.stopPropagation(); open(e.currentTarget); }}>
    <Icon name={viewIcon(view.type)} size="xs" /><span>{view.name}</span><Icon name="down" size="xs" />
  </button>;
}

/* ---------- 全屏：视图标签（当前视图带 ··· 菜单）+ 新建视图 ---------- */
export function ViewTabs({ ctl }: { ctl: ViewCtl }) {
  const { views, view, saveViews } = ctl;
  const add = (anchor: Element) => openPop(anchor, (close) => <>
    <div className="mh">新建视图</div>
    <button className="mi" data-newview="grid" onClick={() => { close(); addView(ctl, "grid"); }}><Icon name="grid" size="s" /><span style={{ flex: 1, display: "flex", flexDirection: "column" }}>表格视图<span className="d">字段 / 筛选 / 分组 / 排序</span></span></button>
    <button className="mi" data-newview="card" onClick={() => { close(); addView(ctl, "card"); }}><Icon name="layoutgrid" size="s" /><span style={{ flex: 1, display: "flex", flexDirection: "column" }}>创意视图<span className="d">卡片墙，首帧做封面</span></span></button>
  </>);
  const menu = (anchor: Element, v: TableViewDef) => openPop(anchor, (close) => <>
    <button className="mi" data-viewact="rename" onClick={() => { close(); openPop(anchor, (c2) => <RenameView name={v.name} onDone={(name) => { c2(); if (name) saveViews((vs) => ({ views: vs.map((x) => (x.id === v.id ? { ...x, name } : x)) })); }} />); }}><Icon name="pencil" size="s" />重命名</button>
    <button className="mi" data-viewact="dup" onClick={() => { close(); if (views.length >= TABLE_VIEW_LIMIT) return ctl.toast(`最多 ${TABLE_VIEW_LIMIT} 个视图`); const id = newViewId(); saveViews((vs) => ({ views: [...vs, { ...v, id, name: v.name + " 副本" }], active: id })); }}><Icon name="copy" size="s" />复制视图</button>
    <button className="mi" data-viewact="type" onClick={() => { close(); saveViews((vs) => ({ views: vs.map((x) => (x.id === v.id ? { ...x, type: x.type === "card" ? "grid" : "card" } : x)) })); }}><Icon name={viewIcon(v.type === "card" ? "grid" : "card")} size="s" />改成{v.type === "card" ? "表格视图" : "创意视图"}</button>
    <div className="msep" />
    <button className="mi" data-viewact="delete" disabled={views.length <= 1} onClick={() => { close(); saveViews((vs) => { const rest = vs.filter((x) => x.id !== v.id); return { views: rest, active: rest[0].id }; }); }}><Icon name="trash" size="s" />{views.length <= 1 ? "至少保留一个视图" : "删除视图"}</button>
  </>);
  return <div className="tv-tabs" data-tview role="tablist" aria-label="视图" onPointerDown={stop}>
    {views.map((v) => <div key={v.id} className={"tv-tab" + (view.id === v.id ? " on" : "")} data-viewid={v.id}>
      <button role="tab" aria-selected={view.id === v.id} data-view={v.type} onClick={() => { if (view.id !== v.id) saveViews((vs) => ({ views: vs, active: v.id })); }}>
        <Icon name={viewIcon(v.type)} size="xs" />{v.name}</button>
      {view.id === v.id ? <button className="tv-more" aria-label="视图菜单" data-tabmenu onClick={(e) => menu(e.currentTarget, v)}><Icon name="more" size="xs" /></button> : null}
    </div>)}
    <button className="tv-new" data-act="newview" onClick={(e) => add(e.currentTarget)}><Icon name="plus" size="xs" />新建视图</button>
  </div>;
}
function RenameView({ name, onDone }: { name: string; onDone: (name: string) => void }) {
  const [val, setVal] = useState(name);
  return <div className="vai tv-form" style={{ width: 240 }} data-rename-view>
    <label>视图名称</label>
    <input autoFocus value={val} maxLength={40} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") onDone(val.trim()); if (e.key === "Escape") onDone(""); }} />
    <div className="vai-foot"><button className="btn" onClick={() => onDone("")}>取消</button><button className="btn solid" data-rename-ok onClick={() => onDone(val.trim())}>确定</button></div>
  </div>;
}

/* ---------- 全屏：字段 / 筛选 / 分组 / 排序 ---------- */
export function ViewTools({ ctl, hint, shown, total }: { ctl: ViewCtl; hint: string; shown: number; total: number }) {
  const { view, columns, patchView } = ctl;
  const hiddenN = (view.hidden || []).filter((h) => columns.includes(h)).length;
  const group = (a: Element) => openPop(a, (close) => <>
    <div className="mh">分组</div>
    <button className={"mi" + (!view.group ? " on" : "")} onClick={() => { close(); patchView({ group: undefined }); }}><span>不分组</span></button>
    {columns.map((c) => <button key={c} className={"mi" + (view.group === c ? " on" : "")} data-group={c} onClick={() => { close(); patchView({ group: c }); }}><span>{c}</span></button>)}
  </>, "down", "left", undefined, 380);
  return <div className="tv-tools" onPointerDown={stop}>
    <button className={hiddenN ? "on" : undefined} data-vtool="fields" onClick={(e) => openPop(e.currentTarget, () => <FieldsPanel nodeId={ctl.nodeId} />)}><Icon name="fields" size="xs" />字段{hiddenN ? <span className="n tnum">隐藏 {hiddenN}</span> : null}</button>
    <button className={view.filters?.length ? "on" : undefined} data-vtool="filter" onClick={(e) => openPop(e.currentTarget, () => <FilterPanel nodeId={ctl.nodeId} />)}><Icon name="filter" size="xs" />筛选{view.filters?.length ? <span className="n tnum">{shown}/{total}</span> : null}</button>
    <button className={view.group ? "on" : undefined} data-vtool="group" onClick={(e) => group(e.currentTarget)}><Icon name="rows" size="xs" />{view.group ? `分组 · ${view.group}` : "分组"}</button>
    <button className={view.sort ? "on" : undefined} data-vtool="sort" onClick={(e) => openPop(e.currentTarget, () => <SortPanel nodeId={ctl.nodeId} />, "down", "left", undefined, 440)}><Icon name="sort" size="xs" />{view.sort ? `排序 · ${view.sort.col}` : "排序"}</button>
    <span className="sp" />
    <span className="tv-hint">{hint}</span>
  </div>;
}
/** 字段面板（原型）：每个字段一行「名称 · 类型 · 眼睛」，底部新建字段（文本 / 单选 / 多选 / 数字，可设智能列） */
function FieldsPanel({ nodeId }: { nodeId: string }) {
  const store = useCtl().store;
  const ctl = useViewCtl(nodeId);
  const node = useS((s) => s.doc.nodes.find((n) => n.id === nodeId));
  const [name, setName] = useState(""); const [type, setType] = useState<ColType>("text"); const [ai, setAi] = useState(false);
  if (!ctl || !node) return null;
  const t = tableOf(node);
  const { view, columns, patchView } = ctl;
  const hidden = new Set(view.hidden || []);
  const toggle = (c: string) => { const next = new Set(hidden); if (next.has(c)) next.delete(c); else next.add(c); if (columns.every((x) => next.has(x))) return ctl.toast("至少显示一个字段"); patchView({ hidden: next.size ? [...next] : undefined }); };
  const create = () => {
    const n = name.trim();
    if (!n) return ctl.toast("先写字段名");
    if (columns.includes(n)) return ctl.toast("已经有同名字段");
    if (columns.length >= TABLE_LIMITS.cols) return ctl.toast("表格最多允许 200 列。");
    const at = columns.length;
    store.updateNode(nodeId, (x) => {
      const d = tableOf(x);
      const types = d.columns.map((_, i) => d.types?.[i] || ""); types.push(type);
      return withTable(x, { ...d, columns: [...d.columns, n], rows: d.rows.map((r) => [...r, ""]), ...(d.roles ? { roles: [...d.roles, ""] } : {}), types, ...(d.aiColumns ? { aiColumns: normalizeAiColumns(d.aiColumns, d.columns.length + 1) } : {}) });
    }, { history: true });
    setName("");
    // 智能列：直接打开已有的「智能列」面板写指令并批量生成（不另做一套）
    if (ai) setTimeout(() => openAiColumnPanel(store, nodeId, at), 0);
  };
  return <div className="tv-fields" data-fields-panel>
    <div className="mh">在「{view.name}」里显示</div>
    <div className="tvf-list">
      {columns.map((c, i) => <button key={c + i} className={"mi" + (hidden.has(c) ? " off" : "")} data-field={c} data-eye={c} aria-pressed={!hidden.has(c)} onClick={() => toggle(c)}>
        <span className="tvf-n">{c}</span><span className="k">{COL_TYPE_LABEL[colTypeOf(t, i)]}</span><Icon name={hidden.has(c) ? "eyeoff" : "eye"} size="s" />
      </button>)}
    </div>
    <div className="msep" />
    <div className="vai">
      <div className="mh">新建字段</div>
      <input value={name} placeholder="字段名，比如 情绪 / 卖点 / 色调" maxLength={120} data-newfield-name onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") create(); }} />
      <div className="seg">{COL_TYPES.map((x) => <button key={x} className={type === x ? "on" : undefined} data-newfield-type={x} onClick={() => setType(x)}>{COL_TYPE_LABEL[x]}</button>)}</div>
      <button className="mi tvf-ai" role="switch" aria-checked={ai} data-newfield-ai onClick={() => setAi(!ai)}>
        <span style={{ flex: 1, display: "flex", flexDirection: "column" }}>智能列<span className="d">建好后写一句指令，按每一行的内容自动填</span></span>
        <span className={"sw" + (ai ? " on" : "")} />
      </button>
      <div className="vai-foot"><button className="btn solid" data-newfield-add onClick={create}>添加字段</button></div>
    </div>
  </div>;
}
function FilterPanel({ nodeId }: { nodeId: string }) {
  const ctl = useViewCtl(nodeId); if (!ctl) return null;
  const { view, columns, patchView } = ctl;
  const list = view.filters || [];
  const set = (i: number, p: Partial<{ col: string; op: FilterOp; value: string }>) => patchView({ filters: list.map((f, j) => (j === i ? { ...f, ...p } : f)) });
  return <div className="vai tv-form" style={{ width: 380 }} data-filter-panel>
    <label>符合以下全部条件</label>
    {list.length ? null : <div className="tv-none">还没有条件</div>}
    {list.map((f, i) => <div className="tv-row" key={i} data-filter-row={i}>
      <select value={f.col} onChange={(e) => set(i, { col: e.target.value })}>{columns.map((c) => <option key={c} value={c}>{c}</option>)}</select>
      <select value={f.op} onChange={(e) => set(i, { op: e.target.value as FilterOp })}>{FILTER_OPS.map(([o, l]) => <option key={o} value={o}>{l}</option>)}</select>
      {f.op === "has" || f.op === "not" ? <input value={f.value || ""} placeholder="关键词" onChange={(e) => set(i, { value: e.target.value })} onKeyDown={stop} /> : <span className="tv-fill" />}
      <button className="ib" aria-label="删除条件" onClick={() => { const next = list.filter((_, j) => j !== i); patchView({ filters: next.length ? next : undefined }); }}><Icon name="x" size="xs" /></button>
    </div>)}
    <div className="vai-foot">
      {list.length ? <button className="btn" onClick={() => patchView({ filters: undefined })}>清空</button> : null}
      <button className="btn solid" data-filter-add onClick={() => patchView({ filters: [...list, { col: columns.includes("景别") ? "景别" : columns[0], op: "has" as FilterOp, value: "" }].slice(0, 10) })}><Icon name="plus" size="xs" />添加条件</button>
    </div>
  </div>;
}
function SortPanel({ nodeId }: { nodeId: string }) {
  const ctl = useViewCtl(nodeId); if (!ctl) return null;
  const { view, columns, patchView } = ctl;
  const dir = view.sort?.dir || "asc";
  return <div style={{ width: 240 }} data-sort-panel>
    <div className="mh">排序</div>
    <div className="seg" style={{ padding: "2px 6px 8px" }}>
      {(["asc", "desc"] as const).map((d) => <button key={d} className={dir === d ? "on" : undefined} data-sortdir={d} onClick={() => view.sort && patchView({ sort: { ...view.sort, dir: d } })}>{d === "asc" ? "升序" : "降序"}</button>)}
    </div>
    <button className={"mi" + (!view.sort ? " on" : "")} onClick={() => patchView({ sort: undefined })}><span>不排序（按原顺序）</span></button>
    {columns.map((c) => <button key={c} className={"mi" + (view.sort?.col === c ? " on" : "")} data-sort={c} onClick={() => patchView({ sort: { col: c, dir } })}><span>{c}</span></button>)}
  </div>;
}

/* ---------- 创意视图：卡片墙 ---------- */
const colOf = (cols: string[], names: string[], vis: Set<number>) => { for (const n of names) { const i = cols.indexOf(n); if (i >= 0 && vis.has(i)) return i; } return -1; };
/** 卡片的字段位置：封面 = 首帧 / 图片列，角标 = 镜号 + 时长，正文 = 画面描述，标签 = 景别 / 机位 / 运镜，底注 = 情绪 */
function cardLayout(t: TableData, roles: Array<{ role: ColRole }>, visCols: number[]) {
  const cols = t.columns; const vis = new Set(visCols);
  const cover = roles.findIndex((r, i) => r.role === "first" && vis.has(i));
  const coverAt = cover >= 0 ? cover : roles.findIndex((r, i) => ROLE_META[r.role].media && vis.has(i));
  const noAt = colOf(cols, ["镜号", "镜头", "序号", "编号"], vis);
  const durAt = colOf(cols, ["时长", "起止"], vis);
  const descAt = colOf(cols, ["画面描述", "画面", "描述"], vis);
  const footAt = colOf(cols, ["情绪", "卖点"], vis);
  const tagAts = ["景别", "机位", "运镜"].map((n) => cols.indexOf(n)).filter((i) => i >= 0 && vis.has(i));
  const used = new Set([coverAt, noAt, durAt, descAt, footAt, ...tagAts]);
  const plain = (i: number) => vis.has(i) && !used.has(i) && !ROLE_META[roles[i].role].media;
  const bodyAt = descAt >= 0 ? descAt : cols.findIndex((_, i) => plain(i));
  const extraTags = tagAts.length ? [] : cols.map((_, i) => i).filter((i) => plain(i) && i !== bodyAt).slice(0, 2);
  return { coverAt, noAt, durAt, bodyAt, footAt, tagAts: [...tagAts, ...extraTags] };
}
export function CardWall({ t, roles, cols: visCols, groups, groupCol, sel, full, active, onRow, onOpenFull, reveal }: {
  t: TableData; roles: Array<{ role: ColRole }>; cols: number[]; groups: Array<{ key: string | null; rows: number[] }>; groupCol?: string;
  sel: boolean; full: boolean; active?: number | null; onRow: (r: number) => void; onOpenFull: () => void; /** 解析刚落表：卡片依次淡入 */ reveal?: boolean;
}) {
  const L = cardLayout(t, roles, visCols);
  const lastDown = useRef(0);
  // 节点里的卡片墙按节点大小自适应：算出列数和卡宽，让所有卡片（封面按首帧原比例 + 文字）整张装进节点，不用滚动
  const wallRef = useRef<HTMLDivElement>(null);
  const [ar, setAr] = useState(0); // 已加载首帧里最高的 高/宽 比
  const [fit, setFit] = useState<{ c: number; w: number } | null>(null);
  const count = groups.reduce((n, g) => n + g.rows.length, 0);
  const flat = !full && groups.every((g) => g.key === null);
  useEffect(() => {
    const el = wallRef.current;
    if (!flat || !el || !count) { setFit(null); return; }
    const calc = () => {
      const cs = getComputedStyle(el), gap = parseFloat(cs.columnGap) || 12;
      const W = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const H = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      if (W <= 0 || H <= 0) return;
      const body = (el.querySelector(".tc-body") as HTMLElement | null)?.offsetHeight || 64;
      const r = ar || 9 / 16;
      let best = { c: 1, w: 0 };
      for (let c = 1; c <= count; c++) {
        const rows = Math.ceil(count / c);
        const w = Math.min((W - (c - 1) * gap) / c, ((H - (rows - 1) * gap) / rows - body) / r);
        if (w > best.w) best = { c, w };
      }
      if (best.w < 96) { const c = Math.max(1, Math.floor((W + gap) / (96 + gap))); best = { c, w: (W - (c - 1) * gap) / c }; } // 太小就退回可滚动
      const w = Math.floor(best.w);
      setFit((f) => (f && f.c === best.c && f.w === w ? f : { c: best.c, w }));
    };
    calc();
    const ro = new ResizeObserver(calc); ro.observe(el);
    return () => ro.disconnect();
  }, [flat, count, ar]);
  // 首帧加载后把封面锁成它的原比例（aspect-ratio 让网格行高按真实高度算，不会叠到下一行上）
  const onImgLoad = (e: SyntheticEvent) => {
    const img = e.target as HTMLImageElement;
    if (img.tagName !== "IMG" || !img.naturalWidth || !img.naturalHeight) return;
    const cover = img.closest(".tc-cover") as HTMLElement | null;
    if (cover) cover.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
    const r = img.naturalHeight / img.naturalWidth;
    setAr((a) => (r > a + 0.01 ? r : a));
  };
  if (!t.rows.length) return <div className="tcards-empty">还没有行，切到表格视图添加</div>;
  const shown = groups.reduce((n, g) => n + g.rows.length, 0);
  if (!shown) return <div className="tcards-empty">没有符合筛选条件的行</div>;
  const card = (r: number) => {
    const row = t.rows[r];
    const img = L.coverAt >= 0 ? mediaRefsIn(row[L.coverAt] || "")[0] : "";
    const no = L.noAt >= 0 && row[L.noAt] ? row[L.noAt] : String(r + 1);
    const dur = L.durAt >= 0 ? row[L.durAt] : "";
    const tags = L.tagAts.map((i) => row[i]).filter((v) => v && v.trim());
    return <article className={"tcard" + (active === r ? " on" : "")} key={r} style={{ ["--i" as string]: r }} data-card={r} data-act="open-row" onClick={full ? () => onRow(r) : undefined}>
      <div className="tc-cover">
        {img ? <PreviewImg src={img} width={TABLE_CELL_PREVIEW_W * 2} title={`镜头 ${no}`} /> : <span className="tc-ph"><Icon name="image" size="s" /></span>}
        <span className="tc-no tnum">#{no}</span>{dur ? <span className="tc-dur tnum">{dur}</span> : null}
      </div>
      <div className="tc-body">
        {L.bodyAt >= 0 && row[L.bodyAt] ? <p className="tc-desc">{row[L.bodyAt]}</p> : <p className="tc-desc tc-none">—</p>}
        {tags.length ? <div className="tc-tags">{tags.map((v, i) => <span key={i}>{v}</span>)}</div> : null}
        {full && L.footAt >= 0 && row[L.footAt] ? <p className="tc-foot">{t.columns[L.footAt]} · {row[L.footAt]}</p> : null}
      </div>
    </article>;
  };
  return <div ref={wallRef} className={"tcards" + (full ? " full" : "") + (reveal ? " reveal" : "") + (fit ? " fit" : "")} style={fit ? { gridTemplateColumns: `repeat(${fit.c}, ${fit.w}px)` } : undefined} onLoad={onImgLoad} data-tcards onWheel={(e) => { if (sel) e.stopPropagation(); }} onPointerDown={(e) => {
    // 画布在 pointerdown 上接管了拖动，原生 dblclick 到不了节点里：按两次按下的间隔判断双击，打开全屏
    if (full) return;
    const now = performance.now();
    if (now - lastDown.current < 350) { lastDown.current = 0; e.stopPropagation(); onOpenFull(); } else lastDown.current = now;
  }}>
    {groups.map((g) => g.key === null ? g.rows.map(card) : <section className="tc-group" key={"g:" + g.key} data-card-group={g.key}>
      <div className="tc-gh"><span className="tg-k">{groupCol}</span><span className="tg-v">{g.key || "（空）"}</span><em className="tnum">{g.rows.length}</em></div>
      <div className="tc-grid">{g.rows.map(card)}</div>
    </section>)}
  </div>;
}

/* ---------- 镜头详情抽屉（全屏里点卡片 / 行首） ---------- */
/** 分镜表的来源视频：连进这张表的第一个视频节点 */
export function sourceVideoOf(store: CanvasStore, tableId: string): CanvasNode | undefined {
  const d = store.state.doc;
  return d.edges.filter((e) => e.to === tableId).map((e) => d.nodes.find((n) => n.id === e.from)).find((n): n is CanvasNode => !!n && n.kind === "video");
}
export function DetailDrawer({ ctl, nodeId, row, order, onMove, onClose }: { ctl: Ctl; nodeId: string; row: number; order: number[]; onMove: (r: number) => void; onClose: () => void }) {
  const store = ctl.store;
  const node = useS((s) => s.doc.nodes.find((n) => n.id === nodeId));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = String((e.target as HTMLElement | null)?.tagName || "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const at = order.indexOf(row);
      if (e.key === "ArrowUp" && at > 0) { e.preventDefault(); onMove(order[at - 1]); }
      if (e.key === "ArrowDown" && at >= 0 && at < order.length - 1) { e.preventDefault(); onMove(order[at + 1]); }
    };
    document.addEventListener("keydown", onKey); return () => document.removeEventListener("keydown", onKey);
  });
  if (!node) return null;
  const t = tableOf(node); const cells = t.rows[row];
  if (!cells) return null;
  const roles = rolesOf(t); const view = activeViewOf(t); const vis = visibleCols(t, view);
  const L = cardLayout(t, roles, t.columns.map((_, i) => i));
  const no = L.noAt >= 0 && cells[L.noAt] ? cells[L.noAt] : String(row + 1);
  const rangeAt = t.columns.indexOf("起止"); const durAt = t.columns.indexOf("时长");
  const img = L.coverAt >= 0 ? mediaRefsIn(cells[L.coverAt] || "")[0] : "";
  const at = order.indexOf(row);
  const set = (c: number, v: string) => store.updateNode(nodeId, (n) => { const d = tableOf(n); return withTable(n, { ...d, rows: d.rows.map((r, i) => (i === row ? r.map((x, j) => (j === c ? v.slice(0, TABLE_LIMITS.cell) : x)) : r)) }); });
  const locate = () => { const v = sourceVideoOf(store, nodeId); if (!v) return store.toast("这张表没有连着原视频"); onClose(); window.dispatchEvent(new CustomEvent("cn:tabledoc-close")); ctl.focusNode(v.id); };
  const frameToCanvas = () => {
    if (!img) return store.toast("这一镜还没有首帧");
    const x = node.x + node.w + 80; const y = node.y + row * 40;
    const n = store.newNode("image", x, y, { title: `镜头 ${no} · 首帧`, hist: [{ url: img }], hi: 0, w: 320, h: 180 });
    store.addNodes([n], [], { select: false });
    store.toast(`已把镜头 ${no} 的首帧放到画布`);
  };
  // 换成我的产品重拍：右边建一个视频节点，提示词带上这一镜的画面 / 景别 / 机位 / 运镜 / 时长，首帧作参考图连进去；产品图由用户连进来再运行
  const retake = () => {
    const pick = (name: string) => { const i = t.columns.indexOf(name); return i >= 0 ? (cells[i] || "").trim() : ""; };
    const desc = pick("画面描述") || pick("画面") || (L.bodyAt >= 0 ? (cells[L.bodyAt] || "").trim() : "");
    const shot = [["景别", pick("景别")], ["机位", pick("机位")], ["运镜", pick("运镜")], ["时长", pick("时长")]].filter(([, v]) => v).map(([k, v]) => `${k}：${v}`).join("；");
    const prompt = `参考这一镜重拍，镜头语言保持不变，把画面里的产品换成我连进来的产品图。${desc ? "画面：" + desc + "。" : ""}${shot ? shot + "。" : ""}`;
    const x = node.x + node.w + 140; const y = node.y + row * 40;
    const nodes: CanvasNode[] = []; const edges: CanvasEdge[] = [];
    // 参考生视频：首帧（镜头构图）和用户连进来的产品图都作为参考图发送
    let video = store.newNode("video", img ? x + 400 : x, y, { title: `镜头 ${no} · 换产品重拍`, prompt });
    video = withGen(video, { params: { ...cloneParams(genOf(video).params as VideoParams), mode: "参考生视频" } });
    if (img) { const f = store.newNode("image", x, y, { title: `镜头 ${no} · 首帧`, hist: [{ url: img }], hi: 0, w: 320, h: 180 }); nodes.push(f); edges.push({ id: uid("e"), from: f.id, to: video.id }); }
    nodes.push(video);
    store.addNodes(nodes, edges, { select: true });
    onClose(); window.dispatchEvent(new CustomEvent("cn:tabledoc-close")); ctl.focusNode(video.id);
    store.toast(`已建好「镜头 ${no} · 换产品重拍」：把你的产品图连进来再运行`, 6000);
  };
  // 编辑区：当前视图里显示的字段（镜号、首帧已在头部展示，不重复）
  const fields = vis.filter((c) => c !== L.noAt && c !== L.coverAt && !ROLE_META[roles[c].role].media);
  return <aside className="td-drawer" data-drawer onPointerDown={stop} onKeyDown={stop}>
    <div className="tdd-head">
      <b>镜头 {no}</b><span className="tnum">{[rangeAt >= 0 ? cells[rangeAt] : "", durAt >= 0 ? cells[durAt] : ""].filter(Boolean).join(" · ")}</span>
      <span className="sp" />
      <button className="ib" aria-label="上一镜" data-act="dprev" disabled={at <= 0} onClick={() => onMove(order[at - 1])}><Icon name="up" size="s" /></button>
      <button className="ib" aria-label="下一镜" data-act="dnext" disabled={at < 0 || at >= order.length - 1} onClick={() => onMove(order[at + 1])}><Icon name="down" size="s" /></button>
      <button className="ib" aria-label="关闭" data-act="dclose" onClick={onClose}><Icon name="x" size="s" /></button>
    </div>
    <div className="tdd-scroll">
      <div className="tdd-cover">{img ? <PreviewImg src={img} width={720} title={`镜头 ${no} 首帧`} /> : <span className="tc-ph"><Icon name="image" /></span>}</div>
      <div className="vai tdd-form">
        {fields.map((c) => {
          const type = colTypeOf(t, c); const v = cells[c] || "";
          return <div className="tdd-f" key={c} data-dfield={t.columns[c]}>
            <label>{t.columns[c]}</label>
            {type === "single" || type === "multi" ? <div className="seg wrap">{selectOptions(t, c).map((o) => {
              const on = type === "single" ? v.trim() === o : splitMulti(v).includes(o);
              return <button key={o} className={on ? "on" : undefined} data-act="dchip" onClick={() => {
                if (type === "single") set(c, on ? "" : o);
                else { const cur = splitMulti(v); set(c, (on ? cur.filter((x) => x !== o) : [...cur, o]).join("、")); }
              }}>{o}</button>;
            })}</div>
              : v.length > 40 || /描述|提示词|对白|画面/.test(t.columns[c]) ? <textarea value={v} rows={Math.min(6, Math.max(2, Math.ceil(v.length / 24)))} onChange={(e) => set(c, e.target.value)} />
                : <input value={v} inputMode={type === "number" ? "decimal" : undefined} onChange={(e) => set(c, e.target.value)} />}
          </div>;
        })}
      </div>
    </div>
    <div className="tdd-acts">
      <button className="btn" data-act="locate" onClick={locate}><Icon name="pin" size="xs" />定位原视频</button>
      <button className="btn" data-act="frame-to-canvas" onClick={frameToCanvas}><Icon name="image" size="xs" />首帧放到画布</button>
      <button className="btn solid" data-act="retake-product" onClick={retake}><Icon name="refresh" size="xs" />换成我的产品重拍</button>
    </div>
  </aside>;
}
