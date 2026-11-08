/**
 * 模型强度滑块（HextaUI Prompt Input 的 Effort 组件，画布助手用）：
 * 标题行「模型强度 + 当前档位 + 说明图标」→「更快 / 更强」→ 28px 胶囊轨道（动态流体渐变填充 + 档位圆点 + 38×24 白色胶囊拇指）
 * → 推荐档位小字 →（有显式档位时）「恢复默认」。
 *
 * 交互：pointer capture 跟手拖动、点击轨道跳档、←/→/Home/End；松手吸附到最近档位，500ms spring 过渡；
 * prefers-reduced-motion 下 CSS 过渡与 WebGL 动画都停（保留静态渐变）。
 * 档位数组来自后端 /api/config 的 model_caps[模型].think；空串 = 默认（停在推荐档，标题显示「默认」）。
 * 同一套组件也用于图片「质量」档（labels / hint / 左右文案 / recommended=null / showRestore=false 可换）。
 */
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "./Icon";
import { createEffortFill, effortFallback, type EffortFillHandle } from "./effort-fill";
import "./effort-slider.css";

export const EFFORT_LABEL: Record<string, string> = { low: "低", mid: "中", high: "高", xhigh: "极高", max: "Max" };
/** 推荐档位：没有 mid 时退到第二档；只有一档不显示（组件本身就不渲染） */
export const EFFORT_RECOMMENDED = "mid";

const THUMB = { width: 38, height: 24 };
const PAD = THUMB.width / 2;

const labelOf = (level: string, labels: Record<string, string>) => labels[level] || level;

function recommendedIndex(levels: string[], recommended?: string | null) {
  if (levels.length < 2) return -1;
  if (recommended == null) return -1;
  const hit = levels.indexOf(recommended);
  return hit >= 0 ? hit : 1;
}

export type EffortSliderProps = {
  /** 后端下发的合法档位（low / mid / high / xhigh / max）；空或一档 = 不渲染 */
  levels: string[];
  /** 当前档位；空串 = 默认 */
  value: string;
  onChange: (level: string) => void;
  /** 推荐档位；null = 没有推荐档（不显示「推荐」，默认态停在第一档） */
  recommended?: string | null;
  label?: string;
  /** 档位文案；默认模型强度那套「低 / 中 / 高 / 极高 / Max」 */
  labels?: Record<string, string>;
  /** 说明图标文案 */
  hint?: string;
  leftLabel?: string;
  rightLabel?: string;
  /** 有显式档位时是否给「恢复默认」；质量档的第一档就是自动/默认，不需要 */
  showRestore?: boolean;
};

/** 填充层：WebGL 可用就挂 canvas，否则回退同色系 CSS 渐变（卸载时销毁上下文） */
function EffortFill({ level }: { level: number }) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const levelRef = useRef(level);
  const handleRef = useRef<EffortFillHandle | null>(null);
  const [failed, setFailed] = useState(false);
  levelRef.current = level;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const canvas = document.createElement("canvas");
    canvas.className = "ev-canvas";
    host.appendChild(canvas);
    const handle = createEffortFill(canvas, levelRef.current, {
      onLost: () => {
        handleRef.current = null;
        canvas.remove();
        setFailed(true);
      },
    });
    if (!handle) {
      canvas.remove();
      setFailed(true);
      return;
    }
    handleRef.current = handle;
    return () => {
      handle.destroy();
      handleRef.current = null;
      canvas.remove();
    };
  }, []);

  useEffect(() => {
    handleRef.current?.setLevel(level);
  }, [level]);

  return (
    <span ref={hostRef} className="ev-fill" aria-hidden="true" data-webgl={failed ? "0" : "1"}>
      {failed ? <span className="ev-fill-grad" style={{ background: effortFallback(level) }} /> : null}
    </span>
  );
}

