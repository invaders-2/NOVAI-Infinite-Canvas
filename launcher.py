#!/usr/bin/env python3
"""NOVAI 桌面启动器 — PyInstaller 打包入口

启动流程：
1. 找到安装目录（exe 所在目录）
2. 将安装目录加入 sys.path，动态加载外置 main.py
3. 用内置 uvicorn 启动 FastAPI 服务（后台线程）
4. 等待服务就绪后打开原生桌面窗口
"""

import os
import sys
import time
import threading


def hide_console():
    """在 --console 模式下打包后，启动时隐藏控制台窗口"""
    if os.name == "nt" and getattr(sys, "frozen", False):
        try:
            import ctypes
            hwnd = ctypes.windll.kernel32.GetConsoleWindow()
            if hwnd:
                ctypes.windll.user32.ShowWindow(hwnd, 0)  # SW_HIDE
        except Exception:
            pass


def get_app_dir() -> str:
    """获取安装目录（exe 所在目录，即 main.py 等外置文件所在位置）

    onefile 模式下 sys._MEIPASS 是临时解压目录（含 Python 运行时和打包依赖），
    但 main.py 是外置的（在 exe 旁边，方便在线更新），不在 _MEIPASS 里。
    所以优先用 exe 所在目录，找不到 main.py 才回退到 _MEIPASS。
    """
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(sys.executable)
        if os.path.isfile(os.path.join(exe_dir, "main.py")):
            return exe_dir
        # fallback：可能 main.py 被打包进 exe 了（onedir 或 add-data 场景）
        return getattr(sys, '_MEIPASS', exe_dir)
    return os.path.dirname(os.path.abspath(__file__))


def _paint_mac_titlebar(win, color):
    """同步 macOS 窗口顶部与主题色（须在主线程调用）。

    - NSWindow 背景刷成页面顶部色：圆角边缘、webview 完成绘制前的窗口底色都跟主题。
    - 标题栏容器视图刷透明：pywebview 建窗时给它设了固定系统色（不随窗口色变化），
      刷透明后标题栏区域直接显示 webview 里的 App Header，天然随主题一致。
      实测该容器只在红绿灯按钮上拦截点击，条带其余区域点击穿透到 webview，不影响交互。
    """
    from Cocoa import NSColor
    try:
        win.setBackgroundColor_(color)
        frame = win.contentView().superview()
        if frame is None:
            return
        for sub in frame.subviews():
            try:
                if 'Titlebar' in str(sub.className()) and sub.respondsToSelector_('setBackgroundColor:'):
                    sub.setBackgroundColor_(NSColor.clearColor())
            except Exception:
                pass
        _hide_mac_titlebar_chrome(win)
    except Exception:
        pass


def _hide_mac_titlebar_chrome(win):
    """隐藏标题栏装饰视图，消除窗口顶部 1pt 亮色细线（须在主线程调用；幂等）。

    红绿灯整体平移把 NSTitlebarContainerView 挪离原位后，容器内随移的
    _NSTitlebarDecorationView、背景填充 NSView 等会在顶缘画出一条横贯的
    亮色细线（深色模式下明显）。这些只是装饰；红绿灯按钮挂在 NSTitlebarView 里，
    隐藏其兄弟视图不影响按钮显示与点击。系统 relayout / 主题切换可能重新显示
    这些视图，故在 applyTrafficLights_ 与 _paint_mac_titlebar 里重复调用。
    """
    try:
        btn = win.standardWindowButton_(0)
        if btn is None:
            return
        titlebar_view = btn.superview()
        if titlebar_view is None:
            return
        container = titlebar_view.superview()
        if container is not None:
            for sub in container.subviews():
                if sub is titlebar_view:
                    continue
                try:
                    sub.setHidden_(True)
                except Exception:
                    pass
        for sub in titlebar_view.subviews():
            try:
                if 'Widget' in str(sub.className()):
                    continue
                sub.setHidden_(True)
            except Exception:
                pass
    except Exception:
        pass


# 窗口拖拽监视器状态（模块级，防止闭包/monitor token 被 GC）
_native_drag_state = {"monitors": []}

# 红绿灯目标位（窗口坐标 pt，与前端 CSS px 一一对应）：
# 红灯左缘对齐主壳侧栏【面板本身】左缘（Boss 复核口径："红绿灯左边距 == 侧栏左边距"
# 指悬浮 sidebar 面板距窗口左缘的 margin，即 .app-shell padding = 15pt；收起/展开态
# 面板左缘均为 15，与图标列无关。曾误对齐图标列 44，方向反了）。
# 注意 AppKit convertPoint 坐标系与屏幕/CGWindow 坐标系存在 +1pt 系统偏差（常量 44
# 时 AX/像素实测 45），故常量设 14.0 抵消，使实测命中 15.0。
# 中心线与主壳 .stage-actions 按钮同线（top:18 + 半高 18 = 36）。
_MAC_TL_LEFT_X = 14.0
_MAC_TL_CENTER_Y = 36.0


def _end_native_window_drag():
    """移除窗口拖拽用的本地事件监视器（须在主线程调用）"""
    try:
        from Cocoa import NSEvent
        for mon in _native_drag_state["monitors"]:
            try:
                NSEvent.removeMonitor_(mon)
            except Exception:
                pass
        _native_drag_state["monitors"] = []
    except Exception:
        pass


