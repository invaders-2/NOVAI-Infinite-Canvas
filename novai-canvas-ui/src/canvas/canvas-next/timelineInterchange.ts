/**
 * 剪辑工程导出：把时间线写成专业剪辑软件能直接打开的工程文件，连同素材打成一个 zip。
 *
 *   NOVAI-xxx/
 *     ├─ 工程-Premiere-达芬奇.xml   FCP7 XML（xmeml v4）：Premiere Pro、DaVinci Resolve、Avid（经转换）
 *     ├─ 工程-FinalCut.fcpxml       FCPXML 1.9：Final Cut Pro 10.5+
 *     ├─ 工程.otio                  OpenTimelineIO：Resolve 18+、Nuke Studio、各种管线工具
 *     ├─ 字幕.srt                   时间线上的字幕（各软件都能导入成字幕轨）
 *     ├─ media/                     用到的素材原文件
 *     └─ 说明.txt
 *
 * 素材用相对路径 media/xxx 引用：解压后整个文件夹一起用；软件提示素材离线时，指向 media 文件夹即可一次全部重新链接。
 *
 * 能对应过去的：剪切位置、素材入出点、变速、音量、交叉溶解类转场、黑场淡入（xml）、
 *   画中画 / 变换的静态位置、缩放、旋转、不透明度，多层画中画分轨。
 * 对应不过去的（写进 .otio 的 metadata.novai，并在说明里列出）：关键帧动画、调色、
 *   擦除 / 推入 / 放大转场（按交叉溶解导出）、背景音乐自动压低。
 *
 * 纯函数部分（buildProject / toXmeml / toFcpxml / toOtio）不碰浏览器 API，node 里可直接测。
 */
import { FPS, OVERLAP_TRANS, baseTf, colorFilter, duckOf, place, speedOf, toSrt, totalOf, transOf, volOf, type Clip, type ClipMedia, type Tf } from "./timelineModel";

export type IxMedia = { id: string; url: string; file: string; kind: ClipMedia; dur: number; w: number; h: number; hasVideo: boolean; hasAudio: boolean };
export type IxTrans = { kind: "dissolve" | "fade"; frames: number; h1: number };
/** 一个片段在工程里的样子：全部以帧为单位（30fps） */
export type IxItem = { media: IxMedia; clip: Clip; start: number; dur: number; srcIn: number; speed: number; volume: number; tf: Tf | null; trans: IxTrans | null };
export type IxProject = {
  name: string; width: number; height: number; frames: number; fit: "contain" | "cover";
  media: IxMedia[]; v1: IxItem[]; overlays: IxItem[][]; a1: IxItem[]; a2: IxItem[]; subs: Array<{ start: number; end: number; text: string }>; srt: string; notes: string[];
};

const F = (sec: number) => Math.max(0, Math.round(sec * FPS));
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hrefOf = (m: IxMedia) => encodeURI("media/" + m.file);

/* ---------------- 时间线 → 工程结构 ---------------- */

/** 吸附轨：溶解类转场在 NOVAI 里是「后一段提前进场、两段重叠」，NLE 里是「两段在剪切点相接 + 跨剪切点的转场」：
 *  剪切点放在重叠区里，前一段截到剪切点，后一段从剪切点开始（入点相应后移），多出来的部分就是转场用的余量 */
