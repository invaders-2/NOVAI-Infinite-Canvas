/**
 * 联网搜索结果卡（消息里「处理过程」步骤区下方、正文上方的一块）。
 * 观感来自 Rare UI 的 WebSearch（MIT），按 BEAT 的令牌与「不画线框」规则重写：
 * 触发胶囊（地球图标 + 顺时针进度环 + 标签 + 站点图标叠层 + chevron）+ 4 列 / 2 列来源卡网格。
 * 项目没有 motion 依赖，所以展开高度、卡片错峰、标签换字、骨架微光全部是 CSS transition / animation；
 * prefers-reduced-motion 下动画全关（见 message-cards.css 末尾）。
 */
import { useEffect, useState } from "react";
import { IconWorld } from "@tabler/icons-react";
import { Icon } from "../ui/Icon";
import { prefersReduced } from "../ui/combo";
import type { WebSearchCardData, WebSearchSource } from "./webSearch";
import "./message-cards.css";

/** 宽面板 4 列；结果超过 4 条时第 4 格换成「还有 N 个来源」，窄面板 2 列（容器查询在 CSS 里） */
const COLUMNS = 4;
/** 胶囊右侧最多叠几个站点图标 */
const STACK = 4;

function hostOf(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/** 域名取二级段：developer.mozilla.org 显示成 mozilla */
function siteOf(url: string): string {
    const host = hostOf(url);
    const parts = host.split(".");
    return (parts.length > 1 ? parts[parts.length - 2] : parts[0]) || host || url;
}

/** 域名 → 0..359 的稳定色相：同一个站点每次渲染的颜色一致 */
function hueOf(value: string): number {
    let h = 2166136261;
    for (let i = 0; i < value.length; i += 1) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
    return (h >>> 0) % 360;
}

/** 只把 http(s) 当链接：结果里的怪协议不渲染成可点的 a */
function linkOf(url: string): string {
    return /^https?:\/\//i.test(url) ? url : "";
}

/**
 * 站点图标：优先站点自己根目录的 favicon.ico（不向第三方发请求），
 * 拉不到（404 / 防盗链 / 断网）就退回按域名哈希生成的渐变底 + 首字母。
 */
function faviconOf(url: string): string {
    const href = linkOf(url);
    if (!href) return "";
    try { return new URL(href).origin + "/favicon.ico"; } catch { return ""; }
}

function Favicon({ url, size, z }: { url: string; size: number; z?: number }) {
    const [broken, setBroken] = useState(false);
    const site = siteOf(url);
    const src = broken ? "" : faviconOf(url);
    const hue = hueOf(site);
    return (
        <span
            aria-hidden="true"
            className="wsearch-fav"
            style={{
                width: size,
                height: size,
                fontSize: Math.max(9, Math.round(size * 0.5)),
                ...(z ? { zIndex: z } : {}),
                ...(src ? {} : { background: "linear-gradient(135deg, hsl(" + hue + ", 62%, 62%), hsl(" + ((hue + 32) % 360) + ", 64%, 46%))" }),
            }}
        >
            {src ? <img alt="" draggable={false} onError={() => setBroken(true)} src={src} /> : <b>{site.charAt(0).toUpperCase() || "网"}</b>}
        </span>
    );
}

/** 进度环：搜索中缓慢逼近 0.94 但永远到不了头，完成后直接满格（再由 CSS 淡出） */
function useRingProgress(searching: boolean, count: number): number {
    const [progress, setProgress] = useState(searching ? 0.08 : 1);
    useEffect(() => {
        if (!searching) { setProgress(1); return; }
        if (prefersReduced()) { setProgress(0.4); return; }
        setProgress((value) => (value < 0.95 ? value : 0.08));
        const timer = window.setInterval(() => setProgress((value) => Math.min(0.94, value + (1 - value) * 0.22)), 480);
        return () => window.clearInterval(timer);
    }, [searching, count]);
    return progress;
}

function SourceCard({ source, index }: { source: WebSearchSource; index: number }) {
    const href = linkOf(source.url);
    const site = siteOf(source.url);
    const body = <>
        <span className="wsearch-card-title">{source.title}</span>
        <span className="wsearch-card-foot">
            <Favicon size={16} url={source.url} />
            <span className="wsearch-card-site">{site}</span>
            <span className="wsearch-card-n">{index}</span>
        </span>
    </>;
    if (!href) return <div className="wsearch-card">{body}</div>;
    return <a className="wsearch-card" href={href} rel="noreferrer" target="_blank" title={source.title || site}>{body}</a>;
}

function SkeletonCard({ delay }: { delay: number }) {
    return (
        <div aria-hidden="true" className="wsearch-card wsearch-skel">
            <span className="wsearch-skel-lines"><i className="is-w1" /><i className="is-w2" /></span>
            <span className="wsearch-skel-foot"><i className="is-dot" /><i className="is-site" /></span>
            <span className="wsearch-skel-shine" style={{ animationDelay: delay + "ms" }} />
        </div>
    );
}

function MoreCard({ sources, count, onClick }: { sources: WebSearchSource[]; count: number; onClick: () => void }) {
    return <button aria-label={"展开另外 " + count + " 个来源"} className="wsearch-card wsearch-more" onClick={onClick} type="button">
        <span aria-hidden="true" className="wsearch-stack is-inline">
            {sources.slice(0, STACK).map((source, index) => <Favicon key={source.url + index} size={20} url={source.url} z={STACK - index} />)}
        </span>
        <span className="wsearch-more-text">还有 {count} 个来源</span>
    </button>;
}

export function WebSearchCard({ card }: { card: WebSearchCardData }) {
    const [open, setOpen] = useState(true);
    const [expanded, setExpanded] = useState(false);
    const sources = card.sources;
    const count = sources.length;
    const searching = card.status === "searching";
    const progress = useRingProgress(searching, count);
    // 第 4 格从「来源卡」换成「还有 N 个来源」：多于 4 条才换，正好 4 条时 4 张都铺开
    const overflow = !expanded && count > COLUMNS;
    const shown = overflow ? sources.slice(0, COLUMNS - 1) : sources;
    const hidden = overflow ? count - (COLUMNS - 1) : 0;
    // 搜索中不够一排时补骨架卡，第一排不会塌成半截
    const skeletons = searching && !overflow ? Math.max(0, COLUMNS - count) : 0;
    const label = searching
        ? card.query ? "正在搜索「" + card.query + "」" : "正在搜索网页"
        : card.status === "web-off" ? "联网搜索未开启"
        : card.status === "failed" ? "联网搜索失败"
        : count ? "搜索了 " + count + " 个网站" : "没有找到可用的网页";
    const note = card.status === "web-off" ? "联网搜索没有开启：到「设置 → 通用」打开「画布助手联网」，再重新发一次这句。"
        : card.status === "failed" ? card.error || "联网搜索失败"
        : card.status === "done" && count === 0 ? "这次没有取到可用的网页，可以换个说法再搜。"
        : "";
    return <div className="wsearch" data-open={open ? "true" : undefined} data-status={card.status}>
        <button aria-expanded={open} className="wsearch-trigger" onClick={() => setOpen((value) => !value)} type="button">
            <span aria-hidden="true" className="wsearch-globe">
                <IconWorld size={15} stroke={1.8} />
                <svg className="wsearch-ring" viewBox="0 0 28 28">
                    <circle className="wsearch-ring-track" cx="14" cy="14" r="13" />
                    <circle className="wsearch-ring-fill" cx="14" cy="14" pathLength={1} r="13" style={{ strokeDashoffset: 1 - progress }} />
                </svg>
            </span>
            <span aria-live="polite" className="wsearch-label">
                <span className={"wsearch-label-in" + (searching ? " is-searching" : "")} key={label}>{label}</span>
            </span>
            {count ? <span aria-hidden="true" className="wsearch-stack">
                {sources.slice(0, STACK).map((source, index) => <Favicon key={source.url + index} size={20} url={source.url} z={STACK - index} />)}
            </span> : null}
            <span aria-hidden="true" className="wsearch-caret"><Icon name="down" size="xs" /></span>
        </button>
        <div className="wsearch-body">
            <div className="wsearch-body-in">
                {note ? <p className={"wsearch-note" + (card.status === "web-off" || card.status === "failed" ? " is-bad" : "")}>
                    {card.status === "web-off" || card.status === "failed" ? <Icon name="alert" size="xs" /> : null}
                    <span>{note}</span>
                </p> : null}
                {count || skeletons ? <ol className="wsearch-grid">
                    {shown.map((source, index) => <li className="wsearch-cell" key={source.url} style={{ animationDelay: index * 45 + "ms" }}>
                        <SourceCard index={index + 1} source={source} />
                    </li>)}
                    {Array.from({ length: skeletons }, (_, index) => <li aria-hidden="true" className="wsearch-cell" key={"skel-" + index} style={{ animationDelay: (count + index) * 45 + "ms" }}>
                        <SkeletonCard delay={index * 120} />
                    </li>)}
                    {overflow ? <li className="wsearch-cell" key="more" style={{ animationDelay: (COLUMNS - 1) * 45 + "ms" }}>
                        <MoreCard count={hidden} onClick={() => setExpanded(true)} sources={sources.slice(COLUMNS - 1)} />
                    </li> : null}
                    {expanded && count > COLUMNS ? <li className="wsearch-cell" key="less" style={{ animationDelay: count * 45 + "ms" }}>
                        <button className="wsearch-card wsearch-less" onClick={() => setExpanded(false)} type="button">
                            <Icon name="up" size="xs" />收起
                        </button>
                    </li> : null}
                </ol> : null}
            </div>
        </div>
    </div>;
}
