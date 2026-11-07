/**
 * 扩图框（对齐 TapNow 的「先框定扩展范围，再扩图」）。
 *
 * 交互：在整块画布上盖一层半透明遮罩，中间是「目标画布」预览；
 *   把四边 / 四角**往外拖**决定要扩多少，或直接点 1:1 / 4:3 / 16:9 / 9:16 让系统按比例补足；
 *   斜纹区域 = 待扩展部分（就是最终 PNG 里的透明区域）。
 *
 * 确认时按**原图自然尺寸**重新合成一张「原图 + 四周透明扩展」的 PNG（不是截图缩放），
 * 交给 registry 的 runEdit('outpaint')。视觉只用线框 + 遮罩 + 斜纹，不引 WebGL / 噪点。
 */
import { useEffect, useRef, useState } from "react";
import type { CanvasNode } from "../../../react-canvas/reactCanvasStore";
import { outOf } from "../../model";
import type { Ctl } from "../ctx";
import { Icon } from "../Icon";
import { useAssetUrl } from "../useAsset";
import {
  NO_EXT, PREVIEW_MAX_EXT, clampPreview, dragExt, fitRatio, hasExt, imageOffset,
  ratioOf, targetSize, type Ext, type Handle,
} from "./outpaint-geometry";

const RATIOS = ["自由", "1:1", "4:3", "16:9", "9:16"] as const;
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

const loadImg = (src: string) => new Promise<HTMLImageElement>((res, rej) => {
  const im = new Image(); im.crossOrigin = "anonymous";
  im.onload = () => res(im); im.onerror = () => rej(new Error("原图读取失败")); im.src = src;
});
const cv = (w: number, h: number) => { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };

export function OutpaintFrame({ ctl, n, source, onClose, onApply }: {
  ctl: Ctl;
  n: CanvasNode;
  /** 可显示的原图地址（已解析资源引用） */
  source: string;
  onClose: () => void;
  onApply: (pngDataUrl: string, ext: Ext) => void;
}) {
  const [base, setBase] = useState<{ w: number; h: number } | null>(null);
  const [ext, setExt] = useState<Ext>(NO_EXT);
  const [ratio, setRatio] = useState<string>("自由");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ h: Handle; x: number; y: number; ext: Ext } | null>(null);

  useEffect(() => {
    if (!source) return;
    let alive = true;
    void loadImg(source).then((im) => { if (alive) setBase({ w: im.naturalWidth || 1, h: im.naturalHeight || 1 }); })
      .catch(() => { if (alive) setErr("原图读取失败，无法扩图"); });
    return () => { alive = false; };
  }, [source]);

  const stage = ctl.rect();
  const availW = Math.max(240, stage.width - 96);
  const availH = Math.max(180, stage.height - 152);
  // 固定比例尺：按「最大可拖范围」算一次，拖动时原图不会跟着缩放跳动
  const k = base ? Math.min(availW / (base.w * (1 + 2 * PREVIEW_MAX_EXT)), availH / (base.h * (1 + 2 * PREVIEW_MAX_EXT))) : 1;
  const t = base ? targetSize(base, ext) : { w: 0, h: 0 };
  const off = base ? imageOffset(base, ext) : { x: 0, y: 0 };
  const boxW = t.w * k; const boxH = t.h * k;
  const left = (stage.width - boxW) / 2;
  const top = (stage.height - boxH) / 2 - 18;
  const showRatio = ratio !== "自由" ? ratio : ratioOf(t);

  const pickRatio = (r: string) => {
    setRatio(r);
    if (!base) return;
    if (r === "自由") return setExt((e) => e);
    const next = fitRatio(base, r);
    setExt(next ? clampPreview(next) : NO_EXT);
  };

  const down = (e: React.PointerEvent<HTMLElement>, h: Handle) => {
    e.stopPropagation(); e.preventDefault();
    if (!base) return;
    drag.current = { h, x: e.clientX, y: e.clientY, ext };
    const move = (ev: PointerEvent) => {
      const d = drag.current; if (!d) return;
      const px = { w: base.w * k, h: base.h * k };
      setExt(clampPreview(dragExt(d.ext, d.h, ev.clientX - d.x, ev.clientY - d.y, px)));
      setRatio((r) => (r === "自由" ? r : "自由")); // 手一拖就回到自由，避免比例标签和框体不一致
    };
    const up = () => { drag.current = null; removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  };

  const confirm = async () => {
    if (!base || !hasExt(ext) || busy) return;
    setBusy(true); setErr("");
    try {
      const im = await loadImg(source);
      const size = targetSize({ w: im.naturalWidth, h: im.naturalHeight }, ext);
      const at = imageOffset({ w: im.naturalWidth, h: im.naturalHeight }, ext);
      const c = cv(size.w, size.h);
      // 关键：画布默认全透明，原图按偏移画进去 → 四周留白就是待扩展的透明区
      c.getContext("2d")!.drawImage(im, at.x, at.y);
      onApply(c.toDataURL("image/png"), ext);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "扩图预览生成失败");
      setBusy(false);
    }
  };

  return <>
    <div className="op-stage" onPointerDown={(e) => e.stopPropagation()}>
      {base ? <>
        <div className="op-box" data-op-box style={{ left, top, width: boxW, height: boxH }}>
          {source ? <img src={source} alt="" style={{ left: off.x * k, top: off.y * k, width: base.w * k, height: base.h * k }} /> : null}
          <div className="op-src" data-op-src style={{ left: off.x * k, top: off.y * k, width: base.w * k, height: base.h * k }} />
          {HANDLES.map((h) => <i key={h} className="op-h" data-h={h} role="slider" tabIndex={0}
            aria-label={"向外拖动 " + h} onPointerDown={(e) => down(e, h)} />)}
          <div className="op-tip" data-op-tip style={{ left: 0, top: -34 }}>
            扩图到 {t.w}×{t.h} <span className="op-dim">· {showRatio}</span>
          </div>
        </div>
      </> : <div className="op-tip" style={{ left: "50%", top: "48%", transform: "translateX(-50%)" }}>{err || "正在读取原图…"}</div>}
    </div>
    <div className="edbar" style={{ left: stage.width / 2, top: Math.min(stage.height - 54, top + boxH + 22), transform: "translateX(-50%)" }} onPointerDown={(e) => e.stopPropagation()}>
      <button className="ib" data-tip="取消" data-k="op-x" onClick={onClose}><Icon name="x" /></button><span className="vsep" />
      <span className="est">扩图</span>
      <span className="vsep" />
      {RATIOS.map((r) => <button key={r} data-k={"op-r-" + r} className={"pill" + (ratio === r ? " on" : "")}
        style={ratio === r ? { background: "var(--solid)", color: "var(--on-solid)" } : undefined}
        onClick={() => pickRatio(r)}>{r}</button>)}
      <span className="vsep" />
      <button className="pill" data-k="op-reset" onClick={() => { setRatio("自由"); setExt(NO_EXT); }}><Icon name="undo" size="s" />重置</button>
      <button className="pill" data-k="op-ok" disabled={!hasExt(ext) || busy}
        style={{ background: "var(--solid)", color: "var(--on-solid)", opacity: hasExt(ext) ? 1 : .45 }}
        onClick={() => void confirm()}>{busy ? "生成中…" : "确认扩图"}</button>
    </div>
  </>;
}
