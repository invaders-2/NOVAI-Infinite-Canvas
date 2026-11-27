/**
 * 多维表格节点。单元格 / 列名默认只读，双击进入编辑，Esc 或失焦退出（DX OS 的编辑状态机）。
 * 最左侧是输入通道列：每个上游素材来源一列「输入 N」，表头可切换 逐行 / 全部 / 沿用（旧版 table-node.js 的通道模型）。
 * 列名旁的小标签是列用途（提示词 / 首帧 / 尾帧 / 参考图 / 时长 / 比例 / 镜头名 / 不使用）：默认按列名自动识别，点开可改。
 * 首帧 / 尾帧 / 参考图列的单元格放图：把图片文件拖进单元格，或把画布上的图片节点拖到单元格上。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { CHANNEL_MODES, CHANNEL_MODE_LABEL, channelItemsForRow, clampSelection, csvFromTable, inputCellHeight, isMediaRef, mediaRefsIn, normalizeAiColumns, ROLE_META, ROLE_ORDER, rolesOf, rowHeight, tableChannels, tableFromCsv, tableInputWarnings, tableOf, TABLE_CELL_PREVIEW_W, TABLE_INPUT_COL_W, TABLE_INPUT_MAX_SHOWN, TABLE_INPUT_PREVIEW_W, TABLE_LIMITS, withRole, withTable, guessRole, activeViewOf, viewsOf, withViews, visibleCols, viewRows, FILTER_OPS, TABLE_VIEW_LIMIT, type ChannelMode, type ColRole, type TableData, type TableSelection, type TableView, type TableViewDef, type FilterOp } from "../table";
import { openAiColumnPanel, TABLE_AI_BUSY_TITLE, TableAiToolbar, installTableAiGlobals, useAiColumnRun, useTableBatchBusy } from "./TableAi";
import { tableLlmConfig } from "../tableLlm";
import { storyboardPipeline } from "../tableFlow";
import { reviewTable } from "../tableReview";
import { genOf } from "../model";
import { plainPrompt } from "../mentions";
import { MEDIA_UPLOAD_LIMIT, MULTIPART_UPLOAD_MIN, tooLargeText, uploadFailureText } from "../actions";
import type { CanvasStore } from "../store";
import { openModal, openPop } from "./overlay";
import { useCtl, useS } from "./ctx";
import { Icon } from "./Icon";
import { PreviewImg } from "./thumb";
import { colTypeOf, COL_TYPE_LABEL } from "../table";
import { CardWall, DetailDrawer, makeViewCtl, sourceVideoOf, ViewMenuButton, ViewTabs, ViewTools } from "./TableViews";

/** 解析中的进度：转圈 + 已用秒数（视频解析一般 1–3 分钟，给个盼头，不靠长时间挂着的 toast） */
/** 解析开始时间（按表节点记）：标题里的计时和节点里的四步进度用同一个起点，切视图 / 重渲不归零 */
const parseStarted = new Map<string, number>();
function useParseSeconds(id: string): number {
  if (!parseStarted.has(id)) parseStarted.set(id, Date.now());
  const t0 = parseStarted.get(id)!;
  const [sec, setSec] = useState(() => Math.floor((Date.now() - t0) / 1000));
  useEffect(() => { const tick = setInterval(() => setSec(Math.floor((Date.now() - t0) / 1000)), 500); return () => clearInterval(tick); }, [t0]);
  return sec;
}
function ParseStatus({ id }: { id: string }) {
  const sec = useParseSeconds(id);
  return <span className="st tnum" data-parse-status style={{ color: "var(--fg2)", fontSize: 11 }}>解析中 · {sec}s<span style={{ color: "var(--fg3)", marginLeft: 4 }}>约 1–3 分钟</span></span>;
}
/**
 * 解析中（原型 v3）：四步进度条（抽帧 → 切镜 → 识别镜头 → 写表）+ 两张骨架卡片。
 * 后端是一次请求，前两步按经验时长推进，「识别镜头」一直亮到结果回来；不给假百分比，当前步只做呼吸。
 */
const PARSE_STEPS = ["抽帧", "切镜", "识别镜头", "写表"];
function ParseProgress({ id }: { id: string }) {
  const sec = useParseSeconds(id);
  const cur = sec < 2 ? 0 : sec < 5 ? 1 : 2;
  return <div className="tparse" data-parse-progress>
    <div className="tp-steps">{PARSE_STEPS.map((s, i) => <div key={s} className={"tp-step" + (i < cur ? " done" : i === cur ? " cur" : "")}><span>{s}</span><span className="tp-bar"><i /></span></div>)}</div>
    <div className="tcards tp-skel" aria-hidden>{[0, 1].map((i) => <div className="tcard" key={i}><div className="tc-cover tp-shim" /><div className="tc-body"><span className="tp-fill" style={{ width: "80%" }} /><span className="tp-fill" style={{ width: "46%" }} /></div></div>)}</div>
  </div>;
}

