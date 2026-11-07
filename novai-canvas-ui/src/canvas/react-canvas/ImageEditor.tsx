import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

type Rect = { x: number; y: number; w: number; h: number };
type Props = { url: string; mode: "view" | "crop" | "annotate"; onCancel: () => void; onApply: (dataUrl: string) => void; onMagic?: () => void; onGrid?: (count: number) => void };
const RATIOS = [{ id: "free", label: "自由", v: null }, { id: "1:1", label: "1:1", v: 1 }, { id: "16:9", label: "16:9", v: 16 / 9 }, { id: "9:16", label: "9:16", v: 9 / 16 }, { id: "4:3", label: "4:3", v: 4 / 3 }];

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!url.startsWith("data:")) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("LOAD_FAILED"));
    img.src = url;
  });
}

export function ImageEditor({ url, mode, onCancel, onApply, onMagic, onGrid }: Props) {
  const [error, setError] = useState("");
  const [tool, setTool] = useState<"view" | "crop" | "annotate">(mode);
  const [displayUrl, setDisplayUrl] = useState(url);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const [gridOpen, setGridOpen] = useState(false);
  const [brightness, setBrightness] = useState(1);
  const [contrast, setContrast] = useState(1);
  const [saturate, setSaturate] = useState(1);
  const [ratio, setRatio] = useState("free");
  const [rect, setRect] = useState<Rect>({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  const [brush, setBrush] = useState("#ff3b3b");
  const [size, setSize] = useState(6);
  const [strokes, setStrokes] = useState<string[]>([]);
  const [drawing, setDrawing] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ kind: string; sx: number; sy: number; rect: Rect } | null>(null);

  const redraw = () => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !img || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const snapshot of strokes) {
      const stroke = new Image();
      stroke.src = snapshot;
      // 同步快照在绘制队列中按序恢复
      try { ctx.drawImage(stroke, 0, 0, canvas.width, canvas.height); } catch { /* ignore */ }
    }
  };

  useEffect(() => {
    if (mode !== "annotate") return;
    loadImage(url).then((img) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      imageRef.current = img;
      redraw();
    }).catch(() => setError("图片加载失败，可能跨域"));
  }, [url, mode]);

  const setRatioValue = (id: string) => {
    setRatio(id);
    const v = RATIOS.find((item) => item.id === id)?.v;
    if (!v) return;
    setRect((prev) => {
      const w = Math.min(prev.w, 0.9);
      const h = Math.min(0.9, w / v);
      const width = h * v;
      return { x: Math.max(0, Math.min(1 - width, prev.x)), y: Math.max(0, Math.min(1 - h, prev.y)), w: width, h };
    });
  };

  const startDrag = (event: ReactPointerEvent, kind: string) => {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { kind, sx: event.clientX, sy: event.clientY, rect: { ...rect } };
  };

  const moveDrag = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    const stage = stageRef.current;
    if (!drag || !stage) return;
    const bounds = stage.getBoundingClientRect();
    const dx = (event.clientX - drag.sx) / Math.max(1, bounds.width);
    const dy = (event.clientY - drag.sy) / Math.max(1, bounds.height);
    setRect(() => {
      const s = drag.rect;
      if (drag.kind === "move") return { ...s, x: Math.max(0, Math.min(1 - s.w, s.x + dx)), y: Math.max(0, Math.min(1 - s.h, s.y + dy)) };
      let x = s.x, y = s.y, w = s.w, h = s.h;
      if (drag.kind.includes("e")) w = Math.max(0.08, Math.min(1 - s.x, s.w + dx));
      if (drag.kind.includes("s")) h = Math.max(0.08, Math.min(1 - s.y, s.h + dy));
      if (drag.kind.includes("w")) { const nw = Math.max(0.08, Math.min(s.x + s.w, s.w - dx)); x = s.x + s.w - nw; w = nw; }
      if (drag.kind.includes("n")) { const nh = Math.max(0.08, Math.min(s.y + s.h, s.h - dy)); y = s.y + s.h - nh; h = nh; }
      const v = RATIOS.find((item) => item.id === ratio)?.v || null;
      if (v) { h = w / v; if (h > 1 - y) { h = 1 - y; w = h * v; } if (w > 1 - x) { w = 1 - x; h = w / v; } }
      return { x, y, w, h };
    });
  };

  const confirmCrop = async () => {
    try {
      const img = await loadImage(url);
      const sw = Math.max(1, Math.round(rect.w * img.naturalWidth));
      const sh = Math.max(1, Math.round(rect.h * img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = sw; canvas.height = sh;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("CANVAS_UNAVAILABLE");
      ctx.drawImage(img, Math.round(rect.x * img.naturalWidth), Math.round(rect.y * img.naturalHeight), sw, sh, 0, 0, sw, sh);
      onApply(canvas.toDataURL("image/png"));
    } catch { setError("裁剪失败：图片读取失败或跨域，原图未修改"); }
  };

  const pointOf = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const bounds = canvas.getBoundingClientRect();
    return { x: ((event.clientX - bounds.left) / bounds.width) * canvas.width, y: ((event.clientY - bounds.top) / bounds.height) * canvas.height };
  };

  const saveStrokeSnapshot = () => {
    const canvas = canvasRef.current;
    if (canvas) setStrokes((prev) => [...prev, canvas.toDataURL("image/png")]);
  };


  const applyColor = async () => {
    try {
      const img = await loadImage(displayUrl);
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d"); if (!ctx) return;
      ctx.filter = "brightness(" + brightness + ") contrast(" + contrast + ") saturate(" + saturate + ")";
      ctx.drawImage(img, 0, 0);
      const next = canvas.toDataURL("image/png");
      setDisplayUrl(next); onApply(next);
    } catch { setError("调色失败"); }
  };

  const transformImage = async (kind: "rotate" | "flip-h" | "flip-v" | "upscale") => {
    try {
      const img = await loadImage(displayUrl);
      const scale = kind === "upscale" ? 2 : 1;
      const rotate = kind === "rotate";
      const canvas = document.createElement("canvas");
      canvas.width = rotate ? img.naturalHeight : img.naturalWidth * scale;
      canvas.height = rotate ? img.naturalWidth : img.naturalHeight * scale;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.translate(canvas.width / 2, canvas.height / 2);
      if (rotate) ctx.rotate(Math.PI / 2);
      if (kind === "flip-h") ctx.scale(-1, 1);
      if (kind === "flip-v") ctx.scale(1, -1);
      ctx.drawImage(img, -img.naturalWidth * scale / 2, -img.naturalHeight * scale / 2, img.naturalWidth * scale, img.naturalHeight * scale);
      const next = canvas.toDataURL("image/png");
      setDisplayUrl(next);
      onApply(next);
    } catch { setError("图片处理失败"); }
  };

  return (
    <div className="rc-image-editor" data-testid="image-editor-overlay" onClick={onCancel}>
      <div className="rc-image-editor-panel" onClick={(event) => event.stopPropagation()}>
      <div className="rc-image-editor-toolbar" data-testid="image-editor-toolbar">
        <button data-testid="image-download" onClick={() => { const a = document.createElement("a"); a.href = displayUrl; a.download = "image.png"; a.click(); }}>下载</button>
        <button data-testid="image-preview" onClick={() => setPreviewOpen(true)}>预览</button>
        <button data-testid="image-rotate" onClick={() => void transformImage("rotate")}>旋转</button>
        <button data-testid="image-flip-h" onClick={() => void transformImage("flip-h")}>水平翻转</button>
        <button data-testid="image-flip-v" onClick={() => void transformImage("flip-v")}>垂直翻转</button>
        <button data-testid="image-adjust" onClick={() => setColorOpen(!colorOpen)}>调色</button>
        <button data-testid="image-reset" onClick={() => setDisplayUrl(url)}>重置</button>
        <button data-testid="image-crop" onClick={() => setTool("crop")}>裁剪</button>
        <button data-testid="image-annotate" onClick={() => setTool("annotate")}>标注</button>
        <button data-testid="image-grid" onClick={() => setGridOpen(!gridOpen)}>宫格</button>
        <button data-testid="image-upscale" onClick={() => void transformImage("upscale")}>本地 2x</button>
        <button data-testid="image-magic" onClick={() => onMagic?.()}>AI 蒙版</button>
      </div>

      {colorOpen ? <div className="rc-image-color-pop" data-testid="image-color-pop">
        {([["brightness","亮度",brightness,setBrightness],["contrast","对比度",contrast,setContrast],["saturate","饱和度",saturate,setSaturate]] as const).map(([key,label,value,setter]) => (
          <label key={key}>{label}<input type="range" min="0.5" max="1.5" step="0.05" value={value} onChange={(event) => setter(Number(event.target.value))} /></label>
        ))}
        <div className="rc-image-color-actions"><button data-testid="image-color-cancel" onClick={() => setColorOpen(false)}>取消</button><button data-testid="image-color-apply" onClick={() => void applyColor()}>确认</button></div>
      </div> : null}
      {gridOpen ? <div className="rc-grid-menu" data-testid="image-grid-menu"><button data-testid="image-grid-2" onClick={() => onGrid?.(2)}>2×2</button><button data-testid="image-grid-3" onClick={() => onGrid?.(3)}>3×3</button></div> : null}
      {previewOpen ? <div className="rc-image-preview" data-testid="image-preview-overlay" onClick={() => setPreviewOpen(false)}><img src={displayUrl} alt="预览" onClick={(event) => event.stopPropagation()} /></div> : null}

        <div className="rc-image-editor-head"><strong>{tool === "crop" ? "裁剪" : "标注"}</strong><button data-testid="image-editor-cancel" onClick={onCancel}>取消</button></div>
        {tool === "crop" ? (
          <>
            <div className="rc-crop-stage" ref={stageRef}>
              <img src={url} alt="裁剪预览" draggable={false} />
              <div className="rc-crop-box" data-testid="image-crop-box" style={{ left: rect.x * 100 + "%", top: rect.y * 100 + "%", width: rect.w * 100 + "%", height: rect.h * 100 + "%" }} onPointerDown={(event) => startDrag(event, "move")} onPointerMove={moveDrag} onPointerUp={() => { dragRef.current = null; }}>
                {["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((handle) => <span key={handle} className={"rc-crop-handle rc-crop-" + handle} data-testid={"crop-handle-" + handle} onPointerDown={(event) => startDrag(event, handle)} onPointerMove={moveDrag} onPointerUp={() => { dragRef.current = null; }} />)}
              </div>
            </div>
            <div className="rc-crop-ratios">{RATIOS.map((item) => <button key={item.id} data-testid={"crop-ratio-" + item.id} className={ratio === item.id ? "is-active" : ""} onClick={() => setRatioValue(item.id)}>{item.label}</button>)}</div>
            <div className="rc-image-editor-actions"><button data-testid="image-crop-confirm" onClick={() => void confirmCrop()}>确认裁剪</button></div>
          </>
        ) : (
          <>
            <div className="rc-annotate-stage">
              <canvas ref={canvasRef} data-testid="image-annotate-canvas" onPointerDown={(event) => { setDrawing(true); lastRef.current = pointOf(event); saveStrokeSnapshot(); }} onPointerMove={(event) => { if (!drawing) return; const canvas = canvasRef.current; const ctx = canvas?.getContext("2d"); const p = pointOf(event); const last = lastRef.current; if (ctx && last) { ctx.strokeStyle = brush; ctx.lineWidth = size; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); } lastRef.current = p; }} onPointerUp={() => setDrawing(false)} />
            </div>
            <div className="rc-annotate-tools">
              <input type="color" data-testid="annotate-color" value={brush} onChange={(event) => setBrush(event.target.value)} />
              <input type="range" min="1" max="30" data-testid="annotate-size" value={size} onChange={(event) => setSize(Number(event.target.value))} />
              <button data-testid="annotate-undo" onClick={() => { setStrokes((prev) => prev.slice(0, -1)); setTimeout(redraw, 0); }}>撤销</button>
              <button data-testid="annotate-clear" onClick={() => { setStrokes([]); setTimeout(redraw, 0); }}>清空</button>
            </div>
            <div className="rc-image-editor-actions"><button data-testid="image-annotate-confirm" onClick={() => { const canvas = canvasRef.current; if (canvas) onApply(canvas.toDataURL("image/png")); }}>确认标注</button></div>
          </>
        )}
        {error ? <div className="rc-timeline-error" data-testid="image-editor-error">{error}</div> : null}
      </div>
    </div>
  );
}
