/**
 * 面板「搜索历史」弹层（阶段二 recall）。入口在 #aMore（更多选项）菜单里，不新增底栏按钮。
 *
 * 数据来自 GET /api/agent/recall（契约见 ./recall.ts，联调版：必填 canvas_id，返回 snippet / source_label / origin）。
 * 一条命中显示片段（关键词高亮）+ 出处（后端给好的 origin，缺了才本地拼「画布 · 日期」）；
 * 开关关闭时后端 400，原样展示 detail，不留空壳。打开时先探一次，开关没开时不用等用户输入就能看到提示。
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { ModalHead, openModal } from "../ui/overlay";
import { Spinner } from "@/components/hexta/spinner";
import { highlightSegments, RECALL_SCOPE_LABEL, RecallError, searchRecall, type RecallItem, type RecallResult, type RecallScope } from "./recall";

/** canvasId 必填（后端缺它会 400）；threadId 在 scope=thread 时会带给后端 */
export function openRecallSearch(canvasId: string, threadId?: string) {
    openModal(() => <RecallSearch canvasId={canvasId} threadId={threadId || ""} />);
}

const SCOPES: RecallScope[] = ["thread", "canvas", "all"];
/** 打开时用的探针词：只取 1 条、结果直接丢掉，唯一目的是尽早知道开关开没开（400 = 没开） */
const PROBE_QUERY = "历史";

function RecallSearch({ canvasId, threadId }: { canvasId: string; threadId: string }) {
    const [query, setQuery] = useState("");
    const [scope, setScope] = useState<RecallScope>("all");
    const [result, setResult] = useState<RecallResult | null>(null);
    const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
    const [failure, setFailure] = useState<{ message: string; status: number } | null>(null);
    const token = useRef(0);
    /** 探针回来时要用「此刻」的输入判断用户是否已经开始搜了，不能读挂载时的闭包 */
    const typed = useRef("");

    const run = async (raw: string, nextScope = scope, probe = false) => {
        const q = raw.trim();
        if (!q) return;
        const id = ++token.current;
        if (!probe) { setStatus("loading"); setFailure(null); }
        try {
            const value = await searchRecall({ query: q, canvasId, threadId, scope: nextScope, limit: probe ? 1 : 20 });
            if (probe) return;
            if (id !== token.current) return;
            setResult(value);
            setStatus("done");
        } catch (error) {
            // 探针有自己的判定：不看搜词计数（挂载时的空输入会推进计数），只看用户有没有开始输入
            if (probe ? typed.current.trim() !== "" : id !== token.current) return;
            setFailure({ message: error instanceof Error ? error.message : "搜索历史失败", status: error instanceof RecallError ? error.status : 0 });
            setResult(null);
            setStatus("error");
        }
    };

    // 打开先探一次开关；探针成功不显示任何东西（不替用户预设结果）
    useEffect(() => { void run(PROBE_QUERY, "all", true); }, []);

    // 输入停下 350ms 自动搜；回车立刻搜；切范围立刻重搜
    useEffect(() => {
        const q = query.trim();
        if (!q) { token.current += 1; setStatus("idle"); setResult(null); setFailure(null); return; }
        const timer = window.setTimeout(() => { void run(q); }, 350);
        return () => window.clearTimeout(timer);
    }, [query, scope]);

    const items: RecallItem[] = result?.items || [];
    const keyword = result?.query || query.trim();

    return <>
        <ModalHead title="搜索历史" icon="search" />
        <div className="mbd ap2-recall">
            <div className="pal-s ap2-recall-in">
                <Icon name="search" size="s" />
                <input autoFocus data-esc-clear="1" value={query} placeholder="搜关键词：封面、阶段二、口播…"
                    onChange={(event) => { typed.current = event.target.value; setQuery(event.target.value); }}
                    onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") { event.preventDefault(); void run(query); return; }
                        if (event.key === "Escape" && query) { event.preventDefault(); setQuery(""); }
                    }} />
            </div>
            <div className="seg ap2-recall-scope" role="group" aria-label="搜索范围">
                {SCOPES.map((row) => <button key={row} type="button" className={scope === row ? "on" : ""} onClick={() => setScope(row)}>{RECALL_SCOPE_LABEL[row]}</button>)}
            </div>
            <div className="ap2-recall-body" aria-live="polite">
                {status === "idle" ? <p className="ap2-recall-note">输入关键词开始搜索：对话、摘要、画布档案和长期记忆都会一起找。</p> : null}
                {status === "loading" ? <div className="ap2-recall-note is-loading"><Spinner size="sm" />正在翻历史…</div> : null}
                {status === "error" && failure ? <div className="ap2-recall-state is-warn" role="alert">
                    <Icon name="alert" size="s" />
                    <div>
                        <b>{failure.status === 400 ? "搜不了历史" : "搜索历史暂时不可用"}</b>
                        <p>{failure.message}</p>
                        {failure.status === 400 ? <p>这是服务端开关 / 参数问题：按上面这句改完再试。</p> : null}
                    </div>
                </div> : null}
                {status === "done" ? (items.length ? <>
                    <div className="ap2-recall-count">找到 {result?.count || items.length} 段相关记录 · 关键词「{keyword}」</div>
                    <div className="ap2-recall-list">{items.map((item) => <div className="ap2-recall-hit" key={item.key || item.snippet.slice(0, 12)}>
                        <p className="ap2-recall-text" title={item.snippet}>
                            {highlightSegments(item.snippet, keyword).map((part, index) => part.hit
                                ? <mark className="ap2-recall-mark" key={index}>{part.text}</mark>
                                : <span key={index}>{part.text}</span>)}
                        </p>
                        <div className="ap2-recall-meta">
                            <span className="ap2-recall-kind">{item.source_label}</span>
                            <span>{item.origin}</span>
                        </div>
                    </div>)}</div>
                </> : <div className="ap2-recall-state is-empty">
                    <Icon name="search" size="s" />
                    <div>
                        <b>没有找到相关的历史记录</b>
                        <p>{keyword ? "「" + keyword + "」在这张画布的历史里没有命中。" : ""}换个关键词试试，或者把范围切到「全部」。</p>
                    </div>
                </div>) : null}
            </div>
        </div>
    </>;
}
