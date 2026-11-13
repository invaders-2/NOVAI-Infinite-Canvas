import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import type { AnnotationPayload, CanvasAnnotation } from "../annotations";
import "./comment-mode.css";

type Tool = "point" | "lasso" | "rect";
type Pt = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
type Box = { x: number; y: number; w: number; h: number };
type Anno = { id: string; no: number; type: Tool; label: string; text: string; point?: Pt; pts?: Pt[]; rect?: Rect; badge: Pt };
type Live = { kind: "lasso"; pts: Pt[] } | { kind: "rect"; a: Pt; b: Pt } | null;

const LABELS = ["文字", "背景色", "主体图形", "徽标"];
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const pct = (n: number) => (n * 100).toFixed(3) + "%";
const pathOf = (pts: Pt[]) => pts.map((p, i) => (i ? "L" : "M") + (p.x * 400).toFixed(1) + " " + (p.y * 500).toFixed(1)).join(" ");
const rectOf = (a: Pt, b: Pt): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

const Pin = () => (
    <svg width="34" height="38" viewBox="0 0 34 38" aria-hidden="true">
        <path d="M9 1H25A8 8 0 0 1 33 9V21A8 8 0 0 1 25 29H18L9 37V29A8 8 0 0 1 1 21V9A8 8 0 0 1 9 1Z" fill="#1d1d1f" stroke="rgba(255,255,255,.9)" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
);

