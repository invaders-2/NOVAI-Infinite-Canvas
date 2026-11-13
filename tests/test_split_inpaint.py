"""拆分图层背景补全（LaMa）：预处理 / 兜底 / 开关 / 与 vision 的衔接，全部离线（不加载真模型）。"""
import json
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.split_engine import config, inpaint, matting, vision
from server.split_engine.image_io import LoadedImage

W, H = 240, 320


def _rgb():
    arr = np.zeros((H, W, 3), np.uint8)
    arr[:, :] = (20, 30, 40)
    arr[100:200, 90:150] = (200, 60, 60)
    return arr


class _FakeInput:
    def __init__(self, name):
        self.name = name


class _FakeSession:
    """假 onnx 会话：恒定颜色的补图输出（0~1 量纲），只验证预处理/合成/兜底。"""

    def __init__(self, value=0.25, fail=False):
        self.value = value
        self.fail = fail
        self.feeds = []

    def get_inputs(self):
        return [_FakeInput("input")]

    def run(self, _outputs, feed):
        self.feeds.append(feed)
        if self.fail:
            raise RuntimeError("模拟推理崩溃")
        return [np.full((1, 3, 512, 512), self.value, np.float32)]


def _session_stub(session=None, reason=""):
    return lambda: (session, reason)


def _loaded_from_rgb(arr):
    return LoadedImage(
        work=Image.fromarray(arr, "RGB").convert("RGBA"),
        width=W,
        height=H,
        up_x=1.0,
        up_y=1.0,
    )


def test_enabled_flag(monkeypatch):
    monkeypatch.delenv("SPLIT_INPAINT", raising=False)
    assert inpaint.enabled() is True
    for value in ("0", "false", "off", "no"):
        monkeypatch.setenv("SPLIT_INPAINT", value)
        assert inpaint.enabled() is False


def test_model_path_precedence(tmp_path, monkeypatch):
    data_root = tmp_path / "data"
    repo_root = tmp_path / "repo"
    (data_root / "assets" / "models").mkdir(parents=True)
    (repo_root / "assets" / "models").mkdir(parents=True)
    monkeypatch.setattr(config, "data_root", lambda: data_root)
    monkeypatch.setattr(config, "repo_root", lambda: repo_root)
    monkeypatch.delenv("SPLIT_INPAINT_MODEL", raising=False)

    data_model = data_root / "assets" / "models" / "lama_512_int8.onnx"
    repo_model = repo_root / "assets" / "models" / "lama_fp32.onnx"
    data_model.write_bytes(b"x")
    repo_model.write_bytes(b"x")
    assert inpaint._model_path() == (str(data_model), "")

    data_model.unlink()
    assert inpaint._model_path() == (str(repo_model), "")   # data_root 没有就退到安装目录

    monkeypatch.setenv("SPLIT_INPAINT_MODEL", str(tmp_path / "missing.onnx"))
    path, reason = inpaint._model_path()
    assert path is None and "不存在" in reason


def test_lama_fill_only_touches_hole(monkeypatch):
    arr = _rgb()
    hole = np.zeros((H, W), bool)
    hole[100:200, 90:150] = True
    session = _FakeSession(value=0.25)
    monkeypatch.setattr(inpaint, "_session", _session_stub(session))

    fill, reason = inpaint.fill_background(arr, hole)
    assert reason == "" and fill is not None and fill.shape == arr.shape
    assert fill[150, 120].tolist() == [64, 64, 64]          # 洞内换成模型输出（0.25*255≈64）
    assert fill[10, 10].tolist() == [20, 30, 40]            # 洞外保持原图
    assert fill[300, 200].tolist() == [20, 30, 40]
    # 预处理：image 和 mask 拼成 4 通道，洞里像素被抹掉（不抹的话模型会照抄主体）
    feed = session.feeds[0]
    tensor = next(iter(feed.values()))
    assert tensor.shape == (1, 4, 512, 512)
    assert float(tensor[0, 3].max()) > 0.5                  # 第 4 通道是 mask


def test_fill_falls_back_to_telea_when_model_missing(monkeypatch):
    arr = _rgb()
    hole = np.zeros((H, W), bool)
    hole[100:200, 90:150] = True
    monkeypatch.setattr(inpaint, "_session", _session_stub(None, "本地补背景模型未下载"))

    fill, reason = inpaint.fill_background(arr, hole)
    assert fill is not None and fill.shape == arr.shape
    assert "Telea" in reason and "本地补背景模型未下载" in reason
    assert fill[150, 120].tolist() != [20, 30, 40]          # 洞内有东西
    assert fill[10, 10].tolist() == [20, 30, 40]


