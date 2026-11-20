/**
 * 助手卡片（待生成卡片 GenerationCard / 方案卡 TaskPlanCard）共用的模型选择：两级弹层，和节点面板的模型选择同一套交互。
 *   · 第一级：供应商列表（带 logo 和「N 个模型」），可搜索；可选在顶部放「跟随助手默认」
 *   · 第二级：这个供应商下的模型（模型名 + 规格），可搜索；顶部有「返回供应商列表」
 * 数据就是调用方传进来的那一类模型（已按 kind 过滤），不在这里再筛：设置里配了几个就显示几个。
 */
import type { ReactNode } from "react";
import { ComboMenu } from "../ui/combo";
import { Icon } from "../ui/Icon";
import { openPop } from "../ui/overlay";
import { VendorLogo } from "../ui/VendorLogo";
import type { ModelSpec } from "../model";

export const modelVendorOf = (m: ModelSpec) => (m.vendor || "").trim() || (String(m.id).includes("::") ? String(m.id).split("::")[0] : "其它");

export type ModelPickerOpts = {
  models: ModelSpec[];
  value: string;
  onPick: (id: string) => void;
  /** 第一级标题，例如「图片模型 · 选择供应商」 */
  title?: string;
  /** 第一级顶部放「跟随助手默认」（回调空串） */
  allowDefault?: boolean;
  /** 模型行的副标题（规格）；不给就只写供应商 */
  specLine?: (m: ModelSpec) => string;
  dir?: "down" | "up";
  cls?: string;
};

export function openModelPicker(anchor: Element, o: ModelPickerOpts) {
  const dir = o.dir || "down";
  const cls = o.cls || "gen-pop model-pop combo-pop";
  const current = o.models.find((m) => m.id === o.value);
  const currentVendor = current ? modelVendorOf(current) : "";
  const vendors = [...new Set(o.models.map(modelVendorOf))];
  const countOf = (v: string) => o.models.filter((m) => modelVendorOf(m) === v).length;
  // 一级弹层卸载后锚点可能跟着没了：先把矩形量下来，二级 / 返回都按它摆
  const r = anchor.getBoundingClientRect();
  const at: Element | { x: number; y: number } = anchor.isConnected && (r.width || r.height) ? anchor : { x: r.left, y: dir === "up" ? r.top : r.bottom };

  const showModels = (vendor: string) => openPop(at, (close) => <ComboMenu
    autoFocus searchable searchPlaceholder="搜索模型"
    header={<>
      <button className="mi" data-model-back aria-label="返回供应商列表" onClick={showVendors}><Icon name="left" size="s" /><span style={{ flex: 1 }}>{vendor}<span className="d">返回供应商列表</span></span></button>
      <div className="msep" />
    </>}
    empty={<span>{countOf(vendor) ? "没有匹配的模型" : "这个供应商还没有模型"}</span>}
    items={o.models.filter((m) => modelVendorOf(m) === vendor)}
    label={(m: ModelSpec) => m.name}
    itemClassName={(m: ModelSpec) => "mi combo-item gen-model-item" + (m.id === o.value ? " on" : "")}
    itemAttrs={(m: ModelSpec) => ({ "data-model": m.id })}
    onPick={(m: ModelSpec) => { close(); o.onPick(m.id); }}
    renderItem={(m: ModelSpec) => <>
      <VendorLogo name={m.vendor} model={m.name} size={14} />
      <span style={{ flex: 1, minWidth: 0 }}>{m.name}<span className="d">{(o.specLine && o.specLine(m)) || modelVendorOf(m)}</span></span>
      {m.id === o.value ? <Icon name="check" size="s" /> : null}
    </>}
  />, dir, "left", cls);

  const showVendors = (): void => {
    const rows: string[] = o.allowDefault ? ["", ...vendors] : vendors;
    openPop(at, (close) => <ComboMenu
      autoFocus searchable searchPlaceholder="搜索供应商"
      header={<div className="mh">{o.title || "选择供应商"}</div>}
      empty={<span>还没有配置模型</span>}
      items={rows}
      label={(v: string) => (v ? v : "跟随助手默认")}
      filterText={(v: string) => (v ? v : "跟随助手默认")}
      itemClassName={(v: string) => "mi combo-item" + ((v && v === currentVendor) || (!v && !o.value) ? " on" : "")}
      itemAttrs={(v: string) => ({ "data-vendor": v || "default" })}
      onPick={(v: string) => { if (!v) { close(); o.onPick(""); return; } showModels(v); }}
      renderItem={(v: string): ReactNode => v
        ? <><VendorLogo name={v} size={16} /><span style={{ flex: 1 }}>{v}<span className="d">{countOf(v)} 个模型{v === currentVendor && current ? " · 当前 " + current.name : ""}</span></span><Icon name="right" size="s" /></>
        : <><Icon name="sparkle" size="s" /><span style={{ flex: 1 }}>跟随助手默认<span className="d">用运行上下文的默认模型</span></span></>}
    />, dir, "left", cls);
  };

  // 只有一个供应商时直接进第二级（返回键仍然在），少点一次
  if (!o.allowDefault && vendors.length === 1) showModels(vendors[0]);
  else showVendors();
}