export function TableNodeBody({ node, sel, full = false }: { node: CanvasNode; sel: boolean; full?: boolean }) {
  const ctl = useCtl(); const store = ctl.store;
  const doc = useS((s) => s.doc); const editCell = useS((s) => s.ui.editCell);
  // 表格数据 / 通道每次渲染重算会拖慢长表（每个通道要展开分组、查节点），按文档和节点缓存
  const t = useMemo(() => tableOf(node), [node]);
  const channels = useMemo(() => tableChannels(doc, node.id), [doc, node.id]);
  // 行文本里的「输入 N」对不上真实通道 / 表格上挂着旧通道：常驻显示，不靠一闪而过的 toast
  const warns = useMemo(() => tableInputWarnings(doc, node.id, channels), [doc, node.id, channels]);
  const save = (fn: (t: TableData) => TableData, history = false) => store.updateNode(node.id, (n) => withTable(n, fn(tableOf(n))), { history });
  // 表头点一下循环 逐行 → 全部 → 沿用（每条通道各存一份，key = input-N）；手点过的通道不再让出表覆盖。
  // 清空时也保留空数组：inputModesAuto 删字段 = 文档退回旧格式，下次出表会把手设模式当系统模式覆盖。
  const cycleMode = (id: string, mode: ChannelMode) => save((x) => {
    const next = CHANNEL_MODES[(CHANNEL_MODES.indexOf(mode) + 1) % CHANNEL_MODES.length];
    const auto = (x.inputModesAuto || []).filter((k) => k !== id);
    return { ...x, inputModes: { ...(x.inputModes || {}), [id]: next }, inputModesAuto: auto };
  }, true);
  // ── 智能（AI 列 / 选区批量改）：选区是界面态，不写文档；aiColumns / aiModel / aiSystem 写文档 ──
  const [cellSel, setCellSel] = useState<TableSelection | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const aiRun = useAiColumnRun(node.id);
  const batchBusy = useTableBatchBusy(store, node.id);
  useEffect(() => { installTableAiGlobals(store); }, [store]);
  // 删列 / 增删行之后把选区夹回表内；夹不出来就清掉
  useEffect(() => { setCellSel((cur) => (cur ? clampSelection(cur, t.rows.length, t.columns.length) : null)); }, [t.rows.length, t.columns.length]);
  // 点表格外 / Esc 清空选区；点弹层与提示条是它们自己的事，不丢选区
  useEffect(() => {
    if (!cellSel) return;
    const typing = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      const tag = String((el && el.tagName) || "").toUpperCase();
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || Boolean(el && el.isContentEditable);
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (rootRef.current && target && rootRef.current.contains(target)) return;
      if (target && typeof target.closest === "function" && target.closest("#modal, #pop, #toasts")) return;
      setCellSel(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key !== "Escape" || typing(e.target)) return; setCellSel(null); };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("keydown", onKey, true); };
  }, [cellSel]);
  /** 按下数据格 = 开始拖选矩形（Shift 从原选区左上角扩选）。不 preventDefault，双击进编辑照旧 */
  const cellDown = (e: React.PointerEvent, r: number, c: number) => {
    if (e.button !== 0) return;
    if (editCell === key(r, c)) return;
    e.stopPropagation();
    const anchor = e.shiftKey && cellSel ? { r: cellSel.r0, c: cellSel.c0 } : { r, c };
    setCellSel(clampSelection({ r0: anchor.r, c0: anchor.c, r1: r, c1: c }, t.rows.length, t.columns.length));
    // 拖选用 document 级监听（不抢指针捕获：否则双击进编辑会被截断）
    const move = (ev: PointerEvent) => {
      const grid = gridRef.current;
      if (grid) {
        const gb = grid.getBoundingClientRect();
        if (ev.clientY < gb.top + 24) grid.scrollTop = Math.max(0, grid.scrollTop - 20);
        else if (ev.clientY > gb.bottom - 24) grid.scrollTop = grid.scrollTop + 20;
      }
      const hit = (document.elementFromPoint(ev.clientX, ev.clientY) as Element | null);
      const td = hit && typeof hit.closest === "function" ? hit.closest("[data-r][data-c]") as HTMLElement | null : null;
      if (!td) return;
      const nr = Number(td.dataset.r), nc = Number(td.dataset.c);
      if (!Number.isInteger(nr) || !Number.isInteger(nc)) return;
      setCellSel(clampSelection({ r0: anchor.r, c0: anchor.c, r1: nr, c1: nc }, t.rows.length, t.columns.length));
    };
    const up = () => {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
  };
  const inSel = (r: number, c: number) => Boolean(cellSel) && r >= cellSel!.r0 && r <= cellSel!.r1 && c >= cellSel!.c0 && c <= cellSel!.c1;
  const failRow = (r: number, c: number) => Boolean(aiRun) && aiRun!.column === c && aiRun!.failed.some((item) => item.row === r + 1);
  const key = (r: number | "h", c: number) => `${node.id}:${r}:${c}`;
  const startEdit = (k: string) => { store.snapshot(); store.setUI({ editCell: k, sel: new Set([node.id]) }); };
  const stopEdit = () => store.setUI({ editCell: null });
  const addRow = (at = t.rows.length) => { if (t.rows.length >= TABLE_LIMITS.rows) return store.toast("表格最多允许 5000 行。"); save((x) => ({ ...x, rows: [...x.rows.slice(0, at), x.columns.map(() => ""), ...x.rows.slice(at)] }), true); };
  const addCol = () => { if (t.columns.length >= TABLE_LIMITS.cols) return store.toast("表格最多允许 200 列。"); save((x) => ({ ...x, columns: [...x.columns, "字段 " + (x.columns.length + 1)], rows: x.rows.map((r) => [...r, ""]), ...(x.roles ? { roles: [...x.roles, ""] } : {}), ...(x.types ? { types: [...x.types, ""] } : {}) }), true); };
  const delCol = (i: number) => {
    if (t.columns.length <= 1) return store.toast("至少保留一列");
    save((x) => {
      const nextColumns = x.columns.filter((_, j) => j !== i);
      const aiNext = normalizeAiColumns(x.aiColumns, x.columns.length).filter((_, j) => j !== i);
      return { ...x, columns: nextColumns, rows: x.rows.map((r) => r.filter((_, j) => j !== i)), ...(x.roles ? { roles: x.roles.filter((_, j) => j !== i) } : {}), ...(x.types ? { types: x.types.filter((_, j) => j !== i) } : {}), ...(aiNext.some(Boolean) ? { aiColumns: normalizeAiColumns(aiNext, nextColumns.length) } : { aiColumns: undefined }) };
    }, true);
  };
  const delRow = (i: number) => save((x) => ({ ...x, rows: x.rows.filter((_, j) => j !== i) }), true);
  // 复制为 CSV：只导数据列，「输入 N」通道列由画布连线推导，不属于表格数据
  const copyCsv = () => { void navigator.clipboard?.writeText(csvFromTable(tableOf(store.node(node.id) || node)))?.then(() => store.toast("已复制 CSV"), () => store.toast("剪贴板不可用，请用「全屏编辑」后手动复制")); };
  const importCsv = () => openModal((close) => <CsvImportDialog store={store} nodeId={node.id} close={close} />);
  // 表格审查：纯函数检查（不发请求）。下游模型只用来检查每行素材会不会超 maxRefs。
  const openReview = () => {
    const d = store.state.doc;
    const gen = d.edges.filter((e) => e.from === node.id).map((e) => store.node(e.to)).find((n) => !!n && (n.kind === "image" || n.kind === "video"));
    const m = gen ? store.modelOf(gen) : undefined;
    const rv = reviewTable(d, node.id, { maxRefs: m?.maxRefs, modelName: m?.name, genId: gen?.id });
    openModal((close) => <div className="tbl-review" data-review role="dialog" aria-label="表格审查">
      <div className="tr-head"><Icon name="fit" size="s" /><b>表格审查</b><span className="sp" /><button className="ib" aria-label="关闭" onClick={close}><Icon name="x" size="s" /></button></div>
      <div className="tr-sum">{rv.summary}</div>
      <div className="tr-stats">
        <span className="tr-stat">{rv.stats.rows} 行</span>
        <span className="tr-stat">{rv.stats.columns} 列</span>
        {rv.stats.channels.map((ch) => <span className="tr-stat" key={ch.id} data-channel-review={ch.id}>输入 {ch.index}「{ch.title}」{ch.count} 张 · {CHANNEL_MODE_LABEL[ch.mode]}</span>)}
        {m ? <span className="tr-stat" data-review-model>下游：{m.name} · {m.i2i ? `参考图上限 ${m.maxRefs ?? 0} 张` : "不支持参考图"}</span> : null}
      </div>
      {rv.findings.length
        ? <div className="tr-list">{rv.findings.map((f) => <div className={"tr-item " + f.level} data-level={f.level} key={f.level + f.text}><span className="dot" /><span>{f.text}</span></div>)}</div>
        : <div className="tr-ok">未发现明显问题</div>}
      <div className="tr-foot"><button className="btn" onClick={close}>关闭</button></div>
    </div>, "table-review-modal");
  };
  // 顶部浮条（#ntb）只派事件，动作必须在这里做：CsvImportDialog / csvFromTable 都在本组件里。
  // 全屏编辑时同一节点会再挂一份 body，靠 full 挡住，免得弹两层导入框。
  useEffect(() => {
    if (full) return;
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as { id?: string; action?: string } | undefined;
      if (!d || d.id !== node.id) return;
      if (d.action === "copy") copyCsv();
      else if (d.action === "import") importCsv();
    };
    addEventListener("cn:tablecsv", on);
    return () => removeEventListener("cn:tablecsv", on);
  });
  const roles = rolesOf(t);
  const setCell = (r: number, c: number, v: string, history = false) => save((x) => ({ ...x, rows: x.rows.map((rr, i) => (i === r ? rr.map((y, j) => (j === c ? (isMediaRef(v) ? v : v.slice(0, TABLE_LIMITS.cell)) : y)) : rr)) }), history);
  const hasFirst = roles.some((r) => r.role === "first");
  // 视频「解析」正在给这张表出分镜：纯界面态（同文本节点的 ui.parsing），标题旁显示转圈和已用时间
  const parsing = useS((s) => s.ui.parsing.has(node.id));
  // 解析结果落表的那一下：卡片 / 行从下方 8px 依次淡入、首帧由模糊变清晰（原型 v3），2.4s 后撤掉动效类
  const wasParsing = useRef(parsing); const [reveal, setReveal] = useState(false);
  useEffect(() => {
    if (wasParsing.current && !parsing) { parseStarted.delete(node.id); setReveal(true); const t = setTimeout(() => setReveal(false), 2400); wasParsing.current = parsing; return () => clearTimeout(t); }
    wasParsing.current = parsing; return undefined;
  }, [parsing, node.id]);
  // ── 视图：当前视图决定显示哪些列、哪些行、怎么排序分组；编辑始终写回原始行号 ──
  const views = viewsOf(t); const view = activeViewOf(t);
  const cols = visibleCols(t, view);
  const groups = viewRows(t, view);
  const shown = groups.reduce((n, g) => n + g.rows.length, 0);
  const viewCtl = makeViewCtl(store, node.id, t);
  // 镜头详情抽屉（只在全屏里）：记原始行号；筛选 / 排序后的顺序用来上下切
  const [detail, setDetail] = useState<number | null>(null);
  const order = groups.flatMap((g) => g.rows);
  useEffect(() => { if (detail !== null && detail >= t.rows.length) setDetail(null); }, [detail, t.rows.length]);
  return (
    <>
      {full ? null : <div className="nhead"><span className="nhead-in">{parsing ? <i className="runsig" role="status" aria-label="解析中" /> : <Icon name="grid" size="xs" />}<span className="t">{t.title}</span>{parsing ? <ParseStatus id={node.id} /> : <span className="tnum" style={{ color: "var(--fg3)", fontSize: 11 }}>{t.rows.length} × {t.columns.length}{channels.length ? ` · ${channels.length} 个输入` : ""}</span>}<ViewMenuButton ctl={viewCtl} /></span></div>}
      <div className={full ? "td-table" : "nbody"} style={full ? undefined : { height: node.h }} ref={rootRef}>
        <div className="tnode">
          {full ? <div className="tv-bar"><ViewTabs ctl={viewCtl} /><ViewTools ctl={viewCtl} shown={shown} total={t.rows.length} hint={view.type === "card" ? "点卡片看详情" : "点行尾 ⤢ 看详情 · ↑↓ 切换镜头"} /></div> : null}
          {parsing && !full ? <ParseProgress id={node.id} /> : null}
          {parsing && !full ? null : view.type === "card" ? <CardWall reveal={reveal} t={t} roles={roles} cols={cols} groups={groups} groupCol={view.group} sel={sel} full={full} active={detail} onRow={setDetail} onOpenFull={() => window.dispatchEvent(new CustomEvent("cn:tabledoc", { detail: node.id }))} /> : null}
          <div className={"tgrid" + (reveal ? " reveal" : "")} ref={gridRef} hidden={view.type === "card" || (parsing && !full)} onWheel={(e) => { if (sel || editCell) e.stopPropagation(); }}>
            <table style={{ width: channels.length * TABLE_INPUT_COL_W + cols.length * 132 + 30 }}>
              <colgroup>{channels.map((ch) => <col key={ch.id} style={{ width: TABLE_INPUT_COL_W }} />)}{cols.map((i) => <col key={i} style={{ width: 132 }} />)}<col style={{ width: 30 }} /></colgroup>
              <thead><tr>
                {/* 表头两行：上行「输入 N」+ 数量，下行模式按钮（112px 也放得下「逐行 / 全部 / 沿用」） */}
                {channels.map((ch, i) => <th className="tin" key={ch.id} title={`${ch.title}：${ch.items.length} 个素材`}><div className="h">
                  <div className="tin-top"><span className="tin-label">输入 {i + 1}</span><small className="tin-count">{ch.items.length}</small></div>
                  <button className="tmode" title={MODE_HINT[ch.mode]} data-channel={ch.id} data-mode={ch.mode} onPointerDown={(e) => { e.stopPropagation(); cycleMode(ch.id, ch.mode); }}>{CHANNEL_MODE_LABEL[ch.mode]}<Icon name="down" size="xs" /></button>
                </div></th>)}
                {cols.map((i) => { const c = t.columns[i]; return <th key={i} title={c || "列名"} className={cellSel && i >= cellSel.c0 && i <= cellSel.c1 ? "is-sel-col" : undefined}><div className="h">
                  <Cell tag="input" cellKey={key("h", i)} value={c} editing={editCell === key("h", i)} onStart={() => startEdit(key("h", i))} onStop={stopEdit} onChange={(v) => save((x) => ({ ...x, columns: x.columns.map((y, j) => (j === i ? v.slice(0, 120) : y)) }))} />
                  {/* 列用途 / 删除放第二行：132px 列宽下标题才有整行宽度，不再只露出「画面提」 */}
                  <div className="hmeta">
                    <button className={"trole" + (roles[i].auto ? " auto" : "") + (ROLE_META[roles[i].role].media ? " media" : "")} data-role={roles[i].role} title={`列用途：${ROLE_META[roles[i].role].label}${roles[i].auto ? "（按列名自动识别）" : ""}。${ROLE_META[roles[i].role].hint}`} onPointerDown={(e) => { e.stopPropagation(); roleMenu(e.currentTarget, c, roles[i], (r) => save((x) => withRole(x, i, r), true)); }}>{ROLE_META[roles[i].role].label}</button>
                    {(() => { const ty = colTypeOf(t, i); return ty === "single" || ty === "multi" || ty === "number" ? <span className="ttype" data-coltype={ty}>{COL_TYPE_LABEL[ty]}</span> : null; })()}
                    {(() => {
                      // 智能列入口：批量生成在跑 / 没配好模型时禁用并写明原因（不静默禁用）
                      const aiMeta = normalizeAiColumns(t.aiColumns, t.columns.length)[i];
                      const ready = tableLlmConfig(t, store.modelsOf("text"));
                      const title = batchBusy ? TABLE_AI_BUSY_TITLE : !ready.ok ? ready.reason : aiMeta ? "智能列：" + aiMeta.instruction : "设为智能列（按这一列的指令批量生成）";
                      return <button type="button" className={"tai-col" + (aiMeta ? " on" : "")} data-ai-col={i} disabled={batchBusy || !ready.ok} title={title}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); openAiColumnPanel(store, node.id, i); }}>AI</button>;
                    })()}
                    <button className="xcol" title="删除列" onPointerDown={(e) => { e.stopPropagation(); delCol(i); }}><Icon name="x" size="xs" /></button>
                  </div>
                </div></th>; })}
                <th className="tact" />
              </tr></thead>
              <tbody>
                {t.rows.length === 0 ? <tr className="tempty">
                  <td colSpan={channels.length + t.columns.length + 1}>
                    <span className="te-hint"><Icon name="grid" size="s" />还没有行，点下面「+ 行」添加；也可以从上游素材生成</span>
                    <button className="te-add" onPointerDown={(e) => { e.stopPropagation(); addRow(); }}><Icon name="plus" size="xs" />添加一行</button>
                  </td>
                </tr> : null}
                {t.rows.length > 0 && shown === 0 ? <tr className="tempty"><td colSpan={channels.length + cols.length + 1}><span className="te-hint"><Icon name="search" size="s" />没有符合筛选条件的行</span></td></tr> : null}
                {groups.map((g) => [
                  g.key !== null ? <tr className="tgroup" key={"g:" + g.key}><td colSpan={channels.length + cols.length + 1}><span className="tg-k">{view.group}</span><span className="tg-v">{g.key || "（空）"}</span><em className="tnum">{g.rows.length}</em></td></tr> : null,
                  ...g.rows.map((r) => { const row = t.rows[r];
                  // 该行每条通道取到的素材；这一行最多有几张决定行高（有几张显示几张，超过 9 张才折叠）
                  const rowItems = channels.map((ch) => channelItemsForRow(ch, r));
                  const mostItems = rowItems.reduce((n, items) => Math.max(n, items.length), 0);
                  return <tr key={r} style={{ height: Math.max(rowHeight(row, channels.length > 0), inputCellHeight(mostItems)), ["--i" as string]: r }}>
                    {channels.map((ch, ci) => {
                      const items = rowItems[ci]; const shown = items.slice(0, TABLE_INPUT_MAX_SHOWN); const more = items.length - shown.length;
                      return <td className="tin" key={ch.id}><div className="mcell">
                        {shown.length ? <>{shown.map((m, i) => <MediaThumb key={m.nodeId + ":" + i} src={m.src} url={m.url} kind={m.kind} title={m.title} width={TABLE_INPUT_PREVIEW_W} />)}{more > 0 ? <em>+{more}</em> : null}</> : <em>—</em>}
                      </div></td>;
                    })}
                    {cols.map((c) => { const v = row[c] ?? "";
                      // 数据格：拖选矩形 / Shift 扩选靠 data-r + data-c；图片格也参与选区，但不参与改写
                      const asMedia = ROLE_META[roles[c].role].media && editCell !== key(r, c) && (!v.trim() || isMediaRef(v));
                      const cls = [asMedia ? "tmc" : "", inSel(r, c) ? "is-sel" : "", failRow(r, c) ? "is-ai-fail" : ""].filter(Boolean).join(" ");
                      return <td key={c} className={cls || undefined} data-r={r} data-c={c} onPointerDown={(e) => cellDown(e, r, c)}>
                        {asMedia
                          ? <MediaCell store={store} cellId={`${node.id}:${r}:${c}`} value={v} multi={roles[c].role === "ref"} label={ROLE_META[roles[c].role].label} onEdit={() => startEdit(key(r, c))} onSet={(nv) => setCell(r, c, nv, true)} />
                          : <Cell tag="textarea" cellKey={key(r, c)} value={editCell === key(r, c) ? v : plainPrompt(v, doc)} editing={editCell === key(r, c)} onStart={() => startEdit(key(r, c))} onStop={stopEdit} onChange={(nv) => setCell(r, c, nv)} maxH={full ? CELL_MAX.full : CELL_MAX.node} />}
                      </td>;
                    })}
                    <td className="tact">{full ? <button title="看详情" data-act="open-row" onPointerDown={(e) => { e.stopPropagation(); setDetail(r); }}><Icon name="expand" size="xs" /></button> : null}<button title="删除这一行" onPointerDown={(e) => { e.stopPropagation(); delRow(r); }}><Icon name="trash" size="xs" /></button></td>
                  </tr>;
                })])}
              </tbody>
            </table>
          </div>
          {cellSel ? <TableAiToolbar store={store} nodeId={node.id} table={t} sel={cellSel} rootRef={rootRef} gridRef={gridRef} busy={batchBusy} onClear={() => setCellSel(null)} /> : null}
          {warns.length ? <div className="trefwarn" data-warn="table-input">
            {warns.map((w) => <div className="tw" key={w}><Icon name="alert" size="xs" /><span>{w}</span></div>)}
          </div> : null}
          <div className="tfoot" style={{ flexWrap: "wrap", rowGap: 4 }}>
            <button onPointerDown={(e) => { e.stopPropagation(); addRow(); }}><Icon name="plus" size="xs" />行</button>
            <button onPointerDown={(e) => { e.stopPropagation(); addCol(); }}><Icon name="plus" size="xs" />列</button>
            {/* 复制 / 导入在节点上是顶部浮条的事；全屏页里浮条被弹层盖住，这里留一份入口 */}
            {full ? <>
              <button data-act="table-csv-copy" title="把整张表（不含输入通道列）复制成 CSV，第一行是列名" style={{ whiteSpace: "nowrap" }} onPointerDown={(e) => e.stopPropagation()} onClick={copyCsv}><Icon name="copy" size="xs" />复制 CSV</button>
              <button data-act="table-csv-import" title="粘贴 CSV / TSV 替换整张表（保留标题、输入通道模式和列用途）" style={{ whiteSpace: "nowrap" }} onPointerDown={(e) => e.stopPropagation()} onClick={importCsv}><Icon name="upload" size="xs" />导入 CSV</button>
            </> : null}
            {/* 动作按卡片规范放右侧：「+行/+列」留在左侧作工具，分镜出片 / 审查靠右 */}
            <span className="sp" />
            {full ? null : <span className="meta">{view.type === "card" ? "双击卡片全屏查看" : "双击单元格编辑"}</span>}
            <button title={hasFirst ? "接出「首帧图」和「分镜视频」两个节点：先逐行出首帧并填回表格，再逐行出视频" : "补上首帧 / 尾帧两列，并接出「首帧图」和「分镜视频」两个节点"} data-act="storyboard-flow" onPointerDown={(e) => { e.stopPropagation(); storyboardPipeline(store, node.id); }}><Icon name="video" size="xs" />分镜出片</button>
            <button data-act="table-review" title="审查这张表：通道 / 模式 / 行数 / 输入编号 / 空行 / 下游模型参考图上限 / 批量失败行（只读检查，不发请求）" onPointerDown={(e) => e.stopPropagation()} onClick={openReview}><Icon name="fit" size="xs" />审查</button>
          </div>
        </div>
      </div>
      {full && detail !== null ? <DetailDrawer ctl={ctl} nodeId={node.id} row={detail} order={order} onMove={setDetail} onClose={() => setDetail(null)} /> : null}
      {full ? null : <div className="rz" data-rz title="拖动调整大小" />}
    </>
  );
}

