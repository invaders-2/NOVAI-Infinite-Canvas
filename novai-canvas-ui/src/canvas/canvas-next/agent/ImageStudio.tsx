/**
 * Image Studio 版式：生成结果与联网搜图共用的方图块 / 网格 / 全屏查看器。
 * 视觉语言照 HextaUI Image Studio block：批次不套卡、方形图块 12px 圆角 8px 间距、
 * hover 底部渐变 + 左下深色玻璃动作按钮、全屏磨砂灯箱 + 底部玻璃信息条。
 */
import { useEffect, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../ui/Icon";
import { ThumbImg } from "../ui/thumb";
import "./image-studio.css";

export type StudioAction = {
  icon: IconName;
  label: string;
  onClick?: () => void;
  href?: string;
  tone?: "bad";
};

export type StudioData = Record<string, string | number | undefined>;

type StudioTileProps = {
  src?: string;
  media?: ReactNode;
  aspect?: string | number;
  label?: string;
  meta?: ReactNode;
  kind?: string;
  badge?: ReactNode;
  selected?: boolean;
  added?: boolean;
  actions?: StudioAction[];
  onActivate?: () => void;
  onDoubleClick?: () => void;
  activateLabel?: string;
  loading?: boolean;
  error?: string;
  pressed?: boolean;
  data?: StudioData;
  className?: string;
};

const dataProps = (data?: StudioData) => {
  if (!data) return {};
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(data)) if (value !== undefined) out[key] = value;
  return out;
};

function StudioActionButton({ action }: { action: StudioAction }) {
  const body = <><Icon name={action.icon} size="xs" /><span className="studio-act-label">{action.label}</span></>;
  const cls = "studio-act" + (action.tone === "bad" ? " bad" : "");
  if (action.href) {
    return <a aria-label={action.label} className={cls} href={action.href} rel="noreferrer" target="_blank" title={action.label}>{body}</a>;
  }
  return <button aria-label={action.label} className={cls} onClick={(event) => { event.stopPropagation(); action.onClick?.(); }} title={action.label} type="button">{body}</button>;
}

export function StudioTile({
  src, media, aspect = 1, label, meta, kind, badge, selected, added, actions, onActivate, onDoubleClick,
  activateLabel, loading, error, pressed, data, className,
}: StudioTileProps) {
  const picked = Boolean(selected || added);
  const fallback = <span className="studio-tile-ph"><Icon name={kind === "video" ? "video" : "image"} size="s" /></span>;
  const picture = media ?? (src ? <ThumbImg fallback={fallback} src={src} width={480} /> : fallback);
  const showVeil = Boolean(label || meta || actions?.length);
  const corner = Boolean(badge || error);
  return <div className={"studio-tile" + (picked ? " is-picked" : "") + (corner ? " has-badge" : "") + (loading ? " is-loading" : "") + (className ? " " + className : "")} {...dataProps(data)}>
    <div className="studio-tile-frame" style={{ aspectRatio: aspect }}>
      <div className="studio-tile-media">{picture}</div>
      {loading ? <span aria-hidden="true" className="studio-tile-skeleton" /> : null}
      {kind === "video" ? <span aria-hidden="true" className="studio-tile-kind"><Icon name="play" size="xs" /></span> : null}
      {badge ? <span className="studio-tile-badge">{badge}</span> : null}
      {error ? <span className="studio-tile-badge" role="status" title={error}>导入失败</span> : null}
      {picked ? <span aria-hidden="true" className={"studio-tile-pick" + (selected ? " on" : " added")}><Icon name="check" size="xs" /></span> : null}
      {showVeil ? <div className="studio-tile-veil">
        <div className="studio-tile-cap">
          {label ? <span className="studio-tile-name">{label}</span> : null}
          {meta ? <span className="studio-tile-meta">{meta}</span> : null}
        </div>
        {actions?.length ? <div className="studio-tile-acts">{actions.map((action) => <StudioActionButton action={action} key={action.label} />)}</div> : null}
      </div> : null}
      {onActivate ? <button
        aria-label={activateLabel || label || "查看大图"}
        aria-pressed={pressed}
        className="studio-tile-hit"
        onClick={onActivate}
        onDoubleClick={onDoubleClick}
        type="button"
      /> : null}
    </div>
  </div>;
}

export function StudioGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={"studio-grid" + (className ? " " + className : "")}>{children}</div>;
}

export type StudioLightboxItem = { id: string; label?: string; media: ReactNode; info: ReactNode };

function portalRoot(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.querySelector<HTMLElement>(".cn-root");
}

export function StudioLightbox({ items, index, onIndex, onClose, label = "查看大图", data }: {
  items: StudioLightboxItem[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  label?: string;
  data?: StudioData;
}) {
  const item = items[index];
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (items.length < 2) return;
      if (event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); onIndex((index - 1 + items.length) % items.length); }
      else if (event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); onIndex((index + 1) % items.length); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, items.length, onIndex, onClose]);
  const root = portalRoot();
  if (!root || !item) return null;
  const step = (dir: number) => onIndex((index + dir + items.length) % items.length);
  // 点空白（遮罩 / 舞台空处）关闭；图片、视频、信息栏与按钮本体点了不关
  const closeOnBlank = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("img, video, canvas, a, button, .studio-lb-bar")) return;
    onClose();
  };
  return createPortal(
    <div
      aria-label={label}
      aria-modal="true"
      className="studio-lb"
      data-studio-lightbox
      role="dialog"
      {...dataProps(data)}
      onClick={closeOnBlank}
    >
      <div className="studio-lb-stage">{item.media}</div>
      {items.length > 1 ? <>
        <button aria-label="上一张" className="studio-lb-nav prev" onClick={(event) => { event.stopPropagation(); step(-1); }} title="上一张" type="button"><Icon name="left" size="s" /></button>
        <button aria-label="下一张" className="studio-lb-nav next" onClick={(event) => { event.stopPropagation(); step(1); }} title="下一张" type="button"><Icon name="right" size="s" /></button>
      </> : null}
      <div className="studio-lb-bar">
        <div className="studio-lb-info">{item.info}</div>
        <div className="studio-lb-hint"><span className="studio-lb-count tnum">{index + 1} / {items.length}</span> · ← / → 切换 · Esc 或点空白处关闭</div>
      </div>
    </div>,
    root,
  );
}