/** 评论层：贴在图片当前显示区域上；子工具条浮在全屏查看器底栏正上方，不再另开一层页面 */
export function CommentMode({ rect, nodeId, nodeTitle, image, onClose, onCommit }: {
    rect: Box | null;
    nodeId: string;
    nodeTitle: string;
    image?: { w: number; h: number };
    onClose: () => void;
    onCommit: (payload: AnnotationPayload) => void;
}) {
    const [tool, setTool] = useState<Tool>("point");
    const [anns, setAnns] = useState<Anno[]>([]);
    const [openId, setOpenId] = useState<string | null>(null);
    const [label, setLabel] = useState("文字");
    const [menu, setMenu] = useState(false);
    const [custom, setCustom] = useState("");
    const [all, setAll] = useState(false);
    const [live, setLive] = useState<Live>(null);
    const [toast, setToast] = useState("");
    const [cardAt, setCardAt] = useState<{ left: number; top: number } | null>(null);
    const cardRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{ tool: Tool; start: Pt; moved: number; pts: Pt[]; last?: Pt } | null>(null);
    const seqRef = useRef(0);
    const toastTimer = useRef(0);
    const cur = openId ? anns.find((a) => a.id === openId) || null : null;

    const say = useCallback((msg: string) => {
        setToast(msg);
        window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(""), 2200);
    }, []);
    useEffect(() => () => window.clearTimeout(toastTimer.current), []);

    const norm = (e: RPointerEvent<HTMLElement>): Pt => {
        if (!rect) return { x: 0.5, y: 0.5 };
        return { x: clamp01((e.clientX - rect.x) / rect.w), y: clamp01((e.clientY - rect.y) / rect.h) };
    };
    const patch = (id: string, next: Partial<Anno>) => setAnns((v) => v.map((a) => (a.id === id ? { ...a, ...next } : a)));
    const openCard = (id: string) => {
        const a = anns.find((x) => x.id === id);
        if (!a) return;
        setOpenId(id); setLabel(a.label); setMenu(false); setAll(false);
        window.setTimeout(() => cardRef.current?.querySelector("textarea")?.focus(), 30);
    };
    const closeCard = () => { setOpenId(null); setMenu(false); };

    const add = (type: Tool, data: { point?: Pt; pts?: Pt[]; rect?: Rect }, badge: Pt) => {
        seqRef.current += 1;
        const no = seqRef.current;
        setAnns((v) => [...v, { id: "ann" + no + "_" + Date.now().toString(36), no, type, label: "文字", text: "", badge, ...data }]);
        setOpenId(null);
        say(type === "point" ? "已标记位置，写一句修改意见" : "已生成标注，点「添加描述」写意见");
    };

    const onDown = (e: RPointerEvent<HTMLDivElement>) => {
        if ((e.target as HTMLElement).closest(".cmm-pin,.cmm-pill")) return;
        if (openId) { closeCard(); return; }
        if (all) { setAll(false); return; }
        if (menu) { setMenu(false); return; }
        if (e.button !== 0) return;
        e.preventDefault();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        const p = norm(e);
        dragRef.current = { tool, start: p, moved: 0, pts: [p] };
        if (tool === "lasso") setLive({ kind: "lasso", pts: [p] });
        else if (tool === "rect") setLive({ kind: "rect", a: p, b: p });
    };
    const onMove = (e: RPointerEvent<HTMLDivElement>) => {
        const d = dragRef.current;
        if (!d) return;
        const p = norm(e);
        d.moved = Math.max(d.moved, Math.hypot(p.x - d.start.x, p.y - d.start.y));
        if (d.tool === "lasso") {
            const last = d.pts[d.pts.length - 1];
            if (Math.hypot(p.x - last.x, p.y - last.y) > 0.004) {
                d.pts.push(p);
                setLive({ kind: "lasso", pts: d.pts.slice() });
            }
        } else if (d.tool === "rect") {
            d.last = p;
            setLive({ kind: "rect", a: d.start, b: p });
        }
    };
    const endDrag = () => {
        const d = dragRef.current;
        dragRef.current = null;
        setLive(null);
        if (!d) return;
        if (d.tool === "point") {
            if (d.moved > 0.012) return;
            add("point", { point: d.start }, d.start);
            return;
        }
        if (d.tool === "lasso") {
            let len = 0;
            for (let i = 1; i < d.pts.length; i++) len += Math.hypot(d.pts[i].x - d.pts[i - 1].x, d.pts[i].y - d.pts[i - 1].y);
            if (d.pts.length < 5 || len < 0.02) { say("线条太短了，再画长一点"); return; }
            const xs = d.pts.map((p) => p.x), ys = d.pts.map((p) => p.y);
            const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
            const end = d.pts[d.pts.length - 1];
            add("lasso", { pts: d.pts.slice(), rect: box }, { x: Math.min(1.02, Math.max(0.02, end.x + 0.015)), y: Math.min(1.03, Math.max(0.02, end.y + 0.045)) });
            return;
        }
        const box = rectOf(d.start, d.last || d.start);
        if (box.w < 0.012 || box.h < 0.012) { say("框太小了，再拉大一点"); return; }
        add("rect", { rect: box }, { x: Math.min(1.02, box.x + box.w + 0.035), y: Math.min(1.02, box.y + box.h + 0.035) });
    };
    const onUp = (e: RPointerEvent<HTMLDivElement>) => {
        const d = dragRef.current;
        if (d && d.tool === "rect") d.last = norm(e);
        endDrag();
    };
    const del = (id: string) => {
        setAnns((v) => v.filter((a) => a.id !== id));
        if (openId === id) closeCard();
        say("已删除标注");
    };
    const commit = (mode: "chat" | "send") => {
        const ready = anns.filter((a) => a.text.trim());
        if (!ready.length) { say("先写一句描述再发送"); return; }
        const annotations: CanvasAnnotation[] = ready.map((a) => ({ no: a.no, type: a.type, label: a.label, text: a.text.trim(), point: a.point, rect: a.rect }));
        onCommit({ nodeId, nodeTitle, image, annotations, mode });
    };

    useEffect(() => {
        if (!openId) { setCardAt(null); return; }
        const a = anns.find((x) => x.id === openId);
        const card = cardRef.current;
        if (!a || !rect || !card) return;
        const px = rect.x + a.badge.x * rect.w, py = rect.y + a.badge.y * rect.h;
        const w = card.offsetWidth, h = card.offsetHeight;
        let left = px + 42, top = py - 46;
        if (left + w > window.innerWidth - 16) left = px - w - 36;
        left = Math.max(16, Math.min(window.innerWidth - w - 16, left));
        top = Math.max(64, Math.min(window.innerHeight - h - 16, top));
        setCardAt({ left, top });
    }, [openId, anns, rect]);

    useEffect(() => {
        const on = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            if (menu) { setMenu(false); return; }
            if (openId) { closeCard(); return; }
            if (all) { setAll(false); return; }
            onClose();
        };
        window.addEventListener("keydown", on, true);
        return () => window.removeEventListener("keydown", on, true);
    }, [menu, openId, all, onClose]);

    useEffect(() => { dragRef.current = null; setLive(null); }, [tool]);
    if (!rect) return null;

    return <>
        <div className="cmm-surface" data-tool={tool} style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={endDrag}>
            {anns.map((a) => a.type === "rect" && a.rect ? <div className="cmm-rect" key={"r" + a.id} style={{ left: pct(a.rect.x), top: pct(a.rect.y), width: pct(a.rect.w), height: pct(a.rect.h) }}><i /><i /><i /><i /></div> : null)}
            {anns.map((a) => a.type === "lasso" && a.pts ? <svg className="cmm-svg" key={"s" + a.id} viewBox="0 0 400 500" preserveAspectRatio="none"><path d={pathOf(a.pts)} /></svg> : null)}
            {live?.kind === "lasso" ? <svg className="cmm-svg" viewBox="0 0 400 500" preserveAspectRatio="none"><path d={pathOf(live.pts)} /></svg> : null}
            {live?.kind === "rect" ? <div className="cmm-live" style={{ left: pct(rectOf(live.a, live.b).x), top: pct(rectOf(live.a, live.b).y), width: pct(rectOf(live.a, live.b).w), height: pct(rectOf(live.a, live.b).h) }} /> : null}
            {anns.map((a) => <button key={a.id} className={"cmm-pin" + (openId === a.id ? " sel" : "")} style={{ left: pct(a.badge.x), top: pct(a.badge.y) }} aria-label={"标注 " + a.no} title={a.label + (a.text ? " · " + a.text : " · 待描述")} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); openCard(a.id); }}>
                <Pin /><span className="n">{a.no}</span>
            </button>)}
            {anns.filter((a) => !a.text && openId !== a.id).map((a) => {
                const flip = a.badge.x > 0.66;
                return <button key={"p" + a.id} className={"cmm-pill" + (flip ? " flip" : "")} style={flip ? { left: "calc(" + pct(a.badge.x) + " - 32px)", top: "calc(" + pct(a.badge.y) + " - 20px)" } : { left: "calc(" + pct(a.badge.x) + " + 32px)", top: "calc(" + pct(a.badge.y) + " - 20px)" }} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); openCard(a.id); }}>添加描述</button>;
            })}
        </div>

        {cur ? <div className="cmm-card" ref={cardRef} style={cardAt ? { left: cardAt.left, top: cardAt.top } : { visibility: "hidden" }}>
            <div className="hd">
                <button className="cmm-label" onClick={() => setMenu((v) => !v)}>{label}
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                </button>
                <span className="sp" />
                <button className="cmm-iconbtn" aria-label="删除标注" onClick={() => del(cur.id)}>
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 15H6L5 6" /></svg>
                </button>
            </div>
            <textarea rows={2} placeholder="添加描述" value={cur.text} onChange={(e) => patch(cur.id, { text: e.target.value })} />
            <div className="cmm-foot">
                <button className="cmm-btn ghost" disabled={!cur.text.trim()} onClick={() => commit("send")}>发送</button>
                <button className="cmm-btn primary" disabled={!cur.text.trim()} onClick={() => commit("chat")}>添加到对话</button>
            </div>
            {menu ? <div className="cmm-menu">
                <div className="mt">已标记对象</div>
                {LABELS.map((name) => <button key={name} className={"cmm-opt" + (cur.label === name ? " on" : "")} onClick={() => { patch(cur.id, { label: name }); setLabel(name); setMenu(false); }}>
                    <span className="th"><i /></span><span>{name}</span>
                    <svg className="ck" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                </button>)}
                <input value={custom} placeholder="输入自定义" onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    const v = custom.trim();
                    if (!v) return;
                    patch(cur.id, { label: v }); setLabel(v); setCustom(""); setMenu(false);
                }} />
            </div> : null}
        </div> : null}

        {all ? <div className="cmm-all">
            <div className="hd">全部评论 · {anns.length}</div>
            {anns.length ? anns.map((a) => <button key={a.id} className="cmm-row" onClick={() => { setAll(false); openCard(a.id); }}>
                <span className="no">{a.no}</span><span className="th"><i /></span>
                <span className="tx"><b>{a.label}</b><small>{a.text || "还没有描述"}</small></span>
            </button>) : <div className="cmm-empty">还没有标注。用点选、圈选或框选，在画面上标一下要改的地方。</div>}
        </div> : null}

        <div className="cmm-bar">
            <button className={"cmm-tool" + (tool === "point" ? " on" : "")} onClick={() => setTool("point")} aria-label="点选">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 3l7.2 17.4 2.3-7.1 7.1-2.3z" /></svg>点选
            </button>
            <button className={"cmm-tool" + (tool === "lasso" ? " on" : "")} onClick={() => setTool("lasso")} aria-label="圈选">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>圈选
            </button>
            <button className={"cmm-tool" + (tool === "rect" ? " on" : "")} onClick={() => setTool("rect")} aria-label="框选">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8V6a2 2 0 0 1 2-2h2" /><path d="M16 4h2a2 2 0 0 1 2 2v2" /><path d="M20 16v2a2 2 0 0 1-2 2h-2" /><path d="M8 20H6a2 2 0 0 1-2-2v-2" /></svg>框选
            </button>
            <span className="cmm-sep" />
            <button className="cmm-tool" onClick={() => { setAll((v) => !v); setOpenId(null); setMenu(false); }} aria-label="全部评论">全部评论 · {anns.length}</button>
        </div>

        <div className={"cmm-toast" + (toast ? " on" : "")}>{toast}</div>
    </>;
}
