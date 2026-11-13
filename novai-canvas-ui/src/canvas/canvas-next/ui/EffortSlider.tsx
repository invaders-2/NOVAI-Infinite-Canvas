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
import { blueFallback, createEffortFill, effortFallback, type EffortFillHandle } from "./effort-fill";
import "./effort-slider.css";

export const EFFORT_LABEL: Record<string, string> = { low: "低", mid: "中", high: "高", xhigh: "极高", max: "Max" };
/** 推荐档位：没有 mid 时退到第二档；只有一档不显示（组件本身就不渲染） */
export const EFFORT_RECOMMENDED = "mid";

const THUMB = { width: 38, height: 24 };
const PAD = THUMB.width / 2;
/** 小号拇指（视频时长滑块）：30×18，行程 34px；大号仍 38×24 / 行程 42px */
const SMALL_THUMB = { width: 30, height: 18 };

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
  /** 用途标记：duration = 视频时长滑块（挂 data-dur-slider，不写 data-think-level，避免和模型强度选择器混） */
  usage?: "effort" | "duration";
  /** 不可交互（生成中 / 只读）：不响应拖动与键盘 */
  disabled?: boolean;
  /** 没有显式值时的文案；默认「默认」 */
  emptyLabel?: string;
  /** 尺寸：sm = 视频时长那种小号（20px 轨道 / 30×18 拇指）；默认 md */
  size?: "md" | "sm";
  /** 配色：blue = 只走纯蓝（不带高档的靛蓝 / 紫）；默认 effort 那套 */
  tone?: "default" | "blue";
};

/** 填充层：WebGL 可用就挂 canvas，否则回退同色系 CSS 渐变（卸载时销毁上下文）
    tone=blue（视频时长）直接用纯蓝 CSS 渐变，不建 WebGL 上下文——小滑块不值得常驻一个 3D canvas */
function EffortFill({ level, tone = "default" }: { level: number; tone?: "default" | "blue" }) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const levelRef = useRef(level);
  const handleRef = useRef<EffortFillHandle | null>(null);
  // blue 用纯 CSS 渐变，一开始就算「没有 WebGL」，useEffect 里直接跳过建上下文
  const [failed, setFailed] = useState(tone === "blue");
  levelRef.current = level;

  useEffect(() => {
    if (tone === "blue") return;
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
  }, [tone]);

  useEffect(() => {
    handleRef.current?.setLevel(level);
  }, [level]);

  return (
    <span ref={hostRef} className="ev-fill" aria-hidden="true" data-webgl={failed ? "0" : "1"}>
      {failed ? <span className="ev-fill-grad" style={{ background: tone === "blue" ? blueFallback(level) : effortFallback(level) }} /> : null}
    </span>
  );
}

export function EffortSlider({
  levels, value, onChange,
  recommended = EFFORT_RECOMMENDED, label = "模型强度",
  labels = EFFORT_LABEL, hint = "越高越慢，推理越深",
  leftLabel = "更快", rightLabel = "更强", showRestore = true,
  usage = "effort", disabled = false, emptyLabel = "默认",
  size = "md", tone = "default",
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

  /* 尺寸档：行程 / 圆心都按拇指宽推，md 与原来的 42px / 21px 完全等价 */
  const dim = size === "sm" ? SMALL_THUMB : THUMB;
  const travel = dim.width + 4;
  const center = dim.width / 2 + 2;
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
    if (disabled) return;
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
    return Math.min(1, Math.max(0, (clientX - rect.left - dim.width / 2) / Math.max(1, rect.width - dim.width)));
  };

  const follow = (clientX: number) => {
    const next = shareAt(clientX);
    setDragShare(next);
    commit(Math.round(next * last));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || disabled) return;
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
    if (disabled) return;
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
    "--ev-thumb": `calc((100% - ${travel}px) * ${share} + 2px)`,
    "--ev-fill": `calc((100% - ${travel}px) * ${share} + ${travel}px)`,
    "--ev-rec": `calc((100% - ${travel}px) * ${recShare} + ${center}px)`,
  } as CSSProperties;

  /* 轨道 + 文案整块复用：模型强度 / 时长两种用途只差最外层 data 钩子
     （时长滑块不能再写 data-think-level，否则和模型强度选择器串台） */
  const sliderBody = <>
      <div className="ev-head">
        <span className="ev-label">{label}</span>
        <span className={"ev-value" + (explicit ? " is-on" : "")}>{explicit ? labelOf(localValue, labels) : emptyLabel}</span>
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
        aria-disabled={disabled || undefined}
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
        <span className="ev-fill-wrap"><EffortFill level={level} tone={tone} /></span>
        <span className="ev-dots" aria-hidden="true">
          {levels.map((item, position) => (
            <span key={item} className="ev-dot" data-think={item} data-on={position <= index ? "" : undefined} data-pop={position === index && dragging ? "" : undefined} />
          ))}
        </span>
        <span className="ev-thumb" aria-hidden="true" />
      </div>
      {rec >= 0 ? <div className="ev-rec" aria-hidden="true"><span>推荐</span></div> : null}
      {showRestore && explicit ? <div className="ev-restore"><button type="button" onClick={() => { setLocalValue(""); onChange(""); }}>恢复默认</button></div> : null}
  </>;

  if (usage === "duration") return (
    <div className="ev-slider" data-dur-slider data-size={size} data-tone={tone} data-disabled={disabled ? "" : undefined} style={vars}>{sliderBody}</div>
  );
  return (
    <div className="ev-slider" data-effort-slider data-size={size} data-think-level={localValue || "default"} style={vars}>
      {sliderBody}
    </div>
  );
}
