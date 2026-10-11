#!/usr/bin/env node
'use strict';
/*
 * 首页「最近项目」卡片缩略图链路回归。
 *
 * 背景：static/home.html 的 renderRecentProjects() 直接把 /api/recent-canvases 返回的
 * c.thumbnail（后端 canvas_thumbnail() 抽出的节点原图 URL）绑到 <img src>，
 * 实测该 iframe 2 张图解码 33.09MB（5562x7140 / 3072x4096，卡片只显示 213x133）,
 * 加载阶段 CPU 0.9s。根修：卡片改走已有的 /api/media-preview 缩放代理
 * （Pillow 缩放 + media_previews 落盘缓存），并补 decoding/尺寸/优先级属性与失败回落原图。
 * 本测试只做静态事实断言，不依赖网络。
 *
 * 跑法：node tests/test_home_recent_thumb_pipeline.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const home = fs.readFileSync(path.join(root, 'static/home.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.py'), 'utf8');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if (cond) pass += 1; else fails.push(label); };

console.log('[1] 取图链路：首页最近项目读 /api/recent-canvases 的 thumbnail（节点原图），卡片刻意走缩放代理');
ok(/fetch\('\/api\/recent-canvases'/.test(home), '首页仍从 /api/recent-canvases 取最近项目');
ok(/var thumb = c\.thumbnail/.test(home), '取图字段仍是 c.thumbnail（接口语义未改）');
ok(/def canvas_thumbnail\(data\):/.test(main), '后端 canvas_thumbnail() 仍返回节点原图 URL');
ok(/"thumbnail": canvas_thumbnail\(data\),/.test(main), 'canvas_record 的 thumbnail 字段语义未改');
ok(/@app\.get\("\/api\/media-preview"\)/.test(main), '复用已有 /api/media-preview 接口');

console.log('[2] 首页卡片接入缩略图代理');
ok(/function mediaPreviewUrl\(/.test(home), '首页新增 mediaPreviewUrl()');
ok(/mediaPreviewUrl\(c\.thumbnail, 480\)/.test(home), '卡片取图改走 mediaPreviewUrl(c.thumbnail, 480)');
ok(/\/api\/media-preview\?w=/.test(home), '媒体地址拼 /api/media-preview');
ok(!/'<img src="' \+ esc\(c\.thumbnail\)/.test(home), '卡片不再直接把原图 URL 绑到 <img src>');

console.log('[3] 解码 / 布局加固 + 失败回落原图');
ok(/decoding="async"/.test(home), '卡片图 decoding=async');
ok(/loading="lazy"/.test(home), '卡片图 loading=lazy');
ok(/fetchpriority="low"/.test(home), '卡片图低优先级（离屏低优先级）');
ok(/width="480" height="300"/.test(home), '卡片图声明固有宽高，避免解码期反复布局');
ok(/data-orig="' \+ esc\(c\.thumbnail\)/.test(home), '保留原图 URL 作为回落源');
ok(/this\.dataset\.fb=\\?['"]?1/.test(home) && /this\.src=this\.dataset\.orig;/.test(home), '代理失败回落原图，原图再失败才移除');

console.log('[4] 只动最近项目，不改数据/布局/其它区块');
ok(/recentCache\.slice\(0, 4\)/.test(home), '仍取前 4 张，数量未改');
ok(/class="hp-thumb"/.test(home) && /class="hp-kind"/.test(home), '卡片 DOM 结构与文案未改');
ok(/<img id="lanQrImg" alt="二维码"\/>/.test(home), '局域网二维码 img 未被动过');

console.log('首页最近项目缩略图链路：' + pass + ' 项通过' + (fails.length ? '，' + fails.length + ' 项失败' : ''));
if (fails.length) { fails.forEach(f => console.error('  \u2717 ' + f)); process.exit(1); }
console.log('全部通过');
