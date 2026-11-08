/** 问答卡：最多 4 个问题，单选 / 多选 + 自己填；提交后拼成一条消息继续对话（逻辑见 ./qa.ts） */
import { useEffect, useMemo, useState } from "react";
import { Icon } from "../ui/Icon";
import { Badge } from "@/components/hexta/badge";
import { Button } from "@/components/hexta/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/hexta/card";
import {
  Questionnaire,
  QuestionnaireChoices,
  QuestionnaireChoice,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSkip,
  QuestionnaireTitle,
} from "@/components/hexta/questionnaire";
import { answeredCount, answerOf, togglePick, type QaCard } from "./qa";

export function QaCardView({ card, busy, onChange, onSubmit, onSkip }: { card: QaCard; busy: boolean; onChange: (c: QaCard) => void; onSubmit: () => void; onSkip: () => void }) {
  const open = card.status === "open"; const n = answeredCount(card);
  /** HextaUI questionnaire 是分步表单：一题一步，Progress 显示第几题 / 共几题 */
  const [active, setActive] = useState("q0");
  const items = useMemo(() => card.questions.map((q, qi) => ({ name: "q" + qi, choices: q.options.map((value) => ({ value })) })), [card.questions]);
  useEffect(() => { setActive("q0"); }, [card.goal]);
  const confirm = card.kind === "confirm";
  /** 有没有不合格项要重做：决定 skip 按钮是「先不重做，继续」还是「满意，继续」 */
  const regenBad = !!card.regen?.items.some((it) => it.ok === false);
  const title = open ? (confirm ? "结果确认" : "先确认几个问题")
    : card.status === "answered" ? (confirm ? "已反馈" : "已回答")
    : (confirm ? (regenBad ? "先不重做，继续" : "满意，继续下一步") : "已跳过，交给 Agent 决定");
  return <Card className={"message-card qa-card" + (open ? "" : " is-done")} data-qa={card.status} size="sm">
    <CardHeader className="mc-head">
      <div className="mc-head-row">
        <span className="mc-glyph"><Icon name={confirm ? "check" : "sparkle"} size="s" /></span>
        <CardTitle className="mc-title">{title}</CardTitle>
        <Badge className="mc-badge" size="sm"><span className="tnum">{n}/{card.questions.length}</span></Badge>
      </div>
    </CardHeader>
    <CardContent className="mc-body">
      {open ? <Questionnaire
        className="qa-questionnaire"
        item={active}
        items={items}
        onItemChange={setActive}
        shortcuts="numbers"
        transition="lift"
      >
        <QuestionnaireProgress className="mc-qa-progress" />
        {card.questions.map((q, qi) => <QuestionnaireItem className="mc-qa-q" key={qi} multiple={q.multi} name={"q" + qi}>
          <QuestionnaireTitle className="mc-qa-title"><span className="tnum">{qi + 1}</span>{q.q}{q.multi ? <em>可多选</em> : null}</QuestionnaireTitle>
          {q.options.length ? <QuestionnaireChoices>
            {q.options.map((o) => <QuestionnaireChoice
              checked={(card.picks[qi] || []).includes(o)}
              key={o}
              onChange={() => onChange(togglePick(card, qi, o))}
              value={o}
            >{o}</QuestionnaireChoice>)}
          </QuestionnaireChoices> : null}
          <QuestionnaireInput
            onChange={(e) => onChange({ ...card, other: card.other.map((x, i) => (i === qi ? e.target.value : x)) })}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && !e.nativeEvent.isComposing) onSubmit(); }}
            placeholder={q.options.length ? "其他（可不填）" : "你的回答"}
            value={card.other[qi] || ""}
          />
        </QuestionnaireItem>)}
        <div className="qa-nav">
          <QuestionnairePrevious size="sm" variant="ghost">上一题</QuestionnairePrevious>
          <span className="sp" />
          <QuestionnaireSkip size="sm" variant="ghost">跳过这题</QuestionnaireSkip>
          <QuestionnaireNext size="sm" variant="secondary">下一题</QuestionnaireNext>
        </div>
      </Questionnaire> : card.questions.map((q, qi) => <div className="mc-qa-q is-readonly" key={qi}>
        <div className="mc-qa-title"><span className="tnum">{qi + 1}</span>{q.q}{q.multi ? <em>可多选</em> : null}</div>
        <div className="mc-qa-answer">{answerOf(card, qi) || "Agent 决定"}</div>
      </div>)}
    </CardContent>
    {open ? <CardFooter className="mc-foot">
      <div className="mc-actions mc-actions-split">
        <Button className="mc-btn-ghost" data-qa-skip disabled={busy} onClick={onSkip} size="sm" variant="ghost">{confirm ? (regenBad ? "先不重做，继续" : "满意，继续") : "跳过，你来决定"}</Button>
        <Button className="mc-btn-solid" data-qa-go disabled={busy} onClick={onSubmit} size="sm" variant="default"><Icon name="send" size="s" />{confirm ? "提交反馈" : n ? "提交回答" : "直接继续"}</Button>
      </div>
    </CardFooter> : null}
  </Card>;
}
