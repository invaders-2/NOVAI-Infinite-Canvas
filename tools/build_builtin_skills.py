#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 sealseek 导出的 16 个技能原文转成 NOVAI 内置技能注册表。

用法：
    /usr/bin/python3 tools/build_builtin_skills.py [skill-details.json 路径]
    默认读取 /tmp/ss/skill-details.json，输出 server/skills/builtin_skills.json。

只做两件事：
1) 保留原文（目标 / 工作流 / 必要工具调用约定 / 输出格式）结构不动；
2) 把原文里「读取文件能力 / 文件上传能力 / 返回可访问链接」这类动作替换成本机
   read_table / write_html_report / write_xlsx，并在正文前加一段本期运行形态说明。
不重写任何业务逻辑。
"""
import json
import os
import sys

DEFAULT_SOURCE = "/tmp/ss/skill-details.json"
OUT_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "server", "skills", "builtin_skills.json")

HEADER = """# 本期运行形态（NOVAI 只做壳）
- 数据来源：用户在本轮对话里手动上传的表格（xlsx / csv）。不接第三方电商 API、不装浏览器插件；原文里的「配合插件下载数据」「粘贴报告链接」都改成上传对应表格文件。
- 读取动作：一律用 read_table 读取上传表格（拿到真实列名、行数、数据样例与数值统计）后再分析，不得编造数据。
- 交付动作：HTML 报告用 write_html_report 写（sections 结构化模块），Excel 数据表用 write_xlsx 写（多工作表）；交付文件就是本轮产物，不需要再「上传」。
- 字段不足时在报告里如实标注「数据不足」，不要臆造结论。
"""

REPLACEMENTS = [
    # —— 读取动作 ——
    ("读取用户提供的评价分析报告，完整提取", "用 read_table 读取用户上传的评价分析表，完整提取"),
    ("读取用户提供的报告或文件，自动识别", "用 read_table 读取用户上传的表格，自动识别"),
    ("读取用户提供的推广数据文件，提取", "用 read_table 读取用户上传的推广数据表格，提取"),
    ("读取用户提供的商品数据表格，提取", "用 read_table 读取用户上传的商品数据表格，提取"),
    ("读取用户提供的行业类目报告（Excel/CSV/截图/文本），完整获取",
     "用 read_table 读取用户上传的行业类目报告表格（xlsx/csv，可多工作表），完整获取"),
    ("必须先调用文件读取能力，完整获取关键词洞察报告原始内容与五个Tab数据。",
     "必须先调用 read_table 读取用户上传的关键词洞察报告表格，完整获取五个 Tab 的原始数据。"),
    ("必须先调用文件读取能力解析用户上传的表格内容。",
     "必须先调用 read_table 解析用户上传的表格内容。"),
    ("优先使用表格或文件解析工具读取商品清单。",
     "优先调用 read_table 读取商品清单表格。"),
    ("优先调用表格或报告读取工具，获取推广数据原始字段。",
     "优先调用 read_table 读取推广数据表格，获取原始字段。"),

    # —— 交付动作 ——
    ("10. 上传HTML报告与Excel数据表并返回文件链接。",
     "10. 用 write_html_report 生成 HTML 报告、用 write_xlsx 生成 Excel 数据表。"),
    ("- 必须将最终HTML与Excel文件上传，并以可访问链接形式返回。",
     "- 必须用 write_html_report 生成 HTML 报告、用 write_xlsx 生成 Excel 数据表。"),
    ("10. 上传并交付 HTML 报告文件与 Excel 数据表文件链接。",
     "10. 用 write_html_report 生成 HTML 报告、用 write_xlsx 生成 Excel 数据表。"),
    ("- 生成完成后，必须调用文件上传能力返回可访问的文件链接。",
     "- 生成完成后必须调用 write_html_report / write_xlsx 写出交付文件。"),
    ("8. 上传并交付 HTML 报告与 Excel 数据表文件链接。",
     "8. 用 write_html_report 生成 HTML 报告、用 write_xlsx 生成 Excel 数据表。"),
    ("- 文件生成后必须执行文件上传，并以可访问链接形式交付。",
     "- 文件写出后即完成交付，不需要再上传。"),
    ("9. 上传 HTML 与 Excel 文件并返回可下载链接。",
     "9. 用 write_html_report 生成 HTML 报告、用 write_xlsx 生成 Excel 数据表。"),
    ("- 必须使用文件生成能力分别产出 HTML 报告与 Excel 数据表。",
     "- 必须用 write_html_report 产出 HTML 报告、用 write_xlsx 产出 Excel 数据表。"),
    ("- 必须使用文件上传能力返回最终可访问的文件链接。",
     "- 必须调用 write_html_report / write_xlsx 写出交付文件。"),
    ("- 需求市场分析HTML报告链接", "- 需求市场分析报告.html"),
    ("- 需求市场分析Excel数据表链接", "- 需求市场分析数据表.xlsx"),
    ("- 最终交付物固定为 HTML 文件，并上传为可访问链接返回。",
     "- 最终交付物固定为一个 HTML 报告，用 write_html_report 生成。"),
    ("- 必须调用文件上传能力返回可下载的Excel文件链接。",
     "- 必须调用 write_xlsx 生成 Excel 数据表。"),
    ("- 必须调用结构化处理能力完成价格段统计、占比计算、卖点归类和Excel写入。",
     "- 必须用程序化处理完成价格段统计、占比计算与卖点归类，再用 write_xlsx 写入多张工作表。"),
    ("10. 生成左侧菜单分屏展示的 HTML 分析报告，并同步生成配套 Excel 数据表后交付文件链接。",
     "10. 用 write_html_report 生成 HTML 分析报告，并用 write_xlsx 生成配套 Excel 数据表。"),
    ("- 生成完成后需上传并返回可访问的文件链接。",
     "- 生成完成后必须调用 write_html_report / write_xlsx 写出交付文件。"),
    ("1. HTML 分析报告文件链接，固定包含", "1. HTML 分析报告.html，固定包含"),
    ("2. Excel 数据表文件链接，固定包含", "2. Excel 数据表.xlsx，固定包含"),
    ("10. 上传并返回两个交付文件链接。",
     "10. 用 write_html_report 生成 HTML 成果页、用 write_xlsx 生成 Excel 数据表。"),
    ("- 必须返回可访问的文件链接作为最终交付结果。",
     "- 必须调用 write_html_report / write_xlsx 写出交付文件。"),
    ("10. 上传 HTML 报告与 Excel 数据表并返回可访问文件链接。",
     "10. 用 write_html_report 生成 HTML 报告、用 write_xlsx 生成 Excel 数据表。"),
    ("- 必须将最终文件上传为可访问链接后再交付。",
     "- 必须先调用 write_html_report / write_xlsx 写出交付文件。"),
    ("- HTML 分析报告链接：", "- HTML 分析报告.html："),
    ("- Excel 数据表链接：", "- Excel 数据表.xlsx："),
    ("9. 上传并交付 HTML 报告文件链接与 Excel 数据表文件链接。",
     "9. 用 write_html_report 生成 HTML 报告、用 write_xlsx 生成 Excel 数据表。"),
    ("- 必须通过文件上传工具返回可访问的文件链接，作为最终交付结果。",
     "- 必须调用 write_html_report / write_xlsx 写出交付文件。"),
    ("5. 返回 HTML 报告文件链接作为最终交付结果。",
     "5. 用 write_html_report 生成 HTML 报告作为最终交付结果。"),
    ("6. 生成并交付可下载的表格文件链接。", "6. 用 write_xlsx 生成并交付表格文件。"),
    ("- 需要使用文件生成工具输出 xlsx 文件。", "- 需要调用 write_xlsx 输出 xlsx 文件。"),
]

DELIVERY = {
    "html_xlsx": "\n# 本期交付动作\n用 read_table 拿到的真实数据组织 sections，先 write_html_report 出 HTML 报告，再 write_xlsx 出多张工作表的结构化数据；两个文件都写完后用一句话说明交付了什么。\n",
    "html": "\n# 本期交付动作\n用 read_table 拿到的真实数据组织 sections，write_html_report 出 HTML 报告；写完后用一句话说明交付了什么。\n",
    "xlsx": "\n# 本期交付动作\n用 read_table 拿到的真实数据整理成多张工作表，write_xlsx 出 Excel 数据表；写完后用一句话说明交付了什么。\n",
    "text": "\n# 本期交付动作\n本技能不产出文件：直接在回答正文里给出最终提示词，不加标题、解释或分点。\n",
}

# 16 个技能的登记信息（顺序与 skill-details.json 一致）
META = [
    dict(key=0, sid="advantage-money", category="找钱模型", icon="\U0001F4AA", delivery="html_xlsx", available=True,
         files=[("review_table", "评价分析表", ["\u002e\u0078\u006c\u0073\u0078", ".xls", ".csv"], "商品评价汇总/评价分析表，含评价内容、评分或情绪、好评差评标签、需求/场景/人群等字段")],
         params=[("product", "商品", "分析对象商品名；不填则按表格内容推断"), ("goal", "补充要求", "额外想强调的方向，例如重点看差评转化")]),
    dict(key=1, sid="sales-rank-money", category="找钱模型", icon="\U0001F4CA", delivery="html_xlsx", available=True,
         files=[("sales_rank_table", "行业前销量商品表", [".xlsx", ".xls", ".csv"], "行业头部销量商品清单，含现价、付款人数、同款数、店铺类型等字段")],
         params=[("category", "类目/商品", "分析对象类目；不填则按表格内容推断"), ("goal", "补充要求", "额外想强调的方向")]),
    dict(key=2, sid="style-money", category="找钱模型", icon="\U0001F3A8", delivery="html_xlsx", available=False,
         files=[("main_image_table", "搜索主图分析数据表", [".xlsx", ".xls", ".csv"], "搜索主图分析导出的多维策略数据表（三十余维视觉字段）")],
         params=[("category", "类目/商品", "分析对象"), ("goal", "补充要求", "额外想强调的方向")]),
    dict(key=3, sid="shop-tier-money", category="找钱模型", icon="\U0001F3EC", delivery="html", available=True,
         files=[("own_shop_table", "本店商品清单", [".xlsx", ".xls", ".csv"], "本店商品清单，含商品标题、销量、价格、SKU数等字段"),
                ("rival_shop_table", "竞店商品清单", [".xlsx", ".xls", ".csv"], "竞店商品清单，字段与本店一致")],
         params=[("shop", "店铺", "店铺名或对比说明；不填则按表格内容推断"), ("goal", "补充要求", "额外想强调的方向")]),
    dict(key=4, sid="demand-money", category="找钱模型", icon="\U0001F50E", delivery="html_xlsx", available=True,
         files=[("keyword_table", "关键词洞察/关键词排行表", [".xlsx", ".xls", ".csv"], "关键词洞察导出的多工作表表格（必争词、蓝海词、意向词等）")],
         params=[("category", "类目/商品", "分析对象类目；不填则按表格内容推断"), ("goal", "补充要求", "额外想强调的方向")]),
    dict(key=5, sid="cost-ratio-money", category="找钱模型", icon="\U0001F4C9", delivery="html", available=True,
         files=[("promotion_table", "推广数据表", [".xlsx", ".xls", ".csv"], "店铺推广数据，含商品维度访客、成交、退款及各推广渠道花费")],
         params=[("visitor_threshold", "访客门槛", "默认 1000"), ("gross_margin", "店铺毛利率", "默认 60%"), ("goal", "补充要求", "额外想强调的方向")]),
    dict(key=6, sid="price-band-money", category="找钱模型", icon="\U0001F4B0", delivery="xlsx", available=True,
         files=[("price_band_table", "价格带商品表", [".xlsx", ".xls", ".csv"], "含商品ID、商品标题、价格带/件单价、预估销售额、销量等字段")],
         params=[("product_title", "我的商品标题", "用于匹配最接近的竞品；不填则跳过竞品匹配"), ("goal", "补充要求", "额外想强调的方向")]),
    dict(key=7, sid="scene-money", category="找钱模型", icon="\U0001F9E9", delivery="html_xlsx", available=True,
         files=[("keyword_table", "关键词需求分析表", [".xlsx", ".xls", ".csv"], "类目下连续四周搜索词排行或关键词需求分析导出的表格")],
         params=[("category", "类目/商品", "分析对象类目"), ("goal", "补充要求", "额外想强调的方向")]),
    dict(key=8, sid="keyword-money", category="找钱模型", icon="\U0001F511", delivery="html_xlsx", available=True,
         files=[("keyword_table", "关键词排行表", [".xlsx", ".xls", ".csv"], "类目下连续四周的搜索词排行数据，或关键词需求分析导出的多工作表表格")],
         params=[("category", "类目/商品", "分析对象类目；不填则按表格内容推断"), ("goal", "补充要求", "额外想强调的方向，例如重点看新客词")]),
    dict(key=9, sid="cross-category-money", category="找钱模型", icon="\U0001F9ED", delivery="html_xlsx", available=True,
         files=[("blue_ocean_table", "蓝海探测报告表", [".xlsx", ".xls", ".csv"], "蓝海探测四榜（增长潜力榜/综合实力榜/头部精选榜/稳定表现榜）数据表")],
         params=[("category", "类目/商品", "分析对象类目"), ("goal", "补充要求", "额外想强调的方向")]),
    dict(key=10, sid="blue-ocean-money", category="找钱模型", icon="\U0001F30A", delivery="html_xlsx", available=True,
         files=[("blue_ocean_table", "蓝海探测报告表", [".xlsx", ".xls", ".csv"], "蓝海探测四榜数据表与品类特征总结")],
         params=[("category", "类目/商品", "分析对象类目"), ("goal", "补充要求", "额外想强调的方向")]),
    dict(key=11, sid="trend-money", category="找钱模型", icon="\U0001F4C8", delivery="html_xlsx", available=True,
         files=[("category_rank_table", "行业类目四榜数据表", [".xlsx", ".xls", ".csv"], "行业类目报告，含增长潜力榜/综合实力榜/头部精选榜/稳定表现榜四周轨迹")],
         params=[("category", "类目/商品", "分析对象类目"), ("goal", "补充要求", "额外想强调的方向")]),
    dict(key=12, sid="buyer-show-graphic", category="视觉营销", icon="\U0001F5BC", delivery="html", available=False,
         files=[("product_image", "商品参考图", ["image"], "商品图（需要图像识别与生图能力）")],
         params=[("product", "商品", "商品信息"), ("crowd", "目标人群", "目标人群"), ("goal", "补充要求", "额外想强调的方向")]),
    dict(key=13, sid="blue-ocean-report-interpret", category="报告解读", icon="\U0001F4D8", delivery="html", available=False,
         files=[("blue_ocean_report", "蓝海探测报告表", [".xlsx", ".xls", ".csv"], "蓝海探测报告中的连续四周商品排行榜数据")],
         params=[("brand", "品牌属性", "白牌/品牌/半品牌"), ("supply_chain", "供应链模式", "贸易型/工厂型/混合型"), ("team", "团队规模", "1-3人/4-10人/11-30人/30人+"), ("revenue", "月销规模", "月销售额区间"), ("stage", "发展阶段", "起步期/成长期/稳定期/扩张期"), ("goal", "补充要求", "额外想强调的方向")]),
    dict(key=14, sid="selling-point-image-prompt", category="视觉营销", icon="\u270D", delivery="text", available=True,
         files=[], params=[("product", "商品", "商品描述"), ("sellpoints", "核心卖点", "核心卖点"), ("style", "目标风格", "目标风格"), ("scene", "使用场景", "使用场景")]),
    dict(key=15, sid="buyer-show-fission-prompt", category="视觉营销", icon="\U0001F500", delivery="xlsx", available=True,
         files=[("reference_image", "参考图片", ["image"], "买家秀参考图（单张商品/买家秀图片）")],
         params=[("goal", "补充要求", "额外想强调的方向")]),
]


def build_input_schema(meta):
    files = []
    for name, label, accept, desc in meta.get("files") or []:
        files.append({"name": name, "label": label, "required": True, "accept": accept, "description": desc})
    params = []
    for name, label, desc in meta.get("params") or []:
        params.append({"name": name, "label": label, "type": "string", "required": False, "description": desc})
    return {"files": files, "params": params}


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SOURCE
    with open(src, "r", encoding="utf-8") as f:
        raw = json.load(f)
    by_name = {item["name"]: item for item in raw}
    out = []
    warnings = []
    for meta in META:
        item = by_name.get(meta["name"]) if "name" in meta else None
        # META 里没写 name，用下标对齐（顺序与导出文件一致）
        item = raw[meta["key"]]
        content = item.get("content") or ""
        adapted = content
        for old, new in REPLACEMENTS:
            adapted = adapted.replace(old, new)
        adapted = HEADER + "\n" + adapted.rstrip() + "\n" + DELIVERY[meta["delivery"]]
        for bad in ("文件上传能力", "文件上传工具", "文件读取能力", "返回可访问的", "返回可下载的",
                    "并返回文件链接", "上传并交付"):
            if bad in adapted:
                warnings.append("%s 仍含未适配表述：%s" % (meta["sid"], bad))
        deliverables = []
        for kind in meta["delivery"].split("_"):
            if kind == "html":
                deliverables.append({"kind": "html", "name": "%s分析报告.html" % item["name"], "label": "HTML 分析报告"})
            elif kind == "xlsx":
                deliverables.append({"kind": "xlsx", "name": "%s数据表.xlsx" % item["name"], "label": "Excel 数据表"})
        out.append({
            "id": meta["sid"],
            "name": item["name"],
            "category": meta["category"],
            "icon": meta["icon"],
            "description": item.get("description") or "",
            "tags": list(item.get("platforms") or []) + list(item.get("scenarios") or []),
            "platforms": item.get("platforms") or [],
            "scenarios": item.get("scenarios") or [],
            "usage_instruction": item.get("usageInstruction") or "",
            "source_skill_code": item.get("skillCode") or "",
            "input_schema": build_input_schema(meta),
            "deliverables": deliverables,
            "skill_prompt": adapted,
            "enabled": True,
            "available": bool(meta["available"]),
        })
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print("wrote %s (%d skills)" % (OUT_PATH, len(out)))
    for w in warnings:
        print("WARN:", w)


if __name__ == "__main__":
    main()
