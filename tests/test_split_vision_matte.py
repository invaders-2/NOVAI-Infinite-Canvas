"""拆分图层 vision 引擎：主体层真透明抠出 + 背景在主体处挖洞（本地假上游，不联网、不加载 349MB 模型）。

覆盖：
  1. role=object 的图片层按抠图 alpha 出图层（透明 + 半透明边），block 仍是矩形；
  2. background 的 alpha = 1 - union(主体 alpha)，叠回去仍等于原图（主体可单独挪走）；
  3. role 缺省时按名字兜底（model / 商品）；
  4. 抠图不可用时主体退回矩形层 + warning，背景仍不透明；
  5. 没有主体层时预跑出来的 matte 直接丢弃；
  6. 抠图线程抛异常也不影响拆分。
"""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.split_engine import matting, vision
from server.split_engine.image_io import LoadedImage

W, H = 240, 320
OBJECT_BBOX = [80, 60, 80, 200]

# 假抠图 mask：主体比 vision 的 bbox 大一圈（真实模型把脚切在框外的现场就是这样）
MATTE_BOX = (64, 50, 116, 226)


class _Upstream:
    """本地假 vision 上游：任何 POST 都回同一份 layers JSON。"""

    def __init__(self):
        self.layers = []
        self.requests = 0
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def _handler(upstream):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                self.rfile.read(length)
                upstream.requests += 1
                content = json.dumps({"layers": upstream.layers}, ensure_ascii=False)
                body = json.dumps(
                    {"choices": [{"message": {"content": content}}]}, ensure_ascii=False
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        return Handler

    @property
    def base_url(self):
        return "http://127.0.0.1:%d/v1" % self.httpd.server_address[1]

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def upstream(monkeypatch):
    with _Upstream() as server:
        monkeypatch.setenv("SPLIT_VISION_BASE_URL", server.base_url)
        monkeypatch.setenv("SPLIT_VISION_API_KEY", "test-key")
        monkeypatch.setenv("SPLIT_VISION_MODEL", "test-model")
        monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
        # 这组用例断言的是「透明洞」语义；开补背景会依赖本地 LaMa 模型，单独在 test_split_inpaint.py 覆盖
        monkeypatch.setenv("SPLIT_INPAINT", "0")
        yield server


@pytest.fixture
def loaded():
    arr = np.zeros((H, W, 3), np.uint8)
    arr[:, :] = (20, 30, 40)
    arr[60:260, 80:160] = (200, 60, 60)
    return LoadedImage(
        work=Image.fromarray(arr, "RGB").convert("RGBA"),
        width=W,
        height=H,
        up_x=1.0,
        up_y=1.0,
    )


def _matte_rgba(loaded):
    """假抠图结果：RGB 用原图像素（和真实 mask_to_rgba 在实心处一致），alpha 有实心 + 半透明边。"""
    rgb = np.asarray(loaded.work.convert("RGB"))
    alpha = np.zeros((H, W), np.float32)
    alpha[50:276, 64:180] = 1.0
    alpha[50:52, 64:180] = 0.5
    alpha[74:276, 64:66] = 0.5
    rgba = np.dstack([rgb, np.clip(alpha * 255.0 + 0.5, 0, 255).astype(np.uint8)])
    return rgba


@pytest.fixture
def fake_matte(monkeypatch, loaded):
    rgba = _matte_rgba(loaded)
    monkeypatch.setattr(matting, "foreground_rgba", lambda image: (rgba, ""))
    return rgba


def _by_name(drafts, name):
    return next(draft for draft in drafts if draft.name == name)


def _alpha(draft):
    return np.asarray(draft.png)[..., 3]


def test_object_layer_is_transparent_and_block_stays_rect(upstream, loaded, fake_matte):
    upstream.layers = [
        {"name": "model", "type": "image", "role": "object", "bbox": OBJECT_BBOX},
        {"name": "panel", "type": "image", "role": "block", "bbox": [180, 50, 40, 60]},
        {"name": "background", "type": "image", "role": "background", "bbox": [0, 0, W, H]},
    ]
    drafts, warnings, engine = vision.split(loaded, "auto", None, None, 16)

    assert engine == "vision"
    # 背景层必须排最前（z 最低），即使模型把它放在最后
    assert drafts[0].role == "background"
    assert drafts[0].name == "background"

    model = _by_name(drafts, "model")
    alpha = _alpha(model)
    assert model.role == "object"
    assert model.png.size == (W, H)
    assert int((alpha == 0).sum()) > 0                              # 主体之外真透明
    assert int(((alpha > 0) & (alpha < 255)).sum()) > 0             # 边缘保留半透明
    assert alpha[120, 150] == 255                                   # 主体实心处不透明
    assert alpha[10, 10] == 0                                       # 远离主体全透明
    assert alpha[100, 170] == 255                                   # 框外但同一主体 → 补全，不锯断
    assert model.bbox == (MATTE_BOX[0], MATTE_BOX[1], MATTE_BOX[2], MATTE_BOX[3])

    panel = _by_name(drafts, "panel")
    panel_alpha = _alpha(panel)
    assert panel.role == "block"
    assert int((panel_alpha[50:110, 180:220] == 255).sum()) == 40 * 60   # 矩形整块不透明
    assert int((panel_alpha == 255).sum()) == 40 * 60
    assert panel.bbox == (180, 50, 40, 60)

    background = _by_name(drafts, "background")
    bg_alpha = _alpha(background)
    assert background.role == "background"
    assert background.png.size == (W, H)
    assert bg_alpha[120, 150] == 0                                  # 主体位置挖成洞
    assert bg_alpha[10, 10] == 255                                  # 主体之外仍是不透明底图
    assert int(((bg_alpha > 0) & (bg_alpha < 255)).sum()) > 0       # 边缘半透明对应主体边
    assert warnings and "vision 引擎结果依赖所接模型" in warnings[0]


def test_background_hole_makes_stack_equal_to_original(upstream, loaded, fake_matte):
    upstream.layers = [
        {"name": "background", "type": "image", "role": "background", "bbox": [0, 0, W, H]},
        {"name": "model", "type": "image", "role": "object", "bbox": OBJECT_BBOX},
    ]
    drafts, _warnings, _engine = vision.split(loaded, "auto", None, None, 16)
    background = _by_name(drafts, "background")
    model = _by_name(drafts, "model")
    bg = np.asarray(background.png)
    obj = np.asarray(model.png)

    # alpha 互补：主体可见处 主体 + 背景 = 255，主体不可见处背景保持 255
    visible = obj[..., 3] > 0
    assert np.array_equal(bg[..., 3][visible] + obj[..., 3][visible], np.full(visible.sum(), 255))
    assert int((bg[..., 3][~visible] == 255).sum()) == int((~visible).sum())

    # 背景挖洞后叠回主体层 = 原图（主体是原图像素，只是被拆出来）
    original = np.asarray(loaded.work.convert("RGB")).astype(np.float32)
    a = obj[..., 3:4].astype(np.float32) / 255.0
    comp = obj[..., :3].astype(np.float32) * a + bg[..., :3].astype(np.float32) * (1 - a)
    assert float(np.abs(comp - original).max()) <= 1.0


@pytest.mark.parametrize("name", ["model", "商品图"])
def test_role_defaults_by_name(upstream, loaded, fake_matte, name):
    upstream.layers = [
        {"name": "background", "type": "image", "role": "background", "bbox": [0, 0, W, H]},
        {"name": name, "type": "image", "bbox": OBJECT_BBOX},
    ]
    drafts, _warnings, _engine = vision.split(loaded, "auto", None, None, 16)

    layer = _by_name(drafts, name)
    assert layer.role == "object"
    assert int((_alpha(layer) == 0).sum()) > 0
    assert int((_alpha(_by_name(drafts, "background")) == 0).sum()) > 0


def test_missing_role_without_keyword_is_block(upstream, loaded, fake_matte):
    upstream.layers = [
        {"name": "background", "type": "image", "role": "background", "bbox": [0, 0, W, H]},
        {"name": "side card", "type": "image", "bbox": [180, 50, 40, 60]},
    ]
    drafts, _warnings, _engine = vision.split(loaded, "auto", None, None, 16)

    assert _by_name(drafts, "side card").role == "block"
    assert int((_alpha(_by_name(drafts, "side card")) == 255).sum()) == 40 * 60


def test_matte_unavailable_falls_back_to_rect_with_warning(upstream, loaded, monkeypatch):
    reason = "本地抠图模型未下载（找不到 rmbg_2.0.onnx）"
    monkeypatch.setattr(matting, "foreground_rgba", lambda image: (None, reason))
    upstream.layers = [
        {"name": "model", "type": "image", "role": "object", "bbox": OBJECT_BBOX},
        {"name": "background", "type": "image", "role": "background", "bbox": [0, 0, W, H]},
    ]
    drafts, warnings, engine = vision.split(loaded, "auto", None, None, 16)

    assert engine == "vision"
    model = _by_name(drafts, "model")
    assert model.role == "object"
    assert model.bbox == tuple(OBJECT_BBOX)
    alpha = _alpha(model)
    assert int((alpha[60:260, 80:160] == 255).sum()) == 80 * 200     # 退回矩形层
    assert int((alpha == 255).sum()) == 80 * 200
    assert int((_alpha(_by_name(drafts, "background")) == 255).sum()) == W * H   # 背景仍不透明
    assert any("本地抠图模型不可用" in line and reason in line for line in warnings)


def test_no_object_layer_discards_speculative_matte(upstream, loaded, monkeypatch):
    monkeypatch.setattr(matting, "foreground_rgba", lambda image: (_matte_rgba(loaded), ""))
    upstream.layers = [
        {"name": "card", "type": "image", "role": "block", "bbox": [10, 10, 60, 40]},
        {"name": "background", "type": "image", "role": "background", "bbox": [0, 0, W, H]},
    ]
    drafts, warnings, _engine = vision.split(loaded, "auto", None, None, 16)

    assert [draft.role for draft in drafts] == ["background", "block"]
    assert int((_alpha(_by_name(drafts, "background")) == 255).sum()) == W * H
    assert int((_alpha(_by_name(drafts, "card")) == 255).sum()) == 60 * 40
    assert not any("抠图" in line for line in warnings)


def test_matte_thread_error_falls_back_to_rect(upstream, loaded, monkeypatch):
    def boom(_image):
        raise RuntimeError("模拟推理崩溃")

    monkeypatch.setattr(matting, "foreground_rgba", boom)
    upstream.layers = [
        {"name": "model", "type": "image", "role": "object", "bbox": OBJECT_BBOX},
        {"name": "background", "type": "image", "role": "background", "bbox": [0, 0, W, H]},
    ]
    drafts, warnings, engine = vision.split(loaded, "auto", None, None, 16)

    assert engine == "vision"
    model = _by_name(drafts, "model")
    assert model.bbox == tuple(OBJECT_BBOX)
    assert int((_alpha(model) == 255).sum()) == 80 * 200
    assert any("本地抠图模型不可用" in line and "模拟推理崩溃" in line for line in warnings)
