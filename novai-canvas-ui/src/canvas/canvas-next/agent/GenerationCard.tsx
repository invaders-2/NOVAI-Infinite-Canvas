import { modelVendorOf, openModelPicker } from "./ModelPicker";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentTaskPlan } from "../backend/types";
import {
  DEFAULT_CAMERA, STYLES, genOf, isQualityDefault, outputFormatLabel, outputFormatOptions,
  qualityChoices, qualityLabel, resRange, thinkLevelLabel, thinkLevelsFor, thinkingAvailable,
  type ImageOutputFormat, type MjParams, type ModelSpec,
} from "../model";
import { Icon } from "../ui/Icon";
import { ratioDisplayLabel } from "../originalRatio";
import { Badge } from "@/components/hexta/badge";
import { Button } from "@/components/hexta/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/hexta/card";
import { Checkbox } from "@/components/hexta/checkbox";
import { Textarea } from "@/components/hexta/textarea";
import { Item, ItemContent, ItemGroup } from "@/components/hexta/item";
import { ComboMenu } from "../ui/combo";
import { OptCards, ratioShape } from "../ui/OptCards";
import { openPop } from "../ui/overlay";
import { useS } from "../ui/ctx";
import {
  TEXT_OUTPUT_MODES, applyUnifiedValues, buildGenerationApproveSteps, buildUnifiedPlan, clampRowParams,
  countOptions, countPlan, durationOptions, generationReady, groupPlanSteps, imageRatioOptions, imageResolutionOptions, maxBatchOf,
  mjWithVersion, pruneUnifiedValues, readAudioRowParams, readPlanParams, readTextRowParams, rowFromNodeParams,
  splitModelId, stepCardKind, unifiedValueCount, videoModeOptions, videoRatioOptions, videoResOptions,
  type ApproveRow, type CardKind, type PlanStep, type StepKindGroup, type TriState, type UnifiedGroup, type UnifiedItem,
  type UnifiedPlan,
} from "./planParams";
import "./message-cards.css";

/**
 * 待生成卡片：助手已经在画布上建好节点、写好提示词、连好线，但还没有生成。
 * 用户在这里给每个节点选模型（不预选、不默认）、比例、分辨率、张数 / 时长，点「执行生成」才真正开跑。
 * 参数是两列字段格（10px 标签 + 11.5px 值 + 右侧线性 caret），模型一步选完，其余收进「更多设置」。
 * 批准给后端的就是对这些节点的 run_generation（带 settings，折叠不会丢键）。
 */
/** 行 = 一个节点这次要用的全部参数 + 卡片自己的展开状态；参数默认值读节点现有 params，读不到按模型能力第一档 */
type Row = ApproveRow & { editing: boolean };
type NodeInfo = { node_id: string; title: string; kind: string; prompt?: string };
/** 参数的一个可选值：写回动作由选项自己带着，字段和「更多设置」共用同一份定义 */
type ParamChoice = { value: string; label: string; shape?: ReactNode; pick: () => void };
/** 行里的一项参数：标签 + 当前值 + 可选项（核心项走字段弹层，折叠项走「更多设置」里的分段按钮） */
type ParamItem = { key: string; label: string; value: string; text: string; changed: boolean; choices: ParamChoice[]; /** 比例这类用画幅网格，其余是列表 */ layout?: "grid" };
/** 折叠项分组：弹层里「分组标题 + 每项一行标签和分段按钮」 */
type ParamGroup = { title?: string; items: ParamItem[] };
/** 一行折叠后的两截：外面留的几项（core）+ 收进「更多设置」的分组（more） */
type ParamSpec = { core: ParamItem[]; more: ParamGroup[] };

const kindOf = stepCardKind;

const KIND_LABEL: Record<string, string> = { image: "图片", video: "视频", text: "文本", audio: "配音" };
/** 拆卡后每张卡头的那颗线性图标（和行里的种类徽标同一套语义） */
const KIND_ICON: Record<string, "image" | "video" | "text" | "audio" | "cube"> = {
  image: "image", video: "video", text: "text", audio: "audio",
};

/** 卡片参数里会跟着节点数据更新的字段（用户动过的不再同步） */
const SYNC_KEYS: Array<keyof ApproveRow> = [
  "ratio", "resolution", "count", "duration", "mode", "audio",
  "quality", "thinking", "outputFormat", "background", "search", "style", "camera", "mj",
  "times", "genMode", "turbo", "draft", "multiShot",
  "output", "think", "audioKind", "audioDur",
];

const sameValue = (a: unknown, b: unknown) => (a && typeof a === "object") || (b && typeof b === "object")
  ? JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  : a === b;

const WITHOUT_UNDEFINED = (patch: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) out[key] = value;
  return out;
};

/** 折叠项和这一行的默认值（节点当前参数 / 步骤默认）比，不同 = 用户改过；入口上的计数只数这些 */
const differsFrom = (r: Row, base: Row) => (key: string): boolean => {
  const a = (r as unknown as Record<string, unknown>)[key];
  const b = (base as unknown as Record<string, unknown>)[key];
  // 质量档：空和 auto 都是「不指定」，两者之间不算改过
  if (key === "quality") {
    const da = isQualityDefault(a), db = isQualityDefault(b);
    return da || db ? da !== db : String(a) !== String(b);
  }
  return !sameValue(a, b);
};

/** MJ 版本文案：niji 系列显示 Niji X，其余显示 vX（与编辑器弹层一致） */
const mjVersionName = (version: string) => /^niji/i.test(version) ? version.replace(/^niji\s*/i, "Niji ") : "v" + version;
const mjVersionLabel = (mj: MjParams | undefined) => mj?.version ? mjVersionName(mj.version) : "默认";