export function TableDocLayer() {
  const ctl = useCtl(); const store = ctl.store;
  const [id, setId] = useState<string | null>(null); const [closing, setClosing] = useState(false);
  useEffect(() => { const on = (e: Event) => { setClosing(false); setId(String((e as CustomEvent).detail || "") || null); }; addEventListener("cn:tabledoc", on); return () => removeEventListener("cn:tabledoc", on); }, []);
  useEffect(() => { const on = () => { setId(null); store.setUI({ editCell: null }); }; addEventListener("cn:tabledoc-close", on); return () => removeEventListener("cn:tabledoc-close", on); }, [store]);
  const close = () => { if (closing) return; setClosing(true); setTimeout(() => { setId(null); setClosing(false); store.setUI({ editCell: null }); }, 140); };
  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => { if (e.key !== "Escape") return; e.preventDefault(); e.stopPropagation(); close(); };
    document.addEventListener("keydown", onKey, true); return () => document.removeEventListener("keydown", onKey, true);
  });
  const n = useS((s) => id ? s.doc.nodes.find((x) => x.id === id) : undefined);
  if (!n || n.kind !== "table") return null;
  const td = tableOf(n); const title = td.title;
  const src = sourceVideoOf(store, n.id);
  const meta = [`${td.rows.length} ${td.columns.includes("首帧") ? "个镜头" : "行"}`, src ? `来自 ${genOf(src).title || "视频"}` : ""].filter(Boolean).join(" · ");
  return <div className="textdoc wide" data-tabledoc style={closing ? { animation: "fadeOut 140ms var(--e-exit) forwards" } : undefined} onPointerDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) close(); }} onWheel={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
    <div className="td-panel" role="dialog" aria-label={title + " · 全屏编辑"} onPointerDown={(e) => e.stopPropagation()}>
      <div className="td-top"><button className="td-back" aria-label="返回" data-tip="返回画布" onClick={close}><Icon name="left" /></button><span className="td-title"><b>{title}</b><span className="tnum">{meta}</span></span><span className="sp" />
        <button className="btn" data-act="storyboard-flow-top" onClick={() => { close(); storyboardPipeline(store, n.id); }}><Icon name="video" size="xs" />分镜出片</button></div>
      <TableNodeBody node={n} sel full />
    </div>
  </div>;
}