def _begin_native_window_drag():
    """安装 LeftMouseDragged/Up 本地监视器，让窗口跟随鼠标位移（须在主线程调用）。

    pywebview（WKWebView）不支持 -webkit-app-region: drag，
    movableByWindowBackground 又够不到盖满整个窗口的 webview 区域，
    只能原生层按鼠标位移挪窗口。前端 Header 带 mousedown 时经桥调用。
    """
    from Cocoa import NSEvent, NSApp
    try:
        wins = NSApp.windows()
        if not wins:
            return
        win = wins[0]
        _end_native_window_drag()  # 防重复安装

        start = {"mouse": NSEvent.mouseLocation(), "origin": win.frame().origin}

        def on_event(event):
            try:
                if event.type() == 2:  # NSLeftMouseUp → 结束本次拖拽
                    _end_native_window_drag()
                    return event
                cur = NSEvent.mouseLocation()
                o = start["origin"]
                win.setFrameOrigin_((
                    o.x + (cur.x - start["mouse"].x),
                    o.y + (cur.y - start["mouse"].y),
                ))
            except Exception:
                pass
            return event

        # NSEventMaskLeftMouseDragged = 1 << 6, NSEventMaskLeftMouseUp = 1 << 2
        mon = NSEvent.addLocalMonitorForEventsMatchingMask_handler_((1 << 6) | (1 << 2), on_event)
        if mon:
            _native_drag_state["monitors"].append(mon)
    except Exception:
        pass


