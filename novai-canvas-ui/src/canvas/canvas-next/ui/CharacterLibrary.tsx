/**
 * AI 角色库：素材库头部「AI 角色」打开的全屏角色面板 + 角色详情弹层。
 * 数据是 ../elements.ts 里的角色元素（kind: "character"），属性见 attrs；尺寸/文案对齐
 * docs/v2/AI-CHARACTER-LIBRARY-SPEC.md 的 TapNow 实测。
 */
import { useEffect, useMemo, useState } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { deleteElement, ELEMENT_ATTR_FIELDS, ELEMENT_ERAS, setElementFav, type CanvasElement, type ElementAttrKey } from "../elements";
import type { Ctl } from "./ctx";
import { GenerateCharacter, useCharacterJobs, type CharacterJobView } from "./CharacterGenerate";
import { createElementFrom, editElement, insertElement, placeRefs, useElements } from "./Elements";
import { Icon } from "./Icon";
import { CHARACTER_OPTION_MAP } from "./characterOptions";
import { ImageViewer, type ViewItem } from "./ImageViewer";
import { openModal, openPop } from "./overlay";
import { PreviewImg } from "./thumb";
import { useAssetUrl } from "./useAsset";
import "./character.css";

/** 筛选条九维（时代用左栏分类，不重复出现在这里） */
const FILTERS: Array<[ElementAttrKey, string]> = [["gender", "性别"], ["age", "年龄段"], ["species", "物种"], ["build", "体格"], ["height", "身高"], ["skin", "肤色"], ["hairLen", "发长"], ["hairColor", "发色"], ["vibe", "气质"]];
const PAGE = 24;
/** 左栏「未分类」：只有存在没有 attrs.era 的老数据时才出现 */
const UNCAT = "uncategorized";
const FALLBACK_ERA = "当代现实";
const metaOf = (e: CanvasElement) => [e.attrs?.gender, e.attrs?.age, e.attrs?.build, e.attrs?.vibe].filter(Boolean).join(" · ");
/** 头部任务 chip：生成中带进度、保存中、其余给「可继续」入口 */
const jobChipState = (j: CharacterJobView) => (j.active ? `${j.done}/4` : j.saving ? "保存中" : "· 可继续");
const jobChipTitle = (j: CharacterJobView) => (j.active ? `${j.name} · 生成中 ${j.done}/4` : j.saving ? `${j.name} · 保存中` : `${j.name} · 未完成，可继续生成`);

export function openCharacterLibrary(ctl: Ctl) {
  // 素材库抽屉开着时先收起来：面板铺满画布区，两个浮层叠着会互相透
  if (ctl.store.state.ui.drawer) ctl.store.setUI({ drawer: null });
  openModal((close) => <CharacterLibrary ctl={ctl} close={close} />, "chlib");
}

