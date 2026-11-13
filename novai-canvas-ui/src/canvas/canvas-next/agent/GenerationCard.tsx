import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AgentTaskPlan } from "../backend/types";
import type { ModelSpec } from "../model";
import { Icon } from "../ui/Icon";
import { ratioDisplayLabel } from "../originalRatio";
import { Badge } from "@/components/hexta/badge";
import { Button } from "@/components/hexta/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/hexta/card";
import { Checkbox } from "@/components/hexta/checkbox";
import { Textarea } from "@/components/hexta/textarea";
import { Item, ItemContent, ItemGroup } from "@/components/hexta/item";
import { ComboMenu } from "../ui/combo";
import { OptCards, ratioShape } from "../ui/OptCards";
import { openPop } from "../ui/overlay";
import {
  buildGenerationApproveSteps, countOptions, countPlan, durationOptions, imageRatioOptions, imageResolutionOptions, generationReady, maxBatchOf, patchPlanStep, readPlanParams,
  splitModelId, videoModeOptions, videoRatioOptions, videoResOptions, type PlanKind, type PlanStep,
} from "./planParams";
import "./message-cards.css";

/**
 * 待生成卡片：助手已经在画布上建好节点、写好提示词、连好线，但还没有生成。
 * 用户在这里给每个节点选模型（不预选、不默认）、比例、分辨率、张数 / 时长，点「执行生成」才真正开跑。
 * 批准给后端的就是对这些节点的 run_generation（带 settings）。
 */
/** on：这次要不要生成；prompt：卡片里改过的提示词（执行时先写回节点）；mode：视频生成方式（空 = 自动） */
type Row = { on: boolean; modelId: string; ratio: string; resolution: string; count: number; duration: number; mode: string; prompt: string; editing: boolean };
type NodeInfo = { node_id: string; title: string; kind: string; prompt?: string };

const kindOf = (step: PlanStep): PlanKind | "audio" | null => {
  const t = String((step.args || {}).type || "").toLowerCase();
  return t === "image" || t === "video" ? t : t === "audio" ? "audio" : null;
};


const KIND_LABEL: Record<string, string> = { image: "图片", video: "视频", audio: "配音" };

function initRow(step: PlanStep, kind: PlanKind | "audio" | null, models: ModelSpec[], prompt = ""): Row {
  const base = { on: true, modelId: "", mode: "", prompt, editing: false };
  if (kind !== "image" && kind !== "video") return { ...base, ratio: "", resolution: "", count: 1, duration: 5 };
  const p = readPlanParams(step, kind, models);
  // 模型故意不取 readPlanParams 的兜底（列表第一个）：用户要自己选
  return { ...base, ratio: p.ratio, resolution: p.resolution, count: p.count, duration: p.duration };
}

const vendorOf = (m: ModelSpec) => (m.vendor || "").trim() || splitModelId(m.id).provider || "其它";

/** 卡片的参数按钮：点开的是画布同一套 #pop 弹层（.mh 标题 + OptCards 网格 + 滑块高亮），不再是下拉框 */
function ParamField({ label, text, busy, render }: { label: string; text: string; busy: boolean; render: (close: () => void) => ReactNode }) {
  return <label className="gen-field"><span>{label}</span>
    <button type="button" className="gen-select gen-param" disabled={busy} aria-label={label}
      onClick={(e) => openPop(e.currentTarget, (close) => render(close), "up", "left", "gen-pop param-pop")}>
      <span className="gen-model-text">{text}</span>
      <Icon name="down" size="xs" />
    </button>
  </label>;
}

/** 网格参数弹层的内容：弹层由 OverlayHost 渲染、拿不到卡片的 React state，选中态放这里自己维护，滑块才会真的滑过去 */
function GridPop({ title, busy, options, current, apply }: {
  title: string;
  busy: boolean;
  options: Array<{ value: string; label: ReactNode; shape?: ReactNode }>;
  current: string;
  apply: (value: string) => void;
}) {
  const [value, setValue] = useState(current);
  return <>
    <div className="mh">{title}</div>
    <OptCards cols={Math.max(1, Math.min(options.length, 4))} items={options.map((o) => ({
      key: o.value, label: o.label, shape: o.shape, on: o.value === value, disabled: busy,
      pick: () => { setValue(o.value); apply(o.value); },
    }))} />
  </>;
}