def main():
    hide_console()
    app_dir = get_app_dir()
    
    # 写启动日志
    log_file = os.path.join(os.environ.get("TEMP", "."), "novai_startup.log")
    def log(msg):
        try:
            with open(log_file, "a", encoding="utf-8") as f:
                f.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
        except:
            pass
    
    log(f"App dir: {app_dir}")
    log(f"Frozen: {getattr(sys, 'frozen', False)}")
    log(f"Python: {sys.version}")
    log(f"sys.path[0:3]: {sys.path[:3]}")

    # 确保安装目录在 sys.path 最前面，优先加载外置 main.py
    if app_dir not in sys.path:
        sys.path.insert(0, app_dir)

    # 设置环境变量供 main.py 使用
    data_dir = os.path.join(
        os.environ.get("APPDATA", os.path.expanduser("~")),
        "NOVAI"
    )
    os.environ.setdefault("NOVAI_APP_DIR", app_dir)
    os.environ.setdefault("NOVAI_DATA_DIR", data_dir)
    os.makedirs(data_dir, exist_ok=True)

    # 动态加载外置 main.py
    try:
        log("Importing main.py...")
        import main as main_module
        log("main.py imported OK")
    except ImportError as e:
        log(f"Import FAILED: {e}")
        import tkinter.messagebox as mb
        mb.showerror("启动失败",
                     f"无法加载 main.py\n\n请确认 {app_dir}\\main.py 存在且完整。\n\n错误: {e}")
        sys.exit(1)

    PORT = 3000
    URL = f"http://127.0.0.1:{PORT}"  # 桌面窗口仍用 127.0.0.1 本地访问

    # 获取局域网 IP，供 main.py 的 /api/lan-info 接口使用
    def get_lan_ip():
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        except Exception:
            return None
        finally:
            s.close()

    lan_ip = get_lan_ip()
    if lan_ip:
        lan_url = f"http://{lan_ip}:{PORT}"
        os.environ["NOVAI_LAN_URL"] = lan_url
        os.environ["NOVAI_LAN_IP"] = lan_ip
        log(f"LAN access: {lan_url}")
        # 运行时确保防火墙规则存在（安装包已添加，此处兜底）
        try:
            import subprocess as sp
            rule_name = "NOVAI Server (port 3000)"
            result = sp.run(
                f'netsh advfirewall firewall show rule name="{rule_name}"',
                capture_output=True, text=True, shell=True, timeout=5
            )
            if "未找到" in result.stdout or "No rules match" in result.stdout:
                log("Firewall rule missing, adding...")
                sp.run(
                    f'netsh advfirewall firewall add rule name="{rule_name}" dir=in action=allow protocol=TCP localport={PORT}',
                    capture_output=True, shell=True, timeout=10
                )
                log("Firewall rule added")
            else:
                log("Firewall rule OK")
        except Exception as e:
            log(f"Firewall check skipped: {e}")
    else:
        log("LAN access: unable to detect local IP")

    # 后台线程启动 uvicorn
    import uvicorn

    server_started = threading.Event()

    def run_server():
        config = uvicorn.Config(
            main_module.app,
            host="0.0.0.0",  # 绑定所有网卡，允许局域网访问
            port=PORT,
            log_level="warning",
            log_config=None,
            loop="asyncio",
        )
        server = uvicorn.Server(config)

        # 在事件循环启动后通知主线程
        async def notify():
            server_started.set()

        # 把 notify 加到 startup
        original_startup = getattr(server, "_serve", None)

        # 简单方案：另开线程检测
        def check_and_notify():
            import urllib.request
            for _ in range(30):
                try:
                    urllib.request.urlopen(URL, timeout=1)
                    server_started.set()
                    return
                except Exception:
                    time.sleep(0.3)
            server_started.set()  # 超时也通知，避免卡死

        threading.Thread(target=check_and_notify, daemon=True).start()
        log("Starting uvicorn server...")
        try:
            server.run()
        except Exception as e:
            log(f"Server run FAILED: {e}")
            import traceback
            log(traceback.format_exc())
            server_started.set()  # unlock main thread

    server_thread = threading.Thread(target=run_server, daemon=True)
    log("Starting server thread...")
    server_thread.start()

    # 等待服务就绪
    log("Waiting for server...")
    if not server_started.wait(timeout=20):
        log("Server wait TIMEOUT!")
        try:
            import tkinter.messagebox as mb
            mb.showerror("启动失败", "后端服务启动超时，请检查网络或防火墙设置。")
        except Exception:
            pass
        sys.exit(1)
    log("Server ready!")

    # 打开原生桌面窗口
    try:
        import webview

        # ===== 窗口控制 API ====
        class Api:
            def __init__(self):
                self._maximized = False
                self._fr_direction = ''
                self._fr_geo = None

            def minimize(self):
                webview.windows[0].minimize()

            def maximize(self):
                if os.name == "nt":
                    import ctypes, os as _os
                    from ctypes import wintypes

                    user32 = ctypes.windll.user32

                    # ── 64 位兼容函数原型（参照 _enable_frameless_resize 写法）──
                    # ctypes 默认返回 c_int（32 位），64 位句柄/指针会被截断导致崩溃
                    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

                    class RECT(ctypes.Structure):
                        _fields_ = [
                            ("left", ctypes.c_long),
                            ("top", ctypes.c_long),
                            ("right", ctypes.c_long),
                            ("bottom", ctypes.c_long),
                        ]

                    user32.EnumWindows.restype = ctypes.c_bool
                    user32.EnumWindows.argtypes = [WNDENUMPROC, wintypes.LPARAM]
                    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
                    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
                    user32.IsWindowVisible.restype = ctypes.c_bool
                    user32.IsWindowVisible.argtypes = [wintypes.HWND]
                    user32.GetParent.restype = wintypes.HWND
                    user32.GetParent.argtypes = [wintypes.HWND]
                    user32.GetForegroundWindow.restype = wintypes.HWND
                    user32.GetForegroundWindow.argtypes = []
                    user32.GetWindowRect.restype = ctypes.c_bool
                    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
                    user32.SystemParametersInfoW.restype = ctypes.c_bool
                    user32.SystemParametersInfoW.argtypes = [wintypes.UINT, wintypes.UINT, ctypes.POINTER(RECT), wintypes.UINT]
                    user32.SetWindowPos.restype = ctypes.c_bool
                    user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
                    user32.GetWindowLongW.restype = ctypes.c_longlong
                    user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]

                    # 按当前进程 PID 找主窗口，比 GetForegroundWindow/native.Handle 都可靠
                    hwnd = None
                    pid = _os.getpid()

                    found = []
                    @WNDENUMPROC
                    def _cb(h, _):
                        if not user32.IsWindowVisible(h):
                            return True
                        if user32.GetParent(h):
                            return True
                        p = wintypes.DWORD()
                        user32.GetWindowThreadProcessId(h, ctypes.byref(p))
                        if p.value == pid:
                            found.append(h)
                        return True
                    user32.EnumWindows(_cb, 0)
                    if found:
                        hwnd = found[0]

                    if not hwnd:
                        hwnd = user32.GetForegroundWindow()
                    if not hwnd:
                        return

                    if self._maximized:
                        if self._fr_geo:
                            x, y, w, h = self._fr_geo
                            user32.SetWindowPos(hwnd, 0, x, y, w, h, 0x0040)
                        self._maximized = False
                    else:
                        r = RECT()
                        user32.GetWindowRect(hwnd, ctypes.byref(r))
                        self._fr_geo = (r.left, r.top, r.right - r.left, r.bottom - r.top)
                        wa = RECT()
                        user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(wa), 0)
                        user32.SetWindowPos(
                            hwnd, 0,
                            wa.left, wa.top,
                            wa.right - wa.left, wa.bottom - wa.top,
                            0x0040
                        )
                        self._maximized = True

            def close(self):
                try:
                    webview.windows[0].hide()
                except Exception as e:
                    log(f"close hide error: {e}")

            def quit_app(self):
                """直接退出应用"""
                log("quit_app: exiting")
                webview.windows[0].destroy()
                os._exit(0)

            def save_file(self, data: str, filename: str = None) -> str:
                """保存文件：接收 base64 数据，弹出原生另存为对话框，返回保存路径或空字符串"""
                import base64, re
                try:
                    # 解析 data URL 或纯 base64
                    b64 = data
                    ext = ".png"
                    if "," in data and data.startswith("data:"):
                        header, b64 = data.split(",", 1)
                        m = re.match(r"data:image/(\w+)", header)
                        if m:
                            ext = "." + m.group(1)
                    raw = base64.b64decode(b64)

                    default_name = filename or f"Art-{int(time.time())}{ext}"
                    try:
                        from webview import FileDialog as _Fd
                        _SAVE = _Fd.SAVE
                    except ImportError:
                        _SAVE = getattr(webview, 'SAVE_DIALOG', 30)
                    result = webview.windows[0].create_file_dialog(
                        _SAVE,
                        directory="",
                        save_filename=default_name
                    )
                    if result:
                        path = str(result[0] if isinstance(result, (list, tuple)) else result)
                        with open(path, "wb") as f:
                            f.write(raw)
                        log(f"save_file: saved to {path}")
                        return path
                    return ""
                except Exception as e:
                    log(f"save_file error: {e}")
                    return ""

            def get_data_dir(self) -> str:
                """返回用户数据目录路径"""
                return app_dir

            def open_data_dir(self):
                """在资源管理器中打开数据目录"""
                import subprocess
                subprocess.Popen(["explorer", app_dir])
                log(f"open_data_dir: {app_dir}")

            def select_directory(self) -> str:
                """打开原生文件夹选择对话框，返回所选路径"""
                result = webview.windows[0].create_file_dialog(
                    webview.FOLDER_DIALOG,
                    directory=app_dir
                )
                if result and len(result) > 0:
                    return str(result[0])
                return ""

            def set_auto_start(self, enable: bool):
                """设置开机自启动（通过快捷方式写入启动文件夹）"""
                try:
                    import os as _os
                    startup = _os.path.join(
                        _os.getenv("APPDATA"),
                        "Microsoft", "Windows", "Start Menu", "Programs", "Startup"
                    )
                    lnk = _os.path.join(startup, "NOVAI.lnk")
                    if enable:
                        import win32com.client
                        shell = win32com.client.Dispatch("WScript.Shell")
                        shortcut = shell.CreateShortcut(lnk)
                        shortcut.TargetPath = sys.executable if getattr(sys, "frozen", False) else sys.argv[0]
                        shortcut.WorkingDirectory = app_dir
                        shortcut.Description = "NOVAI Studio"
                        shortcut.Save()
                        log(f"set_auto_start: enabled → {lnk}")
                    else:
                        if _os.path.exists(lnk):
                            _os.remove(lnk)
                            log(f"set_auto_start: disabled, removed {lnk}")
                    return True
                except Exception as e:
                    log(f"set_auto_start error: {e}")
                    return False

            def set_titlebar_theme(self, r, g, b):
                """前端主题切换时调用，把 NSWindow 背景设为主壳顶部实际背景色（RGB 0-255）"""
                try:
                    red = max(0.0, min(1.0, float(r) / 255.0))
                    green = max(0.0, min(1.0, float(g) / 255.0))
                    blue = max(0.0, min(1.0, float(b) / 255.0))
                except (TypeError, ValueError):
                    return
                try:
                    from Cocoa import NSApp, NSObject, NSColor

                    # pyobjc 不允许同名 ObjC 类重复注册，helper 类只定义一次
                    helper_cls = getattr(self, '_titlebar_helper_cls', None)
                    if helper_cls is None:
                        class _TitlebarColorHelper(NSObject):
                            def applyColor_(self, color):
                                try:
                                    wins = NSApp.windows()
                                    if wins:
                                        _paint_mac_titlebar(wins[0], color)
                                except Exception:
                                    pass
                        helper_cls = _TitlebarColorHelper
                        self._titlebar_helper_cls = helper_cls

                    color = NSColor.colorWithSRGBRed_green_blue_alpha_(red, green, blue, 1.0)
                    helper = helper_cls.alloc().init()
                    self._titlebar_color_helper = helper  # 保持引用防止 GC
                    helper.performSelectorOnMainThread_withObject_waitUntilDone_(
                        'applyColor:', color, False
                    )
                except Exception:
                    pass

            def start_window_drag(self):
                """macOS：前端 Header 带 mousedown 后调用，原生层让窗口跟随鼠标拖动。

                pywebview（WKWebView）不支持 -webkit-app-region: drag，
                movableByWindowBackground 又够不到盖满窗口的 webview 区域，只能桥到原生层挪窗口。
                """
                if os.name == 'nt':
                    return self._start_windows_drag()
                try:
                    from Cocoa import NSObject

                    # pyobjc 不允许同名 ObjC 类重复注册，helper 类只定义一次
                    helper_cls = getattr(self, '_drag_helper_cls', None)
                    if helper_cls is None:
                        class _WindowDragHelper(NSObject):
                            def beginDrag_(self, _ignored):
                                try:
                                    _begin_native_window_drag()
                                except Exception:
                                    pass
                        helper_cls = _WindowDragHelper
                        self._drag_helper_cls = helper_cls

                    helper = helper_cls.alloc().init()
                    self._drag_helper = helper  # 保持引用防止 GC
                    helper.performSelectorOnMainThread_withObject_waitUntilDone_(
                        'beginDrag:', None, False
                    )
                except Exception as e:
                    log(f"start_window_drag error: {e}")

            def _start_windows_drag(self):
                """Windows 无边框：前端标题栏 mousedown 桥到这里，模拟标题栏命中拖动。

                WebView2 子窗口吞掉顶层窗口的 WM_NCHITTEST，_enable_frameless_resize
                里的 HTCAPTION 分支实际失效；改由前端显式调桥，WM_NCLBUTTONDOWN +
                HTCAPTION 让系统接管拖动循环（对无 WS_CAPTION 窗口同样有效）。"""
                try:
                    import ctypes
                    from ctypes import wintypes
                    user32 = ctypes.windll.user32

                    wins = webview.windows
                    if not wins:
                        return
                    w = wins[0]
                    native = getattr(w, 'native', None)
                    if native is None:
                        return
                    hwnd = int(native.Handle.ToInt32())

                    # 64 位兼容：SendMessageW 返回 LRESULT，句柄/参数均按指针宽传递，
                    # 防止 64 位 hwnd 被 ctypes 默认的 c_int 截断（同 _enable_frameless_resize 写法）
                    user32.SendMessageW.restype = ctypes.c_longlong
                    user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]

                    # 先释放鼠标捕获，再发模拟标题栏按下，系统接管拖动循环
                    WM_NCLBUTTONDOWN = 0x00A1
                    HTCAPTION = 2
                    user32.ReleaseCapture()
                    user32.SendMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0)
                except Exception as e:
                    log(f"_start_windows_drag error: {e}")

            def get_lan_url(self) -> dict:
                """动态获取当前局域网访问地址"""
                try:
                    ip = get_lan_ip()
                    if ip:
                        url = f"http://{ip}:{PORT}"
                        return {"ip": ip, "url": url, "port": PORT}
                except Exception as e:
                    log(f"get_lan_url error: {e}")
                return {"ip": None, "url": None, "port": PORT}

            # ── Windows 无边框窗口边缘缩放（前端边缘条 mousedown/move/up 驱动）──
            # WebView2 子窗口会吞掉顶层窗口的 WM_NCHITTEST，原生/子类化方案拿不到边框命中，
            # 只能由前端检测边缘、经 js_api 桥在这里改窗口几何。
            def begin_frameless_resize(self, direction: str):
                """记录缩放拖拽起点时的窗口几何。direction ∈ n/s/e/w/ne/nw/se/sw"""
                try:
                    w = webview.windows[0]
                    self._fr_direction = str(direction or '')
                    self._fr_geo = (w.x, w.y, w.width, w.height)
                except Exception as e:
                    log(f"begin_frameless_resize error: {e}")
                    self._fr_direction = ''
                    self._fr_geo = None

            def update_frameless_resize(self, dx: float, dy: float):
                """按累计位移应用缩放；west/north 方向同步移动窗口保持对边不动"""
                try:
                    geo = self._fr_geo
                    direction = self._fr_direction
                    if not geo or not direction:
                        return
                    x, y, orig_w, orig_h = geo
                    dx, dy = int(dx), int(dy)
                    min_w, min_h = 1200, 800
                    width, height = orig_w, orig_h
                    new_x, new_y = x, y
                    if 'e' in direction:
                        width = max(min_w, orig_w + dx)
                    if 's' in direction:
                        height = max(min_h, orig_h + dy)
                    if 'w' in direction:
                        width = max(min_w, orig_w - dx)
                        new_x = x + (orig_w - width)
                    if 'n' in direction:
                        height = max(min_h, orig_h - dy)
                        new_y = y + (orig_h - height)
                    w = webview.windows[0]
                    if new_x != x or new_y != y:
                        w.move(new_x, new_y)
                    w.resize(width, height)
                except Exception as e:
                    log(f"update_frameless_resize error: {e}")

            def end_frameless_resize(self):
                self._fr_direction = ''
                self._fr_geo = None

        def _enable_frameless_resize(retries=12, delay=0.4):
            """子类化窗口 WndProc 实现无标题栏 + resize 边框。
            优先通过 pywebview window.native 获取 HWND（最可靠），回退 EnumWindows。"""
            import ctypes
            import time
            from ctypes import wintypes, WINFUNCTYPE
            user32 = ctypes.windll.user32
            hwnd = None

            # ── 方法1：pywebview window.native.Handle（推荐）──
            for attempt in range(retries):
                try:
                    wins = webview.windows
                    if wins:
                        w = wins[0]
                        native = getattr(w, 'native', None)
                        if native:
                            hwnd = int(native.Handle.ToInt32())
                            break
                except Exception:
                    pass
                time.sleep(delay)

            if hwnd:
                log(f"_enable_frameless_resize: native → hwnd={hwnd}")
            else:
                # ── 方法2：EnumWindows 回退 ──
                log("_enable_frameless_resize: native not ready, trying EnumWindows...")
                kernel32 = ctypes.windll.kernel32
                pid = kernel32.GetCurrentProcessId()
                found = [None]

                @WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
                def enum_cb(h, _lp):
                    proc_id = wintypes.DWORD()
                    user32.GetWindowThreadProcessId(h, ctypes.byref(proc_id))
                    if proc_id.value == pid and user32.IsWindowVisible(h):
                        cn = ctypes.create_unicode_buffer(256)
                        user32.GetClassNameW(h, cn, 256)
                        if "ConsoleWindowClass" not in cn.value and "#32770" not in cn.value:
                            found[0] = h
                            return False
                    return True

                for attempt in range(retries):
                    found[0] = None
                    user32.EnumWindows(enum_cb, 0)
                    if found[0]:
                        hwnd = found[0]
                        break
                    log(f"_enable_frameless_resize: EnumWindows retry {attempt+1}/{retries}")
                    time.sleep(delay)

                # 保留回调引用防止 GC
                _enable_frameless_resize._enum_cb = enum_cb

            if not hwnd:
                log("_enable_frameless_resize: no window found after all retries")
                return

            # ── 设置 64 位兼容的函数原型 ──
            # ctypes 默认返回 c_int（32 位），64 位指针会被截断导致崩溃
            user32.SetWindowLongPtrW.restype = ctypes.c_longlong
            user32.SetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_longlong]
            user32.GetWindowLongPtrW.restype = ctypes.c_longlong
            user32.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
            user32.CallWindowProcW.restype = ctypes.c_longlong
            user32.CallWindowProcW.argtypes = [ctypes.c_longlong, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]

            try:
                # ── WndProc 子类化：拦截 WM_NCCALCSIZE 去掉标题栏区域 ──
                WM_NCCALCSIZE = 0x0083
                WM_NCHITTEST = 0x0084
                orig_wndproc = [None]

                @WINFUNCTYPE(ctypes.c_longlong, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
                def new_wndproc(h, msg, wp, lp):
                    if msg == WM_NCCALCSIZE and wp:
                        return 0
                    if msg == WM_NCHITTEST:
                        # 先让系统判断，系统返回 HTCLIENT(1) 时再手动判断边框/标题栏区域
                        result = user32.CallWindowProcW(orig_wndproc[0], h, msg, wp, lp)
                        if result == 1:  # HTCLIENT
                            x = ctypes.c_int16(lp & 0xFFFF).value
                            y = ctypes.c_int16((lp >> 16) & 0xFFFF).value
                            rc = wintypes.RECT()
                            user32.GetWindowRect(h, ctypes.byref(rc))
                            bw = 8  # 边框拖拽宽度
                            title_h = 40  # 标题栏拖拽高度
                            on_left = x <= rc.left + bw
                            on_right = x >= rc.right - bw
                            on_top = y <= rc.top + bw
                            on_bottom = y >= rc.bottom - bw
                            # 边框 resize 区域
                            if on_top and on_left:     return 13  # HTTOPLEFT
                            if on_top and on_right:    return 14  # HTTOPRIGHT
                            if on_bottom and on_left:  return 16  # HTBOTTOMLEFT
                            if on_bottom and on_right: return 17  # HTBOTTOMRIGHT
                            if on_top:                 return 12  # HTTOP
                            if on_bottom:              return 15  # HTBOTTOM
                            if on_left:                return 10  # HTLEFT
                            if on_right:               return 11  # HTRIGHT
                            # 顶部标题栏区域 → 允许拖动窗口
                            if y <= rc.top + title_h:  return 2   # HTCAPTION
                            return result
                        return result
                    return user32.CallWindowProcW(orig_wndproc[0], h, msg, wp, lp)

                GWLP_WNDPROC = -4
                orig_wndproc[0] = user32.SetWindowLongPtrW(hwnd, GWLP_WNDPROC,
                    ctypes.cast(new_wndproc, ctypes.c_void_p).value)
                log(f"_enable_frameless_resize: SetWindowLongPtrW ok, orig_wndproc={orig_wndproc[0]}")

                # 移除 WS_CAPTION，添加 WS_THICKFRAME（resize 边框）
                WS_CAPTION = 0x00C00000
                WS_THICKFRAME = 0x00040000
                GWL_STYLE = -16
                style = user32.GetWindowLongPtrW(hwnd, GWL_STYLE)
                style &= ~WS_CAPTION
                style |= WS_THICKFRAME
                user32.SetWindowLongPtrW(hwnd, GWL_STYLE, style)

                # 触发重绘（不改变大小和位置）
                SWP_NOMOVE = 0x0002
                SWP_NOSIZE = 0x0001
                SWP_FRAMECHANGED = 0x0020
                SWP_NOZORDER = 0x0004
                user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED | SWP_NOZORDER)

                # 保留 WndProc 引用防止 GC 崩溃
                _enable_frameless_resize._wndproc = new_wndproc
                _enable_frameless_resize._orig = orig_wndproc[0]

                # 强制显示窗口（frameless 模式下 pywebview 可能未自动 show）
                SW_SHOW = 5
                if not user32.IsWindowVisible(hwnd):
                    user32.ShowWindow(hwnd, SW_SHOW)
                    log(f"_enable_frameless_resize: forced ShowWindow, was hidden")

                log(f"_enable_frameless_resize: subclassed hwnd={hwnd} + WS_THICKFRAME added")
            except Exception as e:
                log(f"_enable_frameless_resize: subclass FAILED: {e}")
                # 回退：仅添加 WS_THICKFRAME 不做子类化
                try:
                    style = user32.GetWindowLongW(hwnd, -16)
                    style |= 0x00040000  # WS_THICKFRAME
                    user32.SetWindowLongW(hwnd, -16, style)
                    user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0, 0x0020 | 0x0002 | 0x0001 | 0x0004)
                    log(f"_enable_frameless_resize: fallback WS_THICKFRAME only, hwnd={hwnd}")
                except Exception as e2:
                    log(f"_enable_frameless_resize: fallback also failed: {e2}")

        # ===== 系统托盘图标 =====
        _tray_icon_ref = [None]

        def _start_tray_icon():
            """启动系统托盘图标（后台线程中运行，阻塞）"""
            try:
                import pystray
            except Exception as e:
                log(f"tray: pystray import failed: {type(e).__name__}: {e}")
                return
            try:
                from PIL import Image
            except Exception as e:
                log(f"tray: PIL import failed: {type(e).__name__}: {e}")
                return

            # 加载图标
            icon_path = os.path.join(app_dir, "static", "images", "icon.ico")
            try:
                image = Image.open(icon_path) if os.path.isfile(icon_path) else Image.new('RGB', (64, 64), color=(99, 102, 241))
            except Exception:
                image = Image.new('RGB', (64, 64), color=(99, 102, 241))

            def on_show(icon, item):
                try:
                    wins = webview.windows
                    if wins:
                        wins[0].show()
                        wins[0].restore()
                except Exception as e:
                    log(f"tray on_show error: {e}")

            def on_quit(icon, item):
                try:
                    icon.stop()
                    wins = webview.windows
                    if wins:
                        wins[0].destroy()
                except Exception as e:
                    log(f"tray on_quit error: {e}")

            menu = pystray.Menu(
                pystray.MenuItem("显示窗口", on_show, default=True),
                pystray.MenuItem("退出 NOVAI", on_quit)
            )
            icon = pystray.Icon("NOVAI", image, "NOVAI", menu)
            _tray_icon_ref[0] = icon
            log("tray icon started")
            icon.run()

        # 读版本号
        version = "1.0"
        version_file = os.path.join(app_dir, "VERSION")
        if os.path.isfile(version_file):
            try:
                with open(version_file, encoding="utf-8") as f:
                    version = f.read().strip()
            except Exception:
                pass

        api = Api()

        # macOS vs Windows: 不同的窗口样式
        if os.name == 'nt':
            frameless = True
            easy_drag = False
        else:
            frameless = False  # macOS: 原生标题栏，带红绿灯
            easy_drag = False

        window = webview.create_window(
            title="",
            url=URL,
            width=1400,
            height=900,
            min_size=(1200, 800),
            resizable=True,
            fullscreen=False,
            frameless=frameless,
            easy_drag=easy_drag,
            js_api=api,
        )

        # macOS: 尽早把标题栏容器刷透明，否则启动瞬间会闪 pywebview 设的固定灰条
        # （主题色要等页面加载后由 delayed_mac_setup / theme.js 同步，透明化与主题无关）
        if os.name != 'nt':
            try:
                from Cocoa import NSColor
                _native_win = getattr(window, 'native', None)
                if _native_win is not None:
                    _frame = _native_win.contentView().superview()
                    if _frame is not None:
                        for _sub in _frame.subviews():
                            if 'Titlebar' in str(_sub.className()) and _sub.respondsToSelector_('setBackgroundColor:'):
                                _sub.setBackgroundColor_(NSColor.clearColor())
            except Exception as e:
                log(f"macOS early titlebar clear skipped: {e}")

        # macOS 惯例：红灯 / Cmd+W = 最小化到程序坞（不退出软件）；
        # 真退出走 Cmd+Q / 程序坞右键“退出”——applicationShouldTerminate_ 放行，
        # 且 NSApp terminate 不经过 windowShouldClose_，不会被这里的最小化拦截。
        # 仅 Mac 生效；Windows 的 closeToTray 逻辑不受影响（本块本来只在非 nt 执行）。
        if os.name != 'nt':
            def on_closing():
                # pywebview 语义：closing 事件返回 False = 取消本次关闭。
                # 取消后改为把窗口最小化到 Dock（windowShouldClose_ 在 AppKit 主线程触发，可直接调）。
                try:
                    native = getattr(window, 'native', None)
                    if native is not None:
                        native.miniaturize_(None)
                except Exception as e:
                    log(f"macOS miniaturize-on-close error: {e}")
                return False

            def on_closed():
                os._exit(0)  # 窗口真正销毁时兜底退出进程（红灯已被拦截，正常走不到这里）

            window.events.closing += on_closing
            window.events.closed += on_closed

        # 启动系统托盘图标（后台线程）
        # 仅 Windows：pystray 的 macOS 后端会创建 NSWindow/NSStatusItem，
        # macOS 强制要求 UI 对象在主线程实例化，子线程启动会直接 EXC_BREAKPOINT 崩溃。
        # Mac 端关窗即退出 / Cmd+Q 退出已单独处理，托盘非必需。
        if os.name == 'nt':
            threading.Thread(target=_start_tray_icon, daemon=True).start()
        else:
            log("macOS: skip pystray tray icon (NSWindow must be on main thread)")

        # Windows: 移除标题栏 + 补 resize 边框
        if os.name == "nt":
            threading.Thread(target=lambda: _enable_frameless_resize(retries=30, delay=0.3), daemon=True).start()

        # macOS: 延迟设置 FullSizeContentView + 透明标题栏 + 背景拖动
        if os.name != 'nt':
            def delayed_mac_setup():
                import time as _time
                _time.sleep(1.2)  # 等 webview.start() 创建 NSWindow
                try:
                    from Cocoa import NSApp, NSObject, NSColor

                    def _read_page_bg_rgb():
                        """从主壳页面读 body 计算背景色（sRGB 0-1）；读不到回退默认亮主题 --bg"""
                        import re as _re
                        for _ in range(8):
                            try:
                                bg = window.evaluate_js(
                                    "document.body ? getComputedStyle(document.body).backgroundColor : ''"
                                )
                                m = _re.match(r"rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)", str(bg or ""))
                                if m:
                                    return tuple(float(v) / 255.0 for v in m.groups())
                            except Exception:
                                pass
                            _time.sleep(0.4)
                        return (245 / 255, 245 / 255, 247 / 255)

                    # 在子线程取色；勿放 setupWindow_ 主线程里 evaluate_js，会死锁
                    initial_rgb = _read_page_bg_rgb()
                    log(f"macOS: initial window bg rgb={tuple(round(v, 4) for v in initial_rgb)}")

                    # NSWindow 操作必须在主线程执行（macOS 26 下子线程调用会 EXC_BREAKPOINT 崩溃），
                    # 因此封装到 NSObject helper 中，通过 performSelectorOnMainThread 派发。
                    class _NOVAIAppEventDelegate(NSObject):
                        """应用层事件兜底：frozen(PyInstaller) 构建里 ObjC 类 "AppDelegate" 会重复定义
                        （启动日志可见 "AppDelegate is overriding existing Objective-C class"），
                        导致 NSApp delegate 损坏——Dock 点图标窗口不恢复、Cmd+Q 被系统判“用户取消”。
                        用独立命名的干净实现替换掉它（名字带 NOVAI 前缀，避开重名冲突）。"""

                        def applicationShouldHandleReopen_hasVisibleWindows_(self, app, hasVisible):
                            # Dock 图标点击：把最小化的主窗口恢复出来并前置
                            try:
                                for w in list(app.windows()):
                                    try:
                                        if w.isMiniaturized():
                                            w.deminiaturize_(None)
                                    except Exception:
                                        pass
                                app.activateIgnoringOtherApps_(True)
                            except Exception:
                                pass
                            return True

                        def applicationShouldTerminate_(self, app):
                            # 放行退出；窗口关闭清理由 pywebview 的 WindowDelegate 正常处理
                            return True

                    class _MacWindowHelper(NSObject):
                        def setupWindow_(self, win):
                            try:
                                # 0. 先修复应用层 delegate（详见 _NOVAIAppEventDelegate 注释）
                                try:
                                    delegate = _NOVAIAppEventDelegate.alloc().init()
                                    NSApp.setDelegate_(delegate)
                                    delayed_mac_setup._app_delegate = delegate  # 保持引用防 GC
                                    log("macOS: app delegate repaired (reopen/terminate)")
                                except Exception as e:
                                    log(f"macOS app delegate repair error: {e}")

                                # 1. 启用 fullSizeContentView — 内容区域延伸至标题栏区域
                                style = win.styleMask()
                                style |= (1 << 15)  # NSWindowStyleMaskFullSizeContentView = 32768
                                win.setStyleMask_(style)

                                # 2. 标题栏完全透明 (clearColor)，消除黑色 TitleBar
                                win.setTitlebarAppearsTransparent_(True)
                                win.setBackgroundColor_(NSColor.clearColor())
                                win.setOpaque_(False)

                                # 3. 隐藏标题文字 + 背景可拖动窗口
                                win.setTitleVisibility_(1)  # NSWindowTitleHidden
                                win.setMovableByWindowBackground_(True)

                                # 4. 让 WKWebView 铺满整个 contentView（包括标题栏区域）
                                content_view = win.contentView()
                                content_view.setAutoresizesSubviews_(True)
                                cv_bounds = content_view.bounds()
                                for subview in content_view.subviews():
                                    cn = str(subview.className()) if hasattr(subview, 'className') else ''
                                    if 'WK' in cn or 'WebView' in cn:
                                        subview.setFrame_(cv_bounds)
                                        # NSViewWidthSizable(2) | NSViewHeightSizable(16) = 18
                                        subview.setAutoresizingMask_(18)
                                        break

                                # 5. 初始窗口背景色跟随首屏主题（页面实际 --bg），不再用固定色
                                _paint_mac_titlebar(
                                    win,
                                    NSColor.colorWithSRGBRed_green_blue_alpha_(*initial_rgb, 1.0)
                                )

                                # 6. 红绿灯平移：红灯左缘对齐侧栏面板左缘（实测 15，常量 14 抵消 +1pt 偏差），中心与 Header 按钮同线 y=36；
                                #    同时隐藏随容器下移的标题栏装饰视图（顶部亮线来源）
                                self.applyTrafficLights_(None)

                                # 7. 系统 relayout（resize/进出全屏）会复位灯位，监听后重应用（幂等）；
                                #    初始布局也可能晚于本方法完成，延迟补几次
                                try:
                                    from Cocoa import NSNotificationCenter
                                    nc = NSNotificationCenter.defaultCenter()
                                    for _name in (
                                        "NSWindowDidResizeNotification",
                                        "NSWindowDidEnterFullScreenNotification",
                                        "NSWindowDidExitFullScreenNotification",
                                    ):
                                        nc.addObserver_selector_name_object_(
                                            self, "applyTrafficLights:", _name, win
                                        )
                                    for _d in (0.3, 1.0, 2.5):
                                        self.performSelector_withObject_afterDelay_(
                                            "applyTrafficLights:", None, _d
                                        )
                                except Exception as e:
                                    log(f"macOS traffic light observer error: {e}")

                                log("macOS: fullSizeContentView + transparent titlebar + webview extended + traffic lights shifted")
                            except Exception as e:
                                log(f"macOS main-thread window setup error: {e}")

                        def applyTrafficLights_(self, notification):
                            """红绿灯整体平移：左缘到 _MAC_TL_LEFT_X、中心距顶 _MAC_TL_CENTER_Y（幂等；须主线程）。

                            平移对象是按钮容器的父视图（NSTitlebarContainerView），不是按钮
                            容器本身：容器在其内部有布局锚点，直接挪容器会被 AppKit relayout
                            弹回原位（实测 x 方向每次都被弹回默认 7pt）；父视图整体平移时
                            按钮在父视图内的相对位置不动，且天然留在父视图 bounds 内——
                            点击命中不受影响（此前只挪容器导致按钮越出父视图 bounds，
                            hitTest 截断、点击穿透到 webview，表现为"红绿灯点不了"）。
                            所有测量/移动都经 convertPoint 换算到窗口坐标系进行：各层坐标系
                            是否 flipped 不确定，直接读 frame.origin 会算错方向（曾把灯甩出
                            屏幕）。按"当前 → 目标"差值移动，系统 relayout 复位后重复调用
                            也安全；差值超阈值说明测量异常，跳过。
                            """
                            try:
                                win = notification.object() if notification is not None else None
                                if win is None:
                                    _wins = NSApp.windows()
                                    win = _wins[0] if _wins else None
                                if win is None:
                                    return
                                _hide_mac_titlebar_chrome(win)
                                btn = win.standardWindowButton_(0)  # NSWindowCloseButton
                                if btn is None:
                                    return
                                container = btn.superview()
                                if container is None:
                                    return
                                sup = container.superview()
                                if sup is None:
                                    return
                                grand = sup.superview()
                                if grand is None:
                                    return
                                win_h = win.frame().size.height
                                # 灯左缘/中心 → 窗口坐标（y 向上），换算"距窗口顶"距离
                                bf = btn.frame()
                                center_win = btn.convertPoint_toView_(
                                    (bf.size.width / 2.0, bf.size.height / 2.0), None
                                )
                                left_win = btn.convertPoint_toView_((0.0, bf.size.height / 2.0), None).x
                                center_from_top = win_h - center_win.y
                                dx = _MAC_TL_LEFT_X - left_win            # 需右移距离
                                delta = _MAC_TL_CENTER_Y - center_from_top  # 需下移距离（窗口坐标 y 向上为负方向）
                                if abs(dx) < 0.05 and abs(delta) < 0.05:
                                    return
                                if abs(dx) > 80.0 or abs(delta) > 60.0:
                                    log(f"macOS: traffic light dx {round(dx, 2)} / dy {round(delta, 2)}pt over threshold, skip")
                                    return
                                # 父视图原点: 其 superview 坐标 → 窗口坐标，平移后转回
                                sf = sup.frame()
                                origin_win = grand.convertPoint_toView_((sf.origin.x, sf.origin.y), None)
                                new_origin = grand.convertPoint_fromView_(
                                    (origin_win.x + dx, origin_win.y - delta), None
                                )
                                sup.setFrameOrigin_(new_origin)
                                log(f"macOS: traffic lights shifted dx {round(dx, 2)} dy {round(delta, 2)}pt "
                                    f"(left {round(left_win, 2)} -> {_MAC_TL_LEFT_X}, center {round(center_from_top, 2)} -> {_MAC_TL_CENTER_Y})")
                            except Exception as e:
                                log(f"macOS traffic light shift error: {e}")

                    wins = list(NSApp.windows())
                    if wins:
                        win = wins[0]

                        # 派发到主线程执行窗口操作（waitUntilDone=True 阻塞等待完成）
                        helper = _MacWindowHelper.alloc().init()
                        delayed_mac_setup._helper = helper  # 保持引用防止 GC
                        helper.performSelectorOnMainThread_withObject_waitUntilDone_(
                            'setupWindow:', win, True
                        )

                except Exception as e:
                    log(f"macOS delayed setup error: {e}")

            threading.Thread(target=delayed_mac_setup, daemon=True).start()

        webview.start()
    except Exception:
        # pywebview 不可用时回退到系统浏览器
        import webbrowser
        webbrowser.open(URL)
        # 保持进程存活
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()