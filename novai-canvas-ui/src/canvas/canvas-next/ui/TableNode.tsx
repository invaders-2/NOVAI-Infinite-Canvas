/**
 * 多维表格节点。单元格 / 列名默认只读，双击进入编辑，Esc 或失焦退出（DX OS 的编辑状态机）。
 * 最左侧是输入通道列：每个上游素材来源一列「输入 N」，表头可切换 逐行 / 全部 / 沿用（旧版 table-node.js 的通道模型）。
 * 列名旁的小标签是列用途（提示词 / 首帧 / 尾帧 / 参考图 / 时长 / 比例 / 镜头名 / 不使用）：默认按列名自动识别，点开可改。
 * 首帧 / 尾帧 / 参考图列的单元格放图：把图片文件拖进单元格，或把画布上的图片节点拖到单元格上。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { CHANNEL_MODES, CHANNEL_MODE_LABEL, channelItemsForRow, inputCellHeight, isMediaRef, mediaRefsIn, ROLE_META, ROLE_ORDER, rolesOf, rowHeight, tableChannels, tableOf, TABLE_CELL_PREVIEW_W, TABLE_INPUT_COL_W, TABLE_INPUT_MAX_SHOWN, TABLE_INPUT_PREVIEW_W, TABLE_LIMITS, withRole, withTable, guessRole, type ChannelMode, type ColRole, type TableData } from "../table";
import { storyboardPipeline } from "../tableFlow";
import { plainPrompt } from "../mentions";
import { MEDIA_UPLOAD_LIMIT } from "../actions";
import type { CanvasStore } from "../store";
import { openPop } from "./overlay";
import { useCtl, useS } from "./ctx";
import { Icon } from "./Icon";
import { PreviewImg } from "./thumb";

export function TableNodeBody({ node, sel, full = false }: { node: CanvasNode; sel: boolean; full?: boolean }) {
  const ctl = useCtl(); const store = ctl.store;
  const doc = useS((s) => s.doc); const editCell = useS((s) => s.ui.editCell);
  // 表格数据 / 通道每次渲染重算会拖慢长表（每个通道要展开分组、查节点），按文档和节点缓存
  const t = useMemo(() => tableOf(node), [node]);
  const channels = useMemo(() => tableChannels(doc, node.id), [doc, node.id]);
  const save = (fn: (t: TableData) => TableData, history = false) => store.updateNode(node.id, (n) => withTable(n, fn(tableOf(n))), { history });
  // 表头点一下循环 逐行 → 全部 → 沿用（每条通道各存一份，key = input-N）
  const cycleMode = (id: string, mode: ChannelMode) => save((x) => ({ ...x, inputModes: { ...(x.inputModes || {}), [id]: CHANNEL_MODES[(CHANNEL_MODES.indexOf(mode) + 1) % CHANNEL_MODES.length] } }), true);
  const key = (r: number | "h", c: number) => `${node.id}:${r}:${c}`;
  const startEdit = (k: string) => { store.snapshot(); store.setUI({ editCell: k, sel: new Set([node.id]) }); };
  const stopEdit = () => store.setUI({ editCell: null });
  const addRow = (at = t.rows.length) => { if (t.rows.length >= TABLE_LIMITS.rows) return store.toast("表格最多允许 5000 行。"); save((x) => ({ ...x, rows: [...x.rows.slice(0, at), x.columns.map(() => ""), ...x.rows.slice(at)] }), true); };
  const addCol = () => { if (t.columns.length >= TABLE_LIMITS.cols) return store.toast("表格最多允许 200 列。"); save((x) => ({ ...x, columns: [...x.columns, "字段 " + (x.columns.length + 1)], rows: x.rows.map((r) => [...r, ""]), ...(x.roles ? { roles: [...x.roles, ""] } : {}) }), true); };
  const delCol = (i: number) => { if (t.columns.length <= 1) return store.toast("至少保留一列"); save((x) => ({ ...x, columns: x.columns.filter((_, j) => j !== i), rows: x.rows.map((r) => r.filter((_, j) => j !== i)), ...(x.roles ? { roles: x.roles.filter((_, j) => j !== i) } : {}) }), true); };
  const delRow = (i: number) => save((x) => ({ ...x, rows: x.rows.filter((_, j) => j !== i) }), true);
  const roles = rolesOf(t);
  const setCell = (r: number, c: number, v: string, history = false) => save((x) => ({ ...x, rows: x.rows.map((rr, i) => (i === r ? rr.map((y, j) => (j === c ? (isMediaRef(v) ? v : v.slice(0, TABLE_LIMITS.cell)) : y)) : rr)) }), history);
  const hasFirst = roles.some((r) => r.role === "first");
  return (
    <>
      {full ? null : <div className="nhead"><Icon name="grid" size="xs" /><span className="t">{t.title}</span><span className="tnum" style={{ color: "var(--fg3)", fontSize: 11 }}>{t.rows.length} × {t.columns.length}{channels.length ? ` · ${channels.length} 个输入` : ""}</span></div>}
      <div className={full ? "td-table" : "nbody"} style={full ? undefined : { height: node.h }}>
        <div className="tnode">
          <div className="tgrid" onWheel={(e) => { if (sel || editCell) e.stopPropagation(); }}>
            <table style={{ width: channels.length * TABLE_INPUT_COL_W + t.columns.length * 132 + 30 }}>
              <colgroup>{channels.map((ch) => <col key={ch.id} style={{ width: TABLE_INPUT_COL_W }} />)}{t.columns.map((_, i) => <col key={i} style={{ width: 132 }} />)}<col style={{ width: 30 }} /></colgroup>
              <thead><tr>
                {/* 表头两行：上行「输入 N」+ 数量，下行模式按钮（112px 也放得下「逐行 / 全部 / 沿用」） */}
                {channels.map((ch, i) => <th className="tin" key={ch.id} title={`${ch.title}：${ch.items.length} 个素材`}><div className="h">
                  <div className="tin-top"><span className="tin-label">输入 {i + 1}</span><small className="tin-count">{ch.items.length}</small></div>
                  <button className="tmode" title={MODE_HINT[ch.mode]} data-channel={ch.id} data-mode={ch.mode} onPointerDown={(e) => { e.stopPropagation(); cycleMode(ch.id, ch.mode); }}>{CHANNEL_MODE_LABEL[ch.mode]}<Icon name="down" size="xs" /></button>
                </div></th>)}
                {t.columns.map((c, i) => <th key={i}><div className="h">
                  <Cell tag="input" cellKey={key("h", i)} value={c} editing={editCell === key("h", i)} onStart={() => startEdit(key("h", i))} onStop={stopEdit} onChange={(v) => save((x) => ({ ...x, columns: x.columns.map((y, j) => (j === i ? v.slice(0, 120) : y)) }))} />
                  <button className={"trole" + (roles[i].auto ? " auto" : "") + (ROLE_META[roles[i].role].media ? " media" : "")} data-role={roles[i].role} title={`列用途：${ROLE_META[roles[i].role].label}${roles[i].auto ? "（按列名自动识别）" : ""}。${ROLE_META[roles[i].role].hint}`} onPointerDown={(e) => { e.stopPropagation(); roleMenu(e.currentTarget, c, roles[i], (r) => save((x) => withRole(x, i, r), true)); }}>{ROLE_META[roles[i].role].label}</button>
                  <button className="xcol" title="删除列" onPointerDown={(e) => { e.stopPropagation(); delCol(i); }}><Icon name="x" size="xs" /></button>
                </div></th>)}
                <th className="tact" />
              </tr></thead>
              <tbody>
                {t.rows.map((row, r) => {
                  // 该行每条通道取到的素材；这一行最多有几张决定行高（有几张显示几张，超过 9 张才折叠）
                  const rowItems = channels.map((ch) => channelItemsForRow(ch, r));
                  const mostItems = rowItems.reduce((n, items) => Math.max(n, items.length), 0);
                  return <tr key={r} style={{ height: Math.max(rowHeight(row, channels.length > 0), inputCellHeight(mostItems)) }}>
                    {channels.map((ch, ci) => {
                      const items = rowItems[ci]; const shown = items.slice(0, TABLE_INPUT_MAX_SHOWN); const more = items.length - shown.length;
                      return <td className="tin" key={ch.id}><div className="mcell">
                        {shown.length ? <>{shown.map((m, i) => <MediaThumb key={m.nodeId + ":" + i} src={m.src} url={m.url} kind={m.kind} title={m.title} width={TABLE_INPUT_PREVIEW_W} />)}{more > 0 ? <em>+{more}</em> : null}</> : <em>—</em>}
                      </div></td>;
                    })}
                    {row.map((v, c) => ROLE_META[roles[c].role].media && editCell !== key(r, c) && (!v.trim() || isMediaRef(v))
                      ? <td key={c} className="tmc"><MediaCell store={store} cellId={`${node.id}:${r}:${c}`} value={v} multi={roles[c].role === "ref"} label={ROLE_META[roles[c].role].label} onEdit={() => startEdit(key(r, c))} onSet={(nv) => setCell(r, c, nv, true)} /></td>
                      : <td key={c}>{/* 只读态把 @{节点id} 显示成 @标题；编辑态留着原始记号，写回文档的仍是 @{id} */}<Cell tag="textarea" cellKey={key(r, c)} value={editCell === key(r, c) ? v : plainPrompt(v, doc)} editing={editCell === key(r, c)} onStart={() => startEdit(key(r, c))} onStop={stopEdit} onChange={(nv) => setCell(r, c, nv)} maxH={full ? CELL_MAX.full : CELL_MAX.node} /></td>)}
                    <td className="tact"><button title="删除这一行" onPointerDown={(e) => { e.stopPropagation(); delRow(r); }}><Icon name="trash" size="xs" /></button></td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
          <div className="tfoot">
            <button onPointerDown={(e) => { e.stopPropagation(); addRow(); }}><Icon name="plus" size="xs" />行</button>
            <button onPointerDown={(e) => { e.stopPropagation(); addCol(); }}><Icon name="plus" size="xs" />列</button>
            <button title={hasFirst ? "接出「首帧图」和「分镜视频」两个节点：先逐行出首帧并填回表格，再逐行出视频" : "补上首帧 / 尾帧两列，并接出「首帧图」和「分镜视频」两个节点"} data-act="storyboard-flow" onPointerDown={(e) => { e.stopPropagation(); storyboardPipeline(store, node.id); }}><Icon name="video" size="xs" />分镜出片</button>
            <span className="sp" />
            {full ? null : <button data-act="table-full" title="全屏编辑" onPointerDown={(e) => e.stopPropagation()} onClick={() => window.dispatchEvent(new CustomEvent("cn:tabledoc", { detail: node.id }))}><Icon name="expand" size="xs" />全屏编辑</button>}
            <span className="meta">双击单元格编辑</span>
          </div>
        </div>
      </div>
      {full ? null : <div className="rz" data-rz title="拖动调整大小" />}
    </>
  );
}

export function TableDocLayer() {
  const ctl = useCtl(); const store = ctl.store;
  const [id, setId] = useState<string | null>(null); const [closing, setClosing] = useState(false);
  useEffect(() => { const on = (e: Event) => { setClosing(false); setId(String((e as CustomEvent).detail || "") || null); }; addEventListener("cn:tabledoc", on); return () => removeEventListener("cn:tabledoc", on); }, []);
  const close = () => { if (closing) return; setClosing(true); setTimeout(() => { setId(null); setClosing(false); store.setUI({ editCell: null }); }, 140); };
  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => { if (e.key !== "Escape") return; e.preventDefault(); e.stopPropagation(); close(); };
    document.addEventListener("keydown", onKey, true); return () => document.removeEventListener("keydown", onKey, true);
  });
  const n = useS((s) => id ? s.doc.nodes.find((x) => x.id === id) : undefined);
  if (!n || n.kind !== "table") return null;
  const title = tableOf(n).title;
  return <div className="textdoc" data-tabledoc style={closing ? { animation: "fadeOut 140ms var(--e-exit) forwards" } : undefined} onPointerDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) close(); }} onWheel={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
    <div className="td-panel" role="dialog" aria-label={title + " · 全屏编辑"} onPointerDown={(e) => e.stopPropagation()}>
      <div className="td-top"><button className="td-back" aria-label="返回" data-tip="返回画布" onClick={close}><Icon name="left" /></button><span className="td-title">{title}</span></div>
      <TableNodeBody node={n} sel full />
    </div>
  </div>;
}