function snapItems(clips: Clip[], track: "video" | "audio", media: Map<string, IxMedia>, notes: Set<string>): IxItem[] {
  const placed = place(clips, track); const out: IxItem[] = [];
  placed.forEach((p, i) => {
    const m = p.clip.url ? media.get(p.clip.url) : undefined; if (!m) return;
    const speed = speedOf(p.clip); const start = F(p.start);
    const item: IxItem = { media: m, clip: p.clip, start, dur: Math.max(1, F(p.end) - start), srcIn: m.kind === "image" ? 0 : F(p.clip.inPoint), speed: m.kind === "image" ? 1 : speed, volume: volOf(p.clip), tf: null, trans: null };
    const tr = transOf(p.clip, placed[i - 1]?.clip);
    const prev = out[out.length - 1];
    if (OVERLAP_TRANS.includes(tr.kind) && i > 0 && tr.sec > 0 && prev && prev.clip === placed[i - 1].clip) {
      const S = Math.max(2, F(tr.sec)); const h1 = Math.floor(S / 2); const cut = start + h1;
      if (cut - prev.start >= 1 && item.dur - h1 >= 1) {
        prev.dur = cut - prev.start;
        item.start = cut; item.dur -= h1; item.srcIn += Math.round(h1 * item.speed);
        if (track === "video") item.trans = { kind: "dissolve", frames: S, h1 };
        if (tr.kind !== "dissolve") notes.add("擦除 / 推入 / 放大转场在工程里按交叉溶解导出");
      }
    } else if (tr.kind === "fade" && tr.sec > 0 && track === "video") {
      item.trans = { kind: "fade", frames: Math.max(1, F(tr.sec)), h1: 0 };
    }
    // 主轨也带上变换：xml 里要靠它把不同分辨率的素材缩放到「适配画幅」（Premiere 默认按原像素大小放）
    if (track === "video") item.tf = baseTf(p.clip);
    out.push(item);
  });
  return out;
}

export function buildProject(clips: Clip[], media: Map<string, IxMedia>, o: { name: string; width: number; height: number; fit?: "contain" | "cover" }): IxProject {
  const notes = new Set<string>();
  const v1 = snapItems(clips, "video", media, notes);
  const a2 = snapItems(clips, "audio", media, notes);
  // 画中画：自由摆放；时间上重叠的分到不同轨（V2、V3…）
  const lanes: IxItem[][] = [];
  for (const p of [...place(clips, "overlay")].sort((a, b) => a.start - b.start)) {
    const m = p.clip.url ? media.get(p.clip.url) : undefined; if (!m) continue;
    const start = F(p.start);
    const item: IxItem = { media: m, clip: p.clip, start, dur: Math.max(1, F(p.end) - start), srcIn: m.kind === "image" ? 0 : F(p.clip.inPoint), speed: m.kind === "image" ? 1 : speedOf(p.clip), volume: volOf(p.clip), tf: baseTf(p.clip), trans: null };
    const lane = lanes.find((l) => { const last = l[l.length - 1]; return last.start + last.dur <= start; });
    if (lane) lane.push(item); else lanes.push([item]);
  }
  // 视频自带的声音：和画面同位置放 A1（音量为 0 的不放）
  const a1 = [...v1, ...lanes.flat()].filter((it) => it.media.kind === "video" && it.media.hasAudio && it.volume > 0)
    .map((it) => ({ ...it, tf: null, trans: null })).sort((a, b) => a.start - b.start);
  for (const c of clips) {
    if (c.kf && c.kf.length) notes.add("关键帧动画没有导出（只保留第一帧之前的静态位置）");
    if (colorFilter(c)) notes.add("调色（亮度 / 对比 / 饱和）没有导出，需要在剪辑软件里重新调");
    if (duckOf(c) < 1) notes.add("背景音乐自动压低没有导出，需要在剪辑软件里手动压低");
  }
  const subs = place(clips, "subtitle").filter((p) => String(p.clip.text || "").trim()).map((p) => ({ start: F(p.start), end: Math.max(F(p.start) + 1, F(p.end)), text: String(p.clip.text).trim() }));
  return { name: o.name, width: o.width, height: o.height, fit: o.fit || "contain", frames: Math.max(1, F(totalOf(clips))), media: [...new Set(media.values())], v1, overlays: lanes, a1, a2, subs, srt: toSrt(clips), notes: [...notes] };
}

/** 素材在画幅里「适配显示」时的缩放（NOVAI 的 s=1 就是这个大小） */
const fitScale = (p: IxProject, m: IxMedia) => { const w = m.w || p.width, h = m.h || p.height; return p.fit === "cover" ? Math.max(p.width / w, p.height / h) : Math.min(p.width / w, p.height / h); };
const dB = (v: number) => (v <= 0.0001 ? -96 : Math.round(20 * Math.log10(v) * 100) / 100);

/* ---------------- FCP7 XML（Premiere / 达芬奇） ---------------- */

