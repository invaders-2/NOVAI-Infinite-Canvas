/** 视频工具条里的 AI 编辑弹层：替换 / 移除 / 续写 / 重拍（逻辑见 ../videoTools.ts） */
import { useState } from "react";
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { clampTrim, outOf, trimIsFull } from "../model";
import type { CanvasStore } from "../store";
import { aiVideoEdit, KEEP, mergeSeg, modelFor, opMode, RETAKE_CAMERAS, retakeSegments, splitSeg, type RetakeSeg, type VideoAiOp } from "../videoTools";
import { Icon, type IconName } from "./Icon";
import { openPop } from "./overlay";

const OPS: Array<[VideoAiOp, IconName, string, string]> = [
  ["replace", "wand", "替换物体", "把画面里的某样东西换掉"],
  ["remove", "eraser", "移除物体", "去掉画面里的某样东西并补全背景"],
  ["extend", "rundown", "续写视频", "往后接着拍，或在前面补一段开头"],
  ["retake", "camera", "重拍", "按时间分段，每段换机位重拍"],
];

/** 工具条「AI 编辑」：先选操作，再填内容 */
export function videoAiMenu(store: CanvasStore, node: CanvasNode, anchor: Element) {
  openPop(anchor, (close) => <>
    <div className="mh">AI 视频编辑</div>
    {OPS.map(([op, ic, label, desc]) => {
      const m = modelFor(store, opMode(op), store.modelOf(node));
      return <button key={op} className="mi" data-vai={op} title={m ? "" : `需要支持「${opMode(op)}」的视频模型`} onClick={() => { close(); setTimeout(() => videoAiForm(store, node, anchor, op), 140); }}>
        <span className="ic"><Icon name={ic} size="s" /></span><span>{label}<span className="d">{m ? desc : `没有支持「${opMode(op)}」的模型`}</span></span>
      </button>;
    })}
  </>, "up");
}

export function videoAiForm(store: CanvasStore, node: CanvasNode, anchor: Element, op: VideoAiOp) {
  openPop(anchor, (close) => <VideoAiForm store={store} node={node} op={op} close={close} />, "up", "left", "vai-pop");
}