/**
 * 导入 CSV 弹层：粘贴文本 → 按 RFC4180 解析（逗号 / 制表符都认）→ 替换整张表。
 * 界面只负责取文本和报错，解析 / 截断 / 保留标题与通道模式都在 table.ts 的 tableFromCsv 里。
 */
function CsvImportDialog({ store, nodeId, close }: { store: CanvasStore; nodeId: string; close: () => void }) {
  const [text, setText] = useState(""); const [err, setErr] = useState("");
  const run = () => {
    const n = store.node(nodeId); if (!n) { close(); return; }
    const res = tableFromCsv(text, tableOf(n));
    if (!res) { setErr("没有解析出任何列：请确认第一行是列名，逗号或制表符分隔"); return; }
    store.updateNode(nodeId, (x) => withTable(x, res.table), { history: true });
    close();
    const cut = [res.droppedRows ? `截掉 ${res.droppedRows} 行` : "", res.droppedCols ? `截掉 ${res.droppedCols} 列` : ""].filter(Boolean).join("、");
    store.toast(`已导入 ${res.table.rows.length} 行 × ${res.table.columns.length} 列` + (cut ? `（超过表格上限，${cut}）` : ""));
  };
  return <div className="folder-dialog">
    <div className="fd-head"><b>导入 CSV</b><button className="ib" aria-label="关闭" onClick={close}><Icon name="x" size="s" /></button></div>
    <textarea autoFocus value={text} data-csv-input aria-label="CSV 内容"
      placeholder={"第一行是列名，其余是数据行；逗号或制表符分隔都行。\n\n镜头,画面\n1,雨夜街头，霓虹倒影"}
      style={{ minHeight: 180, resize: "vertical", border: 0, borderRadius: 9, background: "var(--sunken)", color: "var(--fg)", padding: 10, font: "12px/1.6 var(--mono)", outline: "none" }}
      onChange={(e) => { setText(e.target.value); setErr(""); }} onKeyDown={(e) => e.stopPropagation()} />
    <p>导入会替换整张表：保留标题、输入通道模式和按列位置对应的列用途；超过 {TABLE_LIMITS.rows} 行 / {TABLE_LIMITS.cols} 列会自动截断。</p>
    {err ? <div className="fd-err">{err}</div> : null}
    <div className="fd-foot"><button className="btn" onClick={close}>取消</button><button className="btn solid" onClick={run}>导入</button></div>
  </div>;
}

