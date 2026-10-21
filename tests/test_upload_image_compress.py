"""后端 /api/ai/upload 大图压缩：>50MB 的图片先压到 50MB 以内再存，压不下去才 413。

不联网、不起服务：直接调 main.compress_oversized_image。真实 HTTP 大图上传的验证
（57.3MB PNG → 200/落盘可打开；205MB → 413）是手动跑的，不放在这里的。
"""
import sys
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


def encode(image):
    import io
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def noise_rgb(width, height, seed=1):
    rng = np.random.default_rng(seed)
    return Image.fromarray(rng.integers(0, 256, size=(height, width, 3), dtype=np.uint8), "RGB")


def gradient_rgba(width, height):
    rows = np.linspace(0, 255, height, dtype=np.uint8)[:, None]
    cols = np.linspace(0, 255, width, dtype=np.uint8)[None, :]
    alpha = np.clip(rows.astype(np.int16) + 40, 0, 255).astype(np.uint8)
    alpha = np.repeat(alpha, width, axis=1)
    rgb = np.stack([np.repeat(cols, height, axis=0), np.repeat(rows, width, axis=1),
                    ((cols + rows) // 2).astype(np.uint8)], axis=-1)
    arr = np.dstack([rgb, alpha])
    return Image.fromarray(arr, "RGBA")


class UploadImageCompressTests(unittest.TestCase):
    def test_no_alpha_goes_jpeg_and_keeps_dimensions(self):
        source = encode(noise_rgb(1600, 1200))
        target = max(1024 * 1024, len(source) // 2)
        data, ext, info = main.compress_oversized_image(source, ".png", target)
        self.assertEqual(ext, ".jpg")
        self.assertEqual(info["format"], "JPEG")
        self.assertEqual(info["from_size"], (1600, 1200))
        self.assertEqual(info["to_size"], (1600, 1200), "优先保尺寸，不缩")
        self.assertLessEqual(len(data), target)
        with Image.open(__import__("io").BytesIO(data)) as out:
            self.assertEqual(out.format, "JPEG")
            self.assertEqual(out.size, (1600, 1200))

    def test_alpha_stays_png_when_it_fits(self):
        source = encode(gradient_rgba(400, 300))
        data, ext, info = main.compress_oversized_image(source, ".png", 10 * 1024 * 1024)
        self.assertEqual(ext, ".png", "有透明通道优先 PNG，不能丢透明")
        self.assertEqual(info["format"], "PNG")
        with Image.open(__import__("io").BytesIO(data)) as out:
            self.assertEqual(out.mode, "RGBA")

    def test_shrinks_when_quality_alone_is_not_enough(self):
        # 3000x2000 噪声 PNG ≈17MB，JPEG q92 保尺寸 ≈5MB；目标 3MB 逼它缩到最长边 2048
        source = encode(noise_rgb(3000, 2000))
        target = 3 * 1024 * 1024
        data, ext, info = main.compress_oversized_image(source, ".png", target)
        self.assertEqual(ext, ".jpg")
        self.assertLessEqual(len(data), target)
        self.assertLess(max(info["to_size"]), 3000, "需要缩最长边才能达标")

    def test_unreachable_target_returns_413_with_real_sizes(self):
        source = encode(noise_rgb(600, 600))
        with self.assertRaises(main.HTTPException) as caught:
            main.compress_oversized_image(source, ".png", 1024)
        self.assertEqual(caught.exception.status_code, 413)
        detail = str(caught.exception.detail)
        self.assertIn("压缩后仍有", detail)
        self.assertIn("仍超过单文件", detail)
        self.assertIn("建议长边不超过 6144 像素", detail)

    def test_broken_image_bytes_return_413(self):
        with self.assertRaises(main.HTTPException) as caught:
            main.compress_oversized_image(b"not-an-image", ".png", 50 * 1024 * 1024)
        self.assertEqual(caught.exception.status_code, 413)
        self.assertIn("图片压缩失败", str(caught.exception.detail))


if __name__ == "__main__":
    unittest.main()
