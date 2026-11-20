/**
 * 方案卡（TaskPlanCard）的参数选择器：全部走项目自己的 #pop 弹层（openPop），不再用原生 <select>。
 *   · 模型：两级（平台 → 模型），样式/数据源与 GenerationCard 的 ComboMenu 一致，另有「跟随助手默认」
 *   · 比例：OptCards 格子（与 GenPanel / 待生成卡片一致）
 *   · 分辨率 / 张数 / 时长 / 生成方式：ComboMenu 列表
 * 键盘：button 原生 Enter/Space 打开，overlay 的 Esc 关闭；禁用态照旧。
 */
import type { ReactNode } from "react";
import { ComboMenu } from "../ui/combo";
import { Icon } from "../ui/Icon";
import { OptCards, ratioShape } from "../ui/OptCards";
import { openPop } from "../ui/overlay";
import { ratioDisplayLabel } from "../originalRatio";
import type { ModelSpec } from "../model";
import { modelVendorOf, openModelPicker } from "./ModelPicker";


function PlanField({ label, text, busy, disabled, title, render }: {
  label: string; text: ReactNode; busy: boolean; disabled?: boolean; title?: string;
  render: (close: () => void) => ReactNode;
}) {
  return <div className="pr">
    <span>{label}</span>
    <button type="button" className="pr-btn" disabled={busy || disabled} title={title || label} aria-label={label}
      onClick={(e) => openPop(e.currentTarget, (close) => render(close), "up", "left", "gen-pop param-pop")}>
      <span className="t">{text}</span><Icon name="down" size="xs" />
    </button>
  </div>;
}

/** 模型：供应商 → 模型 两级（共用 ModelPicker，第二级带「返回供应商列表」）；第一级顶部有「跟随助手默认」（回调空串） */
export function PlanModelField({ models, value, busy, onChange }: {
  models: ModelSpec[]; value: string; busy: boolean; onChange: (id: string) => void;
}) {
  const hit = models.find((m) => m.id === value);
  /* 调用方把这一类的默认模型排在最前（AgentPanel 的 planModels）：「跟随助手默认」后面带上它的名字，
     选项按谁算、执行用谁，一眼看得见 */
  const fallback = models[0];
  const defaultText = "跟随助手默认" + (fallback ? "（" + fallback.name + "）" : "");
  return <div className="pr">
    <span>模型</span>
    <button type="button" className="pr-btn" disabled={busy || !models.length} title={hit ? modelVendorOf(hit) + " · " + hit.name : defaultText} aria-label="模型"
      onClick={(e) => openModelPicker(e.currentTarget, { models, value, onPick: onChange, title: "选择模型", allowDefault: true, dir: "up", cls: "gen-pop param-pop model-pop combo-pop" })}>
      <span className="t">{hit ? hit.name : defaultText}</span><Icon name="down" size="xs" />
    </button>
  </div>;
}

/** 比例：格子（带画幅形状） */
export function PlanRatioField({ options, current, busy, onChange }: {
  options: string[]; current: string; busy: boolean; onChange: (ratio: string) => void;
}) {
  const render = (close: () => void) => <>
    <div className="mh">比例</div>
    <OptCards cols={Math.max(1, Math.min(options.length, 4))} items={options.map((value) => ({
      key: value, label: ratioDisplayLabel(value), shape: ratioShape(value, 20), on: value === current, disabled: busy,
      pick: () => { onChange(value); close(); },
    }))} />
  </>;
  return <PlanField label="比例" busy={busy} text={ratioDisplayLabel(current)} render={render} />;
}

/** 分辨率 / 张数 / 时长 / 生成方式：列表弹层 */
export function PlanListField({ label, options, current, busy, onChange }: {
  label: string; options: Array<{ value: string; label: string }>; current: string; busy: boolean;
  onChange: (value: string) => void;
}) {
  const text = options.find((item) => item.value === current)?.label || current;
  return <PlanField label={label} busy={busy} disabled={!options.length} text={text} render={(close) => <ComboMenu
    autoFocus
    header={<div className="mh">{label}</div>}
    items={options}
    label={(item) => item.label}
    itemClassName={(item) => "mi combo-item" + (item.value === current ? " on" : "")}
    itemAttrs={(item) => ({ "data-value": item.value })}
    onPick={(item) => { close(); onChange(item.value); }}
    renderItem={(item) => <span style={{ flex: 1 }}>{item.label}</span>}
  />} />;
}
