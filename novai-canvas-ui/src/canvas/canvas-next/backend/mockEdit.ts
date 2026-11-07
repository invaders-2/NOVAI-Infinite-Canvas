// @ts-nocheck —— 模拟后端的图片编辑：用本地画布效果代替模型，只用于演示 / 测试
import { hash, loadImg } from "./mockArt";
const PALETTES = [["#0b1026", "#3a2a8a", "#b9a6ff"], ["#2b1a12", "#a8552b", "#ffd2a1"], ["#06221e", "#0f6b5c", "#a6f0da"], ["#0d1a2b", "#1f5c99", "#bfe1ff"]];
const cv = (w, h) => { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
export async function relit(src, lx, ly, inten, temp, maxW = 0) {
  const im = await loadImg(src); let W = im.naturalWidth, H = im.naturalHeight; if (maxW && W > maxW) { H = Math.round((H * maxW) / W); W = maxW; }
  const c = cv(W, H); const g = c.getContext("2d"); g.drawImage(im, 0, 0, W, H);
  const col = temp < 50 ? `255,${190 + temp},${130 + temp * 1.5}` : `${300 - temp * 1.2},${210 + (temp - 50) * .6},255`;
  g.globalCompositeOperation = "multiply"; const sh = g.createLinearGradient(lx * W, ly * H, (1 - lx) * W, (1 - ly) * H); sh.addColorStop(0, "rgba(255,255,255,1)"); sh.addColorStop(1, `rgba(0,0,0,${inten / 160})`); g.fillStyle = sh; g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = "screen"; const gl = g.createRadialGradient(lx * W, ly * H, 0, lx * W, ly * H, Math.max(W, H) * .8); gl.addColorStop(0, `rgba(${col},${inten / 140})`); gl.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = gl; g.fillRect(0, 0, W, H);
  return c.toDataURL("image/jpeg", .9);
}
export async function mockEdit(req) {
  const im = await loadImg(req.sourceUrl); const W = im.naturalWidth, H = im.naturalHeight; const p = req.params || {}; let c;
  if (req.op === "redraw" || req.op === "erase" || req.op === "annotate") {
    const mask = cv(W, H); const mg = mask.getContext("2d"); if (req.maskDataUrl) { const m = await loadImg(req.maskDataUrl); mg.drawImage(m, 0, 0, W, H); }
    c = cv(W, H); const og = c.getContext("2d"); og.drawImage(im, 0, 0);
    if (req.op === "annotate") og.drawImage(mask, 0, 0);
    else { const fill = cv(W, H); const fg = fill.getContext("2d"); fg.filter = "blur(18px)"; fg.drawImage(im, 0, 0); fg.filter = "none"; if (req.op === "redraw") { const gr = fg.createLinearGradient(0, 0, W, H); const pal = PALETTES[hash(req.prompt || "") % PALETTES.length]; gr.addColorStop(0, pal[1]); gr.addColorStop(1, pal[2]); fg.globalAlpha = .55; fg.fillStyle = gr; fg.fillRect(0, 0, W, H); fg.globalAlpha = 1; } fg.globalCompositeOperation = "destination-in"; fg.drawImage(mask, 0, 0); og.drawImage(fill, 0, 0); }
  } else if (req.op === "angle") {
    const { yaw = 0, pitch = 0, zoom = 1, wide = false } = p; c = cv(W, H); const g = c.getContext("2d");
    g.fillStyle = "#e9e9ec"; g.fillRect(0, 0, W, H); g.translate(W / 2, H / 2); const sx = Math.max(.3, Math.abs(Math.cos((yaw * Math.PI) / 180))) * zoom * (wide ? .85 : 1); g.transform(sx, (pitch / 100) * .4, (yaw / 180) * .25, Math.max(.4, Math.cos((pitch * Math.PI) / 180)) * zoom, 0, 0); g.drawImage(im, -W / 2, -H / 2);
  } else if (req.op === "relight") { return { url: await relit(req.sourceUrl, p.lx ?? .25, p.ly ?? .3, p.intensity ?? 70, p.temp ?? 40), w: W, h: H }; }
  else if (req.op === "outpaint") { c = cv(W * 1.4, H * 1.4); const g = c.getContext("2d"); g.filter = "blur(30px) brightness(.95)"; g.drawImage(im, -W * .1, -H * .1, W * 1.6, H * 1.6); g.filter = "none"; g.drawImage(im, W * .2, H * .2); }
  else if (req.op === "enhance") { const s = Math.min(2, 1800 / Math.max(W, H)); c = cv(W * s, H * s); const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.filter = "contrast(1.08) saturate(1.12)"; g.drawImage(im, 0, 0, W * s, H * s); }
  else if (req.op === "cutout") { c = cv(W, H); const g = c.getContext("2d"); g.drawImage(im, 0, 0); const d = g.getImageData(0, 0, W, H); const px = d.data; const bg = [px[0], px[1], px[2]]; for (let i = 0; i < px.length; i += 4) { const dist = Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]); if (dist < 46) px[i + 3] = 0; else if (dist < 80) px[i + 3] = Math.round(((dist - 46) / 34) * 255); } g.putImageData(d, 0, 0); }
  return { url: c.toDataURL(req.op === "cutout" ? "image/png" : "image/jpeg", .9), w: c.width, h: c.height };
}
