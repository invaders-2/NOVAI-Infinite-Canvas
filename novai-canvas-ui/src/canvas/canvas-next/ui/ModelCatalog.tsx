/**
 * 节点编辑器模型下拉里的「全部可用模型」：两块来源，都只往本机清单里加，不写「设置 → API」的模型清单。
 *   · 上游目录：GET /api/providers/{id}/fetch-models —— 这个中转站真实有的模型（名字 + 分类，没有参数）
 *   · 内置可用：GET /api/model-caps?include_builtin=1 里 builtin:true 的条目 —— 后端能力表里有定义、
 *     但用户没登记进 provider 的模型；带权威参数（分辨率 / 比例 / 时长），加入后主下拉拿到的就是这套参数
 * 加过的模型在这一段底部「已加入 · 点一下移除」，移除后回到设置里那一份；
 * 返回键回到该供应商的模型列表，保持「供应商 → 模型」两级弹层的老路径。
 */
import { useEffect, useState, type ReactNode } from "react";
import { addExtraModel, readExtraModels, removeExtraModel, type ExtraModelPick } from "../modelExtras";
import { videoDurationTagLabel, type GenKind, type ModelSpec } from "../model";
import { ComboMenu } from "./combo";
import { Icon } from "./Icon";
import { openPop } from "./overlay";

type Row = Record<string, unknown>;
type PickKind = ExtraModelPick["kind"];
type CatalogRow = { type: "add" | "remove"; name: string; kind: PickKind; summary?: string };
type Tab = "catalog" | PickKind;
type State = { status: "loading" } | { status: "ready"; names: string[] } | { status: "error"; message: string };
/** 内置模型：名字 + 能力表里的参数摘要 */
type BuiltinRow = { name: string; kind: PickKind; summary: string };
type BuiltinState = { status: "loading" } | { status: "ready"; rows: BuiltinRow[] } | { status: "error" };

/** 上游目录是按平台拉的：5 分钟内重复打开不再打一次网络（失败不缓存，重试就是真的重试） */
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; data: Row }>();
const KIND_FIELD: Partial<Record<GenKind, string>> = { image: "image_models", video: "video_models" };

