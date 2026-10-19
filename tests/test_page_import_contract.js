#!/usr/bin/env node
/* import-from-page 契约回归（静态断言，不联网、不依赖 python 环境）：
   P1. 新路由存在且挂在 /api 下：POST /api/local-assets/import-from-page；
   P2. main.py 注册了该 router，且在 assets router 之后（deps.bind 之后）；
   P3. 落盘复用 import-urls 的同一个 handler（不重写写盘逻辑）；
   P4. 安全策略齐全：只 http(s)、默认端口、is_global 公网校验、逐跳重定向、
       页面 2MB / 10s、图片上限；
   P5. 解析顺序：og:image → twitter:image → image_src → 最大 <img>（含 srcset），
       并优先 pinimg/huabanimg/huaban/xhscdn；
   P6. 纯逻辑单测文件存在。
   跑法：node tests/test_page_import_contract.js */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const src = read('server/routes/page_import.py');
const mainSrc = read('main.py');

let pass = 0;
const fails = [];
const ok = (cond, label) => { if(cond) pass += 1; else fails.push(label); };

console.log('[1] 路由与注册');
ok(/router = APIRouter\(prefix="\/api"\)/.test(src), 'router 前缀 /api');
ok(/@router\.post\("\/local-assets\/import-from-page"\)/.test(src), '声明 POST /local-assets/import-from-page');
ok(/class PageImportRequest\(BaseModel\)/.test(src), '有独立请求模型 PageImportRequest');
ok(/url: str = ""/.test(src) && /folder: str = ""/.test(src) && /name: str = ""/.test(src), '契约字段 url/folder/name');
ok(/from server\.routes\.page_import import router as _page_import_router/.test(mainSrc), 'main.py 导入新 router');
ok(/app\.include_router\(_page_import_router\)/.test(mainSrc), 'main.py include_router 新 router');
const assetsAt = mainSrc.indexOf('app.include_router(_assets_router)');
const pageAt = mainSrc.indexOf('app.include_router(_page_import_router)');
ok(assetsAt > 0 && pageAt > assetsAt, '注册在 assets router 之后（deps 已 bind）');

