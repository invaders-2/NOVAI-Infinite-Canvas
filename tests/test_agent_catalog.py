#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""智能体/技能目录 + 平台 + 猜你想问的数据契约（对齐 sealseek 真实目录）。

锁住：27 个智能体的 sealseek id / 名称 / 一句话描述；16 个技能；9 个平台（顺序与
亚马逊即将上线）；猜你想问 5 条及其 capability 描述符映射。不依赖服务，只读注册表。
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.agents import catalog  # noqa: E402

# (sealseek 智能体 id, 本项目 id, 名称, 描述) —— 顺序即目录展示顺序
EXPECTED_AGENTS = [
    (3, "blue-ocean", "蓝海探测", "寻找蓝海商品池，发掘趋势机会"),
    (8, "keyword-demand", "关键词需求分析", "分析目标商品/市场的关键词需求"),
    (5, "keyword-insight", "关键词洞察", "必争词榜、蓝海词榜、意向词榜"),
    (4, "search-main-image", "搜索主图分析", "32个维度剖析竞品主图，智能生成效果图"),
    (1, "review-analysis", "评价分析", "分析竞品评价趋势、需求、场景、人群"),
    (2, "qa-analysis", "问大家分析", "分析竞品问大家，预判买家关注点"),
    (12, "title-creation", "标题制作", "生成新品期、成长期、成熟期标题"),
    (9, "main-image-plan", "主图策划", "生成5张商品主图的设计策划"),
    (11, "main-image-gen", "主图生成", "智能生成1套商品主图"),
    (29, "brand-main-image-gen", "品牌级主图生成", "生成品牌级视觉表达主图"),
    (30, "styled-main-image-gen", "风格化主图生成", "按店铺其他商品风格创作主图/详情页"),
    (6, "detail-plan", "详情页策划", "生成一套详情页的设计策划"),
    (17, "brand-detail-plan", "品牌级详情页策划", "8层推导策略，生成品牌级详情页策划"),
    (10, "detail-gen", "详情页生成", "智能生成1套商品详情页"),
    (7, "buyer-show-gen", "买家秀生成", "智能生成8张写实买家秀图片"),
    (28, "viral-image-teardown", "爆款主图拆解", "拆解爆款主图逻辑，生成同类型风格参考"),
    (13, "smart-selection", "智能选款", "按店内商品表现与关键词选潜力商品"),
    (15, "promotion-analysis", "推广分析", "不同推广渠道数据对比（点击率、转化率、ROI）"),
    (22, "region-diagnosis", "地域诊断", "精准排区提投产"),
    (23, "crowd-diagnosis", "人群诊断", "精准锁客提转化"),
    (24, "video-script-teardown", "视频脚本拆解", "自动解析视频结构与脚本逻辑"),
    (25, "video-script-imitation", "视频脚本仿写", "结合自己产品仿写脚本"),
    (31, "live-script-optimize", "直播话术优化", "AI拆解直播话术结构，生成优化方案"),
    (26, "video-script-gen", "视频脚本生成", "生成高转化商品视频脚本"),
    (27, "tax-risk-diagnosis", "税务风险诊断", "智能诊断企业财税风险"),
    (14, "traffic-channel", "流量渠道", "下载竞品流量渠道数据，与自店对比"),
    (16, "product-diagnosis", "商品诊断", "针对单品的商品诊断"),
]

EXPECTED_PLATFORMS = ["淘宝天猫", "抖音电商", "拼多多", "1688", "小红书", "京东", "财税", "亚马逊", "私域"]


class AgentCatalogTest(unittest.TestCase):
    def agents_by_id(self):
        return {a["id"]: a for a in catalog.list_agents()}

    def test_27_agents_metadata(self):
        agents = self.agents_by_id()
        self.assertEqual(len(EXPECTED_AGENTS), 27)
        for sid, aid, name, desc in EXPECTED_AGENTS:
            self.assertIn(aid, agents, "缺少智能体 %s" % aid)
            self.assertEqual(agents[aid]["name"], name)
            self.assertEqual(agents[aid]["description"], desc)
            self.assertEqual(int(agents[aid]["source_agent_id"]), sid)

    def test_directory_order(self):
        ids = [a["id"] for a in catalog.list_agents() if a["id"] in {x[1] for x in EXPECTED_AGENTS}]
        self.assertEqual(ids, [x[1] for x in EXPECTED_AGENTS])

    def test_no_agent_skill_id_overlap(self):
        agent_ids = set(self.agents_by_id())
        skill_ids = {s["id"] for s in catalog.list_skills()}
        self.assertFalse(agent_ids & skill_ids)

    def test_17_skills_and_public_fields(self):
        skills = catalog.list_skills()
        self.assertEqual(len(skills), 17)
        for s in skills:
            pub = catalog.public_capability(s, "skill")
            self.assertIn("source_skill_code", pub)
            self.assertTrue(pub["source_skill_code"], "技能 %s 缺少 source_skill_code" % s["id"])

    def test_public_agent_optional_fields(self):
        for a in catalog.list_agents():
            pub = catalog.public_capability(a, "agent")
            self.assertIn("source_agent_id", pub)
            self.assertIn("unavailable_reason", pub)
            if not pub["available"]:
                self.assertTrue(pub["unavailable_reason"], "即将上线的 %s 缺 unavailable_reason" % a["id"])

    def test_capabilities_union(self):
        caps = catalog.list_capabilities()
        agents = [c for c in caps if c["kind"] == "agent"]
        skills = [c for c in caps if c["kind"] == "skill"]
        self.assertEqual(len(skills), 17)
        self.assertGreaterEqual(len(agents), 27)
        self.assertEqual({c["id"] for c in agents} & {c["id"] for c in skills}, set())

    def test_platforms_9_order_and_amazon_soon(self):
        ps = catalog.list_platforms()
        self.assertEqual(len(ps), 9)
        self.assertEqual([p["name"] for p in ps], EXPECTED_PLATFORMS)
        self.assertEqual([p["sort_num"] for p in ps], sorted(p["sort_num"] for p in ps))
        self.assertEqual({p["key"] for p in ps if p["coming_soon"]}, {"amazon"})

    def test_suggestions_descriptors(self):
        ss = catalog.list_suggestions()
        self.assertEqual(len(ss), 5)
        by_id = {s["id"]: s for s in ss}
        self.assertEqual(by_id["keyword-insight-blue-ocean"]["capability"],
                         {"type": "agent", "capabilityId": "keyword-insight", "agentId": 5, "name": "关键词洞察"})
        self.assertEqual(by_id["promotion-roi"]["capability"]["agentId"], 15)
        self.assertEqual(by_id["buyer-show-graphic"]["capability"]["type"], "skill")
        self.assertEqual(by_id["buyer-show-graphic"]["capability"]["skillCode"],
                         "45e740b5-073e-43f1-b23a-4a6ad0483547")
        self.assertEqual(by_id["generate-image-scene"]["capability"],
                         {"type": "generate-image", "cardType": 3})
        for s in ss:
            self.assertTrue(s["text"])
            self.assertIn(s["icon_type"], ("hot", "new", "skill", "generate-image", ""))


if __name__ == "__main__":
    unittest.main(verbosity=2)