function CharacterLibrary({ ctl, close }: { ctl: Ctl; close: () => void }) {
  const all = useElements().filter((e) => e.kind === "character");
  const jobs = useCharacterJobs();
  const [era, setEra] = useState<string>("all");
  const [filters, setFilters] = useState<Partial<Record<ElementAttrKey, string[]>>>({});
  const [limit, setLimit] = useState(PAGE);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [genOpen, setGenOpen] = useState<null | { jobId?: string }>(null);
  const [view, setView] = useState<{ items: ViewItem[]; start: number } | null>(null);
  useEffect(() => { setLimit(PAGE); }, [era, filters]);
  useEffect(() => { setConfirmDel(false); }, [detailId]);
  // Esc：确认层 → 详情 → 面板逐层收（modal 的 Esc 在冒泡阶段，这里捕获阶段先接住）
  useEffect(() => {
    if (!detailId || view) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      e.preventDefault();
      if (confirmDel) { setConfirmDel(false); return; }
      setDetailId(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [detailId, view, confirmDel]);
  const matchEra = (e: CanvasElement) => (era === "fav" ? !!e.fav : era === "all" ? true : era === UNCAT ? !e.attrs?.era : e.attrs?.era === era);
  // 候选 = 固定字典 + 当前「时代」分类里数据出现过的额外值
  const eraScoped = useMemo(() => all.filter(matchEra), [all, era]);
  const filterOptions = useMemo(() => {
    const out: Partial<Record<ElementAttrKey, string[]>> = {};
    for (const [k] of FILTERS) {
      const dict = CHARACTER_OPTION_MAP[k] || [];
      const extras = [...new Set(eraScoped.map((e) => e.attrs?.[k] || "").filter((v) => !!v && !dict.includes(v)))].sort((a, b) => a.localeCompare(b, "zh"));
      out[k] = [...dict, ...extras];
    }
    return out;
  }, [eraScoped]);
  // 同维度多值 = 或；不同维度 = 且
  const list = useMemo(() => all.filter((e) => matchEra(e) && FILTERS.every(([k]) => { const sel = filters[k]; return !sel?.length || sel.includes(e.attrs?.[k] || ""); })), [all, era, filters]);
  const detail = detailId ? all.find((e) => e.id === detailId) || null : null;
  const eraName = era === "all" ? "全部角色" : era === "fav" ? "收藏" : era === UNCAT ? "未分类" : era;
  const selectedNodes = () => [...ctl.store.state.ui.sel].map((id) => ctl.store.node(id)).filter((n): n is CanvasNode => !!n);
  const newCharacter = (eraSel?: string) => createElementFrom(ctl, selectedNodes(), { kind: "character", ...(eraSel ? { attrs: { era: eraSel } } : {}) }, () => openCharacterLibrary(ctl));
  const counts = new Map(ELEMENT_ERAS.map((x) => [x as string, all.filter((e) => e.attrs?.era === x).length]));
  const uncategorized = all.filter((e) => !e.attrs?.era).length;
  /** 当前左栏分类对应的「新建 / 生成」默认时代：全部角色 / 未分类 → 当代现实 */
  const eraForNew = era === "all" || era === "fav" || era === UNCAT ? FALLBACK_ERA : era;
  const rows = [
    { key: "all", label: "全部角色", count: all.length, canAdd: true },
    { key: "fav", label: "收藏", count: all.filter((e) => e.fav).length, canAdd: false },
    ...ELEMENT_ERAS.map((x) => ({ key: x as string, label: x as string, count: counts.get(x) || 0, canAdd: true })),
    ...(uncategorized ? [{ key: UNCAT, label: "未分类", count: uncategorized, canAdd: false }] : []),
  ];
  return <div className="chlib-panel">
    <div className="chlib-head"><b>AI角色库</b>{all.length ? <span className="chlib-total tnum">{all.length} 个角色</span> : null}
      {jobs.length ? <span className="chlib-jobs" data-ch-jobs>{jobs.map((j) => <button key={j.id} type="button" className={"chlib-job" + (j.active ? " on" : "")} data-ch-job={j.name} title={jobChipTitle(j)} onClick={() => setGenOpen({ jobId: j.id })}><span className="nm">{j.name}</span> <span className="st">{jobChipState(j)}</span></button>)}</span> : null}
      <span className="sp" /><button className="chlib-gen" data-ch-generate onClick={() => setGenOpen({})}><Icon name="sparkle" size="xs" />AI 生成角色</button><button className="chlib-x" aria-label="关闭" onClick={close}><Icon name="x" size="s" /></button></div>
    <div className="chlib-body">
      <div className="chlib-side">
        {rows.map((row) =>
          <div key={row.key} role="button" tabIndex={0} data-ch-era={row.key} title={row.label} className={"chlib-cat" + (era === row.key ? " on" : "")} onClick={() => setEra(row.key)} onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setEra(row.key); } }}>
            {row.key === "fav" ? <Icon name="star" size="xs" /> : null}<span className="lb">{row.label}</span><span className="n tnum">{row.count || ""}</span>
            {row.canAdd ? <button className="chlib-cat-add" aria-label={"在「" + row.label + "」下新建角色"} title="用选中的图片新建角色" onClick={(ev) => { ev.stopPropagation(); newCharacter(eraForNew); }}><Icon name="plus" size="xs" /></button> : null}
          </div>)}
      </div>
      <div className="chlib-main">
        <div className="chlib-tools">
          <span className="chlib-now"><b>{eraName}</b>{list.length ? <span className="tnum"> · {list.length}</span> : null}</span>
          <span className="chlib-chips">{FILTERS.map(([k, label]) => <FilterChip key={k} dim={k} label={label} values={filters[k] || []} options={filterOptions[k] || []} onPick={(vals) => setFilters((f) => { const next = { ...f }; if (vals.length) next[k] = vals; else delete next[k]; return next; })} />)}</span>
        </div>
        <div className="chlib-scroll">
          {!all.length ? <div className="chlib-empty">
            <Icon name="user" size="s" />
            <b>还没有角色</b>
            <span className="lg-dim">用 AI 一次生成四张纯白底设定图（立绘 / 肖像 / 表情九宫格 / 三视图），或者把画布上的角色图片存成角色</span>
            <button className="btn solid" data-ch-generate onClick={() => setGenOpen({})}><Icon name="sparkle" size="xs" />AI 生成角色</button>
            <button className="linkbtn" data-ch-new onClick={() => newCharacter(eraForNew)}>从选中的图片新建角色</button>
          </div> : list.length ? <>
            <div className="chgrid">{list.slice(0, limit).map((e) => <CharacterCard key={e.id} e={e} onOpen={() => setDetailId(e.id)} />)}</div>
            {list.length > limit ? <div className="chlib-more"><button className="btn" data-ch-more onClick={() => setLimit((n) => n + PAGE)}>加载更多</button></div> : null}
          </> : era === "fav" ? <div className="chlib-empty">
            <Icon name="star" size="s" />
            <b>还没有收藏角色</b>
            <span className="lg-dim">把鼠标移到角色卡片上，点右上角的星标就能收藏</span>
          </div> : <div className="chlib-empty">
            <Icon name="user" size="s" />
            <b>没有符合条件的角色</b>
            <span className="lg-dim">换个分类，或者把筛选条件清掉</span>
            <button className="btn" onClick={() => { setFilters({}); setEra("all"); }}>清空筛选</button>
          </div>}
        </div>
      </div>
    </div>
    {detail ? <CharacterDetail ctl={ctl} e={detail} confirmDel={confirmDel} onConfirmDel={setConfirmDel} onBack={() => { setConfirmDel(false); setDetailId(null); }} onClose={close} onView={(i) => {
      const all = detail.refs.map((src, k) => ({ src, title: ["角色立绘", "肖像特写", "表情九宫格", "三视图"][k] || "角色图", ratio: k === 3 ? "16:9" : "3:4" })).filter((x) => x.src);
      const src = detail.refs[i]; if (!src) return;
      setView({ items: all, start: Math.max(0, all.findIndex((x) => x.src === src)) });
    }} /> : null}
    {view ? <ImageViewer items={view.items} start={view.start} onClose={() => setView(null)} /> : null}
    {genOpen ? <GenerateCharacter ctl={ctl} defaultEra={eraForNew} jobId={genOpen.jobId} onClose={() => setGenOpen(null)} onSaved={(id) => { setGenOpen(null); setDetailId(id); }} /> : null}
  </div>;
}

