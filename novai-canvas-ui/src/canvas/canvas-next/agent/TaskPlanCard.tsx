import { useEffect, useMemo, useState } from "react";
import type { AgentTaskPlan } from "../backend/types";
import type { ModelSpec } from "../model";
import { Icon } from "../ui/Icon";
import { ratioDisplayLabel } from "../originalRatio";
import { Badge } from "@/components/hexta/badge";
import { Button } from "@/components/hexta/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/hexta/card";
import { Checkbox } from "@/components/hexta/checkbox";
import { Item, ItemContent, ItemGroup } from "@/components/hexta/item";
import { Progress } from "@/components/hexta/progress";
import {
  countOptions,
  durationOptions,
  findPlanModel,
  imageRatioOptions,
  imageResolutionOptions,
  patchPlanStep,
  planParamsSummary,
  planStepKind,
  planStepScope,
  readPlanParams,
  splitModelId,
  videoRatioOptions,
  videoResOptions,
  videoModeOptions,
  type PlanStep,
  type PlanStepPatch,
} from "./planParams";
import "./message-cards.css";

/**
 * 待确认的执行方案卡：生成类步骤的参数在这里直接改，改完的参数写进批准给后端的 steps。
 * 后端闸门只认 approved_steps，这张卡是它唯一的人工入口。
 */