/** 单元格文字上限：节点视图 ~240（再高整表就不好看了），全屏编辑 480；超过就在格内滚动，绝不裁半行 */
const CELL_MAX = { node: 240, full: 480 };

function Cell({ tag, value, editing, onStart, onStop, onChange, cellKey, maxH = CELL_MAX.node }: { tag: "input" | "textarea"; value: string; editing: boolean; onStart: () => void; onStop: () => void; onChange: (v: string) => void; cellKey?: string; maxH?: number }) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => { if (editing) ref.current?.focus({ preventScroll: true }); }, [editing]);
  // 以前是写死 rows={2} + CSS overflow:hidden：行高涨了字也不涨，第 3 行起被裁掉。
  // 这里按内容量 scrollHeight 设高度（编辑态随输入实时变），超过上限才切成格内滚动。
  useLayoutEffect(() => {
    const el = ref.current; if (!el || tag !== "textarea") return;
    const cs = getComputedStyle(el);
    const lineH = parseFloat(cs.lineHeight) || 18;
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    el.style.height = "auto";
    const want = el.scrollHeight;
    // 触到上限时把可视高度收成「整行」：否则最后一行只露出半行，正是这次要修的观感问题
    const cap = Math.max(lineH + padY, Math.floor((maxH - padY) / lineH) * lineH + padY);
    const next = Math.min(want, cap);
    el.style.height = next + "px";
    el.style.overflowY = want > next + 1 ? "auto" : "hidden";
  }, [value, editing, maxH, tag]);
  const common = {
    ref, value, readOnly: !editing, "data-cell": cellKey,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
    onDoubleClick: (e: React.MouseEvent) => { e.stopPropagation(); onStart(); },
    onPointerDown: (e: React.PointerEvent) => { if (editing) e.stopPropagation(); },
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => { if (editing && (e.relatedTarget as HTMLElement | null)?.dataset.cell !== cellKey) onStop(); },
    onKeyDown: (e: React.KeyboardEvent) => { e.stopPropagation(); if (e.key === "Escape" || (tag === "input" && e.key === "Enter")) (e.target as HTMLElement).blur(); },
  };
  return tag === "input" ? <input {...common} /> : <textarea {...common} rows={2} cols={1} />;
}

