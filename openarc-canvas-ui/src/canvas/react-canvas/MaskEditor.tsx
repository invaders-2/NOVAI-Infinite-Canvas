import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

type Mode = "redraw" | "erase" | "outpaint";
type Props = {
  url: string;
  onCancel: () => void;
  onGenerate: (payload: { mode: Mode; prompt: string; sourceDataUrl: string }) => Promise<void>;
};

export function MaskEditor({ url, onCancel, onGenerate }: Props) {
  const [mode, setMode] = useState<Mode>("redraw");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [strokes, setStrokes] = useState<Array<{ size: number; points: Array<{ x: number; y: number }> }>>([]);
  const [drawing, setDrawing] = useState(false);
  const [size, setSize] = useState(28);
  const baseRef = useRef<HTMLImageElement | null>(null);
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const lastRef = useRef<{ x: number; y: number } | null>(null);

  const redrawMask = () => {
    const canvas = maskRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(255,64,64,.45)";
    for (const stroke of strokes) {
      if (stroke.points.length < 2) continue;
      ctx.lineWidth = stroke.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(255,64,64,.45)";
      ctx.beginPath();
      stroke.points.forEach((point, index) => { if (index === 0) ctx.moveTo(point.x, point.y); else ctx.lineTo(point.x, point.y); });
      ctx.stroke();
    }
  };

  useEffect(() => {
    const img = new Image();
    if (!url.startsWith("data:")) img.crossOrigin = "anonymous";
    img.onload = () => {
      baseRef.current = img;
      const canvas = maskRef.current;
      if (canvas) { canvas.width = img.naturalWidth; canvas.height = img.naturalHeight; redrawMask(); }
    };
    img.onerror = () => setError("图片加载失败，可能跨域");
    img.src = url;
  }, [url]);
  useEffect(() => { redrawMask(); }, [strokes]);

  const pointOf = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * canvas.width, y: ((event.clientY - rect.top) / rect.height) * canvas.height };
  };

  const confirm = async () => {
    const img = baseRef.current;
    if (!img) { setError("图片尚未加载"); return; }
    if (!strokes.length && mode !== "outpaint") { setError("请先涂抹需要编辑的区域"); return; }
    setBusy(true); setError("");
    try {
      const scale = mode === "outpaint" ? 1.5 : 1;
      const outW = Math.round(img.naturalWidth * scale);
      const outH = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = outW; canvas.height = outH;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("CANVAS_UNAVAILABLE");
      const offsetX = Math.round((outW - img.naturalWidth) / 2);
      const offsetY = Math.round((outH - img.naturalHeight) / 2);
      ctx.drawImage(img, offsetX, offsetY, img.naturalWidth, img.naturalHeight);
      const mask = document.createElement("canvas");
      mask.width = outW; mask.height = outH;
      const mctx = mask.getContext("2d");
      if (!mctx) throw new Error("CANVAS_UNAVAILABLE");
      mctx.fillStyle = "#000";
      for (const stroke of strokes) {
        mctx.lineWidth = stroke.size * scale;
        mctx.lineCap = "round";
        mctx.lineJoin = "round";
        mctx.beginPath();
        stroke.points.forEach((point, index) => { const x = point.x * scale + offsetX; const y = point.y * scale + offsetY; if (index === 0) mctx.moveTo(x, y); else mctx.lineTo(x, y); });
        mctx.stroke();
      }
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(mask, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      const dataUrl = canvas.toDataURL("image/png");
      await onGenerate({ mode, prompt, sourceDataUrl: dataUrl });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "图片编辑失败");
    } finally { setBusy(false); }
  };

  return (
    <div className="rc-mask-editor" data-testid="mask-editor" onClick={onCancel}>
      <div className="rc-mask-panel" onClick={(event) => event.stopPropagation()}>
        <div className="rc-mask-head"><strong>AI 蒙版编辑</strong><button data-testid="mask-cancel" onClick={onCancel}>取消</button></div>
        <div className="rc-mask-modes">
          {(["redraw", "erase", "outpaint"] as const).map((item) => (
            <button key={item} data-testid={"mask-mode-" + item} className={mode === item ? "is-active" : ""} onClick={() => setMode(item)}>{item === "redraw" ? "局部重绘" : item === "erase" ? "擦除" : "扩图"}</button>
          ))}
        </div>
        <div className="rc-mask-stage">
          <img src={url} alt="蒙版编辑原图" />
          <canvas ref={maskRef} data-testid="mask-canvas" onPointerDown={(event) => { event.currentTarget.setPointerCapture?.(event.pointerId); setDrawing(true); const p = pointOf(event); lastRef.current = p; setStrokes((prev) => [...prev, { size, points: [p] }]); }} onPointerMove={(event) => { if (!drawing) return; const p = pointOf(event); const last = lastRef.current; if (!last) return; lastRef.current = p; setStrokes((prev) => { const next = prev.slice(); const active = next[next.length - 1]; if (active) next[next.length - 1] = { ...active, points: [...active.points, p] }; return next; }); }} onPointerUp={() => { setDrawing(false); lastRef.current = null; }} />
        </div>
        <div className="rc-mask-tools">
          <label>笔刷 <input type="range" min="8" max="80" data-testid="mask-size" value={size} onChange={(event) => setSize(Number(event.target.value))} /></label>
          <button data-testid="mask-clear" onClick={() => setStrokes([])}>清空</button>
          <span>涂抹区域将生成透明洞</span>
        </div>
        {mode !== "erase" && mode !== "outpaint" ? <textarea data-testid="mask-prompt" placeholder="重绘提示词（可选）" value={prompt} onChange={(event) => setPrompt(event.target.value)} /> : null}
        {mode === "outpaint" ? <p className="rc-mask-note">扩图：画布向四周扩展 25% 透明边</p> : null}
        {error ? <div className="rc-lan-error" data-testid="mask-error">{error}</div> : null}
        <div className="rc-mask-actions"><button data-testid="mask-confirm" disabled={busy} onClick={() => void confirm()}>{busy ? "生成中…" : "生成"}</button></div>
      </div>
    </div>
  );
}
