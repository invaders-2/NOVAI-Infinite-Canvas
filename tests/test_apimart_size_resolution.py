"""APIMart 生图档位：官方 size × resolution → 实际像素映射表（纯函数，不真实调用上游）。

官方口径（https://docs.apimart.ai/en/api-reference/images/gpt-image-2/generation）：
  * size 支持 15 个比例（或直接传像素），resolution 单独给 1k / 2k / 4k，
    两者共同决定实际出图像素；像素不是从尺寸阈值反推出来的。

覆盖：
  1. 官方映射表逐比例/档位精确还原（含同档位多组等价像素）；
  2. 前端预览像素（gpt-image-2 bounds 收敛后）还原成同一档位，不再被长边/像素阈值抬高或压低；
  3. 非像素入参（1k/2k/4k、比例串、auto）行为不变；
  4. apimart_legacy_size_resolution 仍保留：它是 APIMart 官方表之外的像素兜底；
     Gemini 直连已改为官方 14 比例口径，见 tests/test_platform_size_official.py。
"""
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class ApimartOfficialSizeResolutionTests(unittest.TestCase):

    def test_official_table_round_trip(self):
        # 官方表列出的每个像素都必须还原成同一个 (比例, 档位)
        for ratio, tiers in main.APIMART_OFFICIAL_PIXELS.items():
            for level in main.APIMART_RESOLUTION_LEVELS:
                for width, height in tiers.get(level, ()):
                    if (width, height) in self.AMBIGUOUS:
                        continue
                    self.assertEqual(main.apimart_size_resolution("%dx%d" % (width, height)),
                                     (ratio, level), "%dx%d" % (width, height))

    # 官方 1:2 与 1:3 的 1k 行都写了 887×1774（文档重复），它的真实比例是 1:2；
    # 归到 1:2 并在报告里记录这处官方文档歧义。
    AMBIGUOUS = {(887, 1774)}

    def test_official_duplicate_pixel_follows_real_ratio(self):
        self.assertEqual(main.apimart_size_resolution("887x1774"), ("1:2", "1k"))
        self.assertEqual(main.apimart_size_resolution("512x1536"), ("1:3", "1k"))

    def test_threshold_mistiers_are_fixed_for_official_pixels(self):
        # 旧的「长边≥3000 或 像素>450万 → 4k / 长边≥1800 → 2k」会把下面这些官方像素算错档
        cases = {
            "2560x2048": ("5:4", "2k"),    # 旧：像素 524 万 > 450 万 → 4k
            "2048x2560": ("4:5", "2k"),
            "3072x1024": ("3:1", "2k"),    # 旧：长边 3072 ≥ 3000 → 4k
            "1024x3072": ("1:3", "2k"),
            "2016x864": ("21:9", "1k"),    # 旧：长边 2016 ≥ 1800 → 2k
            "864x2016": ("9:21", "1k"),
        }
        for size, expected in cases.items():
            self.assertEqual(main.apimart_size_resolution(size), expected, size)

    def test_legacy_pixels_keep_their_tier(self):
        # 官方表之外的像素走旧阈值兜底，也必须回落到用户选的那个档位
        cases = {
            "1024x1024": ("1:1", "1k"),
            "2048x2048": ("1:1", "2k"),
            "2880x2880": ("1:1", "4k"),
            "3840x2160": ("16:9", "4k"),
            "3840x1648": ("21:9", "4k"),
            "2048x880": ("21:9", "2k"),
            "880x2048": ("9:21", "2k"),
            "2048x1632": ("5:4", "2k"),
            "3216x2576": ("5:4", "4k"),
        }
        for size, expected in cases.items():
            self.assertEqual(main.apimart_size_resolution(size), expected, size)

    # 画布预置比例 key → 官方比例（与前端 API_RATIO_LABELS / apiRatioText 同源）
    # 依据：批 6a 按 APIMart 官方映射表（main.APIMART_OFFICIAL_PIXELS）把比例从 13 键补到 15 键，
    # 新增 3:1 / 1:3；两套画布 SIZE_MAP 与 main._AGENT_SMART_SIZE_MAP 同一批次补齐。
    KEY_TO_RATIO = {
        "square": "1:1", "portrait": "2:3", "portrait43": "3:4", "landscape43": "4:3",
        "landscape": "3:2", "story": "9:16", "wide": "16:9", "ultrawide": "21:9",
        "ultratall": "9:21", "portrait12": "1:2", "landscape21": "2:1",
        "landscape54": "5:4", "portrait45": "4:5",
        "landscape31": "3:1", "portrait13": "1:3",
    }

    @staticmethod
    def _frontend_size_map(filename):
        """从 static/js/<filename> 抠出 SIZE_MAP（比例档 × 分辨率档 → 像素尺寸）。"""
        root = Path(main.__file__).resolve().parent
        source = (root / "static" / "js" / filename).read_text(encoding="utf-8")
        block = re.search(r"const SIZE_MAP = \{[\s\S]*?\n\};", source)
        assert block, filename + " 缺少 SIZE_MAP"
        result = {}
        for key, body in re.findall(r"(\w+)\s*:\s*\{([^}]*)\}", block.group(0)):
            result[key] = dict(re.findall(r"'([^']+)'\s*:\s*'([^']+)'", body))
        return result

    @staticmethod
    def _official_aligned_cell(ratio, level):
        """官方同档位可能给多组像素；取第一个 16 对齐的那组（前端 SIZE_MAP 的取值口径）。

        依据官方映射表 main.APIMART_OFFICIAL_PIXELS：3:1 的 1k 官方先列 (1881,836)（836 非
        16 对齐），再列 16 对齐的 (1536,512)；1:3 的 1k 先列 (887,1774)（非 16 对齐），
        再列 16 对齐的 (512,1536)。这两行是官方补键批次里唯一不在首位的 16 对齐组，
        所以按 16 对齐筛选而不是盲取 [0]，否则会把非对齐的官方行当成期望值。
        """
        for width, height in main.APIMART_OFFICIAL_PIXELS[ratio][level]:
            if width % 16 == 0 and height % 16 == 0:
                return (width, height)
        raise AssertionError("官方表 %s@%s 没有 16 对齐像素" % (ratio, level))

    def test_frontend_size_map_matches_official_cells(self):
        # 阶段 B 收尾：两套画布 SIZE_MAP 的每个预置比例 × 档位都必须精确等于官方映射值
        # （同格多组像素时取第一个 16 对齐的官方组），并由后端还原成同一 (比例, 档位)。
        # 依据：canvas.js 9 个预置比例；smart-canvas.js 15 个（批 6a 补 landscape31 / portrait13）。
        seen = 0
        for filename in ("canvas.js", "smart-canvas.js"):
            for key, tiers in self._frontend_size_map(filename).items():
                ratio = self.KEY_TO_RATIO[key]
                for level in main.APIMART_RESOLUTION_LEVELS:
                    size = tiers[level]
                    self.assertEqual(main.apimart_size_resolution(size), (ratio, level),
                                     "%s %s@%s = %s" % (filename, key, level, size))
                    width, height = (int(part) for part in size.split("x"))
                    self.assertEqual((width, height), self._official_aligned_cell(ratio, level),
                                     "%s %s@%s = %s 必须是官方 16 对齐像素" % (filename, key, level, size))
                    seen += 1
        self.assertEqual(seen, (9 + 15) * 3)

    def test_aligned_presets_no_longer_fall_into_wrong_cell(self):
        # 2:1 / 1:2 的 2K 不再落 1K 单元格；5:4 / 4:5 的 1K 与官方一致，不再被旧阈值算成 2K。
        self.assertEqual(main.apimart_size_resolution("2688x1344"), ("2:1", "2k"))
        self.assertEqual(main.apimart_size_resolution("1344x2688"), ("1:2", "2k"))
        self.assertEqual(main.apimart_size_resolution("1280x1024"), ("5:4", "1k"))
        self.assertEqual(main.apimart_size_resolution("1024x1280"), ("4:5", "1k"))

    def test_non_pixel_inputs_unchanged(self):
        self.assertEqual(main.apimart_size_resolution("1k"), ("1:1", "1k"))
        self.assertEqual(main.apimart_size_resolution("2k"), ("1:1", "2k"))
        self.assertEqual(main.apimart_size_resolution("4K"), ("1:1", "4k"))
        self.assertEqual(main.apimart_size_resolution("auto"), ("auto", "1k"))
        self.assertEqual(main.apimart_size_resolution("21:9"), ("21:9", "1k"))
        self.assertEqual(main.apimart_size_resolution(""), ("1:1", "1k"))

    def test_gemini_legacy_mapping_is_unchanged(self):
        # 旧阈值函数仍在（APIMart 官方映射表之外才用）：5:4@2K 像素按阈值算 4k、21:9@1K 算 2k
        self.assertEqual(main.apimart_legacy_size_resolution("2560x2048"), ("5:4", "4k"))
        self.assertEqual(main.apimart_legacy_size_resolution("2016x864"), ("21:9", "2k"))

    def test_dispatch_sends_ratio_and_tier(self):
        # APIMart 请求体真正下发的是「比例 + 档位」，档位来自本函数的映射
        source = Path(main.__file__).read_text(encoding="utf-8")
        self.assertIn("apimart_size, resolution = apimart_size_resolution(size)", source)
        self.assertIn('"size": apimart_size', source)
        self.assertIn('"resolution": resolution', source)


if __name__ == "__main__":
    unittest.main()