export function TaskPlanCard({ plan, models, busy, onApprove, onDiscard }: {
  plan: AgentTaskPlan;
  models: ModelSpec[];
  busy: boolean;
  onApprove: (steps: AgentTaskPlan["steps"]) => void;
  onDiscard: () => void;
}) {
  const [draft, setDraft] = useState<PlanStep[]>(() => cloneSteps(plan.steps || []));
  /** 取消勾选的步骤不进入批准：默认全选，行为与改造前一致 */
  const [excluded, setExcluded] = useState<Set<number>>(() => new Set());
  // 轮询快照会重建 plan 对象：只有步骤内容真的变了才重置草稿，避免把用户正在改的参数冲掉
  const planKey = JSON.stringify(plan.steps || []);
  useEffect(() => { setDraft(cloneSteps(plan.steps || [])); setExcluded(new Set()); }, [planKey]);
  const steps = draft;
  const generation = Number(plan.impact?.generations) || 0;
  const summary = useMemo(() => planParamsSummary(steps, models), [steps, models]);
  const reason = typeof plan.reason === "string" ? plan.reason.trim() : "";
  /** 整体方案：多阶段任务的全部阶段；下面的步骤只是第一阶段，批准后助手按它一路做到底 */
  const roadmap = Array.isArray(plan.roadmap) ? plan.roadmap.filter((x) => x && x.stage) : [];
  const totalGen = Number(plan.total_generations) || 0;
  const assumptions = Array.isArray(plan.assumptions)
    ? plan.assumptions.map((x) => String(x || "").trim()).filter(Boolean)
    : (typeof plan.assumptions === "string" && plan.assumptions.trim() ? [plan.assumptions.trim()] : []);
  const change = (index: number, patch: PlanStepPatch) => {
    setDraft((prev) => prev.map((step, i) => {
      if (i !== index) return step;
      const kind = planStepKind(step, models);
      return kind ? patchPlanStep(step, kind, models, patch) : step;
    }));
  };
  /** 生成步骤能找到具体模型 = 参数就绪；纯画布操作不需要模型 */
  const readySteps = steps.filter((step) => {
    const kind = planStepKind(step, models);
    if (!kind) return true;
    const params = readPlanParams(step, kind, models);
    if (findPlanModel(models, kind, params?.provider || "", params?.model || "")) return true;
    return !models.some((m) => m.kind === kind);
  }).length;
  const keptCount = steps.length - excluded.size;
  const progressValue = steps.length ? Math.round((readySteps / steps.length) * 100) : 0;
  const toggleStep = (index: number, checked: boolean) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (checked) next.delete(index); else next.add(index);
      return next;
    });
  };
  return <Card className="message-card plan-card" data-plan-requires-confirmation size="sm">
    <CardHeader className="mc-head">
      <div className="mc-head-row">
        <span className="mc-glyph"><Icon name="layers" size="s" /></span>
        <CardTitle className="mc-title">方案待你确认</CardTitle>
        <Badge className="mc-badge" size="sm">{steps.length} 步</Badge>
      </div>
      <div className="mc-progress-row">
        <Progress aria-label="方案就绪度" className="mc-progress" size="sm" value={progressValue} />
        <span className="mc-progress-label tnum">{readySteps}/{steps.length} 步就绪</span>
      </div>
    </CardHeader>
    <CardContent className="mc-body plan-body">
      {roadmap.length > 1 ? <div className="plan-roadmap">
        <div className="plan-roadmap-hd">{"整体方案 · " + roadmap.length + " 个阶段" + (totalGen ? " · 约 " + totalGen + " 次生成" : "")}</div>
        <ol className="plan-roadmap-list">{roadmap.map((item, i) => <li key={i} className={i === 0 ? "is-now" : ""}>
          <b>{item.stage}</b>{item.detail ? <span>{item.detail}</span> : null}
        </li>)}</ol>
        <div className="plan-roadmap-hd">第一阶段的具体步骤</div>
      </div> : null}
      <ItemGroup arrowNavigation={false} className="plan-steps" highlight={false}>
        {steps.map((step, index) => {
          const kind = planStepKind(step, models);
          const params = kind ? readPlanParams(step, kind, models) : null;
          const spec = kind ? findPlanModel(models, kind, params?.provider || "", params?.model || "") : undefined;
          const kindModels = kind ? models.filter((m) => m.kind === kind) : [];
          const rows = Array.isArray((step.args || {}).rows) ? ((step.args as Record<string, unknown>).rows as unknown[]).length : 0;
          const modelName = spec ? (spec.vendor || splitModelId(spec.id).provider) + " · " + spec.name : "跟随助手默认";
          const ratioOpts = kind ? (kind === "image" ? imageRatioOptions(spec, params?.ratio || "") : videoRatioOptions(spec, params?.ratio || "")) : [];
          const resOpts = kind === "image" ? imageResolutionOptions(spec, params?.resolution || "") : [];
          const countOpts = kind === "image" && step.tool !== "batch_generate" ? countOptions(spec, params?.count || 1) : [];
          const durOpts = kind === "video" ? durationOptions(spec, params?.duration || 5) : [];
          const vResOpts = kind === "video" && planStepScope(step) === "settings" ? videoResOptions(spec, params?.resolution || "") : [];
          const modeOpts = kind === "video" && step.tool === "generate_video" ? videoModeOptions(spec) : [];
          const resolutionOpts = kind === "image" ? resOpts : vResOpts;
          const included = !excluded.has(index);
          return <Item className={"plan-step" + (included ? "" : " is-off")} key={index} size="xs">
            <Checkbox aria-label={"执行第 " + (index + 1) + " 步"} checked={included} className="plan-step-check" disabled={busy} onCheckedChange={(checked) => toggleStep(index, Boolean(checked))} />
            <span className="plan-step-num tnum">{index + 1}</span>
            <ItemContent className="plan-step-body">
              <div className="plan-step-head"><b>{step.description || step.tool}</b></div>
              {kind && params ? <div className="plan-params">
                <label className="pr"><span>模型</span>
                  <select value={spec?.id || ""} title={modelName} disabled={busy || !kindModels.length}
                    onChange={(e) => change(index, { modelConfigId: e.target.value || undefined })}>
                    {!spec ? <option value="">{"跟随助手默认（" + modelName + "）"}</option> : null}
                    {kindModels.map((m) => <option key={m.id} value={m.id}>{(m.vendor || splitModelId(m.id).provider) + " · " + m.name}</option>)}
                  </select>
                </label>
                {modeOpts.length ? <label className="pr"><span>生成方式</span>
                  <select value={params.mode} disabled={busy}
                    onChange={(e) => change(index, { mode: e.target.value })}>
                    <option value="">自动选择</option>
                    {modeOpts.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </label> : null}
                {resolutionOpts.length ? <label className="pr"><span>分辨率</span>
                  <select value={params.resolution} disabled={busy}
                    onChange={(e) => change(index, { resolution: e.target.value })}>
                    {resolutionOpts.map((res) => <option key={res} value={res}>{res}</option>)}
                  </select>
                </label> : null}
                {ratioOpts.length ? <label className="pr"><span>比例</span>
                  <select value={params.ratio} disabled={busy}
                    onChange={(e) => change(index, { ratio: e.target.value })}>
                    {ratioOpts.map((ratio) => <option key={ratio} value={ratio}>{ratioDisplayLabel(ratio)}</option>)}
                  </select>
                </label> : null}
                {countOpts.length ? <label className="pr"><span>张数</span>
                  <select value={String(params.count)} disabled={busy}
                    onChange={(e) => change(index, { count: Number(e.target.value) })}>
                    {countOpts.map((n) => <option key={n} value={n}>{n + " 张"}</option>)}
                  </select>
                </label> : null}
                {durOpts.length ? <label className="pr"><span>时长</span>
                  <select value={String(params.duration)} disabled={busy}
                    onChange={(e) => change(index, { duration: Number(e.target.value) })}>
                    {durOpts.map((n) => <option key={n} value={n}>{n + "s"}</option>)}
                  </select>
                </label> : null}
                {step.tool === "batch_generate" ? <div className="pnote">{"张数 = 表格 " + rows + " 行"}</div> : null}
                {kind === "image" && step.tool !== "batch_generate" && spec?.batchUnknown ? <div className="pnote">上限未知，以实际为准</div> : null}
                {kind === "video" && !modeOpts.length ? <div className="pnote">生成方式：自动选择</div> : null}
                {!kindModels.length ? <div className="pnote">当前没有可用的{kind === "video" ? "视频" : "图片"}模型，沿用助手默认</div> : null}
                {kindModels.length && spec?.specSource !== "spec" ? <div className="pnote">该模型未提供规格，比例/分辨率为推断</div> : null}
              </div> : null}
            </ItemContent>
          </Item>;
        })}
      </ItemGroup>
    </CardContent>
    <CardFooter className="mc-foot">
      {summary ? <div className="mc-summary">{summary}</div> : null}
      <div className="mc-note">{plan.summary || (generation ? "将执行 " + steps.length + " 步，含 " + generation + " 次生成" : "将执行 " + steps.length + " 步画布操作")}</div>
      {roadmap.length > 1 ? <div className="mc-why">{"批准后会按整体方案自动推进后续阶段" + (totalGen ? "（整套约 " + totalGen + " 次生成，超出会再问你）" : "")}</div> : null}
      {reason && !(plan.summary || "").includes(reason.slice(0, 24)) ? <div className="mc-why">{"理由：" + reason}</div> : null}
      {assumptions.length ? <div className="mc-why">{"假设：" + assumptions.slice(0, 3).join("；")}</div> : null}
      <div className="mc-actions">
        <Button className="mc-btn-solid" disabled={busy || !keptCount} onClick={() => {
          if (excluded.size === 0) {
            onApprove(approvedSteps(steps, models));
            return;
          }
          onApprove(approvedSteps(steps.filter((_, i) => !excluded.has(i)), models));
        }} size="sm" variant="default"><Icon name="play" size="s" />{"执行 " + keptCount + " 步"}</Button>
        <Button className="mc-btn-ghost" disabled={busy} onClick={onDiscard} size="sm" variant="ghost">先不做</Button>
      </div>
    </CardFooter>
  </Card>;
}

function cloneSteps(steps: AgentTaskPlan["steps"]): PlanStep[] {
  return (steps || []).map((step) => JSON.parse(JSON.stringify(step)) as PlanStep);
}
/** 批准前把步骤按当前 ModelSpec 归一：张数上限、视频方式、比例/分辨率都跟模型能力一致。 */
function approvedSteps(steps: PlanStep[], models: ModelSpec[]): AgentTaskPlan["steps"] {
  return steps.map((step) => {
    const kind = planStepKind(step, models);
    if (!kind) return step;
    return patchPlanStep(step, kind, models, {});
  });
}