/** 模型选择：保持按供应商分组（供应商 → 模型两级），但弹层换成和画布参数浮层同一套 #pop + ComboMenu */
function ModelPicker({ list, busy, value, onChange, placeholder }: { list: ModelSpec[]; busy: boolean; value: string; onChange: (v: string) => void; placeholder: string }) {
  const hit = list.find((m) => m.id === value);
  const currentVendor = hit ? vendorOf(hit) : "";
  const vendors = [...new Set(list.map(vendorOf))];
  const showModels = (anchor: Element, vendor: string) => openPop(anchor, (close) => <ComboMenu
    autoFocus
    searchable
    searchPlaceholder="搜索模型"
    header={<div className="mh">{vendor}</div>}
    empty={<span>这个供应商还没有可用模型</span>}
    items={list.filter((m) => vendorOf(m) === vendor)}
    label={(m) => m.name}
    itemClassName={(m) => "mi combo-item" + (m.id === value ? " on" : "")}
    itemAttrs={(m) => ({ "data-model": m.id })}
    onPick={(m) => { close(); onChange(m.id); }}
    renderItem={(m) => <span style={{ flex: 1 }}>{m.name}<span className="d">{vendorOf(m)}</span></span>}
  />, "up", "left", "model-pop combo-pop gen-pop");
  return <button type="button" className={"gen-select gen-param gen-model" + (value ? "" : " is-empty")} disabled={busy || !list.length} aria-label={placeholder}
    onClick={(e) => {
      const anchor = e.currentTarget;
      openPop(anchor, (close) => <ComboMenu
        autoFocus
        searchable
        searchPlaceholder="搜索供应商"
        header={<div className="mh">{placeholder}</div>}
        empty={<span>还没有配置模型</span>}
        items={vendors}
        label={(vendor) => vendor}
        itemClassName={(vendor) => "mi combo-item" + (vendor === currentVendor ? " on" : "")}
        itemAttrs={(vendor) => ({ "data-vendor": vendor })}
        onPick={(vendor) => showModels(anchor, vendor)}
        renderItem={(vendor) => <><span style={{ flex: 1 }}>{vendor}<span className="d">{list.filter((m) => vendorOf(m) === vendor).length} 个模型</span></span>{vendor === currentVendor ? null : <Icon name="right" size="s" />}</>}
      />, "up", "left", "model-pop combo-pop gen-pop");
    }}>
    <span className="gen-model-text">{hit ? <><em>{currentVendor}</em>{hit.name}</> : placeholder}</span>
    <Icon name="down" size="xs" />
  </button>;
}