export function toXmeml(p: IxProject): string {
  const rate = `<rate><timebase>${FPS}</timebase><ntsc>FALSE</ntsc></rate>`;
  const fileIds = new Map<string, string>(); let clipN = 0;
  const fileXml = (m: IxMedia) => {
    if (fileIds.has(m.id)) return `<file id="${fileIds.get(m.id)}"/>`;
    const id = "file-" + (fileIds.size + 1); fileIds.set(m.id, id);
    const dur = m.kind === "image" ? F(3600) : F(m.dur);
    const v = m.hasVideo ? `<video><samplecharacteristics>${rate}<width>${m.w || p.width}</width><height>${m.h || p.height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></video>` : "";
    const a = m.hasAudio ? `<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>` : "";
    return `<file id="${id}"><name>${esc(m.file)}</name><pathurl>${esc(hrefOf(m))}</pathurl>${rate}<duration>${dur}</duration><media>${v}${a}</media></file>`;
  };
  const param = (id: string, name: string, value: string | number, extra = "") => `<parameter><parameterid>${id}</parameterid><name>${name}</name>${extra}<value>${value}</value></parameter>`;
  const speedFx = (it: IxItem) => Math.abs(it.speed - 1) < 1e-4 ? "" :
    `<filter><effect><name>Time Remap</name><effectid>timeremap</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>${param("variablespeed", "variablespeed", 0)}${param("speed", "speed", r4(it.speed * 100))}${param("reverse", "reverse", "FALSE")}${param("frameblending", "frameblending", "FALSE")}</effect></filter>`;
  const motionFx = (it: IxItem) => {
    if (!it.tf) return "";
    const t = it.tf; let s = "";
    if (!(Math.abs(t.x - 0.5) < 1e-4 && Math.abs(t.y - 0.5) < 1e-4 && Math.abs(t.s - 1) < 1e-4 && Math.abs(t.r) < 1e-4) || fitScale(p, it.media) !== 1) {
      s += `<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>`
        + param("scale", "Scale", r4(t.s * fitScale(p, it.media) * 100), "<valuemin>0</valuemin><valuemax>1000</valuemax>")
        + param("rotation", "Rotation", r4(t.r), "<valuemin>-8640</valuemin><valuemax>8640</valuemax>")
        + `<parameter><parameterid>center</parameterid><name>Center</name><value><horiz>${r4(t.x - 0.5)}</horiz><vert>${r4(t.y - 0.5)}</vert></value></parameter>`
        + `</effect></filter>`;
    }
    if (t.o < 0.9999) s += `<filter><effect><name>Opacity</name><effectid>opacity</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>${param("opacity", "opacity", r4(t.o * 100), "<valuemin>0</valuemin><valuemax>100</valuemax>")}</effect></filter>`;
    return s;
  };
  const levelFx = (it: IxItem) => Math.abs(it.volume - 1) < 1e-4 ? "" :
    `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype>${param("level", "Level", r4(it.volume), "<valuemin>0</valuemin><valuemax>3.98109</valuemax>")}</effect></filter>`;
  const clipXml = (it: IxItem, kind: "video" | "audio") => {
    const id = "clipitem-" + (++clipN);
    const srcLen = it.media.kind === "image" ? it.dur : Math.max(1, Math.round(it.dur * it.speed));
    const fileDur = it.media.kind === "image" ? F(3600) : F(it.media.dur);
    const src = kind === "audio" ? `<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>` : "";
    const fx = kind === "video" ? speedFx(it) + motionFx(it) : speedFx(it).replace("<mediatype>video</mediatype>", "<mediatype>audio</mediatype>") + levelFx(it);
    return `<clipitem id="${id}"><name>${esc(it.clip.title || it.media.file)}</name><enabled>TRUE</enabled><duration>${fileDur}</duration>${rate}<start>${it.start}</start><end>${it.start + it.dur}</end><in>${it.srcIn}</in><out>${it.srcIn + srcLen}</out>${fileXml(it.media)}${src}${fx}</clipitem>`;
  };
  const transXml = (it: IxItem) => {
    if (!it.trans) return "";
    const a = it.trans.kind === "dissolve" ? it.start - it.trans.h1 : it.start; const b = a + it.trans.frames;
    return `<transitionitem>${rate}<start>${a}</start><end>${b}</end><alignment>${it.trans.kind === "dissolve" ? "center" : "start-black"}</alignment>`
      + `<effect><name>Cross Dissolve</name><effectid>Cross Dissolve</effectid><effectcategory>Dissolve</effectcategory><effecttype>transition</effecttype><mediatype>video</mediatype><wipecode>0</wipecode><wipeaccuracy>100</wipeaccuracy><startratio>0</startratio><endratio>1</endratio><reverse>FALSE</reverse></effect></transitionitem>`;
  };
  const vTrack = (items: IxItem[]) => `<track>${items.map((it) => transXml(it) + clipXml(it, "video")).join("")}<enabled>TRUE</enabled><locked>FALSE</locked></track>`;
  const aTrack = (items: IxItem[]) => `<track>${items.map((it) => clipXml(it, "audio")).join("")}<enabled>TRUE</enabled><locked>FALSE</locked></track>`;
  const videoTracks = [vTrack(p.v1), ...p.overlays.map(vTrack)].join("");
  const audioTracks = [p.a1, p.a2].filter((t) => t.length).map(aTrack).join("") || "<track></track>";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4"><sequence id="sequence-1"><name>${esc(p.name)}</name><duration>${p.frames}</duration>${rate}`
    + `<timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>`
    + `<media><video><format><samplecharacteristics>${rate}<width>${p.width}</width><height>${p.height}</height><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>${videoTracks}</video>`
    + `<audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>${audioTracks}</audio></media></sequence></xmeml>\n`;
}

