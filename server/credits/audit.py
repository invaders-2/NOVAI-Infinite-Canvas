#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""模型价格覆盖审计：每个 provider 模型对应哪个价、成本、来源、是否 proxy。

用法：
    python3 -m server.credits.audit            # 人类可读 + 汇总
    python3 -m server.credits.audit --json      # 机器可读

覆盖要求：configured=123 个 provider 模型全部命中 direct/proxy/conservative，
uncovered 必须为 0；任何一行 price <= 0 都算失败。
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, List

from server.credits import model_map, pricing

SAMPLE_PARAMS = {
    "image": {"width": 1024, "height": 1024, "quality": "auto", "rows": 1, "prompt": "audit"},
    "video": {"width": 1280, "height": 720, "duration": 5, "rows": 1},
    "audio": {"rows": 1},
    "chat": {"tokens_in": 1000, "tokens_out": 500},
}


def audit_rows() -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for entry in model_map.entries():
        kind = str(entry.get("kind") or "")
        model = str(entry.get("model") or "")
        provider = str(entry.get("provider") or "")
        quote = pricing.estimate(kind, model, SAMPLE_PARAMS.get(kind, {}), provider)
        rows.append({
            "provider": provider,
            "kind": kind,
            "model": model,
            "mode": entry.get("mode") or "",
            "target": entry.get("target") or "",
            "pricing_source": quote.get("pricing_source") or "",
            "proxy_model": quote.get("proxy_model") or "",
            "matched_spec": quote.get("matched_spec") or "",
            "unit": quote.get("unit") or "",
            "cost": quote.get("cost") or 0.0,
            "price": quote.get("price") or 0.0,
            "profit": round(float(quote.get("price") or 0) - float(quote.get("cost") or 0), 10),
            "cost_usd": quote.get("cost_usd") or 0.0,
            "price_usd": quote.get("price_usd") or 0.0,
        })
    return rows


def audit() -> Dict[str, Any]:
    rows = audit_rows()
    coverage = model_map.coverage()
    bad = [row for row in rows if float(row["price"] or 0) <= 0]
    no_target = [row for row in rows if row["mode"] in ("direct", "proxy") and not row["target"]]
    return {
        "coverage": coverage,
        "counts": {
            "entries": len(rows),
            "direct": sum(1 for row in rows if row["pricing_source"] == "direct"),
            "proxy": sum(1 for row in rows if row["pricing_source"] == "proxy"),
            "conservative": sum(1 for row in rows if row["pricing_source"] == "conservative"),
            "uncovered": len(no_target),
            "non_positive_price": len(bad),
        },
        "rows": rows,
        "ok": not bad and not no_target and int(coverage.get("uncovered") or 0) == 0,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="积分价格覆盖审计")
    parser.add_argument("--json", action="store_true", help="输出完整 JSON")
    args = parser.parse_args(argv)
    result = audit()
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=1))
        return 0 if result["ok"] else 1
    print("provider        kind   model                                              source         target/proxy                          cost      price     profit")
    for row in result["rows"]:
        target = row["proxy_model"] or row["target"] or "-"
        print("%-15s %-6s %-50s %-14s %-36s %-9.6f %-9.6f %-9.6f" % (
            row["provider"], row["kind"], row["model"][:50], row["pricing_source"],
            target[:36], float(row["cost"]), float(row["price"]), float(row["profit"])))
    counts = result["counts"]
    print("")
    print("覆盖：configured=%s direct=%d proxy=%d conservative=%d uncovered=%d 非正价=%d -> %s" % (
        result["coverage"].get("configured_models"), counts["direct"], counts["proxy"],
        counts["conservative"], counts["uncovered"], counts["non_positive_price"],
        "OK" if result["ok"] else "FAILED"))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