/** 视频缩略图的播放角标（纯装饰，不吃指针事件） */
const PLAY_BADGE = { position: "absolute", right: 2, bottom: 2, width: 14, height: 14, borderRadius: 4, display: "grid", placeItems: "center", background: "rgba(0,0,0,.55)", color: "#fff", pointerEvents: "none" } as const;
/**
 * 表格缩略图：一律 <img> 走 /api/media-preview（视频由后端抽帧当封面），绝不在表格里挂 video 元素；
 * 音频只显示图标、不发请求。preview 打不开回落原地址，都打不开交给 onError（上层显示占位 / 文字）。
 */
function MediaThumb({ src, url, kind, title, width, onError }: { src: string; url?: string; kind: string; title: string; width: number; onError?: () => void }) {
  const target = kind === "video" ? url || src : src || url || "";
  if (kind === "audio" || !target) return <span className="mi-ph" title={title}><Icon name={kind === "audio" ? "audio" : kind === "video" ? "video" : "image"} size="s" /></span>;
  return <span className="mthumb" style={{ position: "relative", display: "block" }}>
    <PreviewImg src={target} width={width} title={title} onFail={onError} />
    {kind === "video" ? <span style={PLAY_BADGE} title="视频"><Icon name="play" size="xs" /></span> : null}
  </span>;
}

