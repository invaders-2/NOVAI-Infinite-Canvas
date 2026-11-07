/**
 * 参考图选择卡：把 search_images / find_similar_images 的 items 渲染成方图网格。
 * 默认只铺一排 3 张（紧凑），超过 3 张折叠在「展开全部 (N)」里；
 * 单击 = 选中/取消（延迟 200ms 判定，双击不会改变选中），双击 = 放大预览（原图优先，失败才退回缩略图并标注）。
 * 预览列表只用 thumb_url，落地画布只用 original_url（导入接口换成 /assets/uploads/... 本地地址）。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../ui/Icon";
import type { Ctl } from "../ui/ctx";
import { Alert, AlertDescription, AlertTitle } from "@/components/hexta/alert";
import { AspectRatio } from "@/components/hexta/aspect-ratio";
import { Attachment, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentTitle, AttachmentTrigger } from "@/components/hexta/attachment";
import { Badge } from "@/components/hexta/badge";
import { Button } from "@/components/hexta/button";
import { ButtonGroup } from "@/components/hexta/button-group";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/hexta/card";
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@/components/hexta/carousel";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/hexta/empty";
import { Skeleton } from "@/components/hexta/skeleton";
import { Spinner } from "@/components/hexta/spinner";
import { importWebImages, insertWebImages, thumbProxyUrl, type ImportedWebImage, type WebImageCardData, type WebImageItem } from "./webImages";

const TITLE_TEXT = { search: "参考图", similar: "相似参考图" } as const;
/** 素材站来源中文名（契约 source_kind）；未知来源回退 source_site 域名 */
const SOURCE_NAMES: Record<string, string> = { huaban: "花瓣", zcool: "站酷", bing: "必应", "360": "360", nipic: "昵图", duitang: "堆糖", tuchong: "图虫" };
const sourceName = (kind: string): string => SOURCE_NAMES[kind] || kind;
/** 默认一排铺几张（卡片宽 ~380 时单张 ≤120px） */
const ROW = 3;
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
  if (item.source_kind && SOURCE_NAMES[item.source_kind]) return SOURCE_NAMES[item.source_kind];
  return domainOf(item) || (item.source_kind ? item.source_kind : "");
}

/** 来源筛选选项：数量以服务端 sources 为准，items 里出现但 sources 没给的来源也补上（数量按实际条目数） */
function sourceOptions(items: WebImageItem[], sources: Record<string, number>): Array<{ kind: string; label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) if (item.source_kind) counts.set(item.source_kind, (counts.get(item.source_kind) || 0) + 1);
  for (const [kind, count] of Object.entries(sources)) counts.set(kind, count);
  return [...counts.entries()].map(([kind, count]) => ({ kind, label: sourceName(kind), count }));
}

function sizeOf(item: WebImageItem): string {
  return item.width && item.height ? item.width + "×" + item.height : "尺寸未知";
}

