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

const vendorOf = (m: ModelSpec) => (m.vendor || "").trim() || (String(m.id).includes("::") ? String(m.id).split("::")[0] : "其它");

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

/** 模型：平台 → 模型 两级；第一级顶部有「跟随助手默认」（回调空串） */
export function PlanModelField({ models, value, busy, onChange }: {
  models: ModelSpec[]; value: string; busy: boolean; onChange: (id: string) => void;
}) {
  const hit = models.find((m) => m.id === value);
  const currentVendor = hit ? vendorOf(hit) : "";
  const vendors = [...new Set(models.map(vendorOf))];
  const showModels = (anchor: Element, vendor: string) => openPop(anchor, (close) => <ComboMenu
    autoFocus searchable searchPlaceholder="搜索模型"
    header={<div className="mh">{vendor}</div>}
    empty={<span>这个供应商还没有可用模型</span>}
    items={models.filter((m) => vendorOf(m) === vendor)}
    label={(m) => m.name}
    itemClassName={(m) => "mi combo-item" + (m.id === value ? " on" : "")}
    itemAttrs={(m) => ({ "data-model": m.id })}
    onPick={(m) => { close(); onChange(m.id); }}
    renderItem={(m) => <span style={{ flex: 1 }}>{m.name}<span className="d">{vendorOf(m)}</span></span>}
  />, "up", "left", "model-pop combo-pop gen-pop");
  return <PlanField label="模型" busy={busy} disabled={!models.length} text={hit ? hit.name : "跟随助手默认"} title={hit ? vendorOf(hit) + " · " + hit.name : "跟随助手默认"}
    render={() => {
      // 第一级列表顶部放「跟随助手默认」：用空串哨兵，不额外改 ComboMenu 的 API
      const rows = ["", ...vendors];
      return <ComboMenu
        autoFocus searchable searchPlaceholder="搜索供应商"
        header={<div className="mh">选择模型</div>}
        empty={<span>还没有配置模型</span>}
        items={rows}
        label={(v) => (v ? v : "跟随助手默认")}
        filterText={(v) => (v ? v : "跟随助手默认")}
        itemClassName={(v) => "mi combo-item" + ((v === currentVendor) || (!value && !v) ? " on" : "")}
        itemAttrs={(v) => ({ "data-vendor": v || "default" })}
        onPick={(v) => { if (!v) { onChange(""); return; } showModels(document.getElementById("pop")!, v); }}
        renderItem={(v) => v
          ? <><span style={{ flex: 1 }}>{v}<span className="d">{models.filter((m) => vendorOf(m) === v).length} 个模型</span></span><Icon name="right" size="s" /></>
          : <><span style={{ flex: 1 }}>跟随助手默认<span className="d">用运行上下文的默认模型</span></span></>}
      />;
    }} />;
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
