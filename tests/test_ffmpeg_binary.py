"""ffmpeg_binary() / ffprobe_binary() 解析优先级：环境变量 → 安装包内置 → PATH。

Windows 安装包把 ffmpeg/ffprobe 放在 resources/bin/win，Electron 主进程通过
FFMPEG_PATH/FFPROBE_PATH 传给后端；macOS/Linux 没有内置二进制，必须能回退到 PATH。
这里不执行 ffmpeg，只验证路径选择。
"""
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

_ENV_KEYS = ("FFMPEG_PATH", "FFPROBE_PATH")


def _make_executable(directory, name):
    path = os.path.join(str(directory), name)
    Path(path).write_bytes(b"\x00stub")
    os.chmod(path, stat.S_IRWXU)
    return path


class FfmpegBinaryTests(unittest.TestCase):
    def setUp(self):
        self._saved_env = {key: os.environ.get(key) for key in _ENV_KEYS}
        for key in _ENV_KEYS:
            os.environ.pop(key, None)
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmpdir = Path(self._tmp.name)

    def tearDown(self):
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _patch_resolution(self, bundled_dirs=(), which_map=None):
        dirs_patcher = mock.patch.object(main, "_bundled_ffmpeg_dirs", return_value=list(bundled_dirs))
        dirs_patcher.start()
        self.addCleanup(dirs_patcher.stop)
        which_map = dict(which_map or {})
        which_patcher = mock.patch.object(main.shutil, "which", side_effect=lambda name: which_map.get(name))
        which_patcher.start()
        self.addCleanup(which_patcher.stop)

    def _bundled_dir(self, name):
        directory = self.tmpdir / "pkg" / "bin" / "win"
        directory.mkdir(parents=True, exist_ok=True)
        exe_name = name + (".exe" if os.name == "nt" else "")
        return _make_executable(directory, exe_name)

    def test_env_wins_over_bundled_and_path(self):
        env_ffmpeg = _make_executable(self.tmpdir, "env-ffmpeg")
        bundled = self._bundled_dir("ffmpeg")
        os.environ["FFMPEG_PATH"] = env_ffmpeg
        self._patch_resolution([os.path.dirname(bundled)], {"ffmpeg": "/usr/bin/ffmpeg"})
        self.assertEqual(main.ffmpeg_binary(), env_ffmpeg)

    def test_env_missing_file_falls_back_to_bundled(self):
        bundled = self._bundled_dir("ffmpeg")
        os.environ["FFMPEG_PATH"] = str(self.tmpdir / "not-here" / "ffmpeg.exe")
        self._patch_resolution([os.path.dirname(bundled)], {"ffmpeg": "/usr/bin/ffmpeg"})
        self.assertEqual(main.ffmpeg_binary(), bundled)

    def test_env_directory_is_skipped(self):
        bundled = self._bundled_dir("ffmpeg")
        os.environ["FFMPEG_PATH"] = str(self.tmpdir)
        self._patch_resolution([os.path.dirname(bundled)], {})
        self.assertEqual(main.ffmpeg_binary(), bundled)

    @unittest.skipIf(os.name == "nt", "Windows 不检查可执行位")
    def test_env_non_executable_file_is_skipped(self):
        plain = self.tmpdir / "ffmpeg"
        plain.write_bytes(b"not executable")
        os.chmod(plain, 0o644)
        os.environ["FFMPEG_PATH"] = str(plain)
        bundled = self._bundled_dir("ffmpeg")
        self._patch_resolution([os.path.dirname(bundled)], {"ffmpeg": "/usr/bin/ffmpeg"})
        self.assertEqual(main.ffmpeg_binary(), bundled)

    def test_bundled_wins_over_path(self):
        bundled = self._bundled_dir("ffmpeg")
        self._patch_resolution([os.path.dirname(bundled)], {"ffmpeg": "/usr/bin/ffmpeg"})
        self.assertEqual(main.ffmpeg_binary(), bundled)

    def test_path_is_last_resort(self):
        self._patch_resolution([str(self.tmpdir / "missing")], {"ffmpeg": "/usr/bin/ffmpeg"})
        self.assertEqual(main.ffmpeg_binary(), "/usr/bin/ffmpeg")

    def test_nothing_found_returns_none(self):
        self._patch_resolution([str(self.tmpdir / "missing")], {})
        self.assertIsNone(main.ffmpeg_binary())

    def test_ffprobe_uses_its_own_env_var(self):
        env_ffmpeg = _make_executable(self.tmpdir, "env-ffmpeg")
        env_ffprobe = _make_executable(self.tmpdir, "env-ffprobe")
        os.environ["FFMPEG_PATH"] = env_ffmpeg
        os.environ["FFPROBE_PATH"] = env_ffprobe
        self._patch_resolution([], {"ffprobe": "/usr/bin/ffprobe", "ffmpeg": "/usr/bin/ffmpeg"})
        self.assertEqual(main.ffmpeg_binary(), env_ffmpeg)
        self.assertEqual(main.ffprobe_binary(), env_ffprobe)

    def test_bundled_dirs_follow_install_layout(self):
        root = self.tmpdir / "NOVAI"
        backend = root / "resources" / "backend"
        backend.mkdir(parents=True)
        with mock.patch.object(sys, "executable", str(backend / "NOVAI.exe")), \
                mock.patch.dict(os.environ, {
                    "NOVAI_INSTALL_DIR": str(root),
                    "NOVAI_APP_DIR": str(backend),
                }, clear=False):
            dirs = [os.path.normpath(d) for d in main._bundled_ffmpeg_dirs()]
        from_backend = os.path.normpath(os.path.join(str(backend), "..", "bin", "win"))
        install_bin = os.path.normpath(os.path.join(str(root), "bin", "win"))
        install_resources_bin = os.path.normpath(os.path.join(str(root), "resources", "bin", "win"))
        self.assertIn(from_backend, dirs, "PyInstaller 后端旁的 resources/bin/win 必须被查")
        self.assertIn(install_bin, dirs, "NOVAI_INSTALL_DIR/bin/win 必须被查")
        self.assertIn(install_resources_bin, dirs, "NOVAI_INSTALL_DIR/resources/bin/win 必须被查")
        self.assertLess(dirs.index(from_backend), dirs.index(install_bin), "后端旁目录优先于安装根目录")


if __name__ == "__main__":
    unittest.main()
