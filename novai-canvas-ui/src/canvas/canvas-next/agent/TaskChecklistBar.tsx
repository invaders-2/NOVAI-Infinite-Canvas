import { Icon } from "../ui/Icon";
import { Spinner } from "@/components/hexta/spinner";
import { taskChecklistHint, taskChecklistTally, type TaskChecklistItem } from "./task";
import "./message-cards.css";

/**
 * 任务清单条：钉在输入框上方的一行折叠条（默认收起），点整条才展开看完整步骤。
 * 只读、没有任何执行按钮；数据是当前任务 plan 步骤 + 工具事件对账的结果，随任务推进自己打勾。
 */
export function TaskChecklistBar({ items, status, open, onToggle }: {
    items: TaskChecklistItem[];
    status: string;
    open: boolean;
    onToggle: () => void;
}) {
    const tally = taskChecklistTally(items, status);
    const { total, done, failed, running, settled, succeeded, allDone } = tally;
    // 完成态换成绿勾圆（另外画一层，靠 data-complete 切换，这样对勾描边能走动画）；其余状态保持线性图标
    const linearGlyph = failed
        ? <Icon name="alert" size="s" />
        : running || !settled
            ? <Spinner aria-hidden size="sm" />
            : <Icon name="list" size="s" />;
    const hint = taskChecklistHint(tally);
    // 可纠正的失败（工具在要参数 / 消歧义）：run 成功时补一句「已自动改道」，否则只说到「需补充信息」为止
    const infoNote = succeeded ? "需补充信息 · 已自动改道" : "需补充信息";
    return <div className="checklist-bar" data-open={open ? "1" : undefined} data-task-checklist={status}>
        {/* 鼠标按下不抢输入框焦点（键盘 Tab 仍可聚焦）；整条可点，aria-expanded 给读屏 */}
        <button aria-controls="checklistBarBody" aria-expanded={open} className="checklist-bar-head" onClick={onToggle} onMouseDown={(event) => event.preventDefault()} type="button">
            <span aria-hidden="true" className="checklist-bar-glyph" data-tone={failed ? "bad" : allDone ? "ok" : undefined} data-complete={allDone ? "1" : undefined}>
                <span className="checklist-glyph-linear">{linearGlyph}</span>
                <svg className="checklist-glyph-check" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="9" fill="currentColor" />
                    <path className="checklist-glyph-tick" d="M7.5 12.25 10.5 15.25 16.75 8.75" pathLength={1} fill="none" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </span>
            <span className="checklist-bar-title">任务清单</span>
            <span className="checklist-bar-count tnum" data-complete={allDone ? "1" : undefined}>{done + "/" + total}</span>
            <span aria-hidden="true" className="checklist-bar-dot">·</span>
            <span className="checklist-bar-hint" title={hint}>{hint}</span>
            <span aria-hidden="true" className="checklist-bar-caret">{<Icon name="down" size="xs" />}</span>
        </button>
        {/* 常驻挂载：开合走 grid-template-rows 的高度过渡，不做 display 硬切 */}
        <div aria-hidden={!open} className="checklist-bar-body" id="checklistBarBody">
            <div className="checklist-bar-inner">
                <ol className="checklist-list">
                    {items.map((item) => <li className={"checklist-row is-" + item.state} data-step-state={item.state} key={item.index}>
                        <span aria-hidden="true" className="checklist-mark">{mark(item.state)}</span>
                        <span className="checklist-text" title={item.label}><span className="checklist-label">{item.label}</span></span>
                        {item.state === "info" ? <span className="checklist-note">{infoNote}</span> : null}
                    </li>)}
                </ol>
            </div>
        </div>
    </div>;
}

/** 状态图形：一层底环 + 进行中的 68% 圆弧 + 对勾 + 叉，按行的状态显示其中一层（都是图形，不当描边分隔用） */
function mark(state: TaskChecklistItem["state"]) {
    if (state === "info") return <span className="checklist-info-dot" />;
    return <svg aria-hidden="true" className="checklist-status" viewBox="0 0 24 24">
        <circle className="checklist-ring" cx="12" cy="12" r="9" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle className="checklist-progress" cx="12" cy="12" r="9" pathLength={1} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path className="checklist-tick" d="M7.5 12.25 10.5 15.25 16.75 8.75" pathLength={1} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path className="checklist-cross" d="M8.5 8.5 15.5 15.5M15.5 8.5 8.5 15.5" pathLength={1} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>;
}
