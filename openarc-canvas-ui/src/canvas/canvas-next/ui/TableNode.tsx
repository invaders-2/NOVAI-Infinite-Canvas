/**
 * 多维表格节点。单元格 / 列名默认只读，双击进入编辑，Esc 或失焦退出（DX OS 的编辑状态机）。
 * 最左侧「输入」列显示连进表格的素材：1 个素材时每行共用，多个时逐行对应，也可以切成「两张一组 = 首帧 + 尾帧」。
 * 列名旁的小标签是列用途（提示词 / 首帧 / 尾帧 / 参考图 / 时长 / 比例 / 镜头名 / 不使用）：默认按列名自动识别，点开可改。
 * 首帧 / 尾帧 / 参考图列的单元格放图：把图片文件拖进单元格，或把画布上的图片节点拖到单元格上。
 */
import { useEffect, useRef, useState } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { INPUT_MODE_LABEL, inputModeOf, isMediaRef, mediaForRow, mediaRefsIn, ROLE_META, ROLE_ORDER, rolesOf, rowHeight, tableMedia, tableOf, TABLE_LIMITS, withRole, withTable, guessRole, type ColRole, type InputMode, type TableData } from "../table";
import { storyboardPipeline } from "../tableFlow";
import { MEDIA_UPLOAD_LIMIT } from "../actions";
import type { CanvasStore } from "../store";
import { openPop } from "./overlay";
import { useCtl, useS } from "./ctx";
import { Icon } from "./Icon";
import { useThumbnailUrl } from "./useThumbnail";
import { useMediaUrl } from "./useMedia";