def test_fill_falls_back_when_inference_crashes(monkeypatch):
    arr = _rgb()
    hole = np.zeros((H, W), bool)
    hole[100:200, 90:150] = True
    monkeypatch.setattr(inpaint, "_session", _session_stub(_FakeSession(fail=True)))

    fill, reason = inpaint.fill_background(arr, hole)
    assert fill is not None
    assert "推理失败" in reason and "Telea" in reason


def _vision_layers(roles_object=True):
    return [
        {"name": "background", "type": "image", "role": "background", "bbox": [0, 0, W, H]},
        {"name": "model", "type": "image", "role": "object", "bbox": [90, 100, 60, 100]},
    ]


def _install_fake_vision(monkeypatch, layers):
    class FakeResponse:
        status_code = 200

        @staticmethod
        def json():
            content = json.dumps({"layers": layers}, ensure_ascii=False)
            return {"choices": [{"message": {"content": content}}]}

    monkeypatch.setattr(vision.requests, "post", lambda *args, **kwargs: FakeResponse())


def _matte_stub(monkeypatch, alpha_box=(80, 90, 80, 130)):
    rgba = np.zeros((H, W, 4), np.uint8)
    x, y, w, h = alpha_box
    rgba[y:y + h, x:x + w, :3] = (200, 60, 60)
    rgba[y:y + h, x:x + w, 3] = 255
    rgba[y:y + 2, x:x + w, 3] = 128
    monkeypatch.setattr(matting, "foreground_rgba", lambda loaded: (rgba, ""))
    return rgba


def test_vision_fills_background_when_inpaint_available(monkeypatch):
    monkeypatch.delenv("SPLIT_INPAINT", raising=False)
    monkeypatch.setenv("SPLIT_VISION_BASE_URL", "http://fake")
    monkeypatch.setenv("SPLIT_VISION_API_KEY", "k")
    monkeypatch.setenv("SPLIT_VISION_MODEL", "m")
    _install_fake_vision(monkeypatch, _vision_layers())
    _matte_stub(monkeypatch)
    filled = np.full((H, W, 3), 7, np.uint8)
    warning = "本地 LaMa 补背景模型不可用（测试），已用 OpenCV Telea 兜底"
    monkeypatch.setattr(inpaint, "fill_background", lambda rgb, hole: (filled, warning))

    drafts, warnings, engine = vision.split(_loaded_from_rgb(_rgb()), "auto", None, None, 16)
    background = next(draft for draft in drafts if draft.role == "background")
    bg = np.asarray(background.png)
    assert engine == "vision"
    assert background.png.size == (W, H)
    assert int((bg[..., 3] == 255).sum()) == W * H          # 补完就是完整不透明底图
    assert np.array_equal(bg[..., :3], filled)              # 补出来的像素直接进背景层
    assert any(warning in line for line in warnings)


def test_vision_keeps_transparent_hole_when_inpaint_disabled(monkeypatch):
    monkeypatch.setenv("SPLIT_INPAINT", "0")
    monkeypatch.setenv("SPLIT_VISION_BASE_URL", "http://fake")
    monkeypatch.setenv("SPLIT_VISION_API_KEY", "k")
    monkeypatch.setenv("SPLIT_VISION_MODEL", "m")
    _install_fake_vision(monkeypatch, _vision_layers())
    _matte_stub(monkeypatch)

    def boom(_rgb, _hole):
        raise AssertionError("SPLIT_INPAINT=0 时不该调用补背景")

    monkeypatch.setattr(inpaint, "fill_background", boom)
    drafts, _warnings, _engine = vision.split(_loaded_from_rgb(_rgb()), "auto", None, None, 16)
    bg_alpha = np.asarray(next(d for d in drafts if d.role == "background").png)[..., 3]
    assert int((bg_alpha == 0).sum()) > 0                  # 老行为：主体位置是透明洞
    assert int((bg_alpha == 255).sum()) > 0


def test_vision_keeps_hole_when_fill_returns_none(monkeypatch):
    monkeypatch.delenv("SPLIT_INPAINT", raising=False)
    monkeypatch.setenv("SPLIT_VISION_BASE_URL", "http://fake")
    monkeypatch.setenv("SPLIT_VISION_API_KEY", "k")
    monkeypatch.setenv("SPLIT_VISION_MODEL", "m")
    _install_fake_vision(monkeypatch, _vision_layers())
    _matte_stub(monkeypatch)
    reason = "补背景异常（测试），背景保持原样"
    monkeypatch.setattr(inpaint, "fill_background", lambda rgb, hole: (None, reason))

    drafts, warnings, _engine = vision.split(_loaded_from_rgb(_rgb()), "auto", None, None, 16)
    bg_alpha = np.asarray(next(d for d in drafts if d.role == "background").png)[..., 3]
    assert int((bg_alpha == 0).sum()) > 0                  # 补不了就退回透明洞，不留主体
    assert any(reason in line for line in warnings)


