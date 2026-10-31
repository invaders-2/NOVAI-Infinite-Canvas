import { useState } from "react";
import { X } from "lucide-react";

type Props = { canvasId: string; nodeId: string | null; onClose: () => void };

export function FeedbackDialog({ canvasId, nodeId, onClose }: Props) {
  const [category, setCategory] = useState("bug");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);

  const copyFallback = async () => {
    const content = "OpenArc OS 反馈\n类别：" + category + "\n画布：" + canvasId + "\n节点：" + (nodeId || "-") + "\n时间：" + new Date().toISOString() + "\n\n" + text;
    try { await navigator.clipboard.writeText(content); setError("已复制反馈内容，可粘贴到仓库 issue"); }
    catch { setError("复制失败，请手动选择文本"); }
  };

  const submit = async () => {
    if (!text.trim()) { setError("请输入反馈内容"); return; }
    if (text.trim().length > 4000) { setError("反馈内容不能超过 4000 字"); return; }
    setBusy(true); setError(""); setResult("");
    try {
      const bridge = (window as unknown as { openarc?: { canvas?: { command?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> } } }).openarc?.canvas;
      if (!bridge || typeof bridge.command !== "function") throw new Error("未连接桌面后端，可复制反馈内容");
      const response = await bridge.command({ type: "canvas/feedback/submit", category, text: text.trim(), canvasId, nodeId, appVersion: "canvas" });
      if (!response || response.ok !== true) throw new Error(String((response && (response.detail || response.error)) || "提交失败"));
      setResult("已记录 #" + String(response.id || ""));
      setText("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "提交失败"); }
    finally { setBusy(false); }
  };

  return (
    <div className="rc-help-modal" data-testid="feedback-modal" onClick={onClose}>
      <div className="rc-help-modal-panel" onClick={(event) => event.stopPropagation()}>
        <div className="rc-help-modal-head"><strong>反馈问题</strong><button data-testid="feedback-close" onClick={onClose}><X size={14} /></button></div>
        <div className="rc-feedback-form">
          <label>类别<select data-testid="feedback-category" value={category} onChange={(event) => setCategory(event.target.value)}><option value="bug">问题反馈</option><option value="idea">功能建议</option><option value="other">其他</option></select></label>
          <textarea data-testid="feedback-input" placeholder="描述问题、复现步骤或建议（1-4000 字）" value={text} maxLength={4000} onChange={(event) => setText(event.target.value)} />
          <div className="rc-feedback-actions"><button data-testid="feedback-submit" disabled={busy} onClick={() => void submit()}>{busy ? "提交中…" : "提交"}</button><button data-testid="feedback-cancel" onClick={onClose}>取消</button>{error ? <button data-testid="feedback-copy" onClick={() => void copyFallback()}>复制反馈内容</button> : null}</div>
          {result ? <div className="rc-feedback-result" data-testid="feedback-result">{result}</div> : null}
          {error ? <div className="rc-lan-error" data-testid="feedback-error">{error}</div> : null}
          <p className="rc-help-modal-note">仅写入本机反馈日志，不自动创建工单。</p>
        </div>
      </div>
    </div>
  );
}