export function TableNodeBody({ node, sel, full = false }: { node: CanvasNode; sel: boolean; full?: boolean }) {
  const ctl = useCtl(); const store = ctl.store;
  const doc = useS((s) => s.doc); const editCell = useS((s) => s.ui.editCell);
  const t = tableOf(node); const media = tableMedia(doc, node.id); const mode = inputModeOf(t, media);
  const save = (fn: (t: TableData) => TableData, history = false) => store.updateNode(node.id, (n) => withTable(n, fn(tableOf(n))), { history });
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
      {full ? null : <div className="nhead"><Icon name="grid" size="xs" /><span className="t">{t.title}</span><span className="tnum" style={{ color: "var(--fg3)", fontSize: 11 }}>{t.rows.length} × {t.columns.length}{media.length ? ` · ${media.length} 个输入` : ""}</span></div>}
      <div className={full ? "td-table" : "nbody"} style={full ? undefined : { height: node.h }}>
        <div className="tnode">
          <div className="tgrid" onWheel={(e) => { if (sel || editCell) e.stopPropagation(); }}>
            <table style={{ width: (media.length ? 96 : 0) + t.columns.length * 132 + 30 }}>
              <colgroup>{media.length ? <col style={{ width: 96 }} /> : null}{t.columns.map((_, i) => <col key={i} style={{ width: 132 }} />)}<col style={{ width: 30 }} /></colgroup>
              <thead><tr>
                {media.length ? <th className="tin"><div className="h"><button className="tmode" title="输入列怎么分到每一行" onPointerDown={(e) => { e.stopPropagation(); modeMenu(e.currentTarget, mode, (m) => save((x) => ({ ...x, inputMode: m }), true)); }}>输入 · {INPUT_MODE_LABEL[mode]}<Icon name="down" size="xs" /></button></div></th> : null}
                {t.columns.map((c, i) => <th key={i}><div className="h">
                  <Cell tag="input" cellKey={key("h", i)} value={c} editing={editCell === key("h", i)} onStart={() => startEdit(key("h", i))} onStop={stopEdit} onChange={(v) => save((x) => ({ ...x, columns: x.columns.map((y, j) => (j === i ? v.slice(0, 120) : y)) }))} />
                  <button className={"trole" + (roles[i].auto ? " auto" : "") + (ROLE_META[roles[i].role].media ? " media" : "")} data-role={roles[i].role} title={`列用途：${ROLE_META[roles[i].role].label}${roles[i].auto ? "（按列名自动识别）" : ""}。${ROLE_META[roles[i].role].hint}`} onPointerDown={(e) => { e.stopPropagation(); roleMenu(e.currentTarget, c, roles[i], (r) => save((x) => withRole(x, i, r), true)); }}>{ROLE_META[roles[i].role].label}</button>
                  <button className="xcol" title="删除列" onPointerDown={(e) => { e.stopPropagation(); delCol(i); }}><Icon name="x" size="xs" /></button>
                </div></th>)}
                <th className="tact" />
              </tr></thead>
              <tbody>
                {t.rows.map((row, r) => {
                  const rm = mediaForRow(t, media, r);
                  return <tr key={r} style={{ height: rowHeight(row, media.length > 0) }}>
                    {media.length ? <td className="tin"><div className="mcell">{rm.length ? rm.slice(0, 4).map((m) => <MediaThumb key={m.nodeId} src={m.src} url={m.url} kind={m.kind} title={m.title} />) : <em>—</em>}</div></td> : null}
                    {row.map((v, c) => ROLE_META[roles[c].role].media && editCell !== key(r, c) && (!v.trim() || isMediaRef(v))
                      ? <td key={c} className="tmc"><MediaCell store={store} cellId={`${node.id}:${r}:${c}`} value={v} multi={roles[c].role === "ref"} label={ROLE_META[roles[c].role].label} onEdit={() => startEdit(key(r, c))} onSet={(nv) => setCell(r, c, nv, true)} /></td>
                      : <td key={c}><Cell tag="textarea" cellKey={key(r, c)} value={v} editing={editCell === key(r, c)} onStart={() => startEdit(key(r, c))} onStop={stopEdit} onChange={(nv) => setCell(r, c, nv)} /></td>)}
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

function Cell({ tag, value, editing, onStart, onStop, onChange, cellKey }: { tag: "input" | "textarea"; value: string; editing: boolean; onStart: () => void; onStop: () => void; onChange: (v: string) => void; cellKey?: string }) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => { if (editing) ref.current?.focus({ preventScroll: true }); }, [editing]);
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

function MediaThumb({ src, url, kind, title }: { src: string; url?: string; kind: string; title: string }) {
  const preview = useThumbnailUrl(src || (kind === "image" ? url || "" : ""));
  const media = useMediaUrl(kind === "video" ? url || "" : "");
  if (media.url) return <video src={media.url} poster={preview || undefined} muted preload="metadata" title={title} onError={media.onError} />;
  return preview ? <img src={preview} alt="" title={title} draggable={false} /> : <span className="mi-ph" title={title}><Icon name={kind === "video" ? "video" : kind === "audio" ? "audio" : "image"} size="s" /></span>;
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
function modeMenu(anchor: Element, cur: InputMode, onPick: (m: InputMode | "auto") => void) {
  const items: Array<[InputMode, string]> = [["shared", "每一行都用全部输入素材"], ["sequence", "第 1 个素材给第 1 行，第 2 个给第 2 行…"], ["pair", "两张一组：第 1、2 张是第 1 行的首帧和尾帧，第 3、4 张给第 2 行…"]];
  openPop(anchor, (close) => <>
    <div className="mh">输入素材怎么分到每一行</div>
    <button className="mi" onClick={() => { close(); onPick("auto"); }}><span>自动<span className="d">1 个素材共用，多个逐行</span></span></button>
    {items.map(([m, d]) => <button key={m} className={"mi" + (cur === m ? " on" : "")} data-mode={m} onClick={() => { close(); onPick(m); }}><span>{INPUT_MODE_LABEL[m]}<span className="d">{d}</span></span></button>)}
  </>);
}

/* ---------- 图片单元格 ---------- */
const readFile = (f: File) => new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result)); fr.onerror = () => r(""); fr.readAsDataURL(f); });
function MediaCell({ store, cellId, value, multi, label, onEdit, onSet }: { store: CanvasStore; cellId: string; value: string; multi: boolean; label: string; onEdit: () => void; onSet: (v: string) => void }) {
  const refs = mediaRefsIn(value);
  const drop = async (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); (e.currentTarget as HTMLElement).classList.remove("over");
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/")).slice(0, multi ? 8 : 1);
    if (!files.length) { store.toast(`${label}列只放图片`); return; }
    const urls: string[] = [];
    for (const f of files) { if (f.size > MEDIA_UPLOAD_LIMIT) { store.toast(`${f.name} 超过 200MB，未添加`); continue; } const d = await readFile(f); if (d) urls.push(await store.backend.importAsset(store.state.canvasId, d, f.name)); }
    if (urls.length) onSet((multi ? [...refs, ...urls].slice(0, 8) : urls.slice(0, 1)).join("\n"));
  };
  return <div className={"mcell" + (refs.length ? "" : " empty")} data-mcell={cellId} data-multi={multi ? "1" : undefined}
    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); (e.currentTarget as HTMLElement).classList.add("over"); }}
    onDragLeave={(e) => (e.currentTarget as HTMLElement).classList.remove("over")}
    onDrop={(e) => void drop(e)}
    onDoubleClick={(e) => { e.stopPropagation(); onEdit(); }}>
    {refs.length ? refs.slice(0, 4).map((u, i) => <span key={i} className="mthumb"><MediaThumb src={u} kind="image" title={label} /><button title="移除这张图" onPointerDown={(e) => { e.stopPropagation(); onSet(refs.filter((_, j) => j !== i).join("\n")); }}><Icon name="x" size="xs" /></button></span>)
      : <em>拖入图片</em>}
  </div>;
}
