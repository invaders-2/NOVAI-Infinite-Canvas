/** 问答卡：最多 4 个问题，单选 / 多选 + 自己填；提交后拼成一条消息继续对话（逻辑见 ./qa.ts） */
import { Icon } from "../ui/Icon";
import { answeredCount, answerOf, togglePick, type QaCard } from "./qa";

export function QaCardView({ card, busy, onChange, onSubmit, onSkip }: { card: QaCard; busy: boolean; onChange: (c: QaCard) => void; onSubmit: () => void; onSkip: () => void }) {
  const open = card.status === "open"; const n = answeredCount(card);
  return <div className={"qa" + (open ? "" : " done")} data-qa={card.status}>
    <div className="qa-h"><Icon name="sparkle" size="s" /><b>{open ? "先确认几个问题" : card.status === "answered" ? "已回答" : "已跳过，交给 Agent 决定"}</b><span className="sp" /><span className="tag tnum">{n}/{card.questions.length}</span></div>
    {card.questions.map((q, qi) => <div className="qa-q" key={qi} data-qi={qi}>
      <div className="qa-t"><span className="tnum">{qi + 1}</span>{q.q}{q.multi ? <em>可多选</em> : null}</div>
      {open ? <>
        {q.options.length ? <div className="qa-opts">{q.options.map((o) => <button key={o} className={(card.picks[qi] || []).includes(o) ? "on" : ""} aria-pressed={(card.picks[qi] || []).includes(o)} onClick={() => onChange(togglePick(card, qi, o))}>{o}</button>)}</div> : null}
        <input className="qa-other" placeholder={q.options.length ? "其他（可不填）" : "你的回答"} value={card.other[qi] || ""} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && !e.nativeEvent.isComposing) onSubmit(); }}
          onChange={(e) => onChange({ ...card, other: card.other.map((x, i) => (i === qi ? e.target.value : x)) })} />
      </> : <div className="qa-a">{answerOf(card, qi) || "Agent 决定"}</div>}
    </div>)}
    {open ? <div className="qa-f"><button className="btn ghost" data-qa-skip disabled={busy} onClick={onSkip}>跳过，你来决定</button><span className="sp" /><button className="btn solid" data-qa-go disabled={busy} onClick={onSubmit}><Icon name="send" size="s" />{n ? "提交回答" : "直接继续"}</button></div> : null}
  </div>;
}