function FilterChip({ dim, label, values, options, onPick }: { dim: ElementAttrKey; label: string; values: string[]; options: string[]; onPick: (v: string[]) => void }) {
  const text = !values.length ? label : values.length === 1 ? label + " · " + values[0] : label + " · " + values.length + " 项";
  return <button className={"ch-chip" + (values.length ? " on" : "")} data-ch-filter={dim} title={text} onClick={(ev) => openPop(ev.currentTarget, () => <FilterMenu dim={dim} label={label} options={options} initial={values} onChange={onPick} />, "down", "left", "chfilter-pop")}><Icon name="plus" size="xs" />{text}</button>;
}

/** 多选筛选面板：点行切换、不关弹层；同维度或、不同维度且；没有「不限」和数量 */
function FilterMenu({ dim, label, options, initial, onChange }: { dim: ElementAttrKey; label: string; options: string[]; initial: string[]; onChange: (v: string[]) => void }) {
  const [picked, setPicked] = useState<string[]>(initial);
  const toggle = (v: string) => {
    const next = picked.includes(v) ? picked.filter((x) => x !== v) : [...picked, v];
    setPicked(next); onChange(next);
  };
  return <>
    <div className="mh">{label}</div>
    {options.map((v) => {
      const on = picked.includes(v);
      return <button key={v} role="checkbox" aria-checked={on} className={"mi chk" + (on ? " on" : "")} data-ch-filter-opt={dim + ":" + v} onClick={() => toggle(v)}><span className={"chk-box" + (on ? " on" : "")}>{on ? <Icon name="check" size="xs" /> : null}</span><span className="chk-name">{v}</span></button>;
    })}
  </>;
}

function CharacterCard({ e, onOpen }: { e: CanvasElement; onOpen: () => void }) {
  const cover = useAssetUrl(e.refs[0] || "");
  return <div role="button" tabIndex={0} className="chcard" data-ch-card={e.name} title={e.desc || e.name} onClick={onOpen} onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onOpen(); } }}>
    <span className="cv">{cover ? <PreviewImg src={e.refs[0]} width={320} /> : <span className="chph"><Icon name="user" size="s" /></span>}
      <button className={"chfav" + (e.fav ? " on" : "")} data-ch-fav={e.name} aria-pressed={!!e.fav} aria-label={e.fav ? "取消收藏" : "收藏"} title={e.fav ? "取消收藏" : "收藏"} onClick={(ev) => { ev.stopPropagation(); setElementFav(e.id, !e.fav); }} onKeyDown={(ev) => ev.stopPropagation()}>
        <Icon name="star" size="xs" />
      </button>
    </span>
    <span className="tx"><span className="nm">{e.name}</span><span className="meta">{metaOf(e) || "未填属性"}</span></span>
  </div>;
}

