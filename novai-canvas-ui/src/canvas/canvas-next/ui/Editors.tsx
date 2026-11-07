/**
 * 图片编辑入口（工具条：裁剪 / 多角度 / 局部重绘 / 重打光 / 更多）。
 * 纯前端的（裁剪、切分、截帧）直接在本地完成并作为新版本写回；
 * 需要模型的（多角度、重绘、重打光、扩图、擦除、增强、抠图）走 backend.generate（图片编辑），结果同样进历史版本。
 */
import { useEffect } from "react";
import { useCtl } from "./ctx";
import { EditorLayer, openEditor } from "./editors/registry";
import { ColorAdjustLayer } from "./editors/ColorAdjust";
import { LosslessEditLayer, warmLosslessTool } from "./editors/LosslessEdit";

export function Editors() {
  const ctl = useCtl();
  // 画布已经在跑：空闲时把无损改图的工具页（939KB 单文件）先下进 HTTP 缓存，别等用户点开才下
  useEffect(() => { warmLosslessTool(ctl.store.state.ui.theme); }, [ctl]);
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent).detail as { kind: string; id: string; anchor?: Element }; openEditor(ctl, d.kind, d.id, d.anchor); };
    addEventListener("cn:editor", on); return () => removeEventListener("cn:editor", on);
  }, [ctl]);
  return <><EditorLayer /><LosslessEditLayer /><ColorAdjustLayer /></>;
}
