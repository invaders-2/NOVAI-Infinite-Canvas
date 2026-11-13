from __future__ import annotations

import os
import threading

import numpy as np

from . import config

# 优先用 int8（62MB，随附件体积小），没有就退到 fp16/fp32（同款 LaMa，导出格式略有差异）
MODEL_CANDIDATES = ("lama_512_int8.onnx", "lama_fp16.onnx", "lama_fp32.onnx")
# 这个导出的 ONNX 是固定 512×512；LaMa 本身全卷积，但导出时写死了形状
INFER_SIZE = 512

_SESSION = None
_SESSION_ATTEMPTED = False
_LOAD_REASON = ""
_SESSION_LOCK = threading.Lock()
_INFER_LOCK = threading.Lock()


def enabled() -> bool:
    """SPLIT_INPAINT=0 关闭补背景（退回「背景挖透明洞」的老行为）。"""
    value = (os.environ.get("SPLIT_INPAINT") or "1").strip().lower()
    return value not in {"0", "false", "no", "off"}


def _model_path() -> tuple[str | None, str]:
    """模型路径规则与 matting.py 一致：<data_root>/assets/models 优先，安装目录兜底。"""
    override = (os.environ.get("SPLIT_INPAINT_MODEL") or "").strip()
    if override:
        if os.path.isfile(override):
            return override, ""
        return None, "补背景模型文件不存在（%s）" % override
    for root in (config.data_root(), config.repo_root()):
        for name in MODEL_CANDIDATES:
            path = root / "assets" / "models" / name
            if path.is_file():
                return str(path), ""
    return None, "本地补背景模型未下载（找不到 %s）" % " / ".join(MODEL_CANDIDATES)


def _session() -> tuple[object | None, str]:
    """onnxruntime 会话（懒加载单例）。缺失/损坏只记原因，不抛异常。"""
    global _SESSION, _SESSION_ATTEMPTED, _LOAD_REASON
    if _SESSION is not None:
        return _SESSION, ""
    with _SESSION_LOCK:
        if _SESSION is not None:
            return _SESSION, ""
        if _SESSION_ATTEMPTED:
            return None, _LOAD_REASON
        path, reason = _model_path()
        if path is None:
            # 模型可能刚下载完：文件缺失不缓存，下次拆分重新 stat 一次
            return None, reason
        _SESSION_ATTEMPTED = True
        try:
            import onnxruntime
        except Exception as exc:  # noqa: BLE001 - 缺组件/ABI 不匹配都只降级
            _LOAD_REASON = "缺少推理组件 onnxruntime（%s）" % str(exc)[:120]
            return None, _LOAD_REASON
        try:
            _SESSION = onnxruntime.InferenceSession(
                path, providers=["CPUExecutionProvider"]
            )
        except Exception as exc:  # noqa: BLE001 - 模型损坏也只是降级
            _LOAD_REASON = "补背景模型加载失败（%s）" % str(exc)[:120]
            return None, _LOAD_REASON
        _LOAD_REASON = ""
        return _SESSION, ""


def _infer(session, rgb_u8: np.ndarray, hole: np.ndarray) -> np.ndarray:
    import cv2

    work_h, work_w = rgb_u8.shape[:2]
    small = cv2.resize(rgb_u8, (INFER_SIZE, INFER_SIZE), interpolation=cv2.INTER_AREA)
    mask = cv2.resize(
        (hole.astype(np.uint8) * 255), (INFER_SIZE, INFER_SIZE), interpolation=cv2.INTER_NEAREST
    )
    mask_f = (mask > 127).astype(np.float32)
    # 模型期望洞里已经是纯色：不抹掉的话它会把主体当成上下文照抄一遍（实测会留鬼影）
    tensor = (small.astype(np.float32) / 255.0) * (1.0 - mask_f[..., None])
    tensor = tensor.transpose(2, 0, 1)[None]
    inputs = session.get_inputs()
    if len(inputs) == 1:
        # int8 导出：image + mask 拼成 4 通道
        feed = {inputs[0].name: np.concatenate([tensor, mask_f[None, None]], axis=1)}
    else:
        # fp16/fp32 导出：image 和 mask 是两个入口（按位置喂，名字不可靠）
        feed = {inputs[0].name: tensor, inputs[1].name: mask_f[None, None]}
    with _INFER_LOCK:
        output = session.run(None, feed)[-1]
    out = np.asarray(output[0], dtype=np.float32)
    # 两个导出的输出量纲不一样（0~1 / 0~255），按最大值判断
    if float(out.max()) > 2.0:
        out = out / 255.0
    out = np.clip(out.transpose(1, 2, 0), 0.0, 1.0)
    return cv2.resize(out, (work_w, work_h), interpolation=cv2.INTER_LANCZOS4)


def _composite(rgb_u8: np.ndarray, fill: np.ndarray, hole_u8: np.ndarray) -> np.ndarray:
    """只把洞（外扩 1~2px 羽化）换成补出来的像素，洞外保持原图，接缝不硬。"""
    import cv2

    hard = hole_u8.astype(np.float32) / 255.0
    feather = np.maximum(cv2.GaussianBlur(hard, (0, 0), 1.5), hard)
    weight = feather[..., None]
    out = rgb_u8.astype(np.float32) * (1.0 - weight) + fill * weight
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)


def _telea(rgb_u8: np.ndarray, hole_u8: np.ndarray) -> np.ndarray:
    import cv2

    return cv2.inpaint(rgb_u8, hole_u8, 5, cv2.INPAINT_TELEA)


def fill_background(rgb_u8: np.ndarray, hole: np.ndarray) -> tuple[np.ndarray | None, str]:
    """把 hole 区域补成完整背景：本地 LaMa 优先，模型不可用时 cv2.inpaint(Telea) 兜底。

    返回 (补好的 RGB, warning)；warning 为空表示用的是 LaMa。补不了时返回 (None, 原因)，
    让调用方保留「透明洞」的老行为——补背景只是增强，任何异常都不能冒到 split 外层。
    """
    fallback_reason = ""
    try:
        rgb = np.ascontiguousarray(rgb_u8, dtype=np.uint8)
        hole_mask = np.ascontiguousarray(hole, dtype=bool)
        if not hole_mask.any():
            return rgb, ""
        import cv2

        # 外扩 3px：主体 alpha 的半透明边也要从背景里抹掉，否则留一圈主体颜色的鬼影
        kernel = np.ones((7, 7), np.uint8)
        hole_u8 = cv2.dilate(hole_mask.astype(np.uint8), kernel) * 255
        session, reason = _session()
        if session is None:
            fallback_reason = "本地 LaMa 补背景模型不可用（%s），已用 OpenCV Telea 兜底" % reason
            return _composite(rgb, _telea(rgb, hole_u8).astype(np.float32), hole_u8), fallback_reason
        try:
            fill = _infer(session, rgb, hole_u8 > 0) * 255.0
        except Exception as exc:  # noqa: BLE001 - 推理失败同样退 Telea
            fallback_reason = "本地 LaMa 补背景推理失败（%s），已用 OpenCV Telea 兜底" % str(exc)[:120]
            return _composite(rgb, _telea(rgb, hole_u8).astype(np.float32), hole_u8), fallback_reason
        return _composite(rgb, fill, hole_u8), ""
    except Exception as exc:  # noqa: BLE001
        return None, "补背景异常（%s），背景保持原样" % str(exc)[:160]