async function fetchCatalog(providerId: string): Promise<Row> {
  const hit = cache.get(providerId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const response = await fetch("/api/providers/" + encodeURIComponent(providerId) + "/fetch-models", { headers: { Accept: "application/json" } });
  const data = await response.json().catch(() => ({} as Row));
  if (!response.ok) throw new Error(String((data as { detail?: unknown }).detail || "拉取失败（" + response.status + "）"));
  cache.set(providerId, { at: Date.now(), data });
  return data;
}

function namesOf(data: Row, kind: GenKind): string[] {
  const field = KIND_FIELD[kind];
  const list = field ? data[field] : undefined;
  return Array.isArray(list) ? list.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
}

/** 后端能力表里「有定义、没登记」的模型：include_builtin=1 时才有，默认接口不会下发 */
let builtinCache: { at: number; items: Row[] } | null = null;
async function fetchBuiltin(): Promise<Row[]> {
  if (builtinCache && Date.now() - builtinCache.at < CACHE_MS) return builtinCache.items;
  const response = await fetch("/api/model-caps?include_builtin=1", { headers: { Accept: "application/json" } });
  const data = await response.json().catch(() => ({} as Row));
  if (!response.ok) throw new Error("读取内置模型失败（" + response.status + "）");
  const items = Array.isArray(data.items) ? data.items as Row[] : [];
  builtinCache = { at: Date.now(), items };
  return items;
}

const text = (value: unknown) => String(value ?? "").trim();
const numList = (value: unknown) => (Array.isArray(value) ? value.map(Number).filter((n) => Number.isFinite(n)) : []);
const strList = (value: unknown) => (Array.isArray(value) ? value.map(text).filter(Boolean) : []);

/** 参数摘要：分辨率 / 比例 / 时长都来自 caps，只做展示，不在这里补猜 */
function capsSummary(row: Row, kind: PickKind): string {
  const resolutions = [...strList(row.resolutions), ...strList(row.sizes)];
  const ratios = strList(row.ratios);
  const durations = numList(row.durations);
  const parts: string[] = [];
  if (resolutions.length) parts.push([...new Set(resolutions)].join(" · "));
  if (kind === "video" && durations.length) parts.push(videoDurationTagLabel(durations));
  if (ratios.length) parts.push(ratios.length + " 个比例");
  return parts.join(" · ");
}

export type ModelCatalogPick = { type: "add" | "remove"; provider: string; model: string; kind: PickKind };

export type ModelCatalogOpts = {
  anchor: Element;
  providerId: string;
  providerName: string;
  kind: GenKind;
  /** 当前下拉里已有的模型：用来去重，避免同一条模型出现两次 */
  models: ModelSpec[];
  /** 加入 / 移除之后回调；重拉列表、落到节点参数由调用方做 */
  onPick: (pick: ModelCatalogPick) => void;
  /** 返回该供应商的模型列表 */
  onBack: () => void;
};

export function openModelCatalog(o: ModelCatalogOpts) {
  openPop(o.anchor, (close) => <CatalogMenu
    providerId={o.providerId}
    providerName={o.providerName}
    kind={o.kind}
    models={o.models}
    onBack={() => { close(); o.onBack(); }}
    onPick={(pick) => { close(); o.onPick(pick); }}
  />, "up", "left", "model-pop combo-pop");
}

function CatalogMenu({ providerId, providerName, kind, models, onPick, onBack }: Omit<ModelCatalogOpts, "anchor">) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [builtin, setBuiltin] = useState<BuiltinState>({ status: "loading" });
  const [tab, setTab] = useState<Tab>("catalog");

  const load = () => {
    if (!KIND_FIELD[kind]) { setState({ status: "ready", names: [] }); return; }
    setState({ status: "loading" });
    let alive = true;
    fetchCatalog(providerId)
      .then((data) => { if (alive) setState({ status: "ready", names: namesOf(data, kind) }); })
      .catch((error) => { if (alive) setState({ status: "error", message: error instanceof Error ? error.message : "拉取模型失败" }); });
  };
  // 内置模型和上游目录一起取：tab 上要显示条数，接口没上线时这一块整体隐藏（不影响上游目录）
  const loadBuiltin = () => {
    let alive = true;
    setBuiltin({ status: "loading" });
    fetchBuiltin()
      .then((items) => {
        if (!alive) return;
        const rows: BuiltinRow[] = [];
        for (const item of items) {
          if (item.builtin !== true) continue;
          const itemKind = text(item.kind) as PickKind;
          if (itemKind !== "image" && itemKind !== "video") continue;
          const provider = text(item.provider);
          if (provider && provider.toLowerCase() !== providerId.toLowerCase()) continue;
          const name = text(item.model);
          if (!name || rows.some((x) => x.kind === itemKind && x.name.toLowerCase() === name.toLowerCase())) continue;
          rows.push({ name, kind: itemKind, summary: capsSummary(item, itemKind) });
        }
        setBuiltin({ status: "ready", rows });
      })
      .catch(() => { if (alive) setBuiltin({ status: "error" }); });
  };
  useEffect(load, [providerId, kind]);
  useEffect(loadBuiltin, [providerId]);

  const listed = new Set(models.filter((model) => String(model.id).startsWith(providerId + "::")).map((model) => model.name.toLowerCase()));
  const extras = readExtraModels().filter((pick) => pick.provider.toLowerCase() === providerId.toLowerCase());
  const builtinRows = builtin.status === "ready" ? builtin.rows : [];
  const activeKind: PickKind = tab === "catalog" ? (kind as PickKind) : tab;

  const rows: CatalogRow[] = [];
  if (tab === "catalog") {
    if (state.status === "ready") for (const name of state.names) if (!listed.has(name.toLowerCase())) rows.push({ type: "add", name, kind: activeKind });
  } else {
    for (const row of builtinRows) if (row.kind === activeKind) rows.push({ type: "add", name: row.name, kind: row.kind, summary: row.summary });
  }
  for (const pick of extras) if (pick.kind === activeKind) rows.push({ type: "remove", name: pick.model, kind: pick.kind });

  const pick = (row: CatalogRow) => {
    const entry: ExtraModelPick = { provider: providerId, kind: row.kind, model: row.name };
    if (row.type === "remove") { removeExtraModel(entry); onPick({ type: "remove", provider: providerId, model: row.name, kind: row.kind }); return; }
    addExtraModel(entry);
    onPick({ type: "add", provider: providerId, model: row.name, kind: row.kind });
  };

  const empty: ReactNode = tab !== "catalog"
    ? (builtin.status === "loading"
      ? <span>正在读取后端内置模型…</span>
      : builtin.status === "error"
        ? <span>后端还没有 /api/model-caps?include_builtin=1，暂时读不到内置模型</span>
        : rows.length
          ? <span>没有匹配的内置模型</span>
          : <span>这个平台还没有「内置但没登记」的{activeKind === "image" ? "图像" : "视频"}模型</span>)
    : state.status === "loading"
      ? <span>正在从 {providerName} 拉取模型…</span>
      : state.status === "error"
        ? <span>{state.message}</span>
        : <span>上游目录里没有可加的模型：都已经在清单里了</span>;

  const countOf = (kindOf: PickKind) => builtin.status === "ready" ? builtin.rows.filter((row) => row.kind === kindOf).length : 0;
  const tabButton = (value: Tab, label: ReactNode) => <button
    data-catalog-tab={value}
    className={tab === value ? "on" : ""}
    aria-pressed={tab === value}
    onClick={() => setTab(value)}
  >{label}</button>;

  return <ComboMenu
    autoFocus
    searchable
    empty={empty}
    resetKey={tab}
    header={<>
      <button className="mi" data-catalog-back aria-label="返回模型列表" onClick={onBack}><Icon name="left" size="s" /><span style={{ flex: 1 }}>{providerName} · 全部可用模型<span className="d">返回模型列表</span></span></button>
      {builtin.status === "ready" && builtin.rows.length ? <div className="seg" data-catalog-tabs>
        {tabButton("catalog", "上游目录")}
        {tabButton("image", "内置图像 " + countOf("image"))}
        {tabButton("video", "内置视频 " + countOf("video"))}
      </div> : null}
      <div className="msep" />
    </>}
    footer={state.status === "error" && tab === "catalog" ? <button className="mi" data-catalog-retry onClick={load}><Icon name="download" size="s" />重试</button> : undefined}
    itemAttrs={(row) => ({ "data-catalog": row.type, "data-model": row.name, "data-kind": row.kind })}
    itemClassName={(row) => "mi combo-item" + (row.type === "remove" ? " on" : "")}
    items={rows}
    label={(row) => row.name}
    onPick={pick}
    renderItem={(row) => row.type === "remove"
      ? <><Icon name="check" size="s" /><span style={{ flex: 1 }}>{row.name}<span className="d">已在这台设备的可选清单里 · 点一下移除</span></span><span className="tag">清单外</span></>
      : tab === "catalog"
        ? <><Icon name="plus" size="s" /><span style={{ flex: 1 }}>{row.name}<span className="d">加入可选清单（不改设置里的模型）</span></span></>
        : <><Icon name="plus" size="s" /><span style={{ flex: 1 }}>{row.name}<span className="tag">内置</span><span className="d">{row.summary || "后端能力表里有参数"}</span></span></>}
    searchPlaceholder={tab === "catalog" ? "搜索上游模型" : "搜索内置模型"}
  />;
}
