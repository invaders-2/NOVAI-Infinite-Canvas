// @ts-nocheck —— 只给模拟后端用的程序化出图 / 文本，正式版不会打包到这条路径之外。
/* eslint-disable */
function rng(seed) { let a = (seed * 9301 + 49297) >>> 0 || 1; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
function cv(w, h) { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
function ratioWH(r, long = 640) { if (!r || /auto|自适应/i.test(r)) r = "3:4"; const [a, b] = r.split(":").map(Number); if (!a || !b) return [long, long]; return a >= b ? [long, Math.round((long * b) / a)] : [Math.round((long * a) / b), long]; }
export function loadImg(src) { return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; }); }
/* ========== 模拟出图（画布上的“生成结果”） ========== */
const PALETTES = [["#0b1026", "#3a2a8a", "#b9a6ff"], ["#f4f4f2", "#d6d6db", "#1d1d1f"], ["#2b1a12", "#a8552b", "#ffd2a1"], ["#06221e", "#0f6b5c", "#a6f0da"], ["#141416", "#3a3a3c", "#f5f5f7"], ["#22101a", "#7a2350", "#ffb3d4"], ["#0d1a2b", "#1f5c99", "#bfe1ff"]];
function drawBuds(g, cx, cy, s, light) {
  g.save(); g.translate(cx, cy);
  g.fillStyle = "rgba(0,0,0,.22)"; g.beginPath(); g.ellipse(0, s * .62, s * .95, s * .13, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = light ? "#2a2a2c" : "#5a5a5e"; g.lineWidth = s * .05; g.beginPath(); g.moveTo(s * .7, s * .1); g.bezierCurveTo(s * 1.25, s * .2, s * 1.2, s * .85, s * .55, s * .62); g.stroke();
  const gr = g.createLinearGradient(-s * .8, -s * .5, s * .8, s * .6); gr.addColorStop(0, "#3b3b3f"); gr.addColorStop(.45, "#141416"); gr.addColorStop(1, "#050506");
  g.fillStyle = gr; g.beginPath(); g.roundRect(-s * .8, -s * .35, s * 1.6, s * .95, s * .42); g.fill();
  g.strokeStyle = "rgba(255,255,255,.12)"; g.lineWidth = s * .015; g.beginPath(); g.moveTo(-s * .78, -s * .02); g.lineTo(s * .78, -s * .02); g.stroke();
  g.fillStyle = "#d9fbe8"; g.beginPath(); g.arc(0, s * .32, s * .03, 0, Math.PI * 2); g.fill();
  for (const sx of [-1, 1]) {
    g.save(); g.translate(sx * s * .38, -s * .52); g.rotate(sx * .35);
    const bg = g.createRadialGradient(-s * .05, -s * .08, s * .02, 0, 0, s * .26); bg.addColorStop(0, "#4a4a4f"); bg.addColorStop(1, "#0b0b0c");
    g.fillStyle = bg; g.beginPath(); g.ellipse(0, 0, s * .2, s * .24, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#101012"; g.beginPath(); g.roundRect(-s * .06, s * .12, s * .12, s * .32, s * .06); g.fill();
    g.fillStyle = "rgba(255,255,255,.18)"; g.beginPath(); g.ellipse(-s * .06, -s * .08, s * .06, s * .04, -.6, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  g.restore();
}
function wrapText(g, text, x, y, maxW, lh, maxLines = 3) {
  const chars = [...String(text)]; let line = ""; let n = 0;
  for (let i = 0; i < chars.length; i++) {
    const test = line + chars[i];
    if (g.measureText(test).width > maxW && line) { g.fillText(line, x, y + n * lh); n++; line = chars[i]; if (n >= maxLines) return n; }
    else line = test;
  }
  if (line) { g.fillText(line, x, y + n * lh); n++; }
  return n;
}
export function art(kind, o = {}) {
  const [w, h] = ratioWH(o.ratio || "3:4", o.long || 640);
  const c = cv(w, h), g = c.getContext("2d"); const r = rng(o.seed || 1); const pal = PALETTES[(o.pal ?? Math.floor(r() * PALETTES.length)) % PALETTES.length];
  const m = Math.min(w, h);
  if (kind === "product") {
    const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, "#fbfbfb"); gr.addColorStop(1, "#e7e7ea"); g.fillStyle = gr; g.fillRect(0, 0, w, h);
    drawBuds(g, w / 2, h * .55, m * .32, true);
  } else if (kind === "poster" || kind === "scene" || kind === "model" || kind === "generic") {
    const gr = g.createLinearGradient(0, 0, w * (.3 + r() * .7), h); gr.addColorStop(0, pal[0]); gr.addColorStop(.65, pal[1]); gr.addColorStop(1, pal[0]); g.fillStyle = gr; g.fillRect(0, 0, w, h);
    if (kind === "scene") {
      g.fillStyle = "rgba(255,255,255,.08)"; g.fillRect(w * .58, h * .08, w * .3, h * .42);
      g.fillStyle = "rgba(0,0,0,.28)"; g.fillRect(0, h * .7, w, h * .3);
      g.fillStyle = "rgba(255,255,255,.06)"; g.fillRect(0, h * .7, w, h * .012);
      g.fillStyle = "rgba(40,90,60,.55)"; g.beginPath(); g.ellipse(w * .18, h * .58, w * .07, h * .14, 0, 0, Math.PI * 2); g.fill();
      drawBuds(g, w * .58, h * .66, m * .16, false);
    } else if (kind === "model") {
      g.fillStyle = "rgba(255,255,255,.08)"; g.beginPath(); g.arc(w * .5, h * .38, m * .34, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#e8c9b0"; g.beginPath(); g.ellipse(w * .5, h * .36, m * .13, m * .16, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#2b211c"; g.beginPath(); g.ellipse(w * .5, h * .28, m * .15, m * .1, 0, Math.PI, Math.PI * 2); g.fill();
      g.fillStyle = "#121214"; g.beginPath(); g.moveTo(w * .2, h); g.quadraticCurveTo(w * .22, h * .56, w * .5, h * .54); g.quadraticCurveTo(w * .78, h * .56, w * .8, h); g.fill();
      g.fillStyle = "#0a0a0b"; g.beginPath(); g.ellipse(w * .5 + m * .13, h * .38, m * .025, m * .035, 0, 0, Math.PI * 2); g.fill();
    } else {
      g.strokeStyle = "rgba(255,255,255,.14)"; g.lineWidth = 2;
      for (let i = 1; i < 6; i++) { g.beginPath(); g.arc(w / 2, h * .55, m * .12 * i, 0, Math.PI * 2); g.stroke(); }
      if (kind === "poster") drawBuds(g, w / 2, h * .58, m * .26, false);
      else { for (let i = 0; i < 5; i++) { g.fillStyle = `rgba(255,255,255,${.05 + r() * .12})`; g.beginPath(); g.arc(r() * w, r() * h, m * (.05 + r() * .18), 0, Math.PI * 2); g.fill(); } }
    }
    const ink = pal[2];
    if (o.headline) { g.fillStyle = ink; g.font = `700 ${Math.round(m * .085)}px -apple-system,"PingFang SC",sans-serif`; g.textBaseline = "top"; wrapText(g, o.headline, w * .08, h * .07, w * .84, m * .1, 2); }
    if (o.sub) { g.fillStyle = ink; g.globalAlpha = .75; g.font = `500 ${Math.round(m * .036)}px -apple-system,"PingFang SC",sans-serif`; g.textBaseline = "alphabetic"; wrapText(g, o.sub, w * .08, h * .9, w * .84, m * .05, 2); g.globalAlpha = 1; }
    if (kind === "poster") { g.fillStyle = ink; g.globalAlpha = .6; g.font = `600 ${Math.round(m * .03)}px -apple-system,sans-serif`; g.fillText("HALO", w * .08, h * .965); g.globalAlpha = 1; }
  }
  if (o.style && o.style !== "无") { applyStyleFx(g, w, h, o.style, r); }
  return { src: c.toDataURL("image/jpeg", .86), w, h };
}
function applyStyleFx(g, w, h, style, r) {
  if (style === "胶片") { g.fillStyle = "rgba(255,200,140,.10)"; g.fillRect(0, 0, w, h); for (let i = 0; i < 1400; i++) { g.fillStyle = `rgba(255,255,255,${r() * .06})`; g.fillRect(r() * w, r() * h, 1, 1); } }
  if (style === "电影感") { g.fillStyle = "rgba(0,0,0,.9)"; g.fillRect(0, 0, w, h * .08); g.fillRect(0, h * .92, w, h * .08); g.fillStyle = "rgba(0,60,80,.12)"; g.fillRect(0, 0, w, h); }
  if (style === "赛博") { g.fillStyle = "rgba(255,0,170,.10)"; g.fillRect(0, 0, w, h); g.strokeStyle = "rgba(0,255,240,.25)"; for (let y = 0; y < h; y += 6) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); } }
  if (style === "水彩") { for (let i = 0; i < 12; i++) { g.fillStyle = `hsla(${r() * 360},60%,70%,.08)`; g.beginPath(); g.arc(r() * w, r() * h, 40 + r() * 120, 0, Math.PI * 2); g.fill(); } }
  if (style === "极简棚拍") { g.fillStyle = "rgba(255,255,255,.12)"; g.fillRect(0, 0, w, h); }
  if (style === "3D 渲染") { const gr = g.createRadialGradient(w * .3, h * .2, 10, w * .3, h * .2, w); gr.addColorStop(0, "rgba(255,255,255,.18)"); gr.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = gr; g.fillRect(0, 0, w, h); }
  if (style === "国潮") { g.strokeStyle = "rgba(255,80,60,.35)"; g.lineWidth = 6; g.strokeRect(10, 10, w - 20, h - 20); }
}
export function waveBars(seed, n = 48) { const r = rng(seed); return Array.from({ length: n }, (_, i) => .15 + Math.abs(Math.sin(i * .45 + r() * 2)) * .7 * (.5 + r() * .5)); }


/* ========== 文本模拟 ========== */
export const PRODUCT_INFO = `产品：Halo Buds 2 真无线降噪耳机
颜色：曜石黑
卖点：主动降噪 -45dB；10mm 动圈；单次 8 小时，配合充电仓 30 小时；单耳 4.1g；IPX5 防水；六麦克风通话降噪
人群：通勤、运动、学生
风格偏好：高级、简洁、有质感`;
export const POSTER_COPY = `海报1
主标题：一戴就静，沉浸三十小时
画面：深夜蓝紫渐变，耳机悬浮在声波环中央，充电仓斜置下方
文案：10mm 动圈 · 主动降噪 -45dB · 30h 续航

海报2
主标题：轻到忘记戴着
画面：纯白棚拍，耳机放在羽毛旁做重量对比，冷灰阴影
文案：单耳 4.1g · 人体工学耳翼 · IPX5 防水

海报3
主标题：嘈杂街头，也听得清
画面：城市街头暖色逆光，模特侧脸佩戴，背景虚化车流
文案：六麦克风 AI 通话降噪 · 双设备无缝切换`;
export const headlineOf = (sec) => (/主标题[：:]\s*(.+)/.exec(sec || "") || [])[1] || "";
export const subOf = (sec) => (/文案[：:]\s*(.+)/.exec(sec || "") || [])[1] || "";
export function fakeTextLegacy(prompt, inputs) {
  const p = prompt || "";
  const texts = inputs.filter((x) => x.node.type === "text" && x.node.out?.text).map((x) => x.node.out.text);
  const imgs = inputs.filter((x) => x.node.type === "image" && x.node.out?.src).length;
  if (/海报|卖点|文案/.test(p)) return POSTER_COPY;
  if (/分镜|脚本|镜头/.test(p)) return `镜头1\n画面：清晨地铁车厢，人群拥挤，主角戴上 Halo Buds 2，世界安静下来\n时长：3s\n\n镜头2\n画面：特写充电仓开合，绿灯亮起\n时长：2s\n\n镜头3\n画面：街头逆光，主角侧脸微笑，字幕“一戴就静”\n时长：3s`;
  if (/英文|English|prompt/i.test(p)) return `A premium product shot of matte-black true wireless earbuds floating above an open charging case, deep indigo gradient background, concentric soft sound-wave rings, rim light, ultra-detailed, 85mm, f/4, studio lighting.`;
  const base = texts[0] ? texts[0].split("\n")[0] : "（没有上游文本）";
  return `已读取 ${inputs.length} 个输入（文本 ${texts.length} 段，图片 ${imgs} 张）。\n\n要点：${base}\n\n建议：把卖点拆成“降噪 / 轻 / 通话”三条主线，每条对应一张海报，主标题不超过 10 个字。`;
}
