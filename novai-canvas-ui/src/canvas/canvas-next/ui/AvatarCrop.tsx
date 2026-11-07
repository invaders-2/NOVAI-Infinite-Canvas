/**
 * 头像裁切（我的资料）：240px 圆形预览里拖动取景，滚轮 / 双指捏合 / 滑块缩放，
 * 双击或「重置」回中。确定时按 256/240 把同一套预览 px 参数放大绘制，
 * 保证导出和看到的取景逐像素对得上；JPEG 质量逐级下探，满足后端 200KB 上限。
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export const CROP_VIEW = 240;
export const CROP_OUT = 256;
/** 后端 MAX_AVATAR_BYTES = 200KB；留 2KB 余量给 dataURL 前缀 */
export const AVATAR_LIMIT_BYTES = 200 * 1024 - 2048;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

type Params = { zoom: number; ox: number; oy: number };
type Dims = { baseW: number; baseH: number };
type Point = { x: number; y: number };
export type AvatarCropProps = {
  image: HTMLImageElement;
  onCancel: () => void;
  onConfirm: (dataUrl: string) => void;
};

/** 铺满圆的最小比例：短边等于预览直径，zoom=1 时任何方向都不留白 */
function dimsOf(image: HTMLImageElement): Dims {
  const w = Math.max(1, image.naturalWidth || image.width || 1);
  const h = Math.max(1, image.naturalHeight || image.height || 1);
  const cover = Math.max(CROP_VIEW / w, CROP_VIEW / h);
  return { baseW: w * cover, baseH: h * cover };
}

function layoutOf(params: Params, dims: Dims) {
  const dw = dims.baseW * params.zoom;
  const dh = dims.baseH * params.zoom;
  const maxX = Math.max(0, (dw - CROP_VIEW) / 2);
  const maxY = Math.max(0, (dh - CROP_VIEW) / 2);
  const ox = Math.min(maxX, Math.max(-maxX, params.ox));
  const oy = Math.min(maxY, Math.max(-maxY, params.oy));
  return { dw, dh, ox, oy, left: (CROP_VIEW - dw) / 2 + ox, top: (CROP_VIEW - dh) / 2 + oy };
}

/** 缩放先夹到 1..4，位移再夹到「图片始终盖满圆」的范围 */
function normalize(params: Params, dims: Dims): Params {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, params.zoom));
  const layout = layoutOf({ ...params, zoom }, dims);
  return { zoom, ox: layout.ox, oy: layout.oy };
}

/** 以预览里的 (px, py) 为锚点缩放：滚轮 / 双指捏合都盯着指针位置放大，和外壳「我的资料」一致 */
function zoomAt(params: Params, nextZoom: number, px: number, py: number, dims: Dims): Params {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
  if (Math.abs(zoom - params.zoom) < 1e-4) return params;
  const ratio = zoom / params.zoom;
  const current = layoutOf(params, dims);
  const left = px - (px - current.left) * ratio;
  const top = py - (py - current.top) * ratio;
  const dw = dims.baseW * zoom;
  const dh = dims.baseH * zoom;
  return normalize({ zoom, ox: left - (CROP_VIEW - dw) / 2, oy: top - (CROP_VIEW - dh) / 2 }, dims);
}

function utf8Bytes(text: string) {
  return new TextEncoder().encode(text).length;
}

function renderAvatar(image: HTMLImageElement, dims: Dims, params: Params) {
  const layout = layoutOf(params, dims);
  const scale = CROP_OUT / CROP_VIEW;
  const canvas = document.createElement("canvas");
  canvas.width = CROP_OUT;
  canvas.height = CROP_OUT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("当前浏览器不支持图片处理");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  // JPEG 没有透明通道：先铺白底，和外壳「我的资料」一致
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, CROP_OUT, CROP_OUT);
  ctx.drawImage(image, layout.left * scale, layout.top * scale, layout.dw * scale, layout.dh * scale);
  for (let quality = 0.92; quality >= 0.28; quality -= 0.06) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (utf8Bytes(dataUrl) <= AVATAR_LIMIT_BYTES) return dataUrl;
  }
  throw new Error("这张图片压缩后仍超过 200KB，换一张试试");
}

