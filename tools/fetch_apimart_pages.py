#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建期：抓 APIMart 各模型详情页，补齐视频/音频的规格档位（运行时不联网）。

用法（本机出网要走系统代理）：
    python3 tools/fetch_apimart_pages.py \
        --html /tmp/apimart-pricing.html \
        --pages /tmp/apimart_pages \
        --proxy http://127.0.0.1:7897

抓完后跑：
    python3 tools/apimart_pricing.py --html /tmp/apimart-pricing.html --pages /tmp/apimart_pages

只抓视频/音频详情页：图像档位已在价目页内嵌 initialCatalog 里，文本用起步价表的
输入/输出单价（详情页的 LLM 页面按模型族复用，数据不可靠）。
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import os
import sys
import urllib.request
from typing import Dict, List

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tools.apimart_pricing import parse_index  # noqa: E402


def _opener(proxy: str):
    handlers = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    return urllib.request.build_opener(*handlers)


def main() -> int:
    parser = argparse.ArgumentParser(description="抓 APIMart 模型详情页（构建期）")
    parser.add_argument("--html", required=True, help="apimart.ai/zh/pricing 的 HTML")
    parser.add_argument("--pages", required=True, help="详情页缓存目录")
    parser.add_argument("--proxy", default=os.environ.get("APIMART_PROXY", ""),
                        help="HTTP 代理，例如 http://127.0.0.1:7897")
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    with open(args.html, "r", encoding="utf-8", errors="replace") as handle:
        rows = parse_index(handle.read())
    os.makedirs(args.pages, exist_ok=True)
    opener = _opener(args.proxy)

    targets: List[Dict[str, str]] = [row for row in rows
                                     if row.get("href") and row.get("category") in ("video", "audio")]
    if not targets:
        print("[fetch] 没有需要抓的视频/音频详情页")
        return 0

    def fetch(row: Dict[str, str]):
        href = row["href"]
        path = os.path.join(args.pages, hashlib.sha1(href.encode("utf-8")).hexdigest()[:16] + ".html")
        if os.path.isfile(path) and os.path.getsize(path) > 10000:
            return row["name"], "cached"
        request = urllib.request.Request("https://apimart.ai" + href, headers={"User-Agent": "Mozilla/5.0"})
        try:
            response = opener.open(request, timeout=60)
            body = response.read()
            with open(path, "wb") as handle:
                handle.write(body)
            return row["name"], "ok:%d" % len(body)
        except Exception as exc:  # noqa: BLE001
            return row["name"], "error:%s" % str(exc)[:80]

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        results = list(pool.map(fetch, targets))
    failed = [item for item in results if str(item[1]).startswith("error")]
    for name, status in results:
        print("  %-32s %s" % (name, status))
    print("[fetch] 共 %d 页，失败 %d 页，缓存目录 %s" % (len(results), len(failed), args.pages))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