function initRow(step: PlanStep, kind: CardKind | null, models: ModelSpec[], prompt = "", nodeParams: Record<string, any> | null = null): Row {
  const base: Row = {
    on: true, modelId: "", ratio: "", resolution: "", count: 1, duration: 5, mode: "",
    audio: false, prompt, editing: false,
    quality: "", thinking: "default", outputFormat: "", background: false, search: false,
    style: "无", camera: { ...DEFAULT_CAMERA }, times: 1, genMode: "", turbo: false, draft: false, multiShot: false,
    output: "text", think: "", audioKind: "", audioDur: "",
  };
  if (kind === "image" || kind === "video") {
    const p = readPlanParams(step, kind, models);
    // 模型故意不取 readPlanParams 的兜底（列表第一个）：用户要自己选
    Object.assign(base, {
      ratio: p.ratio, resolution: p.resolution, count: p.count, duration: p.duration, mode: p.mode,
      audio: kind === "video" ? p.audio === true : false,
      quality: p.quality, thinking: p.thinking, outputFormat: p.outputFormat, background: p.background,
      search: p.search, style: p.style, camera: p.camera, mj: p.mj,
      times: p.times, genMode: p.genMode, turbo: p.turbo, draft: p.draft, multiShot: p.multiShot,
    });
  } else if (kind === "text") {
    Object.assign(base, readTextRowParams(step, models));
  } else if (kind === "audio") {
    const a = readAudioRowParams(step, models);
    base.audioKind = a.kind; base.audioDur = a.dur;
  }
  // 节点现有 params 才是默认值：读到什么用什么
  const fromNode = kind ? WITHOUT_UNDEFINED(rowFromNodeParams(kind, nodeParams) as Record<string, unknown>) : {};
  return { ...base, ...fromNode } as Row;
}

const vendorOf = (m: ModelSpec) => (m.vendor || "").trim() || splitModelId(m.id).provider || "其它";

/** 模型行副标题：供应商 · 规格（最高分辨率 / 最多几张），没有声明就只留供应商 */
function modelSpecLine(m: ModelSpec): string {
  const parts: string[] = [];
  if (m.kind === "image") {
    const sizes = (Array.isArray(m.sizes) ? m.sizes : []).map((size) => String(size).toUpperCase()).filter(Boolean);
    if (sizes.length) parts.push(sizes[sizes.length - 1]);
    if (Array.isArray(m.batch) && m.batch.length) parts.push("最多 " + maxBatchOf(m) + " 张");
  } else if (m.kind === "video") {
    if (Array.isArray(m.res) && m.res.length) parts.push(String(m.res[m.res.length - 1]).toUpperCase());
    if (Array.isArray(m.durs) && m.durs.length) parts.push("最长 " + Math.max(...m.durs) + "s");
    if (Array.isArray(m.times) && Math.max(...m.times) > 1) parts.push("最多 " + Math.max(...m.times) + " 条");
  }
  return parts.join(" · ");
}

/** 参数字段：10px 标签 + 11.5px 值 + 右侧线性 caret，点开 #pop（向下，空间不足自动翻上） */
function GenField({ label, text, empty, wide, busy, disabled, ariaLabel, attrs, onClick }: {
  label: string;
  text: ReactNode;
  empty?: boolean;
  wide?: boolean;
  busy?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  attrs?: Record<string, string | number | undefined>;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return <div className={"gen-fieldwrap" + (wide ? " gen-fieldwrap-wide" : "")}>
    <button type="button" className="gen-field" disabled={busy || disabled} aria-label={ariaLabel || label} {...(attrs || {})} onClick={onClick}>
      <span>{label}</span>
      <b data-empty={empty ? "true" : undefined}>{text}</b>
      <Icon name="down" size="xs" className="gen-caret" />
    </button>
  </div>;
}

/** 一个参数的弹层内容：比例走 2 列画幅网格，其余走「名称 + 右侧线性勾」列表；选完就收起 */
function ChoicePop({ title, item, busy, close }: { title: string; item: ParamItem; busy: boolean; close: () => void }) {
  return <>
    <div className="gen-pop-hd">{title}</div>
    {item.layout === "grid"
      ? <div className="gen-pop-grid">
        {item.choices.map((choice) => <button key={choice.value} type="button" className="gen-shape" data-on={String(choice.value === item.value)}
          disabled={busy} onClick={() => { choice.pick(); close(); }}>
          {choice.shape || null}<span>{choice.label}</span>
        </button>)}
      </div>
      : <div className="gen-pop-list">
        {item.choices.map((choice) => <button key={choice.value} type="button" className="gen-opt" data-on={String(choice.value === item.value)}
          disabled={busy} onClick={() => { choice.pick(); close(); }}>
          <span className="gen-opt-main"><b>{choice.label}</b></span>
          <span className="gen-opt-mark"><Icon name="check" size="xs" /></span>
        </button>)}
      </div>}
  </>;
}

/** 「更多设置」弹层：每项一行 10px 灰标签 + 分段按钮（质量 / 风格 / 开关这类原地改，不再开二级弹层）
 *  弹层挂在 #pop 上、拿不到卡片的 state，所以选中态在这层自己留一份：连改几项时高亮立刻跟着走，
 *  真正写回行里仍走每个选项自带的 pick()。 */
function MorePop({ title, groups, busy }: { title: string; groups: ParamGroup[]; busy: boolean }) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  return <div className="gen-more-set" data-gen-mset>
    <div className="gen-pop-hd">{title}</div>
    {groups.map((group) => <div className="gen-pop-grp" key={group.title || "all"}>
      {group.title ? <div className="gen-pop-g">{group.title}</div> : null}
      {group.items.map((item) => {
        const value = picked[item.key] ?? item.value;
        return <div className="gen-pop-item" key={item.key} data-mset-key={item.key}>
          <div className="gen-pop-hd">{item.changed || value !== item.value ? <i className="gen-pop-dot" aria-hidden="true" /> : null}{item.label}</div>
          <div className="gen-seg">
            {item.choices.map((choice) => <button key={choice.value} type="button" data-on={String(choice.value === value)}
              disabled={busy} onClick={() => { setPicked((prev) => ({ ...prev, [item.key]: choice.value })); choice.pick(); }}>{choice.label}</button>)}
          </div>
        </div>;
      })}
    </div>)}
  </div>;
}

