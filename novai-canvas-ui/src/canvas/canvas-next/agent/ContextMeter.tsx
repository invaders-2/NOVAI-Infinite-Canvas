/**
 * 上下文占用表（面板输入区右侧那个圆环按钮）：点开是分层明细。
 *
 * 数据两级：
 *   1. 后端 context_usage 带 layers（NOVAI_AGENT_V2_CONTEXT 开启）→ 显示后端组装出来的真实各层占用；
 *   2. 没有这个事件（开关关闭 / 老后端）→ 沿用面板原来的本地估算（ctxBreak），DOM 与样式与改动前一致。
 * percentage 为 null（模型窗口未知）时只显示绝对值：不拿估算出来的上限去假装百分比。
 */
import { useEffect, useState } from "react";
import { Icon } from "../ui/Icon";
import { openPop } from "../ui/overlay";
import { compactionText, percentText, tokenText, type AgentContextUsage, type ContextCompaction } from "./contextUsage";

/** 本地估算用的窗口上限（老行为：没有真实窗口时按 200K 估）；真实占用不走这个值 */
const ESTIMATE_CTX_MAX = 200000;

/** 「已整理上下文」提示的停留时间：够看完一行，又不一直占着消息流 */
const NOTE_HOLD_MS = 12000;

/**
 * 上下文圆环：底环 + 进度环。
 * muted = 模型窗口未知（算不出百分比）时用：整圈画满但压到很低透明度，
 * 还是同一个圆盘、同一个按钮，不换图标也不加新图形，只是不假装知道进度。
 */
export function Ring({ p, muted = false }: { p: number; muted?: boolean }) {
    const c = 2 * Math.PI * 7;
    return <svg width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeOpacity=".2" strokeWidth="2" /><circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" strokeOpacity={muted ? ".22" : undefined} strokeWidth="2" strokeLinecap="round" strokeDasharray={`${(c * p).toFixed(1)} ${c.toFixed(1)}`} transform="rotate(-90 9 9)" /></svg>;
}

type MeterProps = {
    model: string;
    /** 后端真实占用；null = 这一次没有（开关关闭）→ 退回本地估算 */
    usage: AgentContextUsage | null;
    /** 本地估算的分层占用（与改动前 ctxBreak 的结果一致） */
    estimate: Array<[string, number]>;
    memOn: boolean;
    onCompact: () => void;
    onMemory: () => void;
};

export function ContextMeter({ model, usage, estimate, memOn, onCompact, onMemory }: MeterProps) {
    const percent = percentText(usage);
    const detail = usage
        ? "上下文占用 " + tokenText(usage.used) + " tokens" + (percent ? "（" + percent + "）" : " · 模型窗口未知，不显示百分比")
        : "上下文占用";
    const open = (anchor: Element) => {
        if (!usage) {
            openPop(anchor, (close) => <EstimateDetail model={model} rows={estimate} memOn={memOn} close={close} onCompact={onCompact} onMemory={onMemory} />, "up", "right");
            return;
        }
        openPop(anchor, (close) => <UsageDetail usage={usage} model={model} memOn={memOn} close={close} onCompact={onCompact} onMemory={onMemory} />, "up", "right", "ctx-pop");
    };
    // 这个按钮永远是那个圆盘：有百分比画真实进度；没有百分比画一整圈低透明度环；没有真实占用就是原来的估算环
    const ring = usage
        ? (percent ? <Ring p={Math.min(1, (usage.percentage || 0) / 100)} /> : <Ring p={1} muted />)
        : <Ring p={Math.min(1, estimate.reduce((sum, row) => sum + row[1], 0) / ESTIMATE_CTX_MAX)} />;
    return <button className="ib ap2-btn" id="aRing" aria-label="上下文占用" title={usage ? detail : undefined} onClick={(event) => open(event.currentTarget)}>
        {ring}
    </button>;
}