function VideoAiForm({ store, node, op, close }: { store: CanvasStore; node: CanvasNode; op: VideoAiOp; close: () => void }) {
  const [a, setA] = useState(op === "retake" ? RETAKE_CAMERAS[0] : ""); const [b, setB] = useState("");
  const m = modelFor(store, opMode(op), store.modelOf(node));
  const o = outOf(node); const t = o ? clampTrim(o.dur, o.trim) : null; const part = !!(o?.trim && !trimIsFull(o.dur, o.trim));
  // 续写：往后 / 往前 + 时长；重拍：分段，每段一个机位（或保留原样）
  const [dir, setDir] = useState<"after" | "before">("after"); const durs = m?.durs?.length ? m.durs : [5, 10]; const [dur, setDur] = useState(durs[0]);
  const total = Number(o?.dur) > 0 ? Number(o!.dur) : 0;
  const [segs, setSegs] = useState<RetakeSeg[]>(() => {
    if (!total) return [{ in: 0, out: 0, cam: RETAKE_CAMERAS[0] }];
    if (part && t) return [{ in: 0, out: t.in, cam: KEEP }, { in: t.in, out: t.out, cam: RETAKE_CAMERAS[0] }, { in: t.out, out: total, cam: KEEP }].filter((x) => x.out - x.in >= 0.5);
    return [{ in: 0, out: total, cam: RETAKE_CAMERAS[0] }];
  });
  const [cutAt, setCutAt] = useState(total ? Math.round(total * 5) / 10 : 0);
  const patchSeg = (i: number, p: Partial<RetakeSeg>) => setSegs((l) => l.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const go = () => {
    close();
    if (op === "extend") void aiVideoEdit(store, node, op, a, dir, { dur });
    else if (op === "retake" && total) void retakeSegments(store, node, segs.map((x) => ({ ...x, note: x.note || b })));
    else void aiVideoEdit(store, node, op, a, b);
  };
  const stop = (e: React.KeyboardEvent) => { e.stopPropagation(); if ((e.metaKey || e.ctrlKey) && e.key === "Enter") go(); };
  const title = op === "replace" ? "替换物体" : op === "remove" ? "移除物体" : op === "extend" ? "续写视频" : "重拍片段";
  return <div className="vai" data-vai-form={op}>
    <div className="mh">{title}{m ? <span className="vai-model">{m.name} · {opMode(op)}</span> : null}</div>
    {!m ? <div className="gp-warn"><Icon name="alert" size="s" /><span>还没有支持「{opMode(op)}」的视频模型（如 Seedance），请在设置 › 模型里添加。</span></div> : null}
    {op === "replace" ? <>
      <label>要替换的东西</label><input autoFocus value={a} placeholder="例如：桌上的白色杯子" onChange={(e) => setA(e.target.value)} onKeyDown={stop} />
      <label>换成</label><input value={b} placeholder="例如：一束红玫瑰" onChange={(e) => setB(e.target.value)} onKeyDown={stop} />
    </> : op === "remove" ? <>
      <label>要移除的东西</label><input autoFocus value={a} placeholder="例如：右下角的路人" onChange={(e) => setA(e.target.value)} onKeyDown={stop} />
    </> : op === "extend" ? <>
      <div className="seg" data-vai-dir><button className={dir === "after" ? "on" : ""} onClick={() => setDir("after")}>往后接着拍</button><button className={dir === "before" ? "on" : ""} onClick={() => setDir("before")}>在前面补开头</button></div>
      <label>增加时长</label>
      <div className="seg wrap" data-vai-dur>{durs.map((d) => <button key={d} className={dur === d ? "on" : ""} onClick={() => setDur(d)}>{d}s</button>)}</div>
      <label>{dir === "after" ? "接下来发生什么（可不填）" : "开头发生什么（可不填）"}</label><textarea autoFocus rows={3} value={a} placeholder={dir === "after" ? "例如：镜头慢慢拉远，主角走出画面" : "例如：先是空镜头，主角从远处走进画面"} onChange={(e) => setA(e.target.value)} onKeyDown={stop} />
      {dir === "before" ? <p className="vai-note">新视频结尾会衔接原视频的第一帧，之后可以多选两个视频「建剪辑」接起来。</p> : null}
    </> : total ? <>
      <label>分段（共 {total.toFixed(1)}s）</label>
      <div className="rt-bar" data-rt-bar>{segs.map((x, i) => <span key={i} className={"rt-seg" + (x.cam === KEEP ? " keep" : "")} style={{ flexGrow: Math.max(0.1, x.out - x.in) }} title={`${x.in}s–${x.out}s · ${x.cam}`}>{i + 1}</span>)}</div>
      <div className="rt-cut"><span>在</span><input type="number" min={0} max={total} step={0.1} value={cutAt} onChange={(e) => setCutAt(Number(e.target.value))} onKeyDown={stop} /><span>秒处</span>
        <button className="btn" data-rt="cut" onClick={() => { const next = splitSeg(segs, cutAt); if (next) setSegs(next); else store.toast("切点两边都要至少留 1 秒"); }}>切开</button></div>
      <div className="rt-list">{segs.map((x, i) => <div key={i} className="rt-row" data-rt-seg={i}>
        <b className="tnum">{i + 1}</b><span className="tnum rt-t">{x.in.toFixed(1)}–{x.out.toFixed(1)}s</span>
        <select value={x.cam} data-rt-cam={i} onChange={(e) => patchSeg(i, { cam: e.target.value })}><option value={KEEP}>{KEEP}</option>{RETAKE_CAMERAS.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        {i < segs.length - 1 ? <button className="ib" title="和下一段合并" data-rt-merge={i} onClick={() => setSegs(mergeSeg(segs, i))}><Icon name="x" size="xs" /></button> : <span className="ib" />}
      </div>)}</div>
      <label>补充说明（可不填）</label><input value={b} placeholder="例如：节奏放慢一些" onChange={(e) => setB(e.target.value)} onKeyDown={stop} />
      <p className="vai-note">{segs.length > 1 ? "每段先裁成单独的视频再重拍（需要桌面版的 ffmpeg），全部完成后按原顺序拼成一条剪辑时间线。" : "整段换机位重拍。在上面输入秒数切开，可以每段用不同机位。"}</p>
    </> : <>
      <label>新机位</label>
      <div className="seg wrap">{RETAKE_CAMERAS.map((c) => <button key={c} className={a === c ? "on" : ""} onClick={() => setA(c)}>{c}</button>)}</div>
      <label>补充说明（可不填）</label><input value={b} placeholder="例如：节奏放慢一些" onChange={(e) => setB(e.target.value)} onKeyDown={stop} />
      <p className="vai-note">{part && t ? `只重拍使用区间 ${Math.round(t.in * 10) / 10}s–${Math.round(t.out * 10) / 10}s：先把这一段裁成单独的视频再生成（需要桌面版的 ffmpeg）。` : "没有设使用区间，会重拍整段。拖动视频下方的入点 / 出点可以只重拍一段。"}</p>
    </>}
    <div className="vai-foot"><span className="vai-note">会在右侧新建视频节点并开始生成，按服务商用量计费</span><button className="btn solid" data-vai-go disabled={!m} onClick={go}><Icon name="sparkle" size="s" />生成</button></div>
  </div>;
}