export function GenerationCard({ plan, models, busy, onApprove, onDiscard, onFocusNode }: {
  plan: AgentTaskPlan;
  models: ModelSpec[];
  busy: boolean;
  onApprove: (steps: AgentTaskPlan["steps"]) => void;
  onDiscard: () => void;
  onFocusNode?: (id: string) => void;
}) {
  const steps = (plan.steps || []) as PlanStep[];
  const nodes = (Array.isArray(plan.nodes) ? plan.nodes : []) as NodeInfo[];
  const key = JSON.stringify(steps);
  const infoOf = (step: PlanStep) => nodes.find((n) => n.node_id === (step.args || {}).node_id);
  const fresh = () => steps.map((s) => initRow(s, kindOf(s), models, infoOf(s)?.prompt || ""));
  const [rows, setRows] = useState<Row[]>(fresh);
  useEffect(() => { setRows(fresh()); }, [key]);
  const set = (i: number, patch: Partial<Row>) => setRows((prev) => prev.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  /** 网格参数弹层：和画布节点生成面板同一套 OptCards（.opt-grid + nv-glide 滑块高亮） */
  const gridPop = (title: string, options: Array<{ value: string; label: ReactNode; shape?: ReactNode }>, current: string, apply: (v: string) => void) =>
    () => <GridPop title={title} busy={busy} options={options} current={current} apply={apply} />;
  const kinds = steps.map(kindOf);
  const needModel = kinds.map((k) => k === "image" || k === "video");
  const picked = rows.filter((r) => r.on).length;
  const missing = rows.filter((r, i) => r.on && needModel[i] && !r.modelId).length;
  const allReady = generationReady(rows, kinds);
  const byKind = (k: string) => models.filter((m) => m.kind === k);
  /** 同类节点不止一个时，给一个「统一选择」 */
  const bulkKinds = (["image", "video"] as const).filter((k) => kinds.filter((x) => x === k).length > 1 && byKind(k).length);
  const setAll = (k: PlanKind, modelId: string) => setRows((prev) => prev.map((r, i) => (kinds[i] === k ? { ...r, modelId } : r)));

  /** 点「执行生成」：把这一行选好的模型 / 参数转成真正可执行的步骤交给后端 */
  const approve = () => onApprove(buildGenerationApproveSteps(steps, rows, models, nodes));

  const total = useMemo(() => rows.reduce((sum, r, i) => {
    if (!r.on) return sum;
    if (kinds[i] !== "image") return sum + 1;
    const spec = r.modelId ? models.find((m) => m.id === r.modelId) : undefined;
    return sum + countPlan(spec, r.count).groups;
  }, 0), [rows, models]);
  return <Card className="message-card gen-card" size="sm">
    <CardHeader className="mc-head">
      <div className="mc-head-row">
        <span className="mc-glyph"><Icon name="sparkle" size="s" /></span>
        <CardTitle className="mc-title">待生成</CardTitle>
        <Badge className="mc-badge" size="sm">{picked}/{steps.length} 个节点</Badge>
      </div>
      <div className="gen-sub">节点和提示词已放到画布上，选好模型和参数后再生成</div>
    </CardHeader>
    <CardContent className="mc-body gen-body">
      {bulkKinds.map((k) => <div className="gen-bulk" key={k}><span>{"全部" + KIND_LABEL[k] + "节点用"}</span>
        <ModelPicker list={byKind(k)} busy={busy} value={rows.every((r, i) => kinds[i] !== k || r.modelId === rows[kinds.indexOf(k)]?.modelId) ? rows[kinds.indexOf(k)]?.modelId || "" : ""} onChange={(v) => setAll(k, v)} placeholder="统一选择模型" /></div>)}
      <ItemGroup arrowNavigation={false} className="gen-list" highlight={false}>
        {steps.map((step, i) => {
          const k = kinds[i]; const r = rows[i] || initRow(step, k, models);
          const info = infoOf(step);
          const spec = r.modelId ? models.find((m) => m.id === r.modelId) : undefined;
          const modes = k === "video" ? videoModeOptions(spec) : [];
          const edited = !!info && r.prompt.trim() !== (info.prompt || "").trim();
          return <Item className={"gen-row" + (!r.on ? " is-off" : needModel[i] && !r.modelId ? " is-pending" : "")} key={i} size="xs">
            <ItemContent className="gen-row-body">
              <div className="gen-row-head">
                <Checkbox aria-label={"生成「" + (info?.title || "节点") + "」"} checked={r.on} className="gen-check" disabled={busy} onCheckedChange={(v) => set(i, { on: Boolean(v) })} />
                <span className="gen-kind">{KIND_LABEL[k || ""] || "节点"}</span>
                <button className="gen-title" onClick={() => info && onFocusNode?.(info.node_id)} title="在画布上定位">{info?.title || step.description || "节点"}</button>
                {info ? <button className="gen-edit" disabled={busy} onClick={() => set(i, { editing: !r.editing })}>{r.editing ? "收起" : edited ? "已修改" : "改提示词"}</button> : null}
              </div>
              {r.on ? <>
              {r.editing ? <Textarea className="gen-prompt-edit" value={r.prompt} minRows={3} maxRows={10} disabled={busy} onChange={(e) => set(i, { prompt: e.target.value })} onKeyDown={(e) => e.stopPropagation()} placeholder="提示词" />
                : r.prompt ? <div className="gen-prompt">{r.prompt}</div> : null}
              {k === "image" || k === "video" ? <div className="gen-params">
                <ModelPicker list={byKind(k)} busy={busy} value={r.modelId} onChange={(v) => set(i, { modelId: v })} placeholder="选择模型" />
                {k === "image" ? <>
                  <ParamField label="比例" text={ratioDisplayLabel(r.ratio)} busy={busy} render={gridPop("比例" + (spec ? " · " + spec.name : ""), imageRatioOptions(spec, r.ratio).map((v) => ({ value: v, label: ratioDisplayLabel(v), shape: ratioShape(v, 20) })), r.ratio, (v) => set(i, { ratio: v }))} />
                  <ParamField label="分辨率" text={r.resolution} busy={busy} render={gridPop("分辨率" + (spec ? " · " + spec.name : ""), imageResolutionOptions(spec, r.resolution).map((v) => ({ value: v, label: v })), r.resolution, (v) => set(i, { resolution: v }))} />
                  <ParamField label="张数" text={r.count + " 张"} busy={busy} render={gridPop("一次生成几张", countOptions(spec, r.count).map((v) => ({ value: String(v), label: v + " 张" })), String(r.count), (v) => set(i, { count: Number(v) }))} />
                  {(() => {
                    const plan = countPlan(spec, r.count);
                    if (plan.groups <= 1) return null;
                    const per = plan.batchUnknown || plan.unknownBatch ? "该模型批量上限未知，按一次 1 张处理" : "该模型一次最多 " + plan.perGroup + " 张";
                    return <div className="gen-note gen-split" data-count-split> {per}，将分 {plan.groups} 次生成（{plan.sizes.join(" + ")}）{plan.bumped ? "，尾数会补到该模型最小档位" : ""}</div>;
                  })()}
                </> : <>
                  <ParamField label="比例" text={ratioDisplayLabel(r.ratio)} busy={busy} render={gridPop("比例" + (spec ? " · " + spec.name : ""), videoRatioOptions(spec, r.ratio).map((v) => ({ value: v, label: ratioDisplayLabel(v), shape: ratioShape(v, 16) })), r.ratio, (v) => set(i, { ratio: v }))} />
                  {videoResOptions(spec, r.resolution).length ? <ParamField label="分辨率" text={r.resolution} busy={busy} render={gridPop("分辨率" + (spec ? " · " + spec.name : ""), videoResOptions(spec, r.resolution).map((v) => ({ value: v, label: v })), r.resolution, (v) => set(i, { resolution: v }))} /> : null}
                  <ParamField label="时长" text={r.duration + "s"} busy={busy} render={gridPop("时长", durationOptions(spec, r.duration).map((v) => ({ value: String(v), label: v + "s" })), String(r.duration), (v) => set(i, { duration: Number(v) }))} />
                  {modes.length ? <ParamField label="方式" text={r.mode ? (modes.find((m) => m.value === r.mode)?.label || r.mode) : "自动"} busy={busy} render={gridPop("生成方式", [{ value: "auto", label: "自动" }, ...modes.map((m) => ({ value: m.value, label: m.label }))], r.mode || "auto", (v) => set(i, { mode: v === "auto" ? "" : v }))} /> : null}
                </>}
                {!byKind(k).length ? <div className="gen-note">还没有配置{KIND_LABEL[k]}模型，先到 API 设置里添加</div> : null}
              </div> : <div className="gen-note">配音模型按已配置的语音合成模型自动选择</div>}
              </> : <div className="gen-note">这次不生成</div>}
            </ItemContent>
          </Item>;
        })}
      </ItemGroup>
    </CardContent>
    <CardFooter className="mc-foot">
      <div className="mc-note">{!picked ? "至少勾选一个节点" : missing ? "还有 " + missing + " 个节点没选模型" : "将生成 " + picked + " 个节点（约 " + total + " 次生成），完成后会自动审查并问你是否满意。"}</div>
      <div className="mc-actions">
        <Button className="mc-btn-solid" disabled={busy || !allReady} onClick={approve} size="sm" variant="default"><Icon name="play" size="s" />{"执行生成" + (picked && picked < steps.length ? " " + picked + " 个" : "")}</Button>
        <Button className="mc-btn-ghost" disabled={busy} onClick={onDiscard} size="sm" variant="ghost">先不生成</Button>
      </div>
    </CardFooter>
  </Card>;
}
