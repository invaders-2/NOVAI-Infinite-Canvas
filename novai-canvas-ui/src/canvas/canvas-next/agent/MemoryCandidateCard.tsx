/**
 * 「要记住这些吗」卡片（阶段二·3）：只把勾选的写进长期记忆。
 *
 * 逐条勾选（默认不勾）+ 建议范围徽标（本画布 / 所有画布）+ 依据小字；
 * 底部「不用了」「记住选中的」两个按钮，按项目规则右对齐。
 * 卡片本身用现有的 message-card 体系（磨砂玻璃 + 软底 + 无描边），复选框沿用原生控件的 accent-color。
 */
import { useState } from "react";
import { Icon } from "../ui/Icon";
import { Badge } from "@/components/hexta/badge";
import { Button } from "@/components/hexta/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/hexta/card";
import type { MemoryCandidate } from "./memoryCandidates";

export function MemoryCandidateCard({ items, busy, onConfirm, onDismiss }: {
    items: MemoryCandidate[];
    busy: boolean;
    onConfirm: (ids: string[]) => void;
    onDismiss: () => void;
}) {
    const [picked, setPicked] = useState<string[]>([]);
    const toggle = (id: string) => setPicked((prev) => (prev.includes(id) ? prev.filter((row) => row !== id) : [...prev, id]));
    return <Card className="message-card mem-cand-card" data-memory-candidates size="sm">
        <CardHeader className="mc-head">
            <div className="mc-head-row">
                <span className="mc-glyph"><Icon name="brain" size="s" /></span>
                <CardTitle className="mc-title">要记住这些吗</CardTitle>
                <Badge className="mc-badge" size="sm"><span className="tnum">{picked.length}/{items.length}</span></Badge>
            </div>
        </CardHeader>
        <CardContent className="mc-body">
            {items.map((item) => <label className="mem-cand-row" key={item.id} data-candidate-id={item.id}>
                <input type="checkbox" checked={picked.includes(item.id)} disabled={busy}
                    onChange={() => toggle(item.id)} />
                <span className="mem-cand-main">
                    <span className="mem-cand-text">{item.text}</span>
                    <span className="mem-cand-meta">
                        <span className="mem-cand-scope">{item.scope === "global" ? "所有画布" : "本画布"}</span>
                        {item.reason ? <span className="mem-cand-reason">{item.reason}</span> : null}
                    </span>
                </span>
            </label>)}
        </CardContent>
        <CardFooter className="mc-foot">
            <div className="mc-actions">
                <Button className="mc-btn-ghost" data-mem-dismiss disabled={busy} onClick={onDismiss} size="sm" variant="ghost">不用了</Button>
                <Button className="mc-btn-solid" data-mem-confirm disabled={busy || !picked.length} onClick={() => onConfirm(picked)} size="sm" variant="default">
                    <Icon name="check" size="s" />记住选中的
                </Button>
            </div>
        </CardFooter>
    </Card>;
}
