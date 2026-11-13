#!/usr/bin/env python3
"""用真实界面抓帧，生成更新说明里的三个演示 GIF（右下角卡片 / 更新说明弹窗 / 启动动画）。

用法：
    python3 tools/make_update_demo_gifs.py [版本号] [--port 3122] [--chrome 路径]
                                          [--cdp-port 自动] [--only card|notes|splash]

产物：static/updates/<版本号>/{update-card,update-notes,splash}.gif
流程：必要时起一个独立后端（独立端口 + 独立数据目录）→ 无头 Chrome + CDP 录屏 → Pillow 逐帧自适应调色板合成 → 收尾清理。

为什么不用 chrome --screenshot：虚拟时间不推进 CSS 过渡，会拍到 opacity:0 的卡片；必须走 CDP 按真实渲染抓帧。
为什么用 Page.startScreencast 而不是反复 captureScreenshot：后者每帧要等合成器，实测只有 5~6 fps，滑入动画会卡成几帧。
为什么不共用调色板：三张图里都有渐变（卡片阴影、弹窗磨砂、启动页光晕），共用调色板会压成色带。
"""
import argparse
import base64
import io
import json
import os
import queue
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_VERSION = "2.0.07"
GIF_LIMIT = 1536 * 1024          # 单个 GIF 上限 1.5MB
DEFAULT_PORT = 3122
DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CHROME_CANDIDATES = [
    DEFAULT_CHROME,
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    os.path.expanduser("~/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
]

# capture = 抓帧视口；size = 成片尺寸（16:9）；duration = 每帧毫秒（GIF 只认 10ms 整数倍，用毫秒直接写死才不会出现"报告时长≠实际"）
# lead / tail = 相对触发事件收录的时间窗（秒）
GIFS = {
    "card": {"name": "update-card.gif", "capture": (1280, 720), "size": (1024, 576), "colors": 128, "duration": 50,
             "lead": 0.30, "tail": 1.10},
    # 说明弹窗按 1280x900 抓（列表有足够高度，最后一条不会被滚动裁掉），成片再居中裁成 16:9
    "notes": {"name": "update-notes.gif", "capture": (1280, 900), "size": (1024, 576), "colors": 160, "duration": 60,
              "lead": 0.25, "tail": 2.25},
    "splash": {"name": "splash.gif", "capture": (900, 506), "size": (800, 450), "colors": 128, "duration": 60,
               "lead": 0.15, "tail": 2.55},
}


# ───────────────────────── CDP（只用标准库，避免给发版脚本引入 ws 依赖） ─────────────────────────
class DevtoolsSocket:
    """最小 WebSocket 客户端 + 读线程：录制期间事件是持续推送的，不能只做请求-响应。"""

    def __init__(self, url, timeout=30):
        if not url.startswith("ws://"):
            raise RuntimeError("只支持 ws:// 调试地址：" + url)
        hostport, _, path = url[5:].partition("/")
        host, _, port = hostport.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            "GET /%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (path, hostport, key)
        )
        self.sock.sendall(request.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("CDP 握手被关闭")
            buf += chunk
        head, _, self.buf = buf.partition(b"\r\n\r\n")
        if b"101" not in head.split(b"\r\n")[0]:
            raise RuntimeError("CDP 握手失败：" + head[:200].decode("latin1"))
        self.next_id = 0
        self.inbox = queue.Queue()
        self.buffered = []
        self.alive = True
        self.reader = threading.Thread(target=self._reader_loop, daemon=True)
        self.reader.start()

    def _read(self, count):
        while len(self.buf) < count:
            chunk = self.sock.recv(262144)
            if not chunk:
                raise RuntimeError("CDP 连接断开")
            self.buf += chunk
        out, self.buf = self.buf[:count], self.buf[count:]
        return out

    def _send(self, opcode, payload):
        header = bytearray([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length <= 0xFFFF:
            header.append(0x80 | 126)
            header += struct.pack("!H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack("!Q", length)
        mask = os.urandom(4)
        header += mask
        self.sock.sendall(bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def _read_message(self):
        data = bytearray()
        while True:
            b0, b1 = self._read(2)
            fin, opcode = b0 & 0x80, b0 & 0x0F
            masked, length = b1 & 0x80, b1 & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read(8))[0]
            mask = self._read(4) if masked else None
            payload = self._read(length) if length else b""
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x9:
                self._send(0xA, payload)
                continue
            if opcode == 0x8:
                raise RuntimeError("CDP 连接被对端关闭")
            if opcode in (0x0, 0x1, 0x2):
                data += payload
                if fin:
                    return bytes(data)

    def _reader_loop(self):
        while self.alive:
            try:
                self.inbox.put(json.loads(self._read_message().decode()))
            except Exception:
                self.alive = False
                self.inbox.put(None)
                return

    def post(self, method, params=None):
        """只发不等（截图确认这类高频消息用它，别把事件队列堵住）。"""
        self.next_id += 1
        self._send(0x1, json.dumps({"id": self.next_id, "method": method, "params": params or {}}).encode())

    def call(self, method, params=None, timeout=120):
        self.next_id += 1
        message_id = self.next_id
        self._send(0x1, json.dumps({"id": message_id, "method": method, "params": params or {}}).encode())
        deadline = time.time() + timeout
        while True:
            remaining = max(0.01, deadline - time.time())
            try:
                message = self.inbox.get(timeout=remaining)
            except queue.Empty:
                raise RuntimeError("%s 超时（%ss）" % (method, timeout))
            if message is None:
                raise RuntimeError("CDP 连接已断开")
            if message.get("id") == message_id:
                if "error" in message:
                    raise RuntimeError("%s 失败：%s" % (method, json.dumps(message["error"], ensure_ascii=False)))
                return message.get("result", {})
            self.buffered.append(message)

    def take_event(self, timeout):
        if self.buffered:
            return self.buffered.pop(0)
        try:
            message = self.inbox.get(timeout=timeout)
        except queue.Empty:
            return None
        if message is None:
            raise RuntimeError("CDP 连接已断开")
        return message

    def close(self):
        self.alive = False
        try:
            self._send(0x8, b"")
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


def http_json(url, method="GET", timeout=10):
    request = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ───────────────────────── 进程：后端 + Chrome ─────────────────────────
class Backend:
    """优先复用已在跑的后端；没有就自己起一个独立端口 + 独立数据目录，退出时收掉。"""

    def __init__(self, port, data_dir):
        self.port = port
        self.data_dir = data_dir
        self.proc = None

    def base_url(self):
        return "http://127.0.0.1:%d" % self.port

    def start(self):
        try:
            info = http_json(self.base_url() + "/api/app-info", timeout=3)
            print("[backend] 复用已在运行的后端 %s（版本 %s）" % (self.base_url(), info.get("version")))
            return
        except Exception:
            pass
        os.makedirs(self.data_dir, exist_ok=True)
        log_path = "/tmp/novai-demo-backend.log"
        self.log = open(log_path, "wb")
        env = dict(os.environ, NOVAI_PORT=str(self.port), NOVAI_DATA_DIR=self.data_dir)
        self.proc = subprocess.Popen([sys.executable, "main.py"], cwd=ROOT, env=env,
                                     stdout=self.log, stderr=self.log)
        deadline = time.time() + 120
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError("后端启动失败，日志见 " + log_path)
            try:
                info = http_json(self.base_url() + "/api/app-info", timeout=2)
                print("[backend] 已启动 %s（版本 %s，数据目录 %s）" % (self.base_url(), info.get("version"), self.data_dir))
                return
            except Exception:
                time.sleep(0.5)
        raise RuntimeError("后端 120s 内没就绪，日志见 " + log_path)

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
            try:
                self.proc.wait(timeout=10)
            except Exception:
                pass


class Chrome:
    """一次性无头 Chrome：独立 user-data-dir / HOME，退出时杀掉并删目录。"""

    def __init__(self, binary, width=1280, height=760):
        self.binary = binary
        self.width = width
        self.height = height
        self.port = free_port()
        self.proc = None
        self.profile = tempfile.mkdtemp(prefix="novai-demo-profile-")
        self.home = tempfile.mkdtemp(prefix="novai-demo-home-")
        self.pages = []

    def start(self):
        args = [
            self.binary, "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-crash-reporter",
            "--disable-breakpad", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
            "--use-mock-keychain", "--user-data-dir=" + self.profile,
            "--window-size=%d,%d" % (self.width, self.height),
            "--remote-debugging-port=%d" % self.port, "about:blank",
        ]
        self.proc = subprocess.Popen(args, env=dict(os.environ, HOME=self.home),
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                http_json("http://127.0.0.1:%d/json/version" % self.port, timeout=2)
                return
            except Exception:
                if self.proc.poll() is not None:
                    raise RuntimeError("Chrome 启动失败：" + self.binary)
                time.sleep(0.2)
        raise RuntimeError("Chrome 60s 内没起来")

    def new_page(self):
        target = http_json("http://127.0.0.1:%d/json/new?about:blank" % self.port, method="PUT")
        page = Page(self, target)
        self.pages.append(page)
        return page

    def stop(self):
        for page in self.pages:
            page.close()
        self.pages = []
        if self.proc:
            self.proc.kill()
            try:
                self.proc.wait(timeout=10)
            except Exception:
                pass
        shutil.rmtree(self.profile, ignore_errors=True)
        shutil.rmtree(self.home, ignore_errors=True)


class Page:
    def __init__(self, chrome, target):
        self.chrome = chrome
        self.target = target
        self.ws = DevtoolsSocket(target["webSocketDebuggerUrl"])
        self.recording = False
        self.frames = []
        self.started_at = 0.0

    def setup(self, width, height, init_script=""):
        self.ws.call("Page.enable")
        self.ws.call("Runtime.enable")
        self.ws.call("Emulation.setDeviceMetricsOverride",
                     {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": False})
        self.ws.call("Emulation.setDefaultBackgroundColorOverride",
                     {"color": {"r": 14, "g": 15, "b": 19, "a": 255}})
        if init_script:
            self.ws.call("Page.addScriptToEvaluateOnNewDocument", {"source": init_script})

    def navigate(self, url):
        self.ws.call("Page.navigate", {"url": url})

    def evaluate(self, expression):
        result = self.ws.call("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
        if result.get("exceptionDetails"):
            raise RuntimeError("页面脚本异常：" + json.dumps(result["exceptionDetails"].get("text", ""))[:200])
        return result.get("result", {}).get("value")

    def wait_for(self, expression, timeout=15.0, interval=0.03, label=""):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if self.evaluate(expression):
                    return True
            except Exception:
                pass
            time.sleep(interval)
        raise RuntimeError("等待超时：%s（%s）" % (label or expression[:40], expression[:120]))

    # ── 录屏 ──
    def start_recording(self, width, height):
        self.recording = True
        self.frames = []
        self.ws.call("Page.startScreencast", {"format": "png", "maxWidth": width, "maxHeight": height,
                                              "everyNthFrame": 1})

    def record(self, seconds):
        deadline = time.time() + seconds
        while time.time() < deadline:
            event = self.ws.take_event(timeout=max(0.01, min(0.2, deadline - time.time())))
            if not event:
                continue
            if event.get("method") != "Page.screencastFrame":
                continue
            params = event["params"]
            self.ws.post("Page.screencastFrameAck", {"sessionId": params["sessionId"]})
            # Chrome 的 screencast timestamp 是 epoch 秒，触发时刻也用 time.time()，两边口径一致
            stamp = float(params.get("metadata", {}).get("timestamp") or time.time())
            self.frames.append((stamp, Image.open(io.BytesIO(base64.b64decode(params["data"]))).convert("RGB")))

    def stop_recording(self):
        self.recording = False
        try:
            self.ws.call("Page.stopScreencast", timeout=10)
        except Exception:
            pass
        return self.frames

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass
        try:
            http_json("http://127.0.0.1:%d/json/close/%s" % (self.chrome.port, self.target["id"]), timeout=5)
        except Exception:
            pass


# ───────────────────────── 更新说明数据 ─────────────────────────
def notes_payload(version, skip_srcs):
    """按根 update-notes.json 生成本次演示展示的说明内容；媒体文件不存在的条目自动退回纯文字。"""
    with open(os.path.join(ROOT, "update-notes.json"), "r", encoding="utf-8") as f:
        data = json.load(f)
    entry = next((v for v in data.get("versions") or [] if str(v.get("version")).strip() == version), None)
    if not entry:
        raise SystemExit("update-notes.json 里没有版本 " + version)
    items = []
    for change in entry.get("changes") or []:
        if isinstance(change, str):
            items.append({"type": "feature", "text": change.strip()})
            continue
        text = str(change.get("text") or "").strip()
        if not text:
            continue
        item = {"type": "feature", "text": text}
        media = change.get("media") or {}
        kind = str(media.get("type") or "").strip().lower()
        src = str(media.get("src") or "").strip()
        if kind in ("image", "gif", "video") and src.startswith("/static/") and src not in skip_srcs:
            if os.path.exists(os.path.join(ROOT, src.lstrip("/"))):
                item["media"] = {"type": kind, "src": src}
                if media.get("caption"):
                    item["media"]["caption"] = str(media["caption"]).strip()
        items.append(item)
    return {"version": version, "updated_at": "", "items": items}


DEMO_INIT = """
(() => {
  try {
    localStorage.setItem('novai-visited', '1');
    localStorage.removeItem('novai.update.cardSnoozed');
    localStorage.removeItem('novai.update.dismissedVersion');
    localStorage.removeItem('novai.updatedTo');
  } catch (e) {}
  window.__novaiDemoPatch = %s;
  let real = null;
  function fix(payload) {
    const p = Object.assign({}, payload || {});
    const P = window.__novaiDemoPatch || {};
    if (P.version) p.version = P.version;
    if (p.previousVersion && P.previousVersion) p.previousVersion = P.previousVersion;
    if (p.stage === 'applied' && P.notes) p.notes = P.notes;
    return p;
  }
  function wrap(bridge) {
    if (!bridge || typeof bridge.onStage !== 'function') return bridge;
    const orig = bridge.onStage.bind(bridge);
    return Object.assign({}, bridge, {
      onStage(cb) {
        if (typeof cb !== 'function') return () => {};
        // 演示脚本自己按秒表推事件（时间可控才能截到滑入动画），同时把示例数据改写成真实版本与说明
        window.__novaiDemoEmit = (payload) => { try { cb(fix(payload)); } catch (e) {} };
        return orig((payload) => { try { cb(fix(payload)); } catch (e) {} });
      },
    });
  }
  Object.defineProperty(window, 'novaiUpdater', {
    configurable: true,
    get() { return real; },
    set(value) { real = wrap(value); },
  });
})();
"""


def build_init_script(version, notes):
    return DEMO_INIT % json.dumps({"version": version, "notes": notes}, ensure_ascii=False)


def resample(frames, duration_ms, lead, tail, trigger_at):
    """按成片帧间隔把录到的帧重采样成时间线：lead 秒前摇 + 事件后 tail 秒。"""
    if not frames:
        raise RuntimeError("没录到帧")
    step = duration_ms / 1000.0
    start = trigger_at - lead
    stop = trigger_at + tail
    picked = []
    index = 0
    tick = start
    while tick < stop:
        while index + 1 < len(frames) and frames[index + 1][0] <= tick:
            index += 1
        # 触发前如果第一帧还没到，就用第一帧顶上
        picked.append(frames[index][1] if frames[index][0] <= tick else frames[max(0, index)][1])
        tick += step
    return picked


def fit_aspect(shot, size):
    """抓帧比例和成片不一致时居中裁一刀（弹窗居中，裁掉的是周边背景），再缩到成片尺寸。"""
    target = size[0] / float(size[1])
    width, height = shot.size
    if abs(width / float(height) - target) > 1e-3:
        if width / float(height) > target:
            keep = int(round(height * target))
            left = (width - keep) // 2
            shot = shot.crop((left, 0, left + keep, height))
        else:
            keep = int(round(width / target))
            top = (height - keep) // 2
            shot = shot.crop((0, top, width, top + keep))
    return shot.resize(size, Image.LANCZOS)


def save_gif(shots, out_path, spec, duration):
    """逐帧自适应调色板 + 只写变化区域（optimize）：渐变不共用一个调色板，体积也不会炸。"""
    base = [fit_aspect(shot, spec["size"]) for shot in shots]
    best = None
    for colors in [spec["colors"], 128, 96, 64]:
        frames = [image.quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG) for image in base]
        frames[0].save(out_path, format="GIF", save_all=True, append_images=frames[1:],
                       duration=duration, loop=0, optimize=True, disposal=1)
        best = (colors, os.path.getsize(out_path))
        if best[1] <= GIF_LIMIT:
            break
    # 以文件里的真实帧数/帧间隔为准（Pillow 会把完全相同的相邻帧合并）
    with Image.open(out_path) as saved:
        real_frames = saved.n_frames
        real_duration = saved.info.get("duration", duration)
    return {"path": out_path, "frames": real_frames, "duration": real_duration, "colors": best[0],
            "bytes": best[1], "size": spec["size"]}


# ───────────────────────── 三个场景 ─────────────────────────
def shoot_card(chrome, backend, version, notes):
    page = chrome.new_page()
    width, height = GIFS["card"]["capture"]
    try:
        page.setup(width, height, build_init_script(version, notes))
        page.navigate(backend.base_url() + "/?novaiUpdatePreview=downloaded")
        page.wait_for("!!window.__novaiDemoEmit", timeout=25, label="更新桥订阅")
        time.sleep(0.4)
        page.start_recording(width, height)
        page.record(0.35)
        trigger = time.time()
        page.evaluate("window.__novaiDemoEmit({ stage: 'downloaded' })")
        page.record(GIFS["card"]["lead"] + GIFS["card"]["tail"] + 0.25)
        page.stop_recording()
        frames = page.frames
        print("[card] 录到 %d 帧，事件后 %.2f 秒收尾" % (len(frames), frames[-1][0] - trigger))
        return frames, trigger
    finally:
        page.close()


def shoot_notes(chrome, backend, version, notes):
    page = chrome.new_page()
    width, height = GIFS["notes"]["capture"]
    try:
        page.setup(width, height, build_init_script(version, notes))
        page.navigate(backend.base_url() + "/?novaiUpdatePreview=applied")
        page.wait_for("!!window.__novaiDemoEmit", timeout=25, label="更新桥订阅")
        time.sleep(0.4)
        page.start_recording(width, height)
        page.record(0.3)
        trigger = time.time()
        page.evaluate("window.__novaiDemoEmit({ stage: 'applied', previousVersion: '2.0.06' })")
        flags = page.evaluate("[...document.querySelectorAll('.ud .list .row')].map(row => !!row.querySelector('.mi'))") or []
        if not flags:
            raise RuntimeError("更新说明列表没渲染出来")
        text_rows = [i for i, has_media in enumerate(flags) if not has_media]
        media_rows = [i for i, has_media in enumerate(flags) if has_media]
        # 两段切换：纯文字条目（主展示区显示文字）→ 最后一个带媒体条目（演示自动播放）
        first_text = text_rows[0] if text_rows else 0
        last_media = media_rows[-1] if media_rows else len(flags) - 1
        page.record(0.75)
        page.evaluate("document.querySelectorAll('.ud .list .row')[%d].click()" % first_text)
        page.record(0.65)
        page.evaluate("document.querySelectorAll('.ud .list .row')[%d].click()" % last_media)
        # 最后一条常常刚好卡在列表可视区边缘：把列表滚到底，选中行完整露出来（和用户手动滚一下等价）
        page.evaluate("(() => { const list = document.querySelector('.ud .list'); if (list) list.scrollTop = list.scrollHeight; })()")
        page.record(GIFS["notes"]["tail"])
        page.stop_recording()
        print("[notes] 录到 %d 帧（%d 条：先切到第 %d 条纯文字，再切到第 %d 条媒体）"
              % (len(page.frames), len(flags), first_text + 1, last_media + 1))
        return page.frames, trigger
    finally:
        page.close()


def shoot_splash(chrome, version):
    page = chrome.new_page()
    width, height = GIFS["splash"]["capture"]
    try:
        page.setup(width, height, "")
        splash_path = os.path.join(ROOT, "desktop", "splash.html")
        page.navigate("file://" + urllib.request.pathname2url(splash_path))
        page.wait_for("!!(window.__novaiSplash && window.__novaiSplash.setStage)", timeout=25, label="启动页就绪")
        page.start_recording(width, height)
        page.record(GIFS["splash"]["lead"])
        trigger = time.time()
        steps = [(0.0, "正在启动", 8), (0.45, "正在预热", 30), (0.85, "正在预热", 45),
                 (1.25, "准备界面", 60), (1.65, "检查更新", 85), (2.05, "就绪", 100)]
        for offset, label, percent in steps:
            if offset:
                page.record(offset - prev[0])
            page.evaluate("window.__novaiSplash.setStage(%s, %d)" % (json.dumps(label, ensure_ascii=False), percent))
            prev = (offset, label, percent)
        page.record(GIFS["splash"]["tail"] - steps[-1][0])
        page.stop_recording()
        print("[splash] 录到 %d 帧（6 个阶段：正在启动→就绪）" % len(page.frames))
        return page.frames, trigger
    finally:
        page.close()


# ───────────────────────── 入口 ─────────────────────────
def main():
    parser = argparse.ArgumentParser(description="用真实界面抓帧生成更新演示 GIF")
    parser.add_argument("version", nargs="?", default=DEFAULT_VERSION, help="发版版本号，默认 " + DEFAULT_VERSION)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="后端端口，默认 %d（独立端口，别用 3000）" % DEFAULT_PORT)
    parser.add_argument("--chrome", default="", help="Chrome 可执行文件路径")
    parser.add_argument("--data-dir", default="", help="后端数据目录，默认 /tmp/novai-demo-<版本>")
    parser.add_argument("--only", default="", help="只生成其中一个：card / notes / splash")
    args = parser.parse_args()

    version = args.version.strip()
    if args.port == 3000:
        raise SystemExit("3000 是正式安装版的后端，演示生成不碰它；换个 --port")
    chrome_path = args.chrome or next((p for p in CHROME_CANDIDATES if os.path.exists(p)), "")
    if not chrome_path:
        raise SystemExit("找不到 Chrome，用 --chrome 指定可执行文件")
    out_dir = os.path.join(ROOT, "static", "updates", version)
    os.makedirs(out_dir, exist_ok=True)
    data_dir = args.data_dir or "/tmp/novai-demo-" + version

    only = (args.only or "").strip()
    wanted = [only] if only else ["card", "splash", "notes"]   # 说明弹窗要播卡片/启动动图，排在它们之后
    if [name for name in wanted if name not in GIFS]:
        raise SystemExit("--only 只能是 card / notes / splash")

    self_src = "/static/updates/%s/%s" % (version, GIFS["notes"]["name"])   # 弹窗不能演示它自己
    notes = notes_payload(version, {self_src})

    backend = Backend(args.port, data_dir)
    chrome = Chrome(chrome_path)
    results = []
    try:
        backend.start()
        chrome.start()
        if "card" in wanted:
            frames, trigger = shoot_card(chrome, backend, version, notes)
            shots = resample(frames, GIFS["card"]["duration"], GIFS["card"]["lead"], GIFS["card"]["tail"], trigger)
            results.append(save_gif(shots, os.path.join(out_dir, GIFS["card"]["name"]), GIFS["card"], GIFS["card"]["duration"]))
        if "splash" in wanted:
            frames, trigger = shoot_splash(chrome, version)
            shots = resample(frames, GIFS["splash"]["duration"], GIFS["splash"]["lead"], GIFS["splash"]["tail"], trigger)
            results.append(save_gif(shots, os.path.join(out_dir, GIFS["splash"]["name"]), GIFS["splash"], GIFS["splash"]["duration"]))
        if "notes" in wanted:
            frames, trigger = shoot_notes(chrome, backend, version, notes)
            shots = resample(frames, GIFS["notes"]["duration"], GIFS["notes"]["lead"], GIFS["notes"]["tail"], trigger)
            results.append(save_gif(shots, os.path.join(out_dir, GIFS["notes"]["name"]), GIFS["notes"], GIFS["notes"]["duration"]))
    finally:
        chrome.stop()
        backend.stop()

    print("\n演示 GIF 生成完成（版本 %s）：" % version)
    for item in results:
        rel = os.path.relpath(item["path"], ROOT)
        seconds = item["frames"] * item["duration"] / 1000.0
        print("  %-26s %3d 帧  %dx%d  %5.2f 秒  %7d 字节 (%.2f MB)  颜色 %d"
              % (rel, item["frames"], item["size"][0], item["size"][1], seconds,
                 item["bytes"], item["bytes"] / 1024.0 / 1024.0, item["colors"]))
    over = [i for i in results if i["bytes"] > GIF_LIMIT]
    if over:
        raise SystemExit("有 GIF 超过 1.5MB 上限：" + ", ".join(os.path.basename(i["path"]) for i in over))


if __name__ == "__main__":
    main()
