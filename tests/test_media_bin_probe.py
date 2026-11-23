"""ffprobe 定位：Windows 安装包里那份叫 ffprobe.exe，必须能被找到。

根因回归：`depth_capture.probe()` 原来直接拼 `os.path.join(dirname(ffmpeg), "ffprobe")`，
而 Windows 内置二进制叫 `ffprobe.exe`——拼出来的路径不存在；安装版又不往 PATH 里加 bin，
`shutil.which("ffprobe")` 同样落空，于是 probe() 返回 {}，用户看到「读不到源视频分辨率，无法处理」。
macOS/Linux 的内置二进制没有 .exe，所以那边一直没暴露。

这里不执行 ffmpeg（除了端到端那条用真实 ffprobe 读一个真 mp4），只验证路径选择与探测结果。
"""
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.split_engine import depth_capture, media_bin, video_audio  # noqa: E402

STUB = b"\x00stub"


def _write_stub(directory, name):
    path = os.path.join(str(directory), name)
    Path(path).write_bytes(STUB)
    os.chmod(path, stat.S_IRWXU)
    return path


def _copy_real_binary(name, directory, new_name):
    """复制机器上真实的 ffprobe/ffmpeg 并改名：Windows 布局的端到端用例要能真的跑起来。"""
    found = shutil.which(name)
    if not found:
        return ""
    path = os.path.join(str(directory), new_name)
    shutil.copyfile(found, path)
    os.chmod(path, stat.S_IRWXU)
    return path


class _TempDirTest(unittest.TestCase):
    def setUp(self):
        self._saved_probe_env = os.environ.pop("FFPROBE_PATH", None)
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmpdir = Path(self._tmp.name)

    def tearDown(self):
        os.environ.pop("FFPROBE_PATH", None)
        if self._saved_probe_env is not None:
            os.environ["FFPROBE_PATH"] = self._saved_probe_env

    def layout(self, name):
        directory = self.tmpdir / name
        directory.mkdir(parents=True, exist_ok=True)
        return directory


class FfprobePathTests(_TempDirTest):
    def test_windows_layout_finds_exe_variant_and_legacy_lookup_fails(self):
        """Windows 布局：只有 ffprobe.exe。新工具找得到；旧写法（找无后缀 ffprobe）找不到。"""
        win = self.layout("win")
        ffprobe_exe = _write_stub(win, "ffprobe.exe")
        fake_ffmpeg = _write_stub(win, "ffmpeg.exe")
        with mock.patch.object(media_bin.shutil, "which", return_value=None):
            self.assertEqual(media_bin.ffprobe_path(fake_ffmpeg), ffprobe_exe)
            # 旧写法（2.0.10 及之前 probe()/_ffprobe() 里的那两行）：直接拼无后缀名字
            legacy = os.path.join(os.path.dirname(fake_ffmpeg), "ffprobe")
            if not os.path.isfile(legacy):
                legacy = media_bin.shutil.which("ffprobe") or ""
            self.assertEqual(legacy, "", "旧写法在 Windows 布局下必然落空——这就是「读不到分辨率」的根因")

    def test_unix_layout_still_finds_bare_name(self):
        unix = self.layout("unix")
        bare = _write_stub(unix, "ffprobe")
        fake_ffmpeg = _write_stub(unix, "ffmpeg")
        with mock.patch.object(media_bin.shutil, "which", return_value=None):
            self.assertEqual(media_bin.ffprobe_path(fake_ffmpeg), bare)

    def test_exe_name_on_path_is_tried_after_bare_name(self):
        """PATH 回退也按 .exe 变体找：ffmpeg 是 .exe 时先 ffprobe.exe，再 ffprobe。"""
        win = self.layout("win-path")
        fake_ffmpeg = _write_stub(win, "ffmpeg.exe")
        asked = []

        def fake_which(name):
            asked.append(name)
            return None

        with mock.patch.object(media_bin.shutil, "which", side_effect=fake_which):
            self.assertEqual(media_bin.ffprobe_path(fake_ffmpeg), "")
        self.assertEqual(asked, ["ffprobe.exe", "ffprobe"])

    def test_env_var_wins(self):
        win = self.layout("win-env")
        _write_stub(win, "ffprobe.exe")
        fake_ffmpeg = _write_stub(win, "ffmpeg.exe")
        elsewhere = self.layout("elsewhere")
        env_probe = _write_stub(elsewhere, "ffprobe")
        os.environ["FFPROBE_PATH"] = env_probe
        self.assertEqual(media_bin.ffprobe_path(fake_ffmpeg), env_probe)

    def test_missing_env_path_is_ignored(self):
        win = self.layout("win-missing-env")
        ffprobe_exe = _write_stub(win, "ffprobe.exe")
        fake_ffmpeg = _write_stub(win, "ffmpeg.exe")
        os.environ["FFPROBE_PATH"] = str(self.tmpdir / "not-here" / "ffprobe.exe")
        self.assertEqual(media_bin.ffprobe_path(fake_ffmpeg), ffprobe_exe)

    def test_nothing_found_returns_empty_string(self):
        empty = self.layout("empty")
        with mock.patch.object(media_bin.shutil, "which", return_value=None):
            self.assertEqual(media_bin.ffprobe_path(str(empty / "ffmpeg.exe")), "")
        with mock.patch.object(media_bin.shutil, "which", return_value=None):
            self.assertEqual(media_bin.ffprobe_path(""), "")

    def test_video_audio_probe_uses_the_same_resolution(self):
        """音轨探测（video_audio._ffprobe）同一处 bug：Windows 上拿不到音轨信息。"""
        win = self.layout("win-audio")
        ffprobe_exe = _write_stub(win, "ffprobe.exe")
        fake_ffmpeg = _write_stub(win, "ffmpeg.exe")
        with mock.patch.object(media_bin.shutil, "which", return_value=None):
            self.assertEqual(video_audio._ffprobe(fake_ffmpeg), ffprobe_exe)
            self.assertEqual(depth_capture.ffprobe_path(fake_ffmpeg), ffprobe_exe)


