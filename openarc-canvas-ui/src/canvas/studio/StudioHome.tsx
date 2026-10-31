import { useEffect, useRef, useState } from "react";
import { Copy, Paperclip, RefreshCw, Send, Square, Wrench, ThumbsUp, ThumbsDown, Image as ImageIcon, Film, ChevronDown } from "lucide-react";

type Part =
  | { type: "thinking"; text: string }
  | { type: "tool"; id: string; name: string; status: "running" | "done" | "error"; ms?: number; output?: string }
  | { type: "task"; items: string[] }
  | { type: "source"; title: string; url: string }
  | { type: "code"; lang: string; code: string }
  | { type: "image"; url: string }
  | { type: "video"; url: string };
type Msg = { id: string; role: "user" | "assistant"; text: string; parts: Part[] };
function VideoCard({ url }: { url: string }) {
  const [duration, setDuration] = useState(0);
  return <figure className="studio-media" data-studio-video><video src={url} controls onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)} /><figcaption><Film size={12} /> 真实产物 · {duration ? Math.round(duration) + " 秒" : "时长读取中"}</figcaption></figure>;
}

export function StudioHome({ onOpenSettings, onOpenCanvas }: { onOpenSettings?: () => void; onOpenCanvas?: () => void }) {
  const [models, setModels] = useState<Array<{ configId: string; label: string }>>([]);
  const [model, setModel] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const inputFileRef = useRef<HTMLInputElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const [previewImage, setPreviewImage] = useState("");
  const runRef = useRef("");
  const requestRef = useRef("");
  const assistantRef = useRef("");
  const bridge = (window as unknown as { openarc?: { canvas?: { command?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> } } }).openarc?.canvas;

  useEffect(() => {
    void (async () => {
      const api = (window as unknown as { openarc?: { model?: { command?: (request: Record<string, unknown>) => Promise<Record<string, unknown>>; onEvent?: (cb: (event: unknown) => void) => () => void } } }).openarc?.model;
      try {
        const res = await api?.command?.({ type: "canvas/models" });
        const rows = res && res.ok === true && Array.isArray(res.models) ? res.models as Array<Record<string, unknown>> : [];
        const chat = rows.filter((r) => r.status === "enabled" && Array.isArray(r.capabilities) && r.capabilities.includes("chat")).map((r) => ({ configId: String(r.configId), label: String(r.label || r.configId) }));
        setModels(chat);
        if (chat[0]) setModel(chat[0].configId);
      } catch { setModels([]); }
      const off = api?.onEvent?.((event: unknown) => {
        const payload = (event as { payload?: { type?: string; requestId?: string; event?: Record<string, unknown> } })?.payload;
        if (!payload || payload.type !== "canvas.stream" || payload.requestId !== requestRef.current) return;
        const ev = payload.event || {};
        const id = assistantRef.current;
        const update = (fn: (parts: Part[]) => Part[]) => setMessages((prev) => prev.map((m) => m.id === id ? { ...m, parts: fn(m.parts) } : m));
        if (ev.type === "text.delta" && typeof ev.text === "string") setMessages((prev) => prev.map((m) => m.id === id ? { ...m, text: m.text + String(ev.text) } : m));
        else if (ev.type === "thinking.delta" && typeof ev.text === "string") update((parts) => {
          const last = parts[parts.length - 1];
          if (last?.type === "thinking") return [...parts.slice(0, -1), { ...last, text: last.text + String(ev.text) }];
          return [...parts, { type: "thinking", text: String(ev.text) }];
        });
        else if (ev.type === "tool.start" && typeof ev.id === "string") update((parts) => [...parts, { type: "tool", id: String(ev.id), name: String(ev.name || "工具"), status: "running" }]);
        else if (ev.type === "tool.end" && typeof ev.id === "string") update((parts) => parts.map((p) => p.type === "tool" && p.id === ev.id ? { ...p, status: ev.status === "error" ? "error" : "done", ms: Number(ev.ms || 0), output: typeof ev.output === "string" ? ev.output : "" } : p));
        else if (ev.type === "task" && Array.isArray(ev.items)) update((parts) => [...parts, { type: "task", items: (ev.items as unknown[]).map(String) }]);
        else if (ev.type === "source" && typeof ev.url === "string") update((parts) => [...parts, { type: "source", title: String(ev.title || ev.url), url: String(ev.url) }]);
        else if (ev.type === "code" && typeof ev.code === "string") update((parts) => [...parts, { type: "code", lang: String(ev.lang || "text"), code: String(ev.code) }]);
        else if (ev.type === "image" && typeof ev.url === "string") update((parts) => [...parts, { type: "image", url: String(ev.url) }]);
        else if (ev.type === "video" && typeof ev.url === "string") update((parts) => [...parts, { type: "video", url: String(ev.url) }]);
      });
      return off;
    })();
  }, []);

  const stop = () => {
    if (bridge && runRef.current) void bridge.command?.({ type: "canvas/runStop", runId: runRef.current, reason: "USER_STOP" });
    requestRef.current = "";
    runRef.current = "";
    setStreaming(false);
  };

  const send = async (raw: string) => {
    const text = raw.trim();
    if (!text || streaming) return;
    if (!models.length || !bridge?.command) {
      setMessages((prev) => [...prev, { id: "u" + Date.now(), role: "user", text, parts: [] }, { id: "a" + Date.now(), role: "assistant", text: "未接入可用文本模型。", parts: [] }]);
      setError("未接入模型");
      setDraft("");
      return;
    }
    setDraft("");
    setError("");
    setStreaming(true);
    const assistantId = "a" + Date.now();
    assistantRef.current = assistantId;
    setMessages((prev) => [...prev, { id: "u" + Date.now(), role: "user", text, parts: [] }, { id: assistantId, role: "assistant", text: "", parts: [] }]);
    try {
      const run = await bridge.command({ type: "canvas/run", kind: "chat", configId: model });
      runRef.current = String(run?.runId || "");
      const requestId = "sh_" + Date.now().toString(36);
      requestRef.current = requestId;
      const history = messages.slice(-20).map((m) => ({ role: m.role, content: m.text }));
      const res = await bridge.command({ type: "canvas/modelChatStream", runId: run?.runId, configId: model, requestId, messages: [...history, { role: "user", content: text }], attachments });
      await bridge.command({ type: "canvas/runFinish", runId: run?.runId, status: res?.ok ? "DONE" : "FAILED" });
      if (res && res.ok === true && typeof res.text === "string") setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, text: String(res.text) } : m));
      else throw new Error(String(res?.error || "MODEL_ERROR"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "MODEL_ERROR");
      setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, text: "模型调用失败：" + (e instanceof Error ? e.message : "MODEL_ERROR") } : m));
    } finally {
      requestRef.current = "";
      runRef.current = "";
      setStreaming(false);
    }
  };

  useEffect(() => { const el = threadRef.current; if (el) el.scrollTop = el.scrollHeight; }, [messages, streaming]);
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const renderPart = (part: Part, index: number) => {
    if (part.type === "thinking") return (
      <details key={index} className="studio-reasoning" data-studio-reasoning>
        <summary><ChevronDown size={12} /> 思考过程</summary>
        <p>{part.text}</p>
      </details>
    );
    if (part.type === "tool") return (
      <details key={index} className="studio-tool-card" data-studio-tool={part.status} open={part.status === "running"}>
        <summary><span className={"studio-dot " + part.status} /> {part.name} · {part.status === "running" ? "运行中" : part.status === "done" ? "完成" : "失败"}{part.ms ? " · " + part.ms + "ms" : ""}</summary>
        {part.output ? <pre data-studio-tool-output>{part.output}</pre> : null}
      </details>
    );
    if (part.type === "task") return (
      <ol key={index} className="studio-task" data-studio-task>{part.items.map((item) => <li key={item}>{item}</li>)}</ol>
    );
    if (part.type === "source") return (
      <a key={index} className="studio-source" data-studio-source href={part.url} target="_blank" rel="noreferrer">{part.title}</a>
    );
    if (part.type === "code") return (
      <div key={index} className="studio-code" data-studio-code>
        <div className="studio-code-head"><span>{part.lang}</span><button type="button" className="studio-action" onClick={() => void navigator.clipboard?.writeText?.(part.code)}><Copy size={12} /> 复制代码</button></div>
        <pre><code>{part.code}</code></pre>
      </div>
    );
    if (part.type === "image") return <figure key={index} className="studio-media" data-studio-image onClick={() => setPreviewImage(part.url)}><img src={part.url} alt="生成图片" /><figcaption><ImageIcon size={12} /> 真实产物 · 点击放大</figcaption></figure>;
    if (part.type === "video") return <VideoCard key={index} url={part.url} />;
    return null;
  };

  return (
    <div className="studio-chat" data-studio-chat>
      <header className="studio-head" data-studio-toolbar>
        <strong>AI Studio</strong><span className="studio-sub">对话工作台</span><span className="studio-grow" />
        <button type="button" className="studio-ghost" data-studio-canvas onClick={() => onOpenCanvas?.()}>画布</button>
        <button type="button" className="studio-ghost" onClick={() => onOpenSettings?.()}>模型设置</button>
      </header>
      <div className="studio-thread" data-studio-thread ref={threadRef}>
        {messages.length === 0 ? (
          <div className="studio-empty" data-studio-empty>
            <h1>今天想创作什么？</h1>
            <p>描述目标，我会拆解步骤并调用可用工具；也可以直接打开画布继续编辑。</p>
            <div className="studio-suggestions">
              {["为秋季新品写一段门店海报文案", "把这段故事拆成 3 集短剧", "设计一张 3:4 的商品主图", "总结这个项目的待办"].map((text) => (
                <button key={text} type="button" className="studio-suggestion" onClick={() => setDraft(text)}>{text}</button>
              ))}
            </div>
          </div>
        ) : messages.map((message) => (
          <article key={message.id} className={"studio-msg " + message.role} data-studio-message={message.role}>
            <div className="studio-msg-role">{message.role === "user" ? "你" : "Assistant"}</div>
            {message.parts.map(renderPart)}
            <div className="studio-msg-body">{message.text}{streaming && message.id === assistantRef.current ? <span className="studio-cursor" data-studio-cursor /> : null}</div>
            {message.role === "assistant" && message.text && !streaming ? (
              <div className="studio-actions">
                <button type="button" className="studio-action" onClick={() => void navigator.clipboard?.writeText?.(message.text)}><Copy size={13} /> 复制</button>
                <button type="button" className="studio-action" onClick={() => lastUser && void send(lastUser.text)}><RefreshCw size={13} /> 重试</button>
                <button type="button" className="studio-action" aria-label="赞"><ThumbsUp size={13} /></button>
                <button type="button" className="studio-action" aria-label="踩"><ThumbsDown size={13} /></button>
              </div>
            ) : null}
          </article>
        ))}
        {error ? (
          <div className="studio-error" role="alert" data-studio-error>
            <span>{error === "未接入模型" ? "未接入可用文本模型。" : "生成失败：" + error}</span>
            <button type="button" className="studio-action" onClick={() => onOpenSettings?.()}>去系统设置配置</button>
          </div>
        ) : null}
      </div>
      <form className="studio-composer" data-studio-composer onSubmit={(e) => { e.preventDefault(); void send(draft); }}>
        {attachments.length ? <div className="studio-chips" data-studio-chips>{attachments.map((name) => <span key={name} className="studio-chip"><Paperclip size={11} />{name}</span>)}</div> : null}
        <textarea value={draft} onChange={(e) => { setDraft(e.target.value); e.currentTarget.style.height = "44px"; e.currentTarget.style.height = Math.min(110, e.currentTarget.scrollHeight) + "px"; }} placeholder="描述你想创作的内容…（Enter 发送，Shift+Enter 换行）" rows={2} style={{ height: 44 }} data-studio-input
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(draft); } }} />
        <div className="studio-composer-bar">
          <input ref={inputFileRef} type="file" multiple hidden onChange={(e) => setAttachments(Array.from(e.target.files || []).map((f) => f.name))} data-studio-file />
          <button type="button" className="studio-tool" onClick={() => inputFileRef.current?.click()}><Paperclip size={14} /> 附件</button>
          <button type="button" className="studio-tool"><Wrench size={14} /> 工具</button>
          <select className="studio-model" aria-label="模型" data-studio-model value={model} onChange={(e) => setModel(e.target.value)}>
            {models.length === 0 ? <option value="">未配置模型</option> : models.map((m) => <option key={m.configId} value={m.configId}>{m.label}</option>)}
          </select>
          <span className="studio-grow" />
          {streaming ? <button type="button" className="studio-send stop" data-studio-stop onClick={stop}>■ 停止</button> : <button type="submit" className="studio-send" data-studio-send>↑ 发送</button>}
        </div>
      </form>
      {previewImage ? <div className="studio-lightbox" onClick={() => setPreviewImage("")}><img src={previewImage} alt="放大预览" /></div> : null}
    </div>
  );
}
