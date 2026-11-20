#!/usr/bin/env node
// 应用市场「最新上线」封面：真实素材（官方模型示例图 + 我们自己生成的示例图）
//
//   node tools/market-art/build.cjs
//
// 每张图固定输出 static/images/market/showcase-<id>.jpg，1600×900，JPG 质量 90。
// 流程：取源（仓库里的本地素材 / curl 下载官方示例图）
//      → 按 crop 裁 16:9 → 等比放大到覆盖 1600×900 → 居中裁到 1600×900 → 存 JPG。
// 来源与授权说明见 static/images/market/SOURCES.md。
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'static', 'images', 'market');
const TMP = path.join(ROOT, '_tmp', 'market-art', 'src');
const W = 1600, H = 900, Q = 90;

// crop = [x, y, w, h]（源图像素）；null 表示不裁、整张用
// Seedance / Kling / Gemini Omni 有官方视频：由 tools/market-art/videos.sh 出 mp4 + 封面帧
const SHOTS = [
    {
        id: 'gpt26',
        source: { kind: 'local', file: 'tools/market-art/sources/gpt-image-2.6.png' },
        crop: [0, 40, 1024, 576],
        note: 'GPT Image 2.6：OpenAI 官网未提供可下载示例图，用我们经 APIMart gpt-image-2.6 生成的玻璃蜂鸟',
    },
    {
        id: 'seedream',
        source: { kind: 'url', file: 'sd55-006-22d1692c.webp', url: 'https://lf3-static.bytednsdoc.com/obj/eden-cn/bdeh7uhpsuht/sd55-006-22d1692c-l.webp' },
        crop: [0, 125, 2512, 1413],
        note: 'Seedream 5.5 官网示例图（字节 Seed）：夜晚酒吧吧台上的白猫',
    },
    {
        id: 'minimax',
        source: { kind: 'url', file: 'minimax_h3img.jpg', url: 'https://file.cdn.minimax.io/public/h3-image-cover-1794323228475.jpg' },
        crop: [155, 0, 969, 545],
        note: 'MiniMax H3-Image 官网发布头图：水母 + 品牌字',
    },
    {
        id: 'nanobanana',
        source: { kind: 'url', file: 'nanobanana.jpg', url: 'https://lh3.googleusercontent.com/IQrKmeotvku7oU92ImkQ4h74TbS7A695HU4Zq633YsuNW0hvjZlndcmzyhh5-CqxFntzW6K9J1pgaTUayRTYgK93laVGdPBp2uDAdJASSm4CZprKE3Q=w1920-h1080-n-nu' },
        crop: null,
        note: 'Nano Banana 官网示例图（Google DeepMind Gemini Image 页）：黄昏草地人像',
    },
];

function exists(file) { try { return fs.statSync(file).size > 0; } catch (e) { return false; } }

async function source(shot) {
    const s = shot.source;
    if (s.kind === 'local') return path.join(ROOT, s.file);
    const dest = path.join(TMP, s.file);
    if (!exists(dest)) {
        console.log('[fetch] ' + s.url);
        execFileSync('curl', ['-fsSL', '-A', 'Mozilla/5.0'].concat(process.env.ART_PROXY ? ['-x', process.env.ART_PROXY] : []).concat(['-o', dest, s.url]));
    }
    return dest;
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(TMP, { recursive: true });
    const jobs = [];
    for (const shot of SHOTS) jobs.push({ id: shot.id, src: await source(shot), crop: shot.crop, quality: shot.quality });
    const script = path.join(TMP, '_build.py');
    fs.writeFileSync(script, [
        'import json, sys',
        'from PIL import Image',
        'jobs = json.loads(sys.argv[1])',
        'W, H, Q = int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])',
        'out = sys.argv[5]',
        'for j in jobs:',
        '    im = Image.open(j["src"]).convert("RGB")',
        '    c = j["crop"]',
        '    if c: im = im.crop((c[0], c[1], c[0] + c[2], c[1] + c[3]))',
        '    s = max(W / im.width, H / im.height)',
        '    nw, nh = max(W, round(im.width * s)), max(H, round(im.height * s))',
        '    im = im.resize((nw, nh), Image.LANCZOS)',
        '    left, top = (nw - W) // 2, (nh - H) // 2',
        '    im = im.crop((left, top, left + W, top + H))',
        '    dst = f"{out}/showcase-{j[\'id\']}.jpg"',
        '    im.save(dst, "JPEG", quality=j.get("quality") or Q, optimize=True, progressive=True)',
        '    print(f"[ok] showcase-{j[\'id\']}.jpg  {im.width}x{im.height}  {round(__import__(\'os\').path.getsize(dst)/1024)} KB")',
    ].join('\n'));
    execFileSync('python3', [script, JSON.stringify(jobs), String(W), String(H), String(Q), OUT], { stdio: 'inherit' });
})().catch(err => { console.error(err); process.exit(1); });