export function EffortSlider({
  levels, value, onChange,
  recommended = EFFORT_RECOMMENDED, label = "模型强度",
  labels = EFFORT_LABEL, hint = "越高越慢，推理越深",
  leftLabel = "更快", rightLabel = "更强", showRestore = true,
}: EffortSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [dragShare, setDragShare] = useState<number | null>(null);
  /* 弹层内容在 openPop 时就定稿，不会跟着父组件 re-render；这里留一份本地档位做即时反馈，
     外部值变化（换模型收敛 / 恢复默认）时再跟回来 */
  const [localValue, setLocalValue] = useState(value);
  useEffect(() => { setLocalValue(value); }, [value]);
  /* 「?」说明用项目内 tooltip（hover / focus 显示），不再用原生 title */
  const [tip, setTip] = useState(false);
  const tipId = useId();

  const last = levels.length - 1;
  const explicit = !!localValue && levels.includes(localValue);
  const rec = recommendedIndex(levels, recommended);
  const index = explicit ? levels.indexOf(localValue) : Math.max(0, rec);
  const level = last > 0 ? index / last : 0;
  const share = dragShare ?? level;
  const show = levels.length > 1;

  useEffect(() => {
    if (!dragging) setDragShare(null);
  }, [dragging]);

  if (!show) return null;

  const commit = (next: number) => {
    const clamped = Math.min(last, Math.max(0, next));
    if (explicit && clamped === index) return;
    // 默认态点中推荐档也算一次显式选择，和拖动到别的档位一致
    setLocalValue(levels[clamped]);
    onChange(levels[clamped]);
  };

  const shareAt = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left - PAD) / Math.max(1, rect.width - THUMB.width)));
  };

  const follow = (clientX: number) => {
    const next = shareAt(clientX);
    setDragShare(next);
    commit(Math.round(next * last));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    follow(event.clientX);
  };
  const endDrag = () => {
    setDragging(false);
    setDragShare(null);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    follow(event.clientX);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = index + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else return;
    event.preventDefault();
    commit(next);
  };

  const recShare = rec >= 0 && last > 0 ? rec / last : 0;
  /* 两端各留 2px：行程 = W - (38 + 2×2) = W - 42；拇指 left = 2 + share·(W-42)，
     圆心 = 2 + 19 + share·(W-42) = 21 + share·(W-42)，与档位圆点中心 / 推荐小字同一条线。
     填充 = 42 + share·(W-42)：右缘总在拇指右缘 + 2px（拇指上/下/左/右各露 2px 渐变），Max 时正好 = W 填到轨道右端。 */
  const vars = {
    "--ev-thumb": `calc((100% - 42px) * ${share} + 2px)`,
    "--ev-fill": `calc((100% - 42px) * ${share} + 42px)`,
    "--ev-rec": `calc((100% - 42px) * ${recShare} + 21px)`,
  } as CSSProperties;

  return (
    <div className="ev-slider" data-effort-slider data-think-level={localValue || "default"} style={vars}>
      <div className="ev-head">
        <span className="ev-label">{label}</span>
        <span className={"ev-value" + (explicit ? " is-on" : "")}>{explicit ? labelOf(localValue, labels) : "默认"}</span>
        <span
          className="ev-info-wrap"
          onMouseEnter={() => setTip(true)}
          onMouseLeave={() => setTip(false)}
          onFocus={() => setTip(true)}
          onBlur={() => setTip(false)}
        >
          <button type="button" className="ev-info" aria-label={"说明：" + hint} aria-describedby={tipId}>
            <Icon name="help" size="xs" />
          </button>
          <span id={tipId} role="tooltip" className="ev-tip" data-show={tip ? "" : undefined}>{hint}</span>
        </span>
      </div>
      <div className="ev-caption" aria-hidden="true"><span>{leftLabel}</span><span>{rightLabel}</span></div>
      <div
        ref={trackRef}
        className="ev-track"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={index}
        aria-valuetext={labelOf(levels[index], labels)}
        data-dragging={dragging ? "" : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={onKeyDown}
      >
        <span className="ev-fill-wrap"><EffortFill level={level} /></span>
        <span className="ev-dots" aria-hidden="true">
          {levels.map((item, position) => (
            <span key={item} className="ev-dot" data-think={item} data-on={position <= index ? "" : undefined} data-pop={position === index && dragging ? "" : undefined} />
          ))}
        </span>
        <span className="ev-thumb" aria-hidden="true" />
      </div>
      {rec >= 0 ? <div className="ev-rec" aria-hidden="true"><span>推荐</span></div> : null}
      {showRestore && explicit ? <div className="ev-restore"><button type="button" onClick={() => { setLocalValue(""); onChange(""); }}>恢复默认</button></div> : null}
    </div>
  );
}