/** 统一设置里的一项：点了原地展开选项（不开二级弹层，才能连着改好几项）；第一格永远是「保持不改」 */
function UnifiedRow({ item, kind, value, busy, open, onToggle, onPick }: {
  item: UnifiedItem; kind: CardKind; value: string | undefined; busy: boolean;
  open: boolean; onToggle: () => void; onPick: (value: string | null) => void;
}) {
  const current = item.options.find((option) => option.value === value);
  const long = kind === "video" ? 16 : 20;
  return <div className="mset-item" data-uset-row={item.key}>
    <button type="button" data-uset-key={item.key} disabled={busy}
      className={"mi mset-row" + (current ? " is-changed" : "")} onClick={onToggle}>
      <span className="mset-l">{item.label}</span>
      <span className={"mset-v" + (current ? "" : " is-keep")}>{current ? current.label : "保持不改"}</span>
      <span className="mset-ic"><Icon name={open ? "down" : "right"} size="xs" /></span>
    </button>
    {open ? <div className="uset-open">
      {item.hint ? <div className="uset-pop-hint">{item.hint}</div> : null}
      <OptCards cols={Math.max(1, Math.min(item.options.length + 1, 4))} items={[
        { key: "__keep", label: "保持不改", on: !current, disabled: busy, attrs: { "data-uset-opt": "__keep" }, pick: () => onPick(null) },
        ...item.options.map((option) => ({
          key: option.value || "__default", label: option.label, on: !!current && current.value === option.value,
          disabled: busy, attrs: { "data-uset-opt": option.value },
          ...(item.key === "ratio" ? { shape: ratioShape(option.value, long) } : {}),
          pick: () => onPick(option.value),
        })),
      ]} />
    </div> : null}
  </div>;
}

