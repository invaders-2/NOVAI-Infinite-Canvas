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
const SHOTS = [
    {
        id: 'minimax',
        source: { kind: 'url', file: 'minimax_h3.png', url: 'https://filecdn.minimax.chat/public/h3-en-v2-image-000-1785473644038.png' },
        crop: [560, 60, 1928, 1084],
        note: 'MiniMax H3 官方示例图：咖啡街景视频画面，人物居中偏右，避开左下角「CAFÉ」挂牌与叠字区',
    },
    {
        id: 'gpt26',
        source: { kind: 'local', file: 'tools/market-art/sources/gpt-image-2.6.png' },
        crop: [0, 40, 1024, 576],
        note: 'GPT-Image 2.6 示例图：我们用 APIMart gpt-image-2.6-ext 生成的玻璃蜂鸟（1024×1024），取 16:9 居中偏上，保住翅膀与主体、底部落在深色枝干',
    },
    {
        id: 'fashion',
        source: { kind: 'local', file: 'tools/market-art/sources/fashion-editorial.jpg' },
        crop: null,
        note: '服装大片 · 胶片暗房技能样片：我们用 APIMart seedream-5-0-pro 生成的时尚编辑图（2048×1152，正好 16:9），不裁直接缩，底部白墙与米色连衣裙承载叠字',
    },
    {
        id: 'seedream',
        source: { kind: 'url', file: 'seedream_0.jpeg', url: 'https://arkdocs.tos-cn-beijing.volces.com/images/image-generation/Seedream50_layer_0.jpeg' },
        crop: [0, 620, 2048, 1152],
        quality: 88,
        note: 'Seedream 5.0 官方示例图（火山方舟文档）：雨后雨林与苔藓树枝',
    },
    {
        id: 'seedance',
        source: { kind: 'url', file: 'seedance.png', url: 'https://arkdocs.tos-cn-beijing.volces.com/images/video-generation/i2v_4k.png' },
        crop: null,
        note: 'Seedance 2.5 官方示例图（火山方舟文档）：越野摩托实拍',
    },
    {
        id: 'gemini',
        source: { kind: 'url', file: 'gemini1600.webp', url: 'https://storage.googleapis.com/gweb-uniblog-publish-prod/images/gemini-3_model-blog_header-dark.width-1600.format-webp.webp' },
        crop: [133, 76, 1333, 750],
        note: 'Gemini 3 官方博客头图（Google Blog）：深色品牌视觉',
    },
];

function exists(file) { try { return fs.statSync(file).size > 0; } catch (e) { return false; } }

async function source(shot) {
    const s = shot.source;
    if (s.kind === 'local') return path.join(ROOT, s.file);
    const dest = path.join(TMP, s.file);
    if (!exists(dest)) {
        console.log('[fetch] ' + s.url);
        execFileSync('curl', ['-fsSL', '-o', dest, s.url]);
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

