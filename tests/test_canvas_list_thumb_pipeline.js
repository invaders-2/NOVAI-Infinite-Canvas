#!/usr/bin/env node
'use strict';
/*
 * 无限画布列表卡片缩略图链路回归。
 *
 * 背景：CanvasListPage 直接把 /api/canvases 的 thumbnails（后端 canvas_thumbnails()
 * 抽出的节点原图 URL）绑到 <img src>，37 张图解码总量 173.6MB、加载阶段 CPU 3.07s。
 * 根修：卡片改走已有的 /api/media-preview 缩放代理（Pillow 缩放 + media_previews 落盘缓存），
 * 并首屏只渲染 12 张、补 decoding/尺寸/优先级属性。这里只做静态事实断言，不依赖网络。
 *
 * 跑法：node tests/test_canvas_list_thumb_pipeline.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const vue = fs.readFileSync(path.join(root, 'web/src/pages/canvas/CanvasListPage.vue'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.py'), 'utf8');
const legacy = fs.readFileSync(path.join(root, 'static/canvas-list.html'), 'utf8');

const v2Index = fs.readFileSync(path.join(root, 'static/v2/index.html'), 'utf8');
const bundleName = (v2Index.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/) || [])[1];
const bundle = bundleName ? fs.readFileSync(path.join(root, 'static/v2/assets', bundleName), 'utf8') : '';

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };

console.log('[1] 取图链路：后端 thumbnails 给的是节点原图 URL，卡片刻意走缩放代理');
ok(/def canvas_thumbnails\(data, max_count=4\):/.test(main), '后端 canvas_thumbnails() 仍返回节点图片 URL');
ok(/"thumbnails": canvas_thumbnails\(data\),/.test(main), 'canvas_record 的 thumbnails 字段语义未改');
ok(/@app\.get\("\/api\/media-preview"\)/.test(main), '复用已有 /api/media-preview 接口');
ok(/media_preview_cache_paths\(path, width\)/.test(main), 'media-preview 用 sha1(mtime,size,w) 落盘缓存');
ok(/format="WEBP"/.test(main) && /img\.thumbnail\(/.test(main), 'media-preview 用 Pillow 缩放并输出 webp');
const previewBlock = main.slice(main.indexOf('@app.get("/api/media-preview")'), main.indexOf('@app.get("/api/image-jpeg")'));
ok(/Cache-Control": "public, max-age=31536000, immutable"/.test(previewBlock), 'media-preview 带 immutable 长缓存头');
ok((previewBlock.match(/FileResponse\([^)]*headers=cache_headers\)/g) || []).length === 3, 'webp/png/首次生成三条返回路径都带缓存头');

console.log('[2] 新列表页卡片接入缩略图代理');
ok(/import \{ assetPreviewUrl \} from '\.\.\/assets\/lib\/util\.js'/.test(vue), '复用素材库的 assetPreviewUrl()');
ok(/const THUMB_W = 480;/.test(vue), '缩略图长边固定 480');
ok(/:src="thumbSrc\(u\)"/.test(vue), '卡片 <img> 走 thumbSrc() 而不是原图 URL');
ok(!/:src="u"/.test(vue), '卡片不再直接绑定原图 URL');
ok(/function thumbSrc\(u\) \{ return failedPreview\.value\.has\(u\) \? u : assetPreviewUrl\(u, THUMB_W\); \}/.test(vue), 'thumbSrc 走 assetPreviewUrl(u, 480)');
ok(/failedPreview/.test(vue) && /onThumbError/.test(vue), '缩略图失败回落原图（再失败才移除）');

console.log('[3] 解码 / 布局加固');
ok(/decoding="async"/.test(vue), '卡片图 decoding=async');
ok(/loading="lazy"/.test(vue), '卡片图 loading=lazy');
ok(/fetchpriority="low"/.test(vue), '卡片图低优先级');
ok(/width="480" height="300"/.test(vue), '卡片图声明固有宽高，避免解码期反复布局');

console.log('[4] 首屏分批渲染');
ok(/const FIRST_BATCH = 12;/.test(vue), '首屏只渲染 12 张');
ok(/const renderList = computed\(\(\) => shown\.value\.slice\(0, renderLimit\.value\)\)/.test(vue), 'renderList 只渲染前 renderLimit 张');
ok(/v-for="\(c, i\) in renderList"/.test(vue), '模板用 renderList 而非全量 shown');
ok(/new IntersectionObserver/.test(vue) && /rootMargin: '0px 0px 600px 0px'/.test(vue), '滚动哨兵自动追加下一批');
ok(/renderLimit\.value = FIRST_BATCH/.test(vue), '搜索/排序/数据变化时重置批次');

console.log('[5] 旧列表页 static/canvas-list.html 同步最小改动');
ok(/function mediaPreviewUrl\(/.test(legacy), '旧页新增 mediaPreviewUrl()');
ok(/mediaPreviewUrl\(url, 480\)/.test(legacy), '旧页卡片改走 /api/media-preview');
ok(/\/api\/media-preview\?w=/.test(legacy), '旧页拼 /api/media-preview 地址');

console.log('[6] 构建产物包含改动');
ok(!!bundleName, 'static/v2/index.html 引用了构建产物');
ok(/\/api\/media-preview/.test(bundle), '产物包含 media-preview 代理');
ok(/继续加载/.test(bundle), '产物包含首屏分批的「继续加载」');

console.log('画布列表缩略图链路：' + pass + ' 项通过' + (fails.length ? '，' + fails.length + ' 项失败' : ''));
if (fails.length) { fails.forEach(f => console.error('  \u2717 ' + f)); process.exit(1); }
console.log('全部通过');