function CharacterDetail({ ctl, e, confirmDel, onConfirmDel, onBack, onClose, onView }: { ctl: Ctl; e: CanvasElement; confirmDel: boolean; onConfirmDel: (v: boolean) => void; onBack: () => void; onClose: () => void; onView: (i: number) => void }) {
  const pics: Array<[string, string]> = [["角色立绘", e.refs[0] || ""], ["肖像特写", e.refs[1] || ""], ["表情九宫格", e.refs[2] || ""]];
  const wide = e.refs[3] || "";
  const rows: Array<[string, string]> = [];
  if (e.attrs?.era) rows.push(["大类", e.attrs.era]);
  for (const [k, label] of ELEMENT_ATTR_FIELDS) { const v = e.attrs?.[k]; if (k !== "era" && v) rows.push([label, v]); }
  const apply = () => { if (!e.refs.length) { ctl.store.toast("这个角色还没有参考图，先在编辑里补上"); return; } void placeRefs(ctl, e); onClose(); };
  return <div className="chdt-layer" onPointerDown={(ev) => { if (ev.target === ev.currentTarget) onBack(); }}>
    <div className="chdt" role="dialog" aria-label={e.name} onPointerDown={(ev) => ev.stopPropagation()}>
      <div className="chdt-hd">
        <button className="chdt-back" aria-label="返回角色列表" onClick={onBack}><Icon name="back" size="s" /></button>
        <b>{e.name}</b><span className="chdt-sub">{["AI 角色", e.attrs?.era].filter(Boolean).join(" · ")}</span>
        <span className="sp" />
        <button className="chdt-ib" aria-label="编辑角色" title="编辑角色" onClick={() => editElement(ctl, e, () => openCharacterLibrary(ctl))}><Icon name="pencil" size="s" /></button>
        <button className="chdt-ib" aria-label="在提示词里引用" title="在提示词里引用" onClick={() => insertElement(ctl, e)}><Icon name="link" size="s" /></button>
        <button className="chdt-ib danger" data-ch-del aria-label="删除角色" title="删除角色" onClick={() => onConfirmDel(true)}><Icon name="trash" size="s" /></button>
        <button className="chdt-ib" aria-label="关闭详情" onClick={onBack}><Icon name="x" size="s" /></button>
      </div>
      <div className="chdt-body">
        <div className="chdt-pics">
          <div className="chdt-grid">{pics.map(([label, src], i) => <figure key={label} className="chdt-fig"><span className={"chdt-img" + (src ? " can" : "")} onClick={() => onView(i)}>{src ? <Media src={src} w={900} /> : <Placeholder />}<span className="cap">{label}</span></span></figure>)}</div>
          <figure className="chdt-fig wide"><span className={"chdt-img" + (wide ? " can" : "")} onClick={() => onView(3)}>{wide ? <Media src={wide} w={1200} /> : <Placeholder />}<span className="cap">三视图</span></span></figure>
        </div>
        <div className="chdt-info">
          <span className="chdt-sec">角色属性</span>
          {rows.length ? <dl className="chdt-dl">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={value}>{value}</dd></div>)}</dl> : <p className="chdt-hint">还没有填属性，点右上角的编辑补充</p>}
          {e.attrs?.feature ? <><span className="chdt-sec">辨识特征</span><p className="chdt-text">{e.attrs.feature}</p></> : null}
          {e.attrs?.outfit ? <><span className="chdt-sec">着装描述</span><p className="chdt-text">{e.attrs.outfit}</p></> : null}
          <button className="chdt-apply" data-ch-apply onClick={apply}>应用到画布</button>
        </div>
      </div>
      {confirmDel ? <div className="chdt-confirm" data-ch-del-dialog onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => { if (ev.target === ev.currentTarget) onConfirmDel(false); }}>
        <div className="folder-dialog" role="dialog" aria-modal="true" aria-label="删除角色">
          <div className="fd-head"><b>删除角色</b><button type="button" className="ib" aria-label="关闭" onClick={() => onConfirmDel(false)}><Icon name="x" size="s" /></button></div>
          <p>删除「{e.name}」？删除后不可恢复。</p>
          <div className="fd-foot"><button type="button" className="btn" data-ch-del-cancel onClick={() => onConfirmDel(false)}>取消</button><button type="button" className="btn solid" data-ch-del-confirm onClick={() => { deleteElement(e.id); ctl.store.toast(`已删除角色「${e.name}」`); onBack(); }}>删除</button></div>
        </div>
      </div> : null}
    </div>
  </div>;
}

/** 详情里的图：只给显示层缩图（三竖图 w=900、三视图 w=1200），原图只在放大预览里用 */
function Media({ src, w }: { src: string; w: number }) { const url = useAssetUrl(src); return url ? <PreviewImg src={src} width={w} /> : null; }
function Placeholder() { return <span className="chdt-ph"><Icon name="image" size="s" /><span>暂无图片</span></span>; }