/* ---------------- FCPXML 1.9（Final Cut Pro） ---------------- */

const fr = (n: number) => (n ? `${n}/${FPS}s` : "0s");
type SpineEl = { kind: "clip"; it: IxItem; offset: number; dur: number; start: number } | { kind: "gap"; offset: number; dur: number; start: number };

export function toFcpxml(p: IxProject): string {
  const formats = new Map<string, string>(); const res: string[] = [];
  res.push(`<format id="r1" frameDuration="1/${FPS}s" width="${p.width}" height="${p.height}" colorSpace="1-1-1 (Rec. 709)"/>`);
  const formatOf = (m: IxMedia) => {
    const key = (m.kind === "image" ? "still" : "v") + `${m.w || p.width}x${m.h || p.height}`;
    if (!formats.has(key)) {
      const id = "r" + (2 + formats.size); formats.set(key, id);
      res.push(m.kind === "image"
        ? `<format id="${id}" frameDuration="1/${FPS}s" width="${m.w || p.width}" height="${m.h || p.height}" colorSpace="1-13-1"/>`
        : `<format id="${id}" frameDuration="1/${FPS}s" width="${m.w || p.width}" height="${m.h || p.height}" colorSpace="1-1-1 (Rec. 709)"/>`);
    }
    return formats.get(key)!;
  };
  const assetIds = new Map<string, string>();
  p.media.forEach((m, i) => {
    const id = "a" + (i + 1); assetIds.set(m.id, id);
    const fmt = m.hasVideo ? ` format="${formatOf(m)}"` : "";
    const aud = m.hasAudio ? ` hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000"` : "";
    res.push(`<asset id="${id}" name="${esc(m.file)}" start="0s" duration="${m.kind === "image" ? "0s" : fr(F(m.dur))}"${m.hasVideo ? ` hasVideo="1"` : ""}${fmt}${aud}><media-rep kind="original-media" src="${esc(hrefOf(m))}"/></asset>`);
  });
  const anyTrans = p.v1.some((it) => it.trans?.kind === "dissolve");
  if (anyTrans) res.push(`<effect id="rxd" name="Cross Dissolve" uid="FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265"/>`);

  const tfXml = (it: IxItem) => {
    if (!it.tf) return "";
    const t = it.tf; let s = "";
    if (!(Math.abs(t.x - 0.5) < 1e-4 && Math.abs(t.y - 0.5) < 1e-4 && Math.abs(t.s - 1) < 1e-4 && Math.abs(t.r) < 1e-4)) {
      // FCP 的位置以「画面高度的百分比」计，原点在中心、y 向上；缩放相对「适配」大小（和 NOVAI 的 s 一致）；旋转逆时针为正
      s += `<adjust-transform position="${r4((t.x - 0.5) * (p.width / p.height) * 100)} ${r4((0.5 - t.y) * 100)}" scale="${r4(t.s)} ${r4(t.s)}" rotation="${r4(-t.r)}"/>`;
    }
    if (t.o < 0.9999) s += `<adjust-blend amount="${r4(t.o)}"/>`;
    return s;
  };
  const volXml = (it: IxItem) => (it.media.hasAudio && Math.abs(it.volume - 1) > 1e-4 ? `<adjust-volume amount="${dB(it.volume)}dB"/>` : "");
  const timeMap = (it: IxItem) => Math.abs(it.speed - 1) < 1e-4 ? "" :
    `<timeMap><timept time="${fr(it.srcIn)}" value="${fr(it.srcIn)}" interp="linear"/><timept time="${fr(it.srcIn + it.dur)}" value="${fr(it.srcIn + Math.round(it.dur * it.speed))}" interp="linear"/></timeMap>`;
  /** 一个片段（offset 由调用方给：主线上是时间线位置，连接片段是宿主里的本地时间） */
  const clipXml = (it: IxItem, offset: number, lane: number | null, inner = "") => {
    const ln = lane === null ? "" : ` lane="${lane}"`; const name = esc(it.clip.title || it.media.file); const ref = assetIds.get(it.media.id);
    // 静帧包一层 clip（FCP 自己导出也常这么写，第三方解析器也认）
    if (it.media.kind === "image") return `<clip${ln} name="${name}" offset="${fr(offset)}" duration="${fr(it.dur)}" start="0s" format="r1" tcFormat="NDF">${tfXml(it)}<video ref="${ref}" offset="0s" duration="${fr(it.dur)}" start="0s"/>${inner}</clip>`;
    const audioOnly = !it.media.hasVideo;
    return `<asset-clip ref="${ref}"${ln} name="${name}" offset="${fr(offset)}" duration="${fr(it.dur)}" start="${fr(it.srcIn)}"${audioOnly ? "" : ` format="${formatOf(it.media)}"`} tcFormat="NDF">${timeMap(it)}${audioOnly ? "" : tfXml(it)}${volXml(it)}${inner}</asset-clip>`;
  };

  // 主线：V1 片段 + 中间 / 结尾补 gap，铺满整条时间线
  const spine: SpineEl[] = []; let cur = 0;
  for (const it of p.v1) {
    if (it.start > cur) { spine.push({ kind: "gap", offset: cur, dur: it.start - cur, start: 0 }); }
    spine.push({ kind: "clip", it, offset: it.start, dur: it.dur, start: it.srcIn }); cur = it.start + it.dur;
  }
  if (cur < p.frames) spine.push({ kind: "gap", offset: cur, dur: p.frames - cur, start: 0 });
  // 连接片段：画中画 lane 1、2…；独立音频 lane -1；挂到它开始时刻所在的主线元素上
  const anchored = new Map<SpineEl, string[]>();
  const attach = (it: IxItem, lane: number) => {
    const host = spine.find((e) => it.start >= e.offset && it.start < e.offset + e.dur) || spine[spine.length - 1];
    if (!host) return;
    const local = host.start + (it.start - host.offset);
    const list = anchored.get(host) || []; list.push(clipXml(it, local, lane)); anchored.set(host, list);
  };
  p.overlays.forEach((lane, i) => lane.forEach((it) => attach(it, i + 1)));
  p.a2.forEach((it) => attach(it, -1));

  const body = spine.map((e) => {
    const inner = (anchored.get(e) || []).join("");
    if (e.kind === "gap") return `<gap name="Gap" offset="${fr(e.offset)}" duration="${fr(e.dur)}" start="0s">${inner}</gap>`;
    const tr = e.it.trans?.kind === "dissolve" ? `<transition name="Cross Dissolve" offset="${fr(e.it.start - e.it.trans.h1)}" duration="${fr(e.it.trans.frames)}"><filter-video ref="rxd" name="Cross Dissolve"/></transition>` : "";
    return tr + clipXml(e.it, e.offset, null, inner);
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.9"><resources>${res.join("")}</resources>`
    + `<library><event name="NOVAI"><project name="${esc(p.name)}"><sequence format="r1" duration="${fr(p.frames)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k"><spine>${body}</spine></sequence></project></event></library></fcpxml>\n`;
}

/* ---------------- OpenTimelineIO ---------------- */

export function toOtio(p: IxProject): string {
  const RT = (v: number) => ({ OTIO_SCHEMA: "RationalTime.1", rate: FPS, value: v });
  const TR = (s: number, d: number) => ({ OTIO_SCHEMA: "TimeRange.1", start_time: RT(s), duration: RT(d) });
  const gap = (d: number) => ({ OTIO_SCHEMA: "Gap.1", name: "", source_range: TR(0, d), effects: [], markers: [], enabled: true, metadata: {} });
  const clipObj = (it: IxItem) => ({
    OTIO_SCHEMA: "Clip.1", name: it.clip.title || it.media.file, enabled: true,
    source_range: TR(it.srcIn, it.dur),
    media_reference: { OTIO_SCHEMA: "ExternalReference.1", name: it.media.file, target_url: hrefOf(it.media), available_range: it.media.kind === "image" ? null : TR(0, F(it.media.dur)), metadata: {} },
    effects: Math.abs(it.speed - 1) < 1e-4 ? [] : [{ OTIO_SCHEMA: "LinearTimeWarp.1", name: "speed", effect_name: "LinearTimeWarp", time_scalar: it.speed, metadata: {} }],
    markers: [],
    metadata: { novai: { id: it.clip.id, volume: it.volume, transform: it.tf || undefined, keyframes: it.clip.kf?.length ? it.clip.kf : undefined, color: it.clip.color, transition: it.clip.trans && it.clip.trans !== "none" ? { kind: it.clip.trans, ms: it.clip.transMs } : undefined, duck: it.clip.duck } },
  });
  const trackObj = (name: string, kind: "Video" | "Audio", items: IxItem[], withTrans: boolean, markers: unknown[] = []) => {
    const children: unknown[] = []; let cur = 0;
    for (const it of items) {
      if (it.start > cur) children.push(gap(it.start - cur));
      if (withTrans && it.trans?.kind === "dissolve" && children.length) children.push({ OTIO_SCHEMA: "Transition.1", name: "Cross Dissolve", transition_type: "SMPTE_Dissolve", in_offset: RT(it.trans.h1), out_offset: RT(it.trans.frames - it.trans.h1), metadata: {} });
      children.push(clipObj(it)); cur = it.start + it.dur;
    }
    return { OTIO_SCHEMA: "Track.1", name, kind, children, source_range: null, effects: [], markers, enabled: true, metadata: {} };
  };
  const subMarkers = p.subs.map((s) => ({ OTIO_SCHEMA: "Marker.2", name: s.text, marked_range: TR(s.start, s.end - s.start), color: "YELLOW", comment: s.text, metadata: { novai: { subtitle: true } } }));
  const tracks = [
    trackObj("V1", "Video", p.v1, true, subMarkers),
    ...p.overlays.map((l, i) => trackObj("V" + (i + 2) + " 画中画", "Video", l, false)),
    ...(p.a1.length ? [trackObj("A1 视频原声", "Audio", p.a1, false)] : []),
    ...(p.a2.length ? [trackObj("A2 音频", "Audio", p.a2, false)] : []),
  ];
  return JSON.stringify({
    OTIO_SCHEMA: "Timeline.1", name: p.name, global_start_time: RT(0),
    metadata: { novai: { width: p.width, height: p.height, fps: FPS, fit: p.fit } },
    tracks: { OTIO_SCHEMA: "Stack.1", name: "tracks", children: tracks, source_range: null, effects: [], markers: [], enabled: true, metadata: {} },
  }, null, 2) + "\n";
}

export function readme(p: IxProject): string {
  return [
    `NOVAI 剪辑工程：${p.name}`,
    `画幅 ${p.width}×${p.height} · ${FPS}fps · ${(p.frames / FPS).toFixed(2)} 秒 · 素材 ${p.media.length} 个`,
    "",
    "怎么打开",
    "  · Premiere Pro：文件 → 导入 → 选「工程-Premiere-达芬奇.xml」",
    "  · 达芬奇 Resolve：文件 → 导入 → 时间线 → 选「工程-Premiere-达芬奇.xml」（或 工程.otio）",
    "  · Final Cut Pro：文件 → 导入 → XML → 选「工程-FinalCut.fcpxml」",
    "  · 字幕：把「字幕.srt」拖进软件，会变成一条字幕轨",
    "",
    "素材在 media 文件夹里，用相对路径引用。请先把整个文件夹解压到固定位置再导入；",
    "如果软件提示素材离线，选「重新链接」指向 media 文件夹，会一次全部连上。",
    p.media.some((m) => /\.webm$/i.test(m.file)) ? "注意：有 WebM 素材，Final Cut Pro / Premiere 不能直接读，需要先转成 MP4 / MOV。" : "",
    "",
    p.notes.length ? "没法完全对应的地方\n" + p.notes.map((n) => "  · " + n).join("\n") : "时间线里的剪辑都已对应到工程文件。",
    "",
  ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

/* ---------------- 浏览器：收集素材 + 打包 ---------------- */

const EXT: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/mp4": "m4a", "audio/aac": "aac", "audio/ogg": "ogg", "audio/webm": "webm", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const cleanName = (s: string) => String(s || "").replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

async function probe(blob: Blob, kind: ClipMedia, fallback: { dur: number; w: number; h: number }): Promise<{ dur: number; w: number; h: number; hasVideo: boolean; hasAudio: boolean }> {
  if (kind === "image") {
    try { const bm = await createImageBitmap(blob); const r = { dur: 0, w: bm.width, h: bm.height, hasVideo: true, hasAudio: false }; bm.close(); return r; } catch { return { ...fallback, dur: 0, hasVideo: true, hasAudio: false }; }
  }
  try {
    const mb = await import("mediabunny");
    const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
    try {
      const [dur, vt, at] = await Promise.all([input.computeDuration(), input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
      return { dur: dur || fallback.dur, w: vt?.displayWidth || 0, h: vt?.displayHeight || 0, hasVideo: !!vt, hasAudio: !!at };
    } finally { try { input.dispose(); } catch { /* ignore */ } }
  } catch {
    return { ...fallback, hasVideo: kind === "video", hasAudio: true };
  }
}

export async function exportProjectZip(clips: Clip[], o: {
  name: string; folder: string; width: number; height: number; fit?: "contain" | "cover";
  resolve: (u: string) => Promise<string>; onProgress?: (f: number, label: string) => void;
}): Promise<Blob> {
  const { makeZip } = await import("./zip");
  const progress = o.onProgress || (() => undefined);
  const used = clips.filter((c) => c.type !== "subtitle" && c.url);
  const urls = [...new Set(used.map((c) => c.url))];
  const media = new Map<string, IxMedia>(); const files: Array<{ name: string; data: Blob | Uint8Array }> = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]; const c = used.find((x) => x.url === url)!;
    progress(i / Math.max(1, urls.length), `打包素材 ${i + 1}/${urls.length}`);
    const resp = await fetch(await o.resolve(url));
    if (!resp.ok) throw new Error(`素材「${c.title || url}」读取失败（${resp.status}）`);
    const blob = await resp.blob();
    const type = (blob.type || resp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const urlExt = (url.split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i) || [])[1];
    const ext = EXT[type] || (urlExt ? urlExt.toLowerCase() : c.mediaKind === "image" ? "png" : c.mediaKind === "audio" ? "mp3" : "mp4");
    const file = `${String(i + 1).padStart(2, "0")}-${cleanName(c.title || "") || c.mediaKind}.${ext}`;
    const info = await probe(blob, c.mediaKind, { dur: Number(c.srcDur) || c.outPoint || 0, w: o.width, h: o.height });
    media.set(url, { id: "m" + (i + 1), url, file, kind: c.mediaKind, ...info });
    files.push({ name: `${o.folder}/media/${file}`, data: blob });
  }
  progress(1, "写工程文件");
  const p = buildProject(clips, media, { name: o.name, width: o.width, height: o.height, fit: o.fit });
  const enc = new TextEncoder();
  files.unshift(
    { name: `${o.folder}/工程-Premiere-达芬奇.xml`, data: enc.encode(toXmeml(p)) },
    { name: `${o.folder}/工程-FinalCut.fcpxml`, data: enc.encode(toFcpxml(p)) },
    { name: `${o.folder}/工程.otio`, data: enc.encode(toOtio(p)) },
    ...(p.srt.trim() ? [{ name: `${o.folder}/字幕.srt`, data: enc.encode(p.srt) }] : []),
    { name: `${o.folder}/说明.txt`, data: enc.encode(readme(p)) },
  );
  return makeZip(files);
}
