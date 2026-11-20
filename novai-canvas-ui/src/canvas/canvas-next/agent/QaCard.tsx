/** 问答卡：最多 4 个问题，单选 / 多选 + 自己填；提交后拼成一条消息继续对话（逻辑见 ./qa.ts） */
import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/hexta/card";
import {
  Questionnaire,
  QuestionnaireChoice,
  QuestionnaireChoices,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireSkip,
  QuestionnaireTitle,
} from "@/components/hexta/questionnaire";
import { Icon } from "../ui/Icon";
import { answerOf, answeredCount, togglePick, type QaCard } from "./qa";
import "./message-cards.css";

/** 提交后表单收起成一行摘要的时长；和 message-cards.css 里 .qa-form-slot 的过渡对齐 */
const COLLAPSE_MS = 200;

export function QaCardView({ card, busy, onChange, onSubmit, onSkip }: { card: QaCard; busy: boolean; onChange: (c: QaCard) => void; onSubmit: () => void; onSkip: () => void }) {
  const open = card.status === "open"; const n = answeredCount(card);
  const total = card.questions.length;
  const confirm = card.kind === "confirm";
  /** 有没有不合格项要重做：决定 skip 按钮是「先不重做，继续」还是「满意，继续」 */
  const regenBad = !!card.regen?.items.some((it) => it.ok === false);
  /** HextaUI questionnaire 是分步表单：一题一步，active 记当前这一题 */
  const [active, setActive] = useState("q0");
  const items = useMemo(() => card.questions.map((q, qi) => ({ name: "q" + qi, choices: q.options.map((value) => ({ value })) })), [card.questions]);
  useEffect(() => { setActive("q0"); }, [card.goal]);
  const step = Math.max(0, card.questions.findIndex((_, qi) => "q" + qi === active));
  const last = step >= total - 1;

  /** 提交后状态立刻变成 answered、表单本该当场卸载：多留 200ms 让它原地收起再摘。
      这一步必须在 render 阶段补（不是 effect）：effect 跑之前的那一帧已经把表单摘掉了，收起动画就没了。 */
  const [collapsing, setCollapsing] = useState(false);
  const wasOpen = useRef(open);
  if (wasOpen.current !== open) {
    wasOpen.current = open;
    setCollapsing(!open);
  }
  useEffect(() => {
    if (!collapsing) return;
    const timer = setTimeout(() => setCollapsing(false), COLLAPSE_MS);
    return () => clearTimeout(timer);
  }, [collapsing]);

  const cardTitle = confirm ? "结果确认" : "先确认几个问题";
  /** 已答 / 已跳过的标题沿用原来那句（跳过的两种情况文案不同），进行中就是卡片标题 */
  const title = open || card.status === "answered" ? cardTitle
    : (confirm ? (regenBad ? "先不重做，继续" : "满意，继续下一步") : "已跳过，交给 Agent 决定");
  const resultHead = card.status === "answered" ? (confirm ? "已反馈" : "已回答") : "已跳过";
  const answers = card.questions.map((_, qi) => answerOf(card, qi)).filter(Boolean);
  /* 角标已经写了「已回答 / 已反馈 / 已跳过」，这行不再重复；只写答了什么。
     历史记录里的问答卡没存选项（答案在下一条用户消息里），这时不写「交给 Agent 决定」——那是错的 */
  const result = answers.length ? answers.join("；") : (card.status === "skipped" ? "交给 Agent 决定" : "");

  return <Card className={"message-card qa-card" + (open ? "" : " is-done")} data-qa={card.status} size="sm">
    <CardHeader className="mc-head">
      <div className="mc-head-row">
        <span className="mc-glyph" data-tone={!open ? (card.status === "answered" ? "ok" : "mute") : "ask"}>
          <Icon name={!open ? "check" : confirm ? "msg" : "help"} />
        </span>
        <CardTitle className="mc-title">{title}</CardTitle>
        <span className="qa-badge tnum" data-tone={open ? "live" : card.status === "answered" ? "ok" : "mute"}>{open ? n + "/" + total : resultHead}</span>
      </div>
    </CardHeader>
    <CardContent className="mc-body">
      <div className="qa-stack">
        <div className="qa-form-slot" data-leaving={collapsing ? "" : undefined}>
          <div className="qa-form-inner" inert={collapsing || undefined} aria-hidden={collapsing || undefined}>
            {open || collapsing ? <Questionnaire
              className="qa-questionnaire"
              item={active}
              items={items}
              onItemChange={setActive}
              // Hexta 的问卷根节点是原生 <form>：跳过最后一题 / 末题回车都会 requestSubmit，
              // 不拦的话整页会按 GET 提交，画布地址里的 ?canvas= / ?id= 被冲掉 → 变成「没有指定要打开的画布」。
              // 这里统一接住，交给卡片的提交逻辑。
              onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
              // Hexta 在根节点的捕获阶段就吃掉了回车（在输入框里按回车会被它拿去「下一题」，
              // 且 stopPropagation 后输入框自己的 onKeyDown 根本不跑）。最后一题要在它之前接住，直接提交。
              onKeyDownCapture={(e) => {
                if (e.key !== "Enter" || e.nativeEvent.isComposing || !last) return;
                if (!(e.target as HTMLElement).matches('[data-slot="questionnaire-input"]')) return;
                e.preventDefault();
                e.stopPropagation();
                onSubmit();
              }}
              shortcuts="numbers"
              transition="slide"
            >
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
                  placeholder={q.options.length ? "其他（可不填）" : "你的回答"}
                  value={card.other[qi] || ""}
                />
              </QuestionnaireItem>)}
              <div className="qa-nav">
                <QuestionnairePrevious className="qa-prev" aria-label="上一题" title="上一题"><Icon name="arrowleft" size="s" /></QuestionnairePrevious>
                <span aria-hidden="true" className="qa-dots">
                  {card.questions.map((_, qi) => <span className="qa-dot" data-current={qi === step ? "" : undefined} data-on={qi <= step ? "" : undefined} key={qi} />)}
                </span>
                <span aria-hidden="true" className="qa-steps tnum">{step + 1}/{total}</span>
                <span className="sr-only">第 {step + 1} 题，共 {total} 题</span>
                <span className="sp" />
                <QuestionnaireSkip className="qa-skip-q">跳过这题</QuestionnaireSkip>
                {last
                  ? <button className="qa-primary" data-qa-go disabled={busy} onClick={onSubmit} type="button">{confirm ? "提交反馈" : n ? "提交回答" : "直接继续"}<Icon name="right" size="xs" /></button>
                  : <QuestionnaireNext className="qa-primary" aria-label="下一题" title="下一题"><Icon name="right" size="s" /></QuestionnaireNext>}
              </div>
            </Questionnaire> : null}
          </div>
        </div>
        {open || !result || (card.status === "skipped" && !answers.length) ? null : <p className="qa-result">{result}</p>}
      </div>
    </CardContent>
    {open ? <CardFooter className="mc-foot">
      <button className="qa-skip" data-qa-skip disabled={busy} onClick={onSkip} type="button">{confirm ? (regenBad ? "先不重做，继续" : "满意，继续") : "跳过，你来决定"}</button>
    </CardFooter> : null}
  </Card>;
}