/** 真实占用：各层 token + 堆叠条（条只画有内容的层，长度按层占比，不按猜测的窗口比例） */
function UsageDetail({ usage, model, memOn, close, onCompact, onMemory }: { usage: AgentContextUsage; model: string; memOn: boolean; close: () => void; onCompact: () => void; onMemory: () => void }) {
    const percent = percentText(usage);
    const bars = usage.layers.filter((layer) => layer.tokens > 0);
    return <>
        <div className="mh">上下文 · {model}{usage.round ? " · 第 " + usage.round + " 轮" : ""}</div>
        <div className="row ap2-ctxused"><span>已用</span><b className="tnum">{tokenText(usage.used)} tokens{percent ? " · " + percent : ""}</b></div>
        <div className="row ap2-ctxused"><span>模型窗口</span><b className={"tnum" + (percent ? "" : " ap2-ctxunknown")}>{percent && usage.max ? tokenText(usage.max) : "未知 · 只显示绝对值"}</b></div>
        {bars.length ? <div className="ctxbar ap2-ctxbar">{bars.map((layer, index) => <i key={layer.key} style={{ flexGrow: layer.tokens, opacity: 1 - index * .12 }} title={layer.label} />)}</div> : null}
        {usage.layers.map((layer, index) => <div key={layer.key} className="row ctxk ap2-ctxrow"><span><i style={{ opacity: 1 - index * .12 }} />{layer.label}</span><b className="tnum">{tokenText(layer.tokens)}</b></div>)}
        <div className="ap2-ctxacts">
            <button className="mi" onClick={() => { close(); onCompact(); }}><Icon name="layers" size="s" />压缩对话<span className="k">早期消息合成摘要</span></button>
            <button className="mi" onClick={() => { close(); onMemory(); }}><Icon name="brain" size="s" />记忆<span className="k">{memOn ? "开" : "关"}</span></button>
        </div>
    </>;
}

/** 本地估算：改动前的那份弹层，内容和写法保持原样（开关关闭时面板必须一模一样） */
function EstimateDetail({ model, rows, memOn, close, onCompact, onMemory }: { model: string; rows: Array<[string, number]>; memOn: boolean; close: () => void; onCompact: () => void; onMemory: () => void }) {
    const total = rows.reduce((sum, row) => sum + row[1], 0);
    return <>
        <div className="mh">上下文 · {model}</div>
        <div className="row"><span>已用</span><b className="tnum">{total.toLocaleString()} / {ESTIMATE_CTX_MAX / 1000}K</b></div>
        <div className="ctxbar">{rows.filter((row) => row[1]).map(([label, tokens], index) => <i key={label} style={{ width: Math.max(1.5, (tokens / ESTIMATE_CTX_MAX) * 100 * 6).toFixed(1) + "%", opacity: 1 - index * .16 }} title={label} />)}</div>
        {rows.map(([label, tokens], index) => <div key={label} className="row ctxk"><span><i style={{ opacity: 1 - index * .16 }} />{label}</span><b className="tnum">{tokens.toLocaleString()}</b></div>)}
        <div className="msep" />
        <button className="mi" onClick={() => { close(); onCompact(); }}><Icon name="layers" size="s" />压缩对话<span className="k">早期消息合成摘要</span></button>
        <button className="mi" onClick={() => { close(); onMemory(); }}><Icon name="brain" size="s" />记忆<span className="k">{memOn ? "开" : "关"}</span></button>
    </>;
}

/** 「已整理上下文」：消息流里的一行，出现后淡出（高度一起收掉，不留空壳），不打断对话也不抢焦点 */
export function CompactNotice({ notice, times }: { notice: ContextCompaction; times: number }) {
    const [gone, setGone] = useState(false);
    useEffect(() => {
        const timer = window.setTimeout(() => setGone(true), NOTE_HOLD_MS);
        return () => window.clearTimeout(timer);
    }, []);
    // 一行放得下的只有「做了什么 + 省了多少」；第几次留给 title，别把 token 数字挤成省略号
    const line = "已整理上下文 · " + compactionText(notice);
    const detail = (times > 1 ? "本次运行第 " + times + " 次整理 · " : "") + line;
    return <div className={"ap2-ctxnote" + (gone ? " is-gone" : "")} role="status" title={detail}>
        <Icon name="layers" size="xs" />
        <span>{line}</span>
    </div>;
}