/** 统一设置弹层：分组标题 + 每行「标签 / 当前值」，默认「保持不改」；底部「应用到 N 行」 */
function UnifiedPop({ kind, plan, scope, busy, initial, onApply }: {
  kind: CardKind; plan: UnifiedPlan; scope: string; busy: boolean;
  initial: Record<string, string>; onApply: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [open, setOpen] = useState<string | null>(null);
  const count = unifiedValueCount(plan.groups, values);
  const mode = values.mode;
  const firstFrame = kind === "video" && (mode === "image_to_video" || mode === "start_end_to_video");
  // 展开的选项可能落在弹层可视区外（底部还有吸底按钮）：把展开区滚进来，别让人以为点了没反应
  useEffect(() => {
    if (!open) return;
    const anchor = document.querySelector('#pop .uset-open');
    requestAnimationFrame(() => anchor?.scrollIntoView({ block: "nearest" }));
  }, [open]);
  const pick = (key: string, value: string | null) => setValues((prev) => {
    const next = { ...prev };
    if (value === null) delete next[key]; else next[key] = value;
    // 和节点面板同一套互斥：透明背景清掉输出格式；选 GIF / SVG 清掉透明背景
    if (key === "background" && value === "on") delete next.outputFormat;
    if (key === "outputFormat" && value) delete next.background;
    return next;
  });
  return <div className="mset uset" data-gen-uset={kind}>
    <div className="mh">{(KIND_LABEL[kind] || "节点") + " · 统一设置"}</div>
    <div className="uset-note">{plan.note}</div>
    {firstFrame ? <div className="uset-warn">已选「{mode === "image_to_video" ? "首帧" : "首尾帧"}」：和节点面板一致，比例会跟随首帧（部分模型不再发比例字段），统一的比例不会生效。</div> : null}
    {plan.groups.map((group) => {
      // 透明背景开着时不出输出格式（透明只出 PNG）
      const rows = group.items.filter((item) => !(item.key === "outputFormat" && values.background === "on"));
      if (!rows.length) return null;
      return <div className="mset-group" key={group.title || "all"}>
        {group.title ? <div className="mset-g">{group.title}</div> : null}
        {rows.map((item) => <UnifiedRow key={item.key} item={item} kind={kind} value={values[item.key]} busy={busy}
          open={open === item.key} onToggle={() => setOpen(open === item.key ? null : item.key)}
          onPick={(next) => pick(item.key, next)} />)}
      </div>;
    })}
    <div className="uset-foot">
      <span className="uset-scope">{scope}</span>
      <button type="button" className="uset-apply" disabled={busy || !count} onClick={() => onApply(values)}>应用到 {plan.targets.length} 行</button>
    </div>
  </div>;
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
  const docNodes = useS((s) => s.doc.nodes);
  const key = JSON.stringify(steps);
  const infoOf = (step: PlanStep) => nodes.find((n) => n.node_id === (step.args || {}).node_id);
  /** 节点当前的生成参数：行默认值从这里读（节点还没落到画布就返回 null，退回步骤里的默认值） */
  const nodeParamsOf = (step: PlanStep): Record<string, any> | null => {
    const nodeId = String((step.args || {}).node_id || "");
    const node = nodeId ? docNodes.find((n) => n.id === nodeId) : undefined;
    if (!node) return null;
    const params = genOf(node).params as Record<string, any> | undefined;
    return params && typeof params === "object" ? params : null;
  };
  const kinds = steps.map(kindOf);
  const fresh = () => steps.map((s, i) => initRow(s, kinds[i], models, infoOf(s)?.prompt || "", nodeParamsOf(s)));
  const [rows, setRows] = useState<Row[]>(fresh);
  /** 用户动过的字段不再被节点 params 覆盖（键 = 行:字段） */
  const touched = useRef<Set<string>>(new Set());
  /** 统一设置里每一类改过哪几项（键 = 类型:参数，值 = 选项值）；入口计数和重开面板都读它 */
  const [unified, setUnified] = useState<Record<string, Record<string, string>>>({});
  useEffect(() => { touched.current.clear(); setRows(fresh()); setUnified({}); }, [key]);
  const set = (i: number, patch: Partial<Row>) => {
    for (const field of Object.keys(patch)) touched.current.add(i + ":" + field);
    setRows((prev) => prev.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  };
  // 节点数据比卡片晚到时（刷新恢复方案 / 调试注入），没动过的字段再跟一次节点 params
  useEffect(() => { setRows((prev) => {
    let changed = false;
    const next = prev.map((r, i) => {
      const kind = kinds[i];
      if (!kind) return r;
      const fromNode = WITHOUT_UNDEFINED(rowFromNodeParams(kind, nodeParamsOf(steps[i])) as Record<string, unknown>);
      const patch: Record<string, unknown> = {};
      for (const field of SYNC_KEYS) {
        const value = fromNode[field as string];
        if (value === undefined || touched.current.has(i + ":" + field)) continue;
        if (sameValue((r as unknown as Record<string, unknown>)[field as string], value)) continue;
        patch[field as string] = value;
      }
      if (!Object.keys(patch).length) return r;
      changed = true;
      return { ...r, ...patch } as Row;
    });
    return changed ? next : prev;
  }); }, [docNodes]);
  const needModel = kinds.map((k) => k === "image" || k === "video");
  const picked = rows.filter((r) => r.on).length;
  const missing = rows.filter((r, i) => r.on && needModel[i] && !r.modelId).length;
  const allReady = generationReady(rows, kinds);
  const byKind = (k: CardKind) => models.filter((m) => m.kind === k);
  /** 「统一选择模型」只认本卡这一类：同类几行都选了同一个才显示成已选 */
  const bulkValueOf = (k: CardKind): string => {
    const first = rows[kinds.indexOf(k)];
    if (!first) return "";
    return rows.every((r, i) => kinds[i] !== k || r.modelId === first.modelId) ? first.modelId || "" : "";
  };
  const setAll = (k: CardKind, modelId: string) => {
    const spec = models.find((m) => m.id === modelId && m.kind === k);
    kinds.forEach((kind, i) => {
      if (kind !== k) return;
      set(i, { modelId, ...(kind === "image" || kind === "video" ? clampRowParams(kind, rows[i], spec) : {}) });
    });
  };
  /** 换模型：把不再支持的选项收回到该模型第一档（分辨率不会留空） */
  const pickModel = (i: number, k: "image" | "video", modelId: string) => {
    const spec = models.find((m) => m.id === modelId && m.kind === k);
    set(i, { modelId, ...clampRowParams(k, rows[i], spec) });
  };
  /** 文本 / 音频行没有模型选择：用节点上当前的模型判能力，读不到就用该类第一个模型 */
  const specOf = (i: number, k: CardKind | null): ModelSpec | undefined => {
    if (!k) return undefined;
    if (k === "image" || k === "video") return rows[i]?.modelId ? models.find((m) => m.id === rows[i].modelId) : undefined;
    const nodeModel = String((nodeParamsOf(steps[i]) || {}).model || "");
    return models.find((m) => m.id === nodeModel) || models.find((m) => m.kind === k);
  };

  /** 每行这次生效的模型能力：统一设置按这批行的能力取交集，只列都支持的参数和取值 */
  const rowSpecs = rows.map((r, i) => (r.modelId ? models.find((m) => m.id === r.modelId) : specOf(i, kinds[i])));
  const unifiedPlanOf = (k: CardKind) => buildUnifiedPlan(k, rows, kinds, rowSpecs);
  const unifiedCountOf = (k: CardKind) => unifiedValueCount(unifiedPlanOf(k).groups, unified[k] || {});
  /** 只把用户改过的项写进每一行；走同一个 set()，touched 标记保证节点数据不会把值同步回去 */
  const applyUnified = (k: CardKind, plan: UnifiedPlan, values: Record<string, string>) => {
    const next = pruneUnifiedValues(plan.groups, values);
    setUnified((prev) => ({ ...prev, [k]: next }));
    for (const { index, patch } of applyUnifiedValues(plan.groups, rows, plan.targets, next)) set(index, patch);
  };
  /** N = 勾选中的同类型行数；一个都没勾就应用到同类全部行（面板底部写清作用对象） */
  const openUnified = (k: CardKind) => (e: React.MouseEvent<HTMLButtonElement>) => {
    const plan = unifiedPlanOf(k);
    const same = kinds.filter((kind) => kind === k).length;
    const checked = rows.filter((row, i) => row.on && kinds[i] === k).length;
    const label = KIND_LABEL[k] || "节点";
    const scope = !plan.targets.length ? ""
      : !checked ? "没有勾选，按全部 " + plan.targets.length + " 个" + label + "行处理"
        : "已勾选的 " + plan.targets.length + " 个" + label + "行" + (same > plan.targets.length ? "，另有 " + (same - plan.targets.length) + " 行未勾选、不会改动" : "");
    openPop(e.currentTarget, (close) => <UnifiedPop kind={k} plan={plan} scope={scope} busy={busy}
      initial={pruneUnifiedValues(plan.groups, unified[k] || {})}
      onApply={(values) => { applyUnified(k, plan, values); close(); }} />,
    "down", "left", "uset-pop mset-pop");
  };

  /** 字段弹层：统一向下，空间不足由 placePopover 自动翻上；比例用 2 列画幅网格 */
  const openItem = (item: ParamItem) => (e: React.MouseEvent<HTMLButtonElement>) => {
    openPop(e.currentTarget, (close) => <ChoicePop title={item.label} item={item} busy={busy} close={close} />,
      "down", "left", "gen-card-pop gen-pop" + (item.layout === "grid" ? " gen-shape-pop" : ""));
  };
  /** 「更多设置」：分组标题 + 每项一行分段按钮，原地改、不关弹层 */
  const openMore = (title: string, groups: ParamGroup[]) => (e: React.MouseEvent<HTMLButtonElement>) => {
    openPop(e.currentTarget, () => <MorePop title={title} groups={groups} busy={busy} />, "down", "left", "gen-card-pop gen-pop gen-more-pop");
  };
  /** 模型选择：两级（供应商 → 模型），和节点面板同一套交互；列出设置里这一类的全部模型 */
  const openModels = (list: ModelSpec[], value: string, onChange: (id: string) => void, title: string) =>
    (e: React.MouseEvent<HTMLButtonElement>) => {
      openModelPicker(e.currentTarget, {
        models: list, value, onPick: onChange, title: title + " · 选择供应商", dir: "down",
        specLine: (m) => modelVendorOf(m) + (modelSpecLine(m) ? " · " + modelSpecLine(m) : ""),
        cls: "gen-card-pop gen-pop gen-model-pop combo-pop",
      });
    };

  /** 点「执行生成」：把这一行选好的模型 / 参数转成真正可执行的步骤交给后端 */
  const approve = () => onApprove(buildGenerationApproveSteps(steps, rows, models, nodes));

  /** 底部的合计（跨所有卡）：这次会生成几张图 / 几条视频 / 几段文本 / 几条配音 */
  const totals = useMemo(() => {
    const count: Record<CardKind, number> = { image: 0, video: 0, text: 0, audio: 0 };
    rows.forEach((r, i) => {
      const k = kinds[i];
      if (!r.on || !k) return;
      if (k === "image") count.image += Math.max(1, Math.round(Number(r.count) || 1));
      else if (k === "video") count.video += Math.max(1, Math.round(Number(r.times) || 1));
      else count[k] += 1;
    });
    return count;
  }, [rows, key]);
  /** 合计文案：「2 张图 + 1 条视频」 */
  const totalText = [
    totals.image ? totals.image + " 张图" : "", totals.video ? totals.video + " 条视频" : "",
    totals.text ? totals.text + " 段文本" : "", totals.audio ? totals.audio + " 条配音" : "",
  ].filter(Boolean).join(" + ");

  /** 一项参数：当前值 + 文本 + 可选项（每项自带写回动作） */
  const item = (key: string, label: string, value: string, text: string, changed: boolean, choices: ParamChoice[], layout?: "grid"): ParamItem =>
    ({ key, label, value: String(value), text, changed, choices, layout });

  /** 图片行：外面留「模型 / 比例 / 分辨率 / 张数」，其余按模型能力收进「更多设置」 */
  const imageParams = (i: number, r: Row, base: Row, spec: ModelSpec | undefined): ParamSpec => {
    const differs = differsFrom(r, base);
    const qualities = qualityChoices(spec);
    const formats = outputFormatOptions(spec);
    const mjVersions = spec?.mj?.versions || [];
    const qualityItems: ParamItem[] = qualities.length > 1 ? [item("quality", "质量",
      isQualityDefault(r.quality) ? qualities[0].value : String(r.quality || ""),
      isQualityDefault(r.quality) ? "默认" : qualityLabel(r.quality), differs("quality"),
      qualities.map((q) => ({ value: q.value, label: q.label, pick: () => set(i, { quality: q.value }) })))] : [];
    const thinkingItems: ParamItem[] = thinkingAvailable(spec) ? [item("thinking", "先思考",
      r.thinking || "default", r.thinking === "on" ? "开" : r.thinking === "off" ? "关" : "默认", differs("thinking"),
      [{ value: "default", label: "默认", pick: () => set(i, { thinking: "default" }) },
        { value: "on", label: "开", pick: () => set(i, { thinking: "on" }) },
        { value: "off", label: "关", pick: () => set(i, { thinking: "off" })}])] : [];
    const formatItems: ParamItem[] = formats.length > 1 ? [item("outputFormat", "输出格式",
      r.outputFormat || "", outputFormatLabel(r.outputFormat), differs("outputFormat"),
      formats.map((f) => ({ value: f.value, label: f.label, pick: () => set(i, { outputFormat: f.value as "" | ImageOutputFormat }) })))] : [];
    const backgroundItems: ParamItem[] = spec?.nativeBackground ? [item("background", "透明背景",
      r.background ? "on" : "off", r.background ? "开" : "关", differs("background"),
      [{ value: "off", label: "关", pick: () => set(i, { background: false }) },
        { value: "on", label: "开", pick: () => set(i, { background: true })}])] : [];
    const searchItems: ParamItem[] = spec?.search ? [item("search", "联网",
      r.search ? "on" : "off", r.search ? "开" : "关", differs("search"),
      [{ value: "off", label: "关", pick: () => set(i, { search: false }) },
        { value: "on", label: "开", pick: () => set(i, { search: true })}])] : [];
    const styleItems: ParamItem[] = spec?.style ? [item("style", "风格",
      r.style || "无", r.style || "无", differs("style"),
      STYLES.map(([name]) => ({ value: name, label: name, pick: () => set(i, { style: name }) })))] : [];
    const cameraItems: ParamItem[] = spec?.camera ? [item("camera", "摄影机",
      r.camera?.on ? "on" : "off", r.camera?.on ? "开" : "关", differs("camera"),
      [{ value: "off", label: "关", pick: () => set(i, { camera: { ...(r.camera || DEFAULT_CAMERA), on: false } }) },
        { value: "on", label: "开", pick: () => set(i, { camera: { ...(r.camera || DEFAULT_CAMERA), on: true } })}])] : [];
    const mjItems: ParamItem[] = mjVersions.length ? [item("mj", "MJ 版本",
      r.mj?.version || "", mjVersionLabel(r.mj), differs("mj"),
      [{ value: "", label: "默认", pick: () => set(i, { mj: mjWithVersion(r.mj, "") }) },
        ...mjVersions.map((v) => ({ value: v, label: mjVersionName(v), pick: () => set(i, { mj: mjWithVersion(r.mj, v) }) }))])] : [];
    return {
      core: [
        item("ratio", "比例", r.ratio, ratioDisplayLabel(r.ratio), false,
          imageRatioOptions(spec, r.ratio).map((v) => ({ value: v, label: ratioDisplayLabel(v), shape: ratioShape(v, 18), pick: () => set(i, { ratio: v }) })), "grid"),
        item("resolution", "分辨率", r.resolution, r.resolution, false,
          imageResolutionOptions(spec, r.resolution).map((v) => ({ value: v, label: v, pick: () => set(i, { resolution: v }) }))),
        item("count", "张数", String(r.count), r.count + " 张", false,
          countOptions(spec, r.count).map((v) => ({ value: String(v), label: v + " 张", pick: () => set(i, { count: v }) }))),
      ],
      more: [
        { title: "画质", items: [...qualityItems, ...thinkingItems, ...formatItems, ...backgroundItems] },
        { title: "风格与参考", items: [...searchItems, ...styleItems, ...cameraItems, ...mjItems] },
      ].filter((group) => group.items.length),
    };
  };

  /** 视频行：外面留「模型 / 比例 / 分辨率 / 时长」，其余按模型能力收进「更多设置」 */
  const videoParams = (i: number, r: Row, base: Row, spec: ModelSpec | undefined): ParamSpec => {
    const differs = differsFrom(r, base);
    const modes = videoModeOptions(spec);
    const timesList = (spec?.times || [1]).filter((n) => Number(n) >= 1);
    const genModes = spec?.genModes || [];
    const modeItems: ParamItem[] = modes.length ? [item("mode", "方式",
      r.mode || "auto", r.mode ? (modes.find((m) => m.value === r.mode)?.label || r.mode) : "自动", differs("mode"),
      [{ value: "auto", label: "自动", pick: () => set(i, { mode: "" }) },
        ...modes.map((m) => ({ value: m.value, label: m.label, pick: () => set(i, { mode: m.value }) }))])] : [];
    const timesItems: ParamItem[] = timesList.length > 1 ? [item("times", "一次几条",
      String(r.times || 1), Math.max(1, Math.round(Number(r.times) || 1)) + " 条", differs("times"),
      timesList.map((n) => ({ value: String(n), label: n + " 条", pick: () => set(i, { times: n }) })))] : [];
    const audioItems: ParamItem[] = spec?.audio ? [item("audio", "音频",
      r.audio ? "on" : "off", r.audio ? "开" : "关", differs("audio"),
      [{ value: "on", label: "开", pick: () => set(i, { audio: true }) },
        { value: "off", label: "关", pick: () => set(i, { audio: false })}])] : [];
    const genModeItems: ParamItem[] = genModes.length ? [item("genMode", "生成模式",
      r.genMode || "", r.genMode || "默认", differs("genMode"),
      [{ value: "", label: "默认", pick: () => set(i, { genMode: "" }) },
        ...genModes.map((g) => ({ value: g, label: g, pick: () => set(i, { genMode: g }) }))])] : [];
    const turboItems: ParamItem[] = spec?.turbo ? [item("turbo", "加速",
      r.turbo ? "on" : "off", r.turbo ? "开" : "关", differs("turbo"),
      [{ value: "off", label: "关", pick: () => set(i, { turbo: false }) },
        { value: "on", label: "开", pick: () => set(i, { turbo: true })}])] : [];
    const draftItems: ParamItem[] = resRange(spec) ? [item("draft", "草稿",
      r.draft ? "on" : "off", r.draft ? "开" : "关", differs("draft"),
      [{ value: "off", label: "关", pick: () => set(i, { draft: false }) },
        { value: "on", label: "开", pick: () => set(i, { draft: true })}])] : [];
    const multiShotItems: ParamItem[] = spec?.multiShot ? [item("multiShot", "多镜头",
      r.multiShot ? "on" : "off", r.multiShot ? "开" : "关", differs("multiShot"),
      [{ value: "off", label: "关", pick: () => set(i, { multiShot: false }) },
        { value: "on", label: "开", pick: () => set(i, { multiShot: true })}])] : [];
    return {
      core: [
        item("ratio", "比例", r.ratio, ratioDisplayLabel(r.ratio), false,
          videoRatioOptions(spec, r.ratio).map((v) => ({ value: v, label: ratioDisplayLabel(v), shape: ratioShape(v, 16), pick: () => set(i, { ratio: v }) })), "grid"),
        ...(videoResOptions(spec, r.resolution).length ? [item("resolution", "分辨率", r.resolution, r.resolution, false,
          videoResOptions(spec, r.resolution).map((v) => ({ value: v, label: v, pick: () => set(i, { resolution: v, draft: false }) })))] : []),
        item("duration", "时长", String(r.duration), r.duration + "s", false,
          durationOptions(spec, r.duration).map((v) => ({ value: String(v), label: v + "s", pick: () => set(i, { duration: v }) }))),
      ],
      more: [
        { title: "生成", items: [...modeItems, ...timesItems, ...audioItems, ...genModeItems] },
        { title: "性能", items: [...turboItems, ...draftItems, ...multiShotItems] },
      ].filter((group) => group.items.length),
    };
  };

  /** 文本行：外面不放参数（模型跟随节点），输出 / 强度 / 联网全进「更多设置」 */
  const textParams = (i: number, r: Row, base: Row, spec: ModelSpec | undefined): ParamSpec => {
    const differs = differsFrom(r, base);
    const levels = thinkLevelsFor(spec);
    const outputItems: ParamItem[] = [item("output", "输出", r.output || "text",
      TEXT_OUTPUT_MODES.find(([v]) => v === (r.output || "text"))?.[1] || "文本", differs("output"),
      TEXT_OUTPUT_MODES.map(([v, label]) => ({ value: v, label, pick: () => set(i, { output: v as Row["output"] }) })))];
    const thinkItems: ParamItem[] = levels.length > 1 ? [item("think", "强度",
      r.think || "", r.think ? thinkLevelLabel(r.think) : "默认", differs("think"),
      [{ value: "", label: "默认", pick: () => set(i, { think: "" }) },
        ...levels.map((lv) => ({ value: lv, label: thinkLevelLabel(lv), pick: () => set(i, { think: lv }) }))])] : [];
    const searchItems: ParamItem[] = !spec || spec.search ? [item("search", "联网",
      r.search ? "on" : "off", r.search ? "开" : "关", differs("search"),
      [{ value: "off", label: "关", pick: () => set(i, { search: false }) },
        { value: "on", label: "开", pick: () => set(i, { search: true })}])] : [];
    return { core: [], more: [{ items: [...outputItems, ...thinkItems, ...searchItems] }] };
  };

  /** 音频行：外面不放参数（模型跟随节点），类型 / 时长全进「更多设置」 */
  const audioParams = (i: number, r: Row, base: Row, spec: ModelSpec | undefined): ParamSpec => {
    const differs = differsFrom(r, base);
    const kindList = spec?.kinds || [];
    const durList = spec?.adurs || [];
    const kindItems: ParamItem[] = kindList.length ? [item("audioKind", "类型",
      r.audioKind || kindList[0], r.audioKind || kindList[0], differs("audioKind"),
      kindList.map((k) => ({ value: k, label: k, pick: () => set(i, { audioKind: k }) })))] : [];
    const durItems: ParamItem[] = durList.length ? [item("audioDur", "时长",
      r.audioDur || durList[0], r.audioDur || durList[0], differs("audioDur"),
      durList.map((d) => ({ value: d, label: d, pick: () => set(i, { audioDur: d }) })))] : [];
    return { core: [], more: [{ items: [...kindItems, ...durItems] }] };
  };

  /** 按种类取折叠后的一行参数 */
  const paramsOf = (i: number, kind: CardKind | null, r: Row, base: Row, spec: ModelSpec | undefined): ParamSpec => {
    if (kind === "image") return imageParams(i, r, base, spec);
    if (kind === "video") return videoParams(i, r, base, spec);
    if (kind === "text") return textParams(i, r, base, spec);
    if (kind === "audio") return audioParams(i, r, base, spec);
    return { core: [], more: [] };
  };

  /** 拆卡：图片 → 视频 → 文本 → 配音，只出现有行的类型（认不出类型的步骤挂最后一张，不丢行） */
  const typeGroups = groupPlanSteps(steps);

  /** 一行（勾选 / 标题 / 提示词 / 两列参数格） */
  const rowOf = (i: number) => {
    const step = steps[i];
    const k = kinds[i]; const r = rows[i] || initRow(step, k, models, "", nodeParamsOf(step));
    const info = infoOf(step);
    const spec = r.modelId ? models.find((m) => m.id === r.modelId) : specOf(i, k);
    /** 这一行的默认值（节点当前参数 / 步骤默认）：折叠入口的计数拿它比 */
    const defaults = initRow(step, k, models, info?.prompt || "", nodeParamsOf(step));
    const params = paramsOf(i, k, r, defaults, spec);
    const moreTitle = "更多设置 · " + (spec ? spec.name : KIND_LABEL[k || ""] || "节点");
    const edited = !!info && r.prompt.trim() !== (info.prompt || "").trim();
    const moreItems = params.more.flatMap((group) => group.items);
    const changedMore = moreItems.filter((entry) => entry.changed).length;
    /** 「更多」字段的值：优先露质量 / 风格，其余补到两项（和预览的「质量 标准 · 风格 无」同一口径） */
    const summaryKeys = ["quality", "style"];
    const summary = [
      ...summaryKeys.map((key) => moreItems.find((entry) => entry.key === key)).filter((entry): entry is ParamItem => !!entry),
      ...moreItems.filter((entry) => !summaryKeys.includes(entry.key)),
    ].slice(0, 2).map((entry) => entry.label + " " + entry.text).join(" · ");
    const splitPlan = k === "image" ? countPlan(spec, r.count) : null;
    return <Item className={"gen-row" + (!r.on ? " is-off" : needModel[i] && !r.modelId ? " is-pending" : "")} key={i} size="xs">
      <ItemContent className="gen-row-body">
        <div className="gen-row-head">
          <Checkbox aria-label={"生成「" + (info?.title || "节点") + "」"} checked={r.on} className="gen-check" disabled={busy} onCheckedChange={(v) => set(i, { on: Boolean(v) })} />
          <span className="gen-kind">{KIND_LABEL[k || ""] || "节点"}</span>
          <button className="gen-title" onClick={() => info && onFocusNode?.(info.node_id)} title="在画布上定位">{info?.title || step.description || "节点"}</button>
          {info ? <button className="gen-edit" disabled={busy} onClick={() => set(i, { editing: !r.editing })}>{r.editing ? "收起" : edited ? "已修改" : "改提示词"}</button> : null}
        </div>
        {r.on ? <>
          {r.editing
            ? <Textarea className="gen-prompt-edit" value={r.prompt} minRows={3} maxRows={10} disabled={busy} onChange={(e) => set(i, { prompt: e.target.value })} onKeyDown={(e) => e.stopPropagation()} placeholder="提示词" />
            : r.prompt ? <div className="gen-prompt"><em>提示词</em><span className="gen-prompt-text">{r.prompt}</span></div> : null}
          {k === "image" || k === "video" || params.core.length || moreItems.length ? <div className="gen-fields">
            {k === "image" || k === "video" ? <GenField label="模型" text={spec?.name || "选择模型"} empty={!r.modelId} busy={busy}
              disabled={!byKind(k).length} onClick={openModels(byKind(k), r.modelId, (v) => pickModel(i, k, v), "选择模型")} /> : null}
            {params.core.map((entry) => <GenField key={entry.key} label={entry.label} text={entry.text} busy={busy} onClick={openItem(entry)} />)}
            {moreItems.length ? <GenField wide label="更多" busy={busy} ariaLabel="更多设置" attrs={{ "data-gen-more": changedMore }}
              text={<>{changedMore ? <i className="gen-more-dot" aria-hidden="true" /> : null}{summary}</>}
              onClick={openMore(moreTitle, params.more)} /> : null}
          </div> : null}
          {splitPlan && splitPlan.groups > 1
            ? <div className="gen-note gen-split" data-count-split>
              {(splitPlan.batchUnknown || splitPlan.unknownBatch ? "该模型批量上限未知，按一次 1 张处理" : "该模型一次最多 " + splitPlan.perGroup + " 张")
                + "，将分 " + splitPlan.groups + " 次生成（" + splitPlan.sizes.join(" + ") + "）"}
              {splitPlan.bumped ? "，尾数会补到该模型最小档位" : ""}
            </div>
            : null}
          {k && k !== "audio" && !byKind(k).length ? <div className="gen-note">还没有配置{KIND_LABEL[k]}模型，先到 API 设置里添加</div> : null}
          {k === "audio" ? <div className="gen-note">配音模型按已配置的语音合成模型自动选择</div> : null}
        </> : <div className="gen-note">这次不生成</div>}
      </ItemContent>
    </Item>;
  };

  /** 一张卡只放同一类节点：卡头（类型 + 节点数）、本卡类型的「统一模型」/「统一设置」、本卡的行 */
  const cardOf = (group: StepKindGroup) => {
    const kind = group.kind;
    const label = kind ? KIND_LABEL[kind] || "节点" : "节点";
    const size = group.indices.length;
    const checked = group.indices.filter((i) => rows[i]?.on).length;
    /** 「统一选择模型」只对本卡生效，且同类不止一行才有意义（门控与原来一致） */
    const bulkKind = (kind === "image" || kind === "video") && size > 1 && byKind(kind).length > 0 ? kind : null;
    const bulkValue = bulkKind ? bulkValueOf(bulkKind) : "";
    const bulkName = bulkValue ? (models.find((m) => m.id === bulkValue)?.name || "") : "";
    const unifiedCount = kind ? unifiedCountOf(kind) : 0;
    return <Card className="message-card gen-card" size="sm" key={kind || "other"} data-gen-card={kind || "other"}>
      <CardHeader className="mc-head">
        <div className="mc-head-row">
          <span className="mc-glyph"><Icon name={KIND_ICON[kind || ""] || "cube"} size="s" /></span>
          <CardTitle className="mc-title">{label}</CardTitle>
          <Badge className="mc-badge" size="sm">{checked < size ? checked + "/" + size + " 个节点" : size + " 个节点"}</Badge>
        </div>
        <div className="gen-sub">节点和提示词已经放上画布，选好模型和参数再生成</div>
      </CardHeader>
      <CardContent className="mc-body gen-body">
        {bulkKind || kind ? <div className="gen-fields gen-bulk" data-gen-unify-row>
          {bulkKind ? <GenField label="统一模型" text={bulkName || "统一选择模型"} empty={!bulkValue} busy={busy}
            onClick={openModels(byKind(bulkKind), bulkValue, (v) => setAll(bulkKind, v), "统一选择模型")} /> : null}
          {kind ? <GenField label="统一设置" wide={!bulkKind} busy={busy}
            text={unifiedCount ? "改过 " + unifiedCount + " 项" : "保持不改"}
            ariaLabel={(KIND_LABEL[kind] || "节点") + " · 统一设置"}
            attrs={{ "data-gen-unify": kind, "data-gen-unify-count": unifiedCount }}
            onClick={openUnified(kind)} /> : null}
        </div> : null}
        <ItemGroup arrowNavigation={false} className="gen-list" highlight={false}>
          {group.indices.map(rowOf)}
        </ItemGroup>
      </CardContent>
    </Card>;
  };

  /** 底部只这一份按钮：批准的是全部卡的全部步骤（口径没变），所以不放进任何一张类型卡里 */
  const footNote = !picked ? "至少勾选一个节点"
    : missing ? "还有 " + missing + " 个节点没选模型" + (totalText ? " · 共 " + totalText : "")
      : totalText ? "将生成 " + totalText + "（共 " + picked + " 个节点一次批准），完成后会自动审查并问你是否满意。"
        : "将生成 " + picked + " 个节点，完成后会自动审查并问你是否满意。";
  return <>
    {typeGroups.map(cardOf)}
    <div className="gen-foot" data-gen-foot>
      <div className="gen-foot-note" data-gen-total={totalText}>{footNote}</div>
      <div className="mc-actions gen-foot-actions">
        <Button className="mc-btn-solid" disabled={busy || !allReady} onClick={approve} size="sm" variant="default"><Icon name="play" size="s" />{"执行生成" + (picked && picked < steps.length ? " " + picked + " 个" : "")}</Button>
        <Button className="mc-btn-ghost" disabled={busy} onClick={onDiscard} size="sm" variant="ghost">先不生成</Button>
      </div>
    </div>
  </>;
}