class DepthCaptureProbeTests(_TempDirTest):
    """端到端：ffmpeg 路径以 .exe 结尾 + 同目录只有 ffprobe.exe 时，probe() 必须读到宽高。"""

    @classmethod
    def setUpClass(cls):
        cls.ffmpeg = shutil.which("ffmpeg") or ""
        cls.ffprobe = shutil.which("ffprobe") or ""
        cls._clip = tempfile.TemporaryDirectory()
        cls.clip = os.path.join(cls._clip.name, "clip.mp4")
        if cls.ffmpeg:
            subprocess.run(
                [cls.ffmpeg, "-nostdin", "-loglevel", "error", "-y",
                 "-f", "lavfi", "-i", "testsrc=size=64x48:rate=5", "-t", "1",
                 "-pix_fmt", "yuv420p", cls.clip],
                check=True, capture_output=True,
            )

    @classmethod
    def tearDownClass(cls):
        cls._clip.cleanup()

    def setUp(self):
        super().setUp()
        if not self.ffmpeg or not self.ffprobe or not os.path.isfile(self.clip):
            self.skipTest("本机没有 ffmpeg/ffprobe，跳过真实探测用例")

    def test_probe_reads_size_in_windows_layout(self):
        win = self.layout("win-e2e")
        ffprobe_exe = _copy_real_binary("ffprobe", win, "ffprobe.exe")
        fake_ffmpeg = _write_stub(win, "ffmpeg.exe")
        # PATH 里找不到 ffprobe：只能靠「ffmpeg 同目录 + .exe 变体」这条路
        with mock.patch.object(media_bin.shutil, "which", return_value=None):
            info = depth_capture.probe(fake_ffmpeg, self.clip)
        self.assertEqual((info.get("width"), info.get("height")), (64, 48), info)
        self.assertEqual(info.get("fps"), 5.0, info)
        self.assertGreater(info.get("duration") or 0, 0.0, info)
        self.assertEqual(media_bin.ffprobe_path(fake_ffmpeg), ffprobe_exe)

    def test_probe_without_resolvable_ffprobe_is_the_reported_symptom(self):
        """探测拿不到 ffprobe 时 probe() 返回 {}，上层就看到「读不到源视频分辨率」。"""
        win = self.layout("win-e2e-broken")
        fake_ffmpeg = _write_stub(win, "ffmpeg.exe")
        with mock.patch.object(depth_capture, "ffprobe_path", return_value=""), \
                mock.patch.object(media_bin.shutil, "which", return_value=None):
            self.assertEqual(depth_capture.probe(fake_ffmpeg, self.clip), {})

    def test_probe_accepts_explicit_ffprobe(self):
        """main.py 显式传 ffprobe_binary() 的那条路同样能读到宽高。"""
        win = self.layout("win-e2e-explicit")
        explicit = _copy_real_binary("ffprobe", win, "ffprobe-pro.exe")
        fake_ffmpeg = _write_stub(win, "ffmpeg.exe")
        with mock.patch.object(media_bin.shutil, "which", return_value=None):
            info = depth_capture.probe(fake_ffmpeg, self.clip, explicit)
        self.assertEqual((info.get("width"), info.get("height")), (64, 48), info)


if __name__ == "__main__":
    unittest.main()