def test_vision_never_inpaints_without_object_layer(monkeypatch):
    monkeypatch.delenv("SPLIT_INPAINT", raising=False)
    monkeypatch.setenv("SPLIT_VISION_BASE_URL", "http://fake")
    monkeypatch.setenv("SPLIT_VISION_API_KEY", "k")
    monkeypatch.setenv("SPLIT_VISION_MODEL", "m")
    _install_fake_vision(
        monkeypatch,
        [
            {"name": "card", "type": "image", "role": "block", "bbox": [10, 10, 60, 40]},
            {"name": "background", "type": "image", "role": "background", "bbox": [0, 0, W, H]},
        ],
    )
    _matte_stub(monkeypatch)  # vision 会预跑一次抠图线程，别让它加载真模型

    def boom(_rgb, _hole):
        raise AssertionError("没有主体层时不该补背景")

    monkeypatch.setattr(inpaint, "fill_background", boom)
    drafts, _warnings, _engine = vision.split(_loaded_from_rgb(_rgb()), "auto", None, None, 16)
    bg_alpha = np.asarray(next(d for d in drafts if d.role == "background").png)[..., 3]
    assert int((bg_alpha == 255).sum()) == W * H

def _text_matte(bbox, color="#FFFFFF"):
    x, y, w, h = bbox
    rgba = np.zeros((h, w, 4), np.uint8)
    rgba[..., :3] = 255
    rgba[2:12, 2:12, 3] = 255  # 模拟很弱的 glyph matte：只盖住 bbox 一小角
    return {"x": x, "y": y, "rgba": rgba, "color": color, "density": 0.1, "largestRatio": 0.1}


def _run_text_scene(monkeypatch, image, layers, matte_bbox):
    monkeypatch.delenv("SPLIT_INPAINT", raising=False)
    monkeypatch.setenv("SPLIT_VISION_BASE_URL", "http://fake")
    monkeypatch.setenv("SPLIT_VISION_API_KEY", "k")
    monkeypatch.setenv("SPLIT_VISION_MODEL", "m")
    _install_fake_vision(monkeypatch, layers)
    _matte_stub(monkeypatch)
    monkeypatch.setattr(
        vision.text, "build_text_matte", lambda rgb, bbox: _text_matte(matte_bbox)
    )
    captured = {}

    def fake_fill(rgb, hole):
        captured["hole"] = np.asarray(hole).copy()
        return np.full((H, W, 3), 7, np.uint8), ""

    monkeypatch.setattr(inpaint, "fill_background", fake_fill)
    drafts, warnings, engine = vision.split(_loaded_from_rgb(image), "auto", None, None, 16)
    return drafts, warnings, engine, captured["hole"]


def test_text_bbox_block_is_wiped_from_background(monkeypatch):
    image = _rgb()
    bbox = [100, 120, 60, 40]
    layers = [
        {"name": "background", "type": "image", "role": "background", "bbox": [0, 0, W, H]},
        {"name": "title", "type": "text", "text": "标题", "bbox": bbox,
         "style": {"color": "#FFFFFF", "fontSize": 24}},
    ]
    drafts, warnings, engine, hole = _run_text_scene(monkeypatch, image, layers, tuple(bbox))

    assert engine == "vision"
    # bbox 外扩 8px（整块）+ 检测到的文字外接框，四角都要进 inpaint mask
    for px, py in ((100, 120), (159, 120), (100, 159), (159, 159)):
        assert hole[py, px], (px, py)
    background = next(draft for draft in drafts if draft.role == "background")
    bg = np.asarray(background.png)
    assert int((bg[..., 3] == 255).sum()) == W * H
    assert np.array_equal(bg[..., :3], np.full((H, W, 3), 7, np.uint8))
    text_layer = next(draft for draft in drafts if draft.kind == "text")
    assert text_layer.text == "标题" and text_layer.style["color"] == "#FFFFFF"


def test_text_removal_catches_text_beyond_declared_bbox(monkeypatch):
    # 原图里一段亮条从左下角一直延伸到 bbox 右边很远，模拟 vision bbox 只框住半行
    image = _rgb()
    image[130:150, 105:170] = (250, 250, 250)
    bbox = [100, 120, 40, 30]
    layers = [
        {"name": "background", "type": "image", "role": "background", "bbox": [0, 0, W, H]},
        {"name": "title", "type": "text", "text": "很长的一行标题", "bbox": bbox,
         "style": {"color": "#FFFFFF", "fontSize": 24}},
    ]
    _drafts, _warnings, _engine, hole = _run_text_scene(monkeypatch, image, layers, tuple(bbox))

    assert hole[140, 165], "bbox 外的同色文字也要被补掉"
    assert hole[140, 105]