console.log('[2] 落盘复用 import-urls');
ok(/from server\.routes import assets as assets_routes/.test(src), '显式复用 assets 路由模块');
ok(/assets_routes\.import_local_assets_from_urls\(/.test(src), '直接调用 import-urls 的 handler');
ok(/assets_routes\.LocalAssetUrlImportRequest\(/.test(src), '复用 import-urls 的请求模型');
ok(/assets_routes\.LocalAssetUrlImportItem\(/.test(src), '复用 import-urls 的 item 模型');
ok(!/["']wb["']/.test(src), '不自己写盘（不出现 open(..., "wb")）');
ok(/"data": _data_url\(/.test(src), '走 import-urls 的 base64(data) 通道');
ok(/return await assets_routes\.import_local_assets_from_urls\(request_payload\)/.test(src), '返回 import-urls 的结果');

console.log('[3] 安全策略');
ok(/scheme not in \("http", "https"\)/.test(src), '只接受 http(s)');
ok(/parsed\.username or parsed\.password/.test(src), '拒绝 userinfo');
ok(/port not in \(None, 80, 443\)/.test(src), '只允许 80/443');
ok(/ip\.is_global/.test(src), '用 is_global 判公网（拒 loopback/私网/link-local/保留段）');
ok(/ipaddress\.ip_address/.test(src), 'IP 字面量直接判定');
ok(/ipv4_mapped/.test(src), 'IPv4-mapped IPv6 也判');
ok(/getaddrinfo/.test(src), '域名做 DNS 解析');
ok(/async def assert_public_url/.test(src) && /await assert_public_url\(current\)/.test(src), '每一跳重定向都重新校验');
ok(/follow_redirects=False/.test(src), '手动跟重定向（才能逐跳校验）');
ok(/MAX_REDIRECTS = 5/.test(src), '重定向次数上限');
ok(/PAGE_MAX_BYTES = 2 \* 1024 \* 1024/.test(src), '页面 2MB 上限');
ok(/PAGE_TIMEOUT_SECONDS = 10\.0/.test(src), '页面 10s 超时');
ok(/MEDIA_MAX_BYTES =/.test(src) && /MEDIA_TIMEOUT_SECONDS/.test(src), '图片有大小/超时上限');
ok(/NOVAI_PAGE_IMPORT_PRIVATE_HOSTS/.test(src), '私网放行只由显式环境变量控制（默认空）');

console.log('[4] 解析顺序与过滤');
ok(/og:image/.test(src) && /twitter:image/.test(src), '支持 og:image / twitter:image');
ok(/image_src/.test(src), '支持 <link rel="image_src">');
ok(/srcset/.test(src), '支持 srcset 取最大图');
ok(/SMALL_EDGE = 200/.test(src), '小于 200px 视为小图');
ok(/avatar\|icon\|logo/.test(src), '排除头像/图标/logo');
ok(/"pinimg\.com"/.test(src) && /"huabanimg\.com"/.test(src) && /"huaban\.com"/.test(src) && /"xhscdn\.com"/.test(src), '优先 pinimg/huabanimg/huaban/xhscdn');
ok(/"priority": priority/.test(src) && /candidates\.sort\(/.test(src), '候选按优先级排序');
ok(/urljoin\(/.test(src), '相对地址 urljoin 成绝对地址');

console.log('[5] 可读中文错误');
ok(/页面超过 2MB/.test(src), '页面过大有中文提示');
ok(/页面里没有找到可用的图片/.test(src), '没找到图片有中文提示');
ok(/反爬机制拦住了/.test(src), '反爬拦截有单独中文提示');
ok(/下载失败：/.test(src), '图片下载失败有中文提示');
ok(/这个链接不是网页/.test(src), '非网页链接有中文提示');
ok(/内网\/本机地址/.test(src), '内网地址拒绝有中文提示');

console.log('[6] 返回结构与测试文件');
ok(/return \{\s*"ok": True,\s*"count"/.test(src), '返回 {ok,count,files,items}');
ok(/"page": \{/.test(src), '附带 page 元信息（url/title/source）');
ok(fs.existsSync(path.join(root, 'tests/test_page_import.py')), '存在纯逻辑单测 tests/test_page_import.py');

console.log('[7] prefer / 大图优先 / 品牌图过滤 / picked');
ok(/prefer: str = "auto"/.test(src), '请求模型有 prefer，默认 auto');
ok(/PREFER_VALUES = \("og", "largest", "auto"\)/.test(src), 'prefer 取值只有 og/largest/auto');
ok(/SITE_PREFERS_LARGEST_HOSTS/.test(src) && /"xiaohongshu\.com"/.test(src) && /"pinterest\.com"/.test(src) && /"huaban\.com"/.test(src), 'auto 站点名单含小红书/Pinterest/花瓣');
ok(/LARGE_IMG_EDGE = 400/.test(src), '大图门槛 max(w,h) >= 400');
ok(/_BRAND_ASSET_RE/.test(src) && /_looks_like_brand_image/.test(src), 'og:image 品牌图识别（logo/avatar/brand 等）');
ok(/_BRAND_FILE_HINTS/.test(src) && /xiaohongshu-logo/.test(src), '含小红书官方品牌图特征');
ok(/has_non_brand/.test(src), '品牌 og 仅在还有其它候选时跳过');
ok(/prefer_mode == "largest" and img_candidates/.test(src) && /max\(large_imgs or img_candidates, key=_candidate_size_key\)/.test(src), 'largest 模式按面积取最大（无尺寸按 DOM 靠后）');
ok(/prefer_mode == "auto" and _site_prefers_largest\(page_host\) and large_imgs/.test(src), 'auto 模式：站点 + >=400px 大图才改取大图');
ok(/_picked_label/.test(src) && /"picked": parsed\.get\("picked"\) or ""/.test(src), 'page 返回 picked（og/largest/image_src/img）');
ok(/"picked": "",/.test(src), '直链路径 picked 为空（没有解析步骤）');
ok(/"prefer 只能是 og \/ largest \/ auto"/.test(src), '非法 prefer 有中文报错');

console.log('');
console.log('import-from-page 契约：' + pass + ' 项通过' + (fails.length ? ('，失败 ' + fails.length + ' 项') : ''));
fails.forEach(f => console.log('  ✗ ' + f));
if(fails.length) process.exit(1);
