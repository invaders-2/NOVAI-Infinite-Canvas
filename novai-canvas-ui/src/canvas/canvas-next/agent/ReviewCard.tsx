/**
 * 结果审查卡：每个生成结果一张方图，整块点开大图；hover 出定位 / 查看 / 重新生成；
 * 信息条里列问题与修订提示词。版式照 Image Studio block（无外框卡片）。
 */
import { useEffect, useState } from "react";
import type { Ctl } from "../ui/ctx";
import { Icon } from "../ui/Icon";
import { ThumbImg } from "../ui/thumb";
import type { AgentReview } from "./task";
import type { AgentRegenerateItem } from "../backend/types";
import { StudioGrid, StudioLightbox, StudioTile } from "./ImageStudio";

/** 审查行 → 重生成请求项：修订提示词取审查给的 revised_prompt，没有就留空，后端按 issues 自己改 */
export const regenItemOf = (it: AgentReview["items"][number]): AgentRegenerateItem => ({ node_id: it.node_id, label: it.label, kind: it.kind || "", prompt: it.revised_prompt || "", issues: it.issues || [] });

type ReviewItem = AgentReview["items"][number];

function ReviewInfo({ item, ctl, onRegenerate }: { item: ReviewItem; ctl: Ctl; onRegenerate?: (items: AgentRegenerateItem[]) => void }) {
  const [open, setOpen] = useState(false);
  const prompt = item.revised_prompt || "";
  useEffect(() => { setOpen(false); }, [item.node_id, prompt]);
  return <>
    <div className="studio-lb-head">
      <b title={item.label}>{item.label}</b>
      <span className={"studio-lb-state " + (item.ok ? "ok" : "bad")}>{item.ok ? "合格" : "有问题"}</span>
    </div>
    {item.issues?.length ? <ul className="studio-lb-issues">{item.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul> : null}
    {prompt ? <div className="studio-lb-prompt">
      <span className="studio-lb-prompt-t">修订提示词</span>
      <p className={open ? "open" : undefined} data-review-prompt>{prompt}</p>
      <button className="studio-linkbtn" onClick={() => setOpen(!open)} type="button">{open ? "收起" : "展开"}</button>
    </div> : null}
    <div className="studio-lb-acts">
      <button className="studio-lb-btn" data-review-locate onClick={() => ctl.focusNode(item.node_id)} type="button"><Icon name="search" size="xs" />定位到画布</button>
      {onRegenerate && !item.ok ? <button className="studio-lb-btn" data-review-regen onClick={() => onRegenerate([regenItemOf(item)])} type="button"><Icon name="redo" size="xs" />重新生成这张</button> : null}
    </div>
  </>;
}

export function ReviewCard({ review, ctl, round, onRegenerate }: { review: AgentReview; ctl: Ctl; round: number; onRegenerate?: (items: AgentRegenerateItem[]) => void }) {
  const [view, setView] = useState<number | null>(null);
  const badItems = review.items.filter((item) => !item.ok);
  const bad = badItems.length;
  const title = "结果审查" + (review.skipped ? " · 跳过" : round ? " · 第 " + round + " 批" : "");
  const meta = [
    review.items.length + " 张",
    review.model || "",
    review.skipped ? "跳过审查" : bad ? bad + " 个有问题" : "全部合格",
  ].filter(Boolean).join(" · ");
  const items = review.items.map((item, index) => ({
    id: item.node_id + "|" + item.label,
    label: item.label,
    media: <div className="studio-lb-media">
      <ThumbImg
        fallback={<div className="studio-lb-broken"><Icon name={item.kind === "video" ? "video" : "image"} size="s" /><span>这张结果还没有可预览的图</span></div>}
        src={item.url || ""}
        width={1600}
      />
    </div>,
    info: <ReviewInfo ctl={ctl} item={item} onRegenerate={onRegenerate} />,
  }));
  return <div className={"studio-batch review-card" + (bad ? " has-bad" : "")} data-review data-review-bad={bad} data-review-count={review.items.length}>
    <div className="studio-batch-hd">
      <div className="studio-batch-hd-main">
        <b className="studio-batch-title">{title}</b>
        <span className="studio-batch-meta" data-review-meta>{meta}</span>
      </div>
      {onRegenerate && bad > 1 ? <button className="studio-linkbtn" data-review-regen-all onClick={() => onRegenerate(badItems.map(regenItemOf))} type="button">重新生成有问题的 {bad} 个</button> : null}
    </div>
    {review.summary ? <p className="studio-batch-sum">{review.summary}</p> : null}
    {review.items.length ? <StudioGrid>
      {review.items.map((item, index) => <StudioTile
        actions={[
          { icon: "search", label: "定位到画布", onClick: () => ctl.focusNode(item.node_id) },
          { icon: "eye", label: "查看大图", onClick: () => setView(index) },
          ...(onRegenerate && !item.ok ? [{ icon: "redo" as const, label: "重新生成", tone: "bad" as const, onClick: () => onRegenerate([regenItemOf(item)]) }] : []),
        ]}
        badge={item.ok ? undefined : "有问题"}
        data={{ "data-review-node": item.node_id, "data-review-ok": item.ok ? "1" : "0" }}
        key={item.node_id + item.label}
        kind={item.kind}
        label={item.label}
        media={<ThumbImg
          fallback={<span className="studio-tile-ph"><Icon name={item.kind === "video" ? "video" : "image"} size="s" /><em>{item.url ? "预览加载失败" : "暂无预览图"}</em></span>}
          src={item.url || ""}
          width={480}
        />}
        meta={item.ok ? "合格" : item.issues.join("；") || "不符合要求"}
        onActivate={() => setView(index)}
      />)}
    </StudioGrid> : <div className="studio-note"><b>本轮没有生成结果</b><p>这次没有需要审查的图。</p></div>}
    {view !== null ? <StudioLightbox
      data={{ "data-review-viewer": "" }}
      index={Math.min(view, review.items.length - 1)}
      items={items}
      label="查看生成结果"
      onClose={() => setView(null)}
      onIndex={(next) => setView(next)}
    /> : null}
  </div>;
}