/* ---------- 列用途 / 输入列方式 ---------- */
function roleMenu(anchor: Element, name: string, cur: { role: ColRole; auto: boolean }, onPick: (r: ColRole | "") => void) {
  const guess = guessRole(name);
  openPop(anchor, (close) => <>
    <div className="mh">「{name}」这一列用来</div>
    <button className={"mi" + (cur.auto ? " on" : "")} onClick={() => { close(); onPick(""); }}><span>自动识别<span className="d">按列名：{ROLE_META[guess].label}</span></span></button>
    {ROLE_ORDER.map((r) => <button key={r} className={"mi" + (!cur.auto && cur.role === r ? " on" : "")} data-role={r} onClick={() => { close(); onPick(r); }}><span>{ROLE_META[r].label}<span className="d">{ROLE_META[r].hint}</span></span></button>)}
  </>);
}
/** 每条通道的模式说明（点表头循环 逐行 → 全部 → 沿用） */
const MODE_HINT: Record<ChannelMode, string> = {
  sequence: "逐行：第 N 行取这条通道的第 N 个素材，超出为空（点一下切「全部」）",
  all: "全部：每一行都带上整条通道的素材（点一下切「沿用」）",
  shared: "沿用：按行取，超出后沿用最后一个素材（点一下切「逐行」）",
};