/** 单元格文字上限：节点视图 ~240（再高整表就不好看了），全屏编辑 480；超过就在格内滚动，绝不裁半行 */
const CELL_MAX = { node: 240, full: 480 };

function Cell({ tag, value, editing, onStart, onStop, onChange, cellKey, maxH = CELL_MAX.node }: { tag: "input" | "textarea"; value: string; editing: boolean; onStart: () => void; onStop: () => void; onChange: (v: string) => void; cellKey?: string; maxH?: number }) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => { if (editing) ref.current?.focus({ preventScroll: true }); }, [editing]);
  // 以前是写死 rows={2} + CSS overflow:hidden：行高涨了字也不涨，第 3 行起被裁掉。
  // 这里按内容量 scrollHeight 设高度（编辑态随输入实时变），超过上限才切成格内滚动。
  const measure = useCallback(() => {
    const el = ref.current; if (!el || tag !== "textarea") return;
    const cs = getComputedStyle(el);
    const lineH = parseFloat(cs.lineHeight) || 18;
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const wasHidden = el.style.overflowY;
    el.style.height = "auto";
    const want = el.scrollHeight;
    // 触到上限时把可视高度收成「整行」：否则最后一行只露出半行
    const cap = Math.max(lineH + padY, Math.floor((maxH - padY) / lineH) * lineH + padY);
    const next = Math.min(want, cap);
    el.style.height = next + "px";
    el.style.overflowY = want > next + 1 ? "auto" : "hidden";
    void wasHidden;
  }, [maxH, tag]);
  useLayoutEffect(() => { measure(); }, [measure, value, editing]);
  // 宽度变化（760→420 这类拖窄）会改变换行数：只读态靠 scrollHeight 量的高度必须重算，否则末尾字被裁掉
  useEffect(() => {
    const el = ref.current; if (!el || tag !== "textarea") return;
    const host = el.parentElement;
    if (!host || typeof ResizeObserver === "undefined") return;
    let lastWidth = host.clientWidth;
    const ro = new ResizeObserver(() => {
      const width = host.clientWidth;
      if (width === lastWidth) return;
      lastWidth = width;
      measure();
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [measure, tag]);
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
    for (const f of files) {
      if (f.size > MEDIA_UPLOAD_LIMIT) { store.toast(tooLargeText(f), 7000); continue; }
      try {
        // >8MB 走 multipart 原始字节：整段 base64 会让几十 MB 的图片全进内存
        if (f.size > MULTIPART_UPLOAD_MIN && typeof store.backend.importAssetFile === "function") { urls.push(await store.backend.importAssetFile!(store.state.canvasId, f, f.name)); continue; }
        const d = await readFile(f); if (d) urls.push(await store.backend.importAsset(store.state.canvasId, d, f.name));
      } catch (error) {
        store.toast(uploadFailureText(f, error), 9000);
      }
    }
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
