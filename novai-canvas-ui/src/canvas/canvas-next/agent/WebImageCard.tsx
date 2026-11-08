/**
 * 参考图选择卡（Image Studio 版式）：把 search_images / find_similar_images 的 items 铺成方图网格。
 * 默认只铺一排 4 张，超过 4 张折叠在「展开全部 (N)」里；
 * 单击 = 选中/取消（延迟 200ms 判定，双击不会改变选中），双击 = 放大预览（原图优先，失败才退回缩略图并标注）。
 * 预览列表只用 thumb_url / 原图回退链，落地画布仍只用 original_url。
 * 整卡不套外框（落在消息背景上），只有空 / 失败 / 联网关闭用软底提示块。
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import type { Ctl } from "../ui/ctx";
import { Spinner } from "@/components/hexta/spinner";
import { importWebImages, insertWebImages, thumbProxyUrl, type ImportedWebImage, type WebImageCardData, type WebImageItem } from "./webImages";
import { StudioGrid, StudioLightbox, StudioTile, type StudioLightboxItem } from "./ImageStudio";

const TITLE_TEXT = { search: "参考图", similar: "相似参考图" } as const;
/** 素材站来源中文名（契约 source_kind）；未知来源回退 source_site 域名 */
const SOURCE_NAMES: Record<string, string> = {
    huaban: "花瓣", zcool: "站酷", bing: "必应", "360": "360", nipic: "昵图", duitang: "堆糖", tuchong: "图虫",
    pinterest: "Pinterest", artstation: "ArtStation", bingglobal: "必应国际",
};
/** 别名收敛：后端 / 历史数据里同一个来源可能写成 web / global，不收敛的话筛选按 key 精确比会漏图 */
const SOURCE_ALIASES: Record<string, string> = { web: "bingglobal", global: "bingglobal", bing_global: "bingglobal", "bing-global": "bingglobal" };
const canonicalSource = (kind: string): string => SOURCE_ALIASES[kind] || kind;
const sourceName = (kind: string): string => SOURCE_NAMES[canonicalSource(kind)] || canonicalSource(kind);
/** 默认一排铺几张（卡片宽 ~380 时单张 ≤120px） */
const ROW = 4;
/** 单击要等一下：200ms 内再来一次就是双击（打开预览，不动选中状态） */
const CLICK_DELAY = 200;
/** 服务端代理的宽度：列表缩略图 / 列表退回原图 / 放大预览按原图 */
const THUMB_PROXY_W = 480;
const THUMB_PROXY_ORIGINAL_W = 720;
const VIEWER_PROXY_W = 1200;

/**
 * 缩略图回退链：thumb_url → 服务端代理 thumb(480) → 服务端代理 original(720) → 占位。
 * 花瓣/堆糖的 CDN 按 Referer 反爬，浏览器直连会拿到 HTML，代理由服务端不带 Referer 去拉。
 * 没有 thumb_url 时从原图开始（直连原图 → 代理原图），避免直接掉到占位。
 */
function thumbStepsOf(item: WebImageItem): string[] {
  const steps: string[] = [];
  const add = (value: string) => { const url = String(value || "").trim(); if (url && !steps.includes(url)) steps.push(url); };
  if (item.thumb_url) {
    add(item.thumb_url);
    add(thumbProxyUrl(item.thumb_url, THUMB_PROXY_W));
    add(thumbProxyUrl(item.original_url, THUMB_PROXY_ORIGINAL_W));
  } else {
    add(item.original_url);
    add(thumbProxyUrl(item.original_url, THUMB_PROXY_ORIGINAL_W));
  }
  return steps;
}

/** 放大预览回退链：original_url → 服务端代理 original(1200) → thumb_url → 占位 */
function viewerStepsOf(item: WebImageItem): string[] {
  const steps: string[] = [];
  const add = (value: string) => { const url = String(value || "").trim(); if (url && !steps.includes(url)) steps.push(url); };
  add(item.original_url);
  add(thumbProxyUrl(item.original_url, VIEWER_PROXY_W));
  add(item.thumb_url);
  return steps;
}

function domainOf(item: WebImageItem): string {
  if (item.source_site) return item.source_site;
  if (item.source_page) {
    try { return new URL(item.source_page).hostname; } catch { /* 不是合法 URL 时按未知来源显示 */ }
  }
  return "";
}

/** 单张图的来源标注：优先 source_kind 的中文名，回退 source_site 域名，再回退出处页域名 */
function sourceLabelOf(item: WebImageItem): string {
  // 只出中文名 / 域名，不把 source_kind 的英文 key 直接摆给用户看
  const name = SOURCE_NAMES[canonicalSource(item.source_kind || "")];
  return name || domainOf(item);
}