export function AvatarCrop({ image, onCancel, onConfirm }: AvatarCropProps) {
  const dims = useMemo(() => dimsOf(image), [image]);
  const [params, setParams] = useState<Params>({ zoom: 1, ox: 0, oy: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const stageRef = useRef<HTMLDivElement | null>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const dragRef = useRef<{ id: number; x: number; y: number; ox: number; oy: number } | null>(null);
  const pinchRef = useRef<{ dist: number; zoom: number } | null>(null);
  const paramsRef = useRef(params);
  const layout = layoutOf(params, dims);

  useEffect(() => { paramsRef.current = params; }, [params]);

  // React 的 onWheel 是 passive 的，阻止不了弹窗/画布跟着滚；这里挂原生监听
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const px = Math.min(CROP_VIEW, Math.max(0, event.clientX - rect.left));
      const py = Math.min(CROP_VIEW, Math.max(0, event.clientY - rect.top));
      const factor = Math.exp(-event.deltaY * 0.0018);
      setParams((current) => zoomAt(current, current.zoom * factor, px, py, dims));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [dims]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size === 1) {
      dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: params.ox, oy: params.oy };
      pinchRef.current = null;
    } else if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      dragRef.current = null;
      pinchRef.current = { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), zoom: params.zoom };
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pinch = pinchRef.current;
    if (pinch && pointersRef.current.size >= 2) {
      const [a, b] = [...pointersRef.current.values()];
      const ratio = Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist;
      const rect = stageRef.current?.getBoundingClientRect();
      const px = rect ? Math.min(CROP_VIEW, Math.max(0, (a.x + b.x) / 2 - rect.left)) : CROP_VIEW / 2;
      const py = rect ? Math.min(CROP_VIEW, Math.max(0, (a.y + b.y) / 2 - rect.top)) : CROP_VIEW / 2;
      setParams((current) => zoomAt(current, pinch.zoom * ratio, px, py, dims));
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    setParams((current) => normalize({
      zoom: current.zoom,
      ox: drag.ox + (event.clientX - drag.x),
      oy: drag.oy + (event.clientY - drag.y),
    }, dims));
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* 已经释放 */ }
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 1) {
      const [id, point] = [...pointersRef.current.entries()][0];
      dragRef.current = { id, x: point.x, y: point.y, ox: paramsRef.current.ox, oy: paramsRef.current.oy };
    } else if (!pointersRef.current.size) {
      dragRef.current = null;
    }
  };

  const reset = () => { setParams({ zoom: 1, ox: 0, oy: 0 }); setError(""); };

  const confirm = () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      onConfirm(renderAvatar(image, dims, params));
    } catch (err) {
      setError(err instanceof Error ? err.message : "导出失败，换一张试试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lan-crop" data-lan-crop>
      <div
        ref={stageRef}
        className="lan-crop-stage"
        data-lan-crop-stage
        role="application"
        aria-label="拖动调整头像取景，滚轮或双指缩放"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDoubleClick={reset}
      >
        <img
          data-lan-crop-img
          src={image.currentSrc || image.src}
          alt=""
          draggable={false}
          style={{ left: layout.left, top: layout.top, width: layout.dw, height: layout.dh }}
        />
      </div>
      <div className="lan-crop-zoom">
        <span className="lan-crop-zoom-val" data-lan-crop-zoom-text>{params.zoom.toFixed(1)}×</span>
        <input
          type="range"
          data-lan-crop-zoom
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.01}
          value={params.zoom}
          aria-label="缩放头像取景"
          onChange={(event) => { setParams((current) => zoomAt(current, Number(event.target.value), CROP_VIEW / 2, CROP_VIEW / 2, dims)); setError(""); }}
        />
      </div>
      <p className="lan-crop-hint">拖动移动取景，滚轮或双指缩放，双击预览回中</p>
      {error ? <p className="lan-crop-error" data-lan-crop-error>{error}</p> : null}
      <div className="lan-crop-acts">
        <button type="button" className="lan-btn" data-lan-crop-reset onClick={reset}>重置</button>
        <button type="button" className="lan-btn" data-lan-crop-cancel onClick={onCancel}>取消</button>
        <button type="button" className="lan-btn pri" data-lan-crop-confirm disabled={busy} onClick={confirm}>{busy ? "导出中…" : "确定"}</button>
      </div>
    </div>
  );
}