function portalRoot(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.querySelector<HTMLElement>(".cn-root");
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
  const filtered = sourceFilter ? card.items.filter((item) => item.source_kind === sourceFilter) : card.items;
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
    if (!viewer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setViewer(null); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); stepViewer(-1); }
      else if (event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); stepViewer(1); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [viewer, filtered.length]);

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

  const header = <CardHeader className="mc-head">
    <div className="mc-head-row">
      <span className="mc-glyph"><Icon name={card.kind === "similar" ? "search" : "image"} size="s" /></span>
      <CardTitle className="mc-title">{TITLE_TEXT[card.kind]}</CardTitle>
      {card.status === "ready" ? <Badge className="mc-badge" size="sm"><span className="tnum">{card.items.length ? card.items.length + " 张" : "无结果"}</span></Badge> : null}
      {card.status === "loading" ? <Badge className="mc-badge" size="sm" variant="info">正在搜</Badge> : null}
      {card.status === "web-off" ? <Badge className="mc-badge" size="sm" variant="warning">未开启</Badge> : null}
      {card.status === "failed" ? <Badge className="mc-badge" size="sm" variant="destructive">失败</Badge> : null}
    </div>
  </CardHeader>;

  if (card.status === "web-off") return <Card aria-label="参考图 · 联网未开启" className="message-card webimg-card" data-webimg="web-off" size="sm">
    {header}
    <CardContent className="mc-body">
      <Alert appearance="soft" className="webimg-off" variant="warning">
        <AlertTitle>联网未开启</AlertTitle>
        <AlertDescription>在「设置 → 通用 → 画布助手联网」打开后，助手才能搜参考图。</AlertDescription>
      </Alert>
    </CardContent>
  </Card>;

  if (card.status === "loading") return <Card aria-label="参考图 · 正在搜索" className="message-card webimg-card" data-webimg="loading" size="sm">
    {header}
    <CardContent className="mc-body">
      <div className="webimg-skeleton">
        {[0, 1, 2].map((index) => <Skeleton className="webimg-skeleton-cell" key={index} />)}
      </div>
      <div className="webimg-load"><Spinner aria-hidden size="sm" /><span>{card.kind === "similar" ? "正在识别图片并搜索相似参考图…" : "正在搜索参考图…"}</span></div>
    </CardContent>
  </Card>;

  if (card.status === "failed") return <Card aria-label="参考图 · 搜索失败" className="message-card webimg-card" data-webimg="failed" size="sm">
    {header}
    <CardContent className="mc-body">
      <Alert appearance="soft" className="webimg-failed" role="alert" variant="destructive">
        <AlertTitle>搜图失败</AlertTitle>
        <AlertDescription>{card.error || "搜图失败（服务端没有给出原因）"}</AlertDescription>
      </Alert>
      {card.kind === "similar" ? <p className="mc-note">可以换一张更清晰、主体更明确的图再试。</p> : null}
    </CardContent>
  </Card>;

  const nothing = !card.items.length;
  const viewing = viewer ? filtered[viewer.index] : null;
  const viewerSteps = viewing ? viewerStepsOf(viewing) : [];
  const viewerSrc = viewing ? viewerSteps[viewerStep[viewing.id] || 0] || "" : "";
  /** 已经退到缩略图（说明原图和代理原图都不行）才提示 */
  const viewerOnThumb = !!viewing && (viewerStep[viewing.id] || 0) > 0 && viewerSrc === viewing.thumb_url;
  const root = portalRoot();
  return <>
  <Card aria-label="参考图选择" className="message-card webimg-card" data-webimg="ready" size="sm">
    {header}
    <CardContent className="mc-body">
      {card.description ? <p className="webimg-desc">{card.description}</p> : null}
      {card.queries.length ? <div className="webimg-q">{card.queries.slice(0, 5).map((q) => <span key={q}>{q}</span>)}</div> : null}
      {options.length > 1 ? <div className="webimg-srcchips" role="group" aria-label="来源筛选">
        <span>来源</span>
        <button aria-pressed={sourceFilter === null} className={"webimg-chip" + (sourceFilter === null ? " on" : "")} data-source="all" onClick={() => chooseSource(null)}>全部 ({card.items.length})</button>
        {options.map((option) => <button aria-pressed={sourceFilter === option.kind} className={"webimg-chip" + (sourceFilter === option.kind ? " on" : "")} data-source={option.kind} key={option.kind} onClick={() => chooseSource(option.kind)}>{option.label} ({option.count})</button>)}
      </div> : null}
      {nothing
        ? <Empty className="webimg-empty">
          <EmptyMedia><Icon name="image" size="s" /></EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>没有搜到参考图</EmptyTitle>
            <EmptyDescription>{card.note || (card.query ? "「" + card.query + "」没有搜到图（引擎返回空列表）" : "这次没有搜到图（引擎返回空列表）")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
        : filtered.length === 0
        ? <Empty className="webimg-empty" data-webimg-empty-source>
          <EmptyMedia><Icon name="image" size="s" /></EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>这个来源没有图片</EmptyTitle>
            <EmptyDescription>{sourceFilter ? "这个来源这次没搜到图片" : "这次没有搜到图（引擎返回空列表）"}</EmptyDescription>
          </EmptyHeader>
        </Empty>
        : <div className="webimg-grid">
          {visible.map((item, index) => {
            const on = picked.has(item.id);
            const error = rowErrors[item.id];
            const sourceLabel = sourceLabelOf(item);
            const steps = thumbStepsOf(item);
            const step = thumbStep[item.id] || 0;
            const src = steps[step] || "";
            return <div className={"webimg-cell" + (on ? " on" : "") + (added.has(item.id) ? " added" : "")} key={item.id}>
              <Attachment className="webimg-attach" orientation="vertical" size="sm" state="done">
                <AspectRatio
                  className="webimg-media"
                  fallback={<span className="webimg-noimg"><Icon name="image" size="s" /><em>{steps.length ? "预览加载失败" : "无预览图"}</em></span>}
                  ratio={1}
                >
                  {src ? <img alt={item.title || ""} draggable={false} loading="lazy" referrerPolicy="no-referrer" src={src}
                    onError={() => {
                      // 直连失败（CDN 反爬返回 HTML）→ 服务端代理 thumb → 服务端代理原图 → 占位
                      setThumbStep((prev) => {
                        const current = prev[item.id] || 0;
                        return current + 1 < steps.length ? { ...prev, [item.id]: current + 1 } : { ...prev, [item.id]: steps.length };
                      });
                    }} /> : null}
                </AspectRatio>
                <AttachmentContent className="webimg-meta">
                  <AttachmentTitle className="webimg-size tnum">{sizeOf(item)}</AttachmentTitle>
                  <AttachmentDescription className="webimg-srcname"><span title={sourceLabel || "来源未知"}>{sourceLabel || "来源未知"}</span></AttachmentDescription>
                </AttachmentContent>
                <AttachmentActions className="webimg-tools">
                  <span className="webimg-pick">{on || added.has(item.id) ? <Icon name="check" size="xs" /> : null}</span>
                </AttachmentActions>
                <AttachmentTrigger
                  aria-label={(item.title || "参考图") + " " + sizeOf(item) + "（双击放大）"}
                  aria-pressed={on}
                  className="webimg-tap"
                  onClick={() => tapSelect(item.id)}
                  onDoubleClick={() => openViewer(filtered.indexOf(item))}
                  title="单击选中 · 双击放大"
                />
              </Attachment>
              {item.source_page ? <a aria-label="打开出处" className="webimg-src" href={item.source_page} onClick={(event) => event.stopPropagation()} rel="noreferrer" target="_blank" title={"出处：" + item.source_page}><Icon name="link" size="xs" /></a> : null}
              {error ? <span className="webimg-err" role="alert">{error}</span> : null}
            </div>;
          })}
        </div>}
    </CardContent>
    {nothing ? null : <CardFooter className="mc-foot">
      <div className="webimg-bar">
        <div className="webimg-bar-l">
          <span className="tnum webimg-count">已选 {picked.size}/{card.items.length}</span>
          <ButtonGroup className="webimg-actions">
            <Button className="webimg-linkbtn" onClick={toggleAll} size="xs" variant="ghost">{allOn ? "取消全选" : "全选"}</Button>
            {filtered.length > ROW ? <Button className="webimg-linkbtn" data-webimg-expand={expanded ? "collapse" : "expand"} onClick={() => setExpanded(!expanded)} size="xs" variant="ghost">{expanded ? "收起" : "展开全部 (" + filtered.length + ")"}</Button> : null}
          </ButtonGroup>
        </div>
        <span className="sp" />
        <div className="webimg-bar-r">
          {added.size ? <span className="webimg-added">已加入 {added.size} 张</span> : null}
          <Button className="mc-btn-solid" disabled={!picked.size || busy} onClick={() => void add()} size="sm" variant="default">
            {busy ? <><Spinner aria-hidden size="sm" />正在加入…</> : "加入画布 (" + picked.size + ")"}
          </Button>
        </div>
      </div>
      {requestError ? <Alert appearance="soft" role="alert" variant="destructive">
        <AlertDescription>{requestError}</AlertDescription>
      </Alert> : null}
    </CardFooter>}
  </Card>
  {viewing && root ? createPortal(
    <div aria-label="查看参考图" aria-modal="true" className="webimg-lb" data-webimg-viewer onClick={() => setViewer(null)} role="dialog">
      <button aria-label="关闭" className="webimg-lb-close" onClick={(event) => { event.stopPropagation(); setViewer(null); }}><Icon name="x" size="s" /></button>
      <div className="webimg-lb-shell" onClick={(event) => event.stopPropagation()}>
        <Carousel className="webimg-lb-carousel" index={viewer!.index} onIndexChange={(next) => setViewer((prev) => (prev ? { index: next } : prev))} rewind>
          <CarouselContent className="webimg-lb-content">
            {filtered.map((item) => {
              const steps = viewerStepsOf(item);
              const step = viewerStep[item.id] || 0;
              const src = steps[step] || "";
              const loaded = Boolean(viewerLoaded[item.id]);
              return <CarouselItem className="webimg-lb-item" key={item.id}>
                <div className="webimg-lb-stage">
                  {!src
                    ? <div className="webimg-lb-broken"><Icon name="alert" size="s" /><span>原图和缩略图都没能显示</span></div>
                    : <>
                      {loaded ? null : <Skeleton className="webimg-lb-skeleton" />}
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
                </div>
              </CarouselItem>;
            })}
          </CarouselContent>
          {filtered.length > 1 ? <CarouselPrevious className="webimg-lb-nav prev" /> : null}
          {filtered.length > 1 ? <CarouselNext className="webimg-lb-nav next" /> : null}
        </Carousel>
      </div>
      <div className="webimg-lb-info" data-webimg-viewer-info onClick={(event) => event.stopPropagation()}>
        <div className="webimg-lb-head">
          <b title={viewing.title || "未命名参考图"}>{viewing.title || "未命名参考图"}</b>
          <span className="tnum">{viewer!.index + 1} / {filtered.length}</span>
        </div>
        <div className="webimg-lb-meta">
          <span className="tnum">{sizeOf(viewing)}</span>
          <span>{sourceLabelOf(viewing) || "来源未知"}</span>
          {viewerOnThumb ? <span className="webimg-lb-note" role="status">原图加载失败，显示的是缩略图</span> : null}
          {viewing.source_page ? <a href={viewing.source_page} rel="noreferrer" target="_blank">打开出处<Icon name="link" size="xs" /></a> : null}
        </div>
        <div className="webimg-lb-hint">← / → 切换 · Esc 或点遮罩关闭</div>
      </div>
    </div>,
    root,
  ) : null}
  </>;
}
