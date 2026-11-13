#!/usr/bin/env python3
"""tools/refresh_static_versions.py 的行为测试（不需要真实仓库副本，纯临时目录）。

覆盖：
  1) --write 后每个 /static/*.js|css|html 引用都变成 <VERSION>.<人为设定的 mtime 秒>；
  2) 同一文件多处引用写完一致；缺失文件退回裸 VERSION；非 /static/ 引用只归一化版本号；
  3) 重复 --write 幂等（第二次不改任何字节）；
  4) 默认 dry-run 不写盘；
  5) html 之间互相引用时会多轮收敛，最终值等于被引用 html 的最终 mtime。

跑法：python3 -m unittest tests.test_refresh_static_versions -v
"""
import os
import re
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE_SCRIPT = os.path.join(REPO_ROOT, "tools", "refresh_static_versions.py")
VERSION = "2.0.08"

PAGE = """<!doctype html>
<html><head>
<link rel="stylesheet" href="/static/css/b.css?v=1.0.143">
</head><body>
<script src="/static/js/a.js?v=1.0.143"></script>
<script src="/static/js/a.js?v=9.9.9"></script>
<script src="/static/js/missing.js?v=old"></script>
<script src="/custom.js?v=old"></script>
<img src="/static/img/pic.png?v=whatever">
<iframe src="/static/child.html?v=old"></iframe>
</body></html>
"""
CHILD = """<!doctype html>
<link rel="stylesheet" href="/static/css/b.css?v=old">
"""


def write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def read_text(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


class RefreshStaticVersionsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="novai-refresh-test-")
        self.root = self.tmp.name
        script_dir = os.path.join(self.root, "tools")
        os.makedirs(script_dir)
        with open(SOURCE_SCRIPT, "r", encoding="utf-8") as src:
            script_text = src.read()
        write_text(os.path.join(script_dir, "refresh_static_versions.py"), script_text)
        write_text(os.path.join(self.root, "VERSION"), VERSION + "\n")
        write_text(os.path.join(self.root, "static", "page.html"), PAGE)
        write_text(os.path.join(self.root, "static", "child.html"), CHILD)
        write_text(os.path.join(self.root, "static", "js", "a.js"), "console.log('a');\n")
        write_text(os.path.join(self.root, "static", "css", "b.css"), "body{}\n")
        write_text(os.path.join(self.root, "static", "img", "pic.png"), "not-an-image")
        self.script = os.path.join(script_dir, "refresh_static_versions.py")
        # 人为设定 mtime，避免测试依赖 checkout 时间
        self.js_mtime = 1700000000
        self.css_mtime = 1700000100
        os.utime(os.path.join(self.root, "static", "js", "a.js"), (self.js_mtime, self.js_mtime))
        os.utime(os.path.join(self.root, "static", "css", "b.css"), (self.css_mtime, self.css_mtime))

    def tearDown(self):
        self.tmp.cleanup()

    def run_script(self, *args):
        return subprocess.run(
            [sys.executable, self.script] + list(args),
            cwd=self.root,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_write_refreshes_versions_and_is_idempotent(self):
        dry = self.run_script()
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertIn("dry-run", dry.stdout)
        self.assertEqual(read_text(os.path.join(self.root, "static", "page.html")), PAGE, "dry-run 不能写盘")

        first = self.run_script("--write")
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertIn("已刷新", first.stdout)
        page = read_text(os.path.join(self.root, "static", "page.html"))

        self.assertIn('/static/js/a.js?v=2.0.08.%d' % self.js_mtime, page)
        self.assertEqual(page.count('/static/js/a.js?v=2.0.08.%d' % self.js_mtime), 2, "同一文件多处引用应写成同一串")
        self.assertIn('/static/css/b.css?v=2.0.08.%d' % self.css_mtime, page)
        self.assertIn('/static/js/missing.js?v=2.0.08"', page, "缺失文件退回裸 VERSION")
        self.assertIn('/custom.js?v=2.0.08"', page, "非 /static/ 引用只归一化版本号")
        self.assertIn('/static/img/pic.png?v=2.0.08"', page, "非 js/css/html 引用只归一化版本号")
        self.assertNotIn("1.0.143", page)

        child = read_text(os.path.join(self.root, "static", "child.html"))
        self.assertIn('/static/css/b.css?v=2.0.08.%d' % self.css_mtime, child)
        child_mtime = int(os.path.getmtime(os.path.join(self.root, "static", "child.html")))
        self.assertIn('/static/child.html?v=2.0.08.%d' % child_mtime, page, "html 互引要收敛到最终 mtime")

        before = {}
        for name in ("page.html", "child.html"):
            path = os.path.join(self.root, "static", name)
            before[name] = read_text(path)
        second = self.run_script("--write")
        self.assertEqual(second.returncode, 0, second.stderr)
        for name, text in before.items():
            self.assertEqual(read_text(os.path.join(self.root, "static", name)), text, "重复执行必须幂等")

        # 资产文件本身不能被改写
        self.assertEqual(read_text(os.path.join(self.root, "static", "js", "a.js")), "console.log('a');\n")
        self.assertEqual(int(os.path.getmtime(os.path.join(self.root, "static", "js", "a.js"))), self.js_mtime)

    def test_missing_version_file_fails(self):
        os.remove(os.path.join(self.root, "VERSION"))
        result = self.run_script("--write")
        self.assertNotEqual(result.returncode, 0, "VERSION 缺失必须非零退出")


if __name__ == "__main__":
    unittest.main(verbosity=2)