/* ---------- 图片单元格 ---------- */
const readFile = (f: File) => new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result)); fr.onerror = () => r(""); fr.readAsDataURL(f); });
function MediaCell({ store, cellId, value, multi, label, onEdit, onSet }: { store: CanvasStore; cellId: string; value: string; multi: boolean; label: string; onEdit: () => void; onSet: (v: string) => void }) {
  const refs = mediaRefsIn(value);
  // 地址打不开（模型瞎编的 /assets 路径）时不显示裂图：这一格回落成文字，双击照旧进编辑
  const [broken, setBroken] = useState<string[]>([]);
  const lost = new Set(broken);
  const markBroken = (u: string) => setBroken((prev) => (prev.includes(u) ? prev : [...prev, u]));
  const drop = async (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); (e.currentTarget as HTMLElement).classList.remove("over");
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/")).slice(0, multi ? 8 : 1);
    if (!files.length) { store.toast(`${label}列只放图片`); return; }
    const urls: string[] = [];
    for (const f of files) { if (f.size > MEDIA_UPLOAD_LIMIT) { store.toast(`${f.name} 超过 200MB，未添加`); continue; } const d = await readFile(f); if (d) urls.push(await store.backend.importAsset(store.state.canvasId, d, f.name)); }
    if (urls.length) onSet((multi ? [...refs, ...urls].slice(0, 8) : urls.slice(0, 1)).join("\n"));
  };
  if (refs.length && refs.every((u) => lost.has(u))) return <div className="mcell" data-mcell={cellId} title={value}
    onDoubleClick={(e) => { e.stopPropagation(); onEdit(); }}>
    <em>{value}</em>
  </div>;
  return <div className={"mcell" + (refs.length ? "" : " empty")} data-mcell={cellId} data-multi={multi ? "1" : undefined}
    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); (e.currentTarget as HTMLElement).classList.add("over"); }}
    onDragLeave={(e) => (e.currentTarget as HTMLElement).classList.remove("over")}
    onDrop={(e) => void drop(e)}
    onDoubleClick={(e) => { e.stopPropagation(); onEdit(); }}>
    {refs.length ? refs.slice(0, 4).map((u, i) => lost.has(u) ? null : <span key={i} className="mthumb"><MediaThumb src={u} kind="image" title={label} width={TABLE_CELL_PREVIEW_W} onError={() => markBroken(u)} /><button title="移除这张图" onPointerDown={(e) => { e.stopPropagation(); onSet(refs.filter((_, j) => j !== i).join("\n")); }}><Icon name="x" size="xs" /></button></span>)
      : <em>拖入图片</em>}
  </div>;
}
