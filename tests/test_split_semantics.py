"""拆分图层语义层：角色收敛、中文命名、行合并、字号估计、字体统一。"""
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.split_engine import fonts, semantics, text


def test_canonical_role_maps_model_vocabulary():
    assert semantics.canonical_role("object") == semantics.ROLE_SUBJECT
    assert semantics.canonical_role("block") == semantics.ROLE_DECORATION
    assert semantics.canonical_role("背景") == semantics.ROLE_BACKGROUND
    assert semantics.canonical_role("logo") == semantics.ROLE_LOGO
    assert semantics.canonical_role("whatever", "text") == semantics.ROLE_TEXT


def test_canonical_role_uses_name_hint_when_role_missing():
    assert semantics.canonical_role(None, "image", 1, "model") == semantics.ROLE_SUBJECT
    assert semantics.canonical_role(None, "image", 1, "商品图") == semantics.ROLE_SUBJECT
    assert semantics.canonical_role(None, "image", 1, "品牌logo") == semantics.ROLE_LOGO
    assert semantics.canonical_role(None, "image", 1, "side card") == semantics.ROLE_DECORATION


def test_clean_name_is_readable_chinese():
    assert semantics.clean_name("model", semantics.ROLE_SUBJECT) == "主体"
    assert semantics.clean_name("robot_hand", semantics.ROLE_PROP) == "道具：机械手"
    assert semantics.clean_name(None, semantics.ROLE_TEXT, "夏日清透") == "夏日清透"
    assert len(semantics.clean_name("x" * 40, semantics.ROLE_PROP)) <= 12


def test_ensure_unique_appends_index():
    drafts = [SimpleNamespace(name="主体"), SimpleNamespace(name="主体"), SimpleNamespace(name="文字")]
    semantics.ensure_unique(drafts)
    assert [draft.name for draft in drafts] == ["主体", "主体 2", "文字"]


def test_merge_lines_joins_same_line_fragments():
    lines = [
        {"text": "限时5", "x": 265, "y": 520, "w": 114, "h": 56, "conf": 80.0},
        {"text": "-立即抢购", "x": 448, "y": 520, "w": 187, "h": 56, "conf": 82.0},
    ]
    merged = text.merge_lines(lines)
    assert len(merged) == 1
    assert merged[0]["text"] == "限时5 -立即抢购"
    assert merged[0]["x"] == 265 and merged[0]["w"] == 370


def test_estimate_font_size_is_bounded_by_width_and_height():
    wide = text.estimate_font_size("夏日清透", ink_h=110, box_w=455)
    narrow = text.estimate_font_size("夏日清透", ink_h=110, box_w=200)
    assert narrow < wide <= 140
    latin = text.estimate_font_size("NOVAI BEAUTY", ink_h=23, box_w=223)
    assert 8 <= latin <= 40


def test_font_vote_and_harmonize_by_script():
    votes = [("MiSans", 0.9, 5000), ("Alibaba PuHuiTi 3.0", 0.6, 800)]
    assert fonts.dominant(votes) == "MiSans"

    drafts = [
        SimpleNamespace(text="NOVAI BEAUTY", area=1000, style={"fontFamily": "MiSans"}, font_score=0.8),
        SimpleNamespace(text="夏日清透", area=4000, style={"fontFamily": "Alibaba PuHuiTi 3.0"}, font_score=0.7),
        SimpleNamespace(text="保湿精华", area=3000, style={"fontFamily": "MiSans"}, font_score=0.2),
    ]
    applied = fonts.harmonize(drafts)
    assert applied["cjk"] == "Alibaba PuHuiTi 3.0"
    assert applied["latin"] == "MiSans"
    assert drafts[2].style["fontFamily"] == "Alibaba PuHuiTi 3.0"
