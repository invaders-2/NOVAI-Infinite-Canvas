from __future__ import annotations

import os
import threading

import numpy as np

from . import config
from .image_io import LoadedImage

MODEL_FILENAME = "rmbg_2.0.onnx"
INFER_SIZE = 1024
# RMBG 官方预处理：ImageNet 归一化；模型输出已内置 sigmoid，不用再过一次
_MEAN = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)
_STD = np.asarray([0.229, 0.224, 0.225], dtype=np.float32)

_SESSION = None
_SESSION_ATTEMPTED = False
_LOAD_REASON = ""
_SESSION_LOCK = threading.Lock()
_INFER_LOCK = threading.Lock()


def _model_path() -> tuple[str | None, str]:
    """模型读取路径：<data_root>/assets/models 优先，其次安装目录内置的那份。

    与 main.py 的 _models_path() 同规则（安装目录可能只读，用户数据目录才是下载落点）；
    frozen 安装版下 config.repo_root() 是安装目录，data_root 由 NOVAI_DATA_DIR 决定。
    """
    override = (os.environ.get("SPLIT_MATTING_MODEL") or "").strip()
    if override:
        if os.path.isfile(override):
            return override, ""
        return None, "抠图模型文件不存在（%s）" % override
    primary = config.data_root() / "assets" / "models" / MODEL_FILENAME
    if primary.is_file():
        return str(primary), ""
    fallback = config.repo_root() / "assets" / "models" / MODEL_FILENAME
    if fallback.is_file():
        return str(fallback), ""
    return None, "本地抠图模型未下载（找不到 %s）" % primary


def _session() -> tuple[object | None, str]:
    """onnxruntime 会话（懒加载单例）。模型/组件缺失只记原因，不抛异常。"""
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
            _LOAD_REASON = "抠图模型加载失败（%s）" % str(exc)[:120]
            return None, _LOAD_REASON
        _LOAD_REASON = ""
        return _SESSION, ""


def _infer_mask(session, work_w: int, work_h: int, work) -> np.ndarray:
    resized = work.resize((INFER_SIZE, INFER_SIZE))
    tensor = np.asarray(resized, dtype=np.float32) / 255.0
    tensor = (tensor - _MEAN) / _STD
    tensor = tensor.transpose(2, 0, 1)[None]
    with _INFER_LOCK:
        output = session.run(None, {session.get_inputs()[0].name: tensor})[-1]
    mask = np.clip(np.asarray(output[0, 0], dtype=np.float32), 0.0, 1.0)
    import cv2

    return cv2.resize(mask, (work_w, work_h), interpolation=cv2.INTER_LINEAR)


def foreground_rgba(loaded: LoadedImage) -> tuple[np.ndarray | None, str]:
    """整幅 work 尺寸的前景 RGBA（一次推理 + 边缘精修），供本次拆分的所有主体层复用。

    失败返回 (None, 人能看懂的原因)：拆分是主流程，抠图只是增强，任何异常都不能冒到接口层。
    """
    try:
        return _foreground_rgba(loaded)
    except Exception as exc:  # noqa: BLE001
        return None, "抠图推理异常（%s）" % str(exc)[:160]


def _foreground_rgba(loaded: LoadedImage) -> tuple[np.ndarray | None, str]:
    session, reason = _session()
    if session is None:
        return None, reason
    work = loaded.work.convert("RGB")
    work_w, work_h = work.size
    coarse = _infer_mask(session, work_w, work_h, work)
    from server import matting_refine

    rgba = matting_refine.mask_to_rgba(np.array(work), coarse)
    return rgba, ""
