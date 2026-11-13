from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from functools import lru_cache
from pathlib import Path

from PIL import Image

TIMEOUT = 45
PRIMARY_PSM = 11
WORD_MIN_CONF = 40.0
EXTRA_LINE_MIN_CONF = 70.0
PRIMARY_MAX_SIDE = 900
EXTRA_PSMS = (6, 3)


@lru_cache(maxsize=1)
def available_langs() -> tuple[str, ...]:
    binary = shutil.which("tesseract")
    if not binary:
        return ()
    try:
        proc = subprocess.run(
            [binary, "--list-langs"], capture_output=True, text=True, timeout=15
        )
    except (OSError, subprocess.SubprocessError):
        return ()
    if proc.returncode != 0:
        return ()
    lines = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
    return tuple(line for line in lines if not line.lower().startswith("list of"))


@lru_cache(maxsize=1)
def pick_lang() -> str | None:
    langs = set(available_langs())
    has_cn = "chi_sim" in langs
    has_en = "eng" in langs
    if has_cn and has_en:
        return "chi_sim+eng"
    if has_cn:
        return "chi_sim"
    if has_en:
        return "eng"
    return None


def is_available() -> bool:
    return shutil.which("tesseract") is not None and pick_lang() is not None


def _extra_psm_modes() -> list[int]:
    raw = os.environ.get("SPLIT_OCR_EXTRA_PSM")
    if raw is None:
        raw = "6,3"
    modes: list[int] = []
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        try:
            value = int(chunk)
        except ValueError:
            continue
        if value in {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13} and value != PRIMARY_PSM:
            modes.append(value)
    return modes


def _run_pass(
    binary: str, source: Path, lang: str, psm: int, inv_scale: float
) -> tuple[list[dict], str | None]:
    cmd = [binary, str(source), "stdout", "-l", lang, "--psm", str(psm), "tsv"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        return [], f"tesseract psm {psm} 超时（>{TIMEOUT}s）"
    except OSError as exc:
        return [], f"tesseract 调用失败: {exc}"
    if proc.returncode != 0:
        detail = (proc.stderr or "").strip().splitlines()
        reason = detail[-1] if detail else f"exit {proc.returncode}"
        return [], f"tesseract psm {psm} 失败（{reason}）"

    words: list[dict] = []
    for row in proc.stdout.splitlines()[1:]:
        parts = row.split("\t")
        if len(parts) < 12 or parts[0] != "5":
            continue
        text = "\t".join(parts[11:]).strip()
        if not text:
            continue
        try:
            conf = float(parts[10])
            x, y, w, h = (int(parts[index]) for index in (6, 7, 8, 9))
        except ValueError:
            continue
        if inv_scale != 1.0:
            x = int(round(x * inv_scale))
            y = int(round(y * inv_scale))
            w = int(round(w * inv_scale))
            h = int(round(h * inv_scale))
        if conf < WORD_MIN_CONF or h < 8 or w < 3:
            continue
        words.append({"text": text, "x": x, "y": y, "w": w, "h": h, "conf": conf})
    return words, None


def ocr_passes(image: Image.Image) -> tuple[list[dict], list[str]]:
    binary = shutil.which("tesseract")
    if not binary:
        return [], ["未检测到 tesseract，已跳过文字层"]
    lang = pick_lang()
    if not lang:
        return [], ["tesseract 缺少 chi_sim/eng 语言包，已跳过文字层"]

    image = image.convert("RGB")
    long_side = max(image.size)
    primary_scale = min(1.0, PRIMARY_MAX_SIDE / long_side) if long_side > 0 else 1.0
    primary_image = image
    if primary_scale < 1.0:
        primary_image = image.resize(
            (max(1, round(image.width * primary_scale)), max(1, round(image.height * primary_scale))),
            Image.LANCZOS,
        )

    passes: list[dict] = []
    warnings: list[str] = []
    with tempfile.TemporaryDirectory(prefix="novai-ocr-") as tmp:
        primary_source = Path(tmp) / "primary.png"
        primary_image.save(primary_source, format="PNG")
        primary, error = _run_pass(binary, primary_source, lang, PRIMARY_PSM, 1.0 / primary_scale)
        if error:
            return [], [error + "，已跳过文字层"]
        passes.append({"psm": PRIMARY_PSM, "words": primary, "minLineConf": 0.0})

        extra_modes = [psm for psm in _extra_psm_modes() if psm in EXTRA_PSMS]
        if extra_modes:
            extra_source = Path(tmp) / "extra.png"
            image.save(extra_source, format="PNG")
            for psm in extra_modes:
                words, extra_error = _run_pass(binary, extra_source, lang, psm, 1.0)
                if extra_error:
                    warnings.append(extra_error + "（补充识别已跳过）")
                    continue
                if words:
                    passes.append(
                        {"psm": psm, "words": words, "minLineConf": EXTRA_LINE_MIN_CONF}
                    )
    return passes, warnings