/** 来源筛选选项：数量以服务端 sources 为准，items 里出现但 sources 没给的来源也补上（数量按实际条目数） */
function sourceOptions(items: WebImageItem[], sources: Record<string, number>): Array<{ kind: string; label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.source_kind) continue;
    const kind = canonicalSource(item.source_kind);
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  for (const [kind, count] of Object.entries(sources)) counts.set(canonicalSource(kind), count);
  return [...counts.entries()].map(([kind, count]) => ({ kind, label: sourceName(kind), count }));
}

function sizeOf(item: WebImageItem): string {
  return item.width && item.height ? item.width + "×" + item.height : "尺寸未知";
}

function Header({ kind, meta }: { kind: WebImageCardData["kind"]; meta: string }) {
  return <div className="studio-batch-hd">
    <div className="studio-batch-hd-main">
      <b className="studio-batch-title">{TITLE_TEXT[kind]}</b>
      <span className="studio-batch-meta">{meta}</span>
    </div>
  </div>;
}

export function WebImageCard({ card, ctl }: { card: WebImageCardData; ctl: Ctl }) {
  const store = ctl.store;
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<Set<string>>(() => new Set());
  const [requestError, setRequestError] = useState("");
  const [expanded, setExpanded] = useState(false);
  /** 来源筛选：null = 全部；只影响显示，不动已选集合 */
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  /** 每张缩略图当前走到回退链的第几步（0 起；越过链尾 = 占位） */
  const [thumbStep, setThumbStep] = useState<Record<string, number>>({});
  /** 放大预览：当前索引 + 每张原图的回退链步数与加载状态 */
  const [viewer, setViewer] = useState<{ index: number } | null>(null);
  const [viewerStep, setViewerStep] = useState<Record<string, number>>({});
  const [viewerLoaded, setViewerLoaded] = useState<Record<string, boolean>>({});
  const clickTimer = useRef<number | null>(null);

  const clearClick = () => { if (clickTimer.current) { window.clearTimeout(clickTimer.current); clickTimer.current = null; } };
  useEffect(() => clearClick, []);

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  /** 单击选中：双击的第二下会在这里被吞掉（清掉计时器直接返回，不改选中） */
  const tapSelect = (id: string) => {
    if (clickTimer.current) { clearClick(); return; }
    clickTimer.current = window.setTimeout(() => { clickTimer.current = null; toggle(id); }, CLICK_DELAY);
  };
  const openViewer = (index: number) => { clearClick(); setViewer({ index }); };

  const options = sourceOptions(card.items, card.sources);
  // 筛选也按收敛后的 key 比：source_kind=web 的图在「必应国际」chip 下也要出来
  const filtered = sourceFilter ? card.items.filter((item) => canonicalSource(item.source_kind || "") === sourceFilter) : card.items;
  const allOn = filtered.length > 0 && filtered.every((item) => picked.has(item.id));
  const toggleAll = () => setPicked((prev) => {
    const next = new Set(prev);
    if (allOn) filtered.forEach((item) => next.delete(item.id)); else filtered.forEach((item) => next.add(item.id));
    return next;
  });
  /** 折叠按「当前筛选后的数量」算；切换来源时重置回折叠态 */
  const visible = expanded ? filtered : filtered.slice(0, ROW);
  const chooseSource = (kind: string | null) => { setSourceFilter(kind); setExpanded(false); };
  const stepViewer = (dir: number) => setViewer((prev) => (prev && filtered.length ? { index: (prev.index + dir + filtered.length) % filtered.length } : prev));

  useEffect(() => {
    if (!viewer || viewer.index < filtered.length) return;
    setViewer(filtered.length ? { index: Math.min(viewer.index, filtered.length - 1) } : null);
  }, [filtered.length, viewer]);

  const add = async () => {
    const chosen = card.items.filter((item) => picked.has(item.id));
    if (!chosen.length || busy) return;
    setBusy(true); setRequestError("");
    try {
      const imported = await importWebImages(chosen.map((item) => ({ url: item.original_url, source_page: item.source_page })));
      const byUrl = new Map<string, ImportedWebImage>();
      imported.forEach((row) => { if (row.source_url) byUrl.set(row.source_url, row); });
      const positionOnly = imported.length === chosen.length && imported.every((row) => !row.source_url);
      const nextErrors: Record<string, string> = {};
      const okRows: Array<{ item: WebImageItem; row: ImportedWebImage }> = [];
      chosen.forEach((item, index) => {
        const row = byUrl.get(item.original_url) || (positionOnly ? imported[index] : undefined);
        if (!row) { nextErrors[item.id] = "导入接口没有返回这张图的结果"; return; }
        if (!row.ok || !row.url) { nextErrors[item.id] = row.error || "导入失败（服务端没有给出原因）"; return; }
        okRows.push({ item, row });
      });
      setRowErrors(nextErrors);
      const okIds = new Set(okRows.map((x) => x.item.id));
      const failedCount = Object.keys(nextErrors).length;
      if (!okRows.length) {
        store.toast("没有图片加入画布：" + (Object.values(nextErrors)[0] || "导入失败"), 6000);
        return;
      }
      insertWebImages(store, ctl.center(), okRows.map(({ item, row }) => ({
        url: row.url,
        title: item.title || domainOf(item) || "参考图",
        width: row.width || item.width,
        height: row.height || item.height,
      })));
      store.toast("已加入 " + okRows.length + " 张参考图" + (failedCount ? "，" + failedCount + " 张失败" : ""));
      setAdded((prev) => new Set([...prev, ...okIds]));
      setPicked(new Set(Object.keys(nextErrors)));
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "加入画布失败");
    } finally {
      setBusy(false);
    }
  };

  if (card.status === "web-off") return <div aria-label="参考图 · 联网未开启" className="webimg-card studio-batch" data-webimg="web-off">
    <Header kind={card.kind} meta="联网未开启" />
    <div className="studio-note"><b>联网未开启</b><p>在「设置 → 通用 → 画布助手联网」打开后，助手才能搜参考图。</p></div>
  </div>;

  if (card.status === "loading") return <div aria-label="参考图 · 正在搜索" className="webimg-card studio-batch" data-webimg="loading">
    <Header kind={card.kind} meta="正在搜索" />
    <StudioGrid>{(card.items.length ? card.items : [null, null, null, null]).slice(0, ROW).map((item, index) => <StudioTile key={item ? item.id : "ph" + index} loading />)}</StudioGrid>
    <div className="studio-phase" role="status"><Spinner aria-hidden size="sm" /><span>{card.kind === "similar" ? "正在识别图片并搜索相似参考图…" : "正在搜索参考图…"}</span></div>
  </div>;

  if (card.status === "failed") return <div aria-label="参考图 · 搜索失败" className="webimg-card studio-batch" data-webimg="failed">
    <Header kind={card.kind} meta="失败" />
    <div className="studio-note bad" role="alert"><b>搜图失败</b><p>{card.error || "搜图失败（服务端没有给出原因）"}</p></div>
    {card.kind === "similar" ? <p className="studio-batch-sum">可以换一张更清晰、主体更明确的图再试。</p> : null}
  </div>;

  const nothing = !card.items.length;
  const viewing = viewer ? filtered[viewer.index] : null;
  const sourceCounts = options.length > 1 ? options.map((option) => option.label + " " + option.count).join(" · ") : "";
  const meta = nothing ? "无结果" : [card.items.length + " 张", sourceCounts].filter(Boolean).join(" · ");

  const lightboxItems: StudioLightboxItem[] = filtered.map((item) => {
    const steps = viewerStepsOf(item);
    const step = viewerStep[item.id] || 0;
    const src = steps[step] || "";
    const loaded = Boolean(viewerLoaded[item.id]);
    return {
      id: item.id,
      label: item.title || "参考图",
      media: <div className="studio-lb-media">
        {!src
          ? <div className="studio-lb-broken"><Icon name="alert" size="s" /><span>原图和缩略图都没能显示</span></div>
          : <>
            {loaded ? null : <span className="studio-lb-skeleton" aria-hidden="true" />}
            <img
              alt={item.title || ""}
              draggable={false}
              referrerPolicy="no-referrer"
              src={src}
              onError={() => {
                setViewerStep((prev) => ({ ...prev, [item.id]: (prev[item.id] || 0) + 1 }));
                setViewerLoaded((prev) => ({ ...prev, [item.id]: false }));
              }}
              onLoad={() => setViewerLoaded((prev) => ({ ...prev, [item.id]: true }))}
            />
          </>}
      </div>,
      info: <>
        <div className="studio-lb-head">
          <b title={item.title || "未命名参考图"}>{item.title || "未命名参考图"}</b>
          <span className="studio-lb-state">{step > 0 && src === item.thumb_url ? "缩略图" : "原图"}</span>
        </div>
        <div className="studio-lb-meta" data-webimg-viewer-info>
          <span className="tnum">{sizeOf(item)}</span>
          <span>{sourceLabelOf(item) || "来源未知"}</span>
          {step > 0 && src === item.thumb_url ? <span className="studio-lb-note" role="status">原图加载失败，显示的是缩略图</span> : null}
          {rowErrors[item.id] ? <span className="studio-lb-note" role="status">{rowErrors[item.id]}</span> : null}
          {item.source_page ? <a href={item.source_page} rel="noreferrer" target="_blank">打开出处<Icon name="link" size="xs" /></a> : null}
        </div>
      </>,
    };
  });

  return <>
  <div aria-label="参考图选择" className="webimg-card studio-batch" data-webimg="ready">
    <Header kind={card.kind} meta={meta} />
    {card.description ? <p className="webimg-desc">{card.description}</p> : null}
    {card.queries.length ? <div className="studio-q webimg-q">{card.queries.slice(0, 5).map((q) => <span key={q}>{q}</span>)}</div> : null}
    {options.length > 1 ? <div aria-label="来源筛选" className="studio-chips webimg-srcchips" role="group">
      <span>来源</span>
      <button aria-pressed={sourceFilter === null} className={"studio-chip webimg-chip" + (sourceFilter === null ? " on" : "")} data-source="all" onClick={() => chooseSource(null)} type="button">全部 ({card.items.length})</button>
      {options.map((option) => <button aria-pressed={sourceFilter === option.kind} className={"studio-chip webimg-chip" + (sourceFilter === option.kind ? " on" : "")} data-source={option.kind} key={option.kind} onClick={() => chooseSource(option.kind)} type="button">{option.label} ({option.count})</button>)}
    </div> : null}
    {nothing
      ? <div className="studio-empty webimg-empty" data-webimg-empty>
        <Icon name="image" size="s" />
        <b>没有搜到参考图</b>
        <p>{card.note || (card.query ? "「" + card.query + "」没有搜到图（引擎返回空列表）" : "这次没有搜到图（引擎返回空列表）")}</p>
      </div>
      : filtered.length === 0
      ? <div className="studio-empty webimg-empty" data-webimg-empty-source>
        <Icon name="image" size="s" />
        <b>这个来源没有图片</b>
        <p>{sourceFilter ? "这个来源这次没搜到图片" : "这次没有搜到图（引擎返回空列表）"}</p>
      </div>
      : <StudioGrid>
        {visible.map((item) => {
          const on = picked.has(item.id);
          const error = rowErrors[item.id];
          const sourceLabel = sourceLabelOf(item);
          const steps = thumbStepsOf(item);
          const step = thumbStep[item.id] || 0;
          const src = steps[step] || "";
          return <StudioTile
            actions={[
              { icon: "eye", label: "查看大图", onClick: () => openViewer(filtered.indexOf(item)) },
              ...(item.source_page ? [{ icon: "link" as const, label: "打开出处", href: item.source_page }] : []),
            ]}
            activateLabel={(item.title || "参考图") + " " + sizeOf(item) + "（双击放大）"}
            added={added.has(item.id)}
            data={{ "data-source": item.source_kind || "", "data-webimg-item": item.id }}
            error={error}
            key={item.id}
            label={sourceLabel || "来源未知"}
            media={src
              ? <img
                alt={item.title || ""}
                draggable={false}
                loading="lazy"
                referrerPolicy="no-referrer"
                src={src}
                onError={() => {
                  // 直连失败（CDN 反爬返回 HTML）→ 服务端代理 thumb → 服务端代理原图 → 占位
                  setThumbStep((prev) => {
                    const current = prev[item.id] || 0;
                    return current + 1 < steps.length ? { ...prev, [item.id]: current + 1 } : { ...prev, [item.id]: steps.length };
                  });
                }}
              />
              : <span className="studio-tile-ph"><Icon name="image" size="s" /><em>{steps.length ? "预览加载失败" : "无预览图"}</em></span>}
            meta={sizeOf(item)}
            onActivate={() => tapSelect(item.id)}
            onDoubleClick={() => openViewer(filtered.indexOf(item))}
            pressed={on}
            selected={on}
          />;
        })}
      </StudioGrid>}
    {nothing ? null : <div className="webimg-bar">
      <span className="webimg-count tnum">已选 {picked.size}/{card.items.length}</span>
      <div className="webimg-bar-acts">
        <button className="studio-linkbtn webimg-linkbtn" onClick={toggleAll} type="button">{allOn ? "取消全选" : "全选"}</button>
        {filtered.length > ROW ? <button className="studio-linkbtn webimg-linkbtn" data-webimg-expand={expanded ? "collapse" : "expand"} onClick={() => setExpanded(!expanded)} type="button">{expanded ? "收起" : "展开全部 (" + filtered.length + ")"}</button> : null}
      </div>
      <span className="sp" />
      {added.size ? <span className="webimg-added">已加入 {added.size} 张</span> : null}
      <button className="studio-primary" data-webimg-add disabled={!picked.size || busy} onClick={() => void add()} type="button">
        {busy ? <><Spinner aria-hidden size="sm" />正在加入…</> : "加入画布 (" + picked.size + ")"}
      </button>
    </div>}
    {requestError ? <p className="studio-note-inline" role="alert">{requestError}</p> : null}
  </div>
  {viewing ? <StudioLightbox
    data={{ "data-webimg-viewer": "" }}
    index={viewer!.index}
    items={lightboxItems}
    label="查看参考图"
    onClose={() => setViewer(null)}
    onIndex={(next) => setViewer({ index: next })}
  /> : null}
  </>;
}
