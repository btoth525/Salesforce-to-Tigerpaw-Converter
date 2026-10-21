#!/usr/bin/env python3
"""
tp-agent: a tiny local bridge that runs on the TigerPaw server
under the owner's own Windows account, in his interactive session.

It exposes a small token-authenticated JSON-over-HTTP API so Papi can:
  - ping / health
  - take screenshots of the server desktop
  - click, type, and send keys with REAL local input (SendInput)
  - list / focus windows
  - run PowerShell commands locally (run_ps)

Stdlib only. Python 3.8+ (embeddable 3.11 on Server 2012 R2).
Config: tp_agent_config.json next to this file: {"token": "...", "port": 8799}
Log:    tp_agent.log next to this file.
"""
import base64
import ctypes
import ctypes.wintypes as wt
import json
import os
import struct
import subprocess
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "0.2.1"
HERE = os.path.dirname(os.path.abspath(__file__))
CFG_PATH = os.path.join(HERE, "tp_agent_config.json")
LOG_PATH = os.path.join(HERE, "tp_agent.log")

try:
    with open(CFG_PATH, "r", encoding="utf-8-sig") as f:
        CFG = json.load(f)
except Exception:
    CFG = {}
TOKEN = str(CFG.get("token", ""))
PORT = int(CFG.get("port", 8799))
BIND = str(CFG.get("bind", "127.0.0.1"))

_log_lock = threading.Lock()


def log(msg):
    line = "%s %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    try:
        with _log_lock:
            with open(LOG_PATH, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except Exception:
        pass


# --------------------------------------------------------------------------
# Win32 input (SendInput)
# --------------------------------------------------------------------------
user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_ABSOLUTE = 0x8000
SM_CXSCREEN = 0
SM_CYSCREEN = 1


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wt.LONG), ("dy", wt.LONG), ("mouseData", wt.DWORD),
                ("dwFlags", wt.DWORD), ("time", wt.DWORD),
                ("dwExtraInfo", ctypes.c_void_p)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD),
                ("time", wt.DWORD), ("dwExtraInfo", ctypes.c_void_p)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wt.DWORD), ("wParamL", wt.WORD), ("wParamH", wt.WORD)]


class INPUT_UNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wt.DWORD), ("u", INPUT_UNION)]


user32.SendInput.argtypes = [wt.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
user32.SendInput.restype = wt.UINT


def _send(inputs):
    arr = (INPUT * len(inputs))(*inputs)
    n = user32.SendInput(len(inputs), arr, ctypes.sizeof(INPUT))
    if n != len(inputs):
        raise OSError("SendInput sent %d of %d inputs" % (n, len(inputs)))


def _mouse(flags, x=0, y=0):
    inp = INPUT()
    inp.type = INPUT_MOUSE
    inp.mi = MOUSEINPUT(x, y, 0, flags, 0, None)
    return inp


def _key_vk(vk, up=False):
    inp = INPUT()
    inp.type = INPUT_KEYBOARD
    inp.ki = KEYBDINPUT(vk, 0, KEYEVENTF_KEYUP if up else 0, 0, None)
    return inp


def _key_unicode(ch, up=False):
    inp = INPUT()
    inp.type = INPUT_KEYBOARD
    flags = KEYEVENTF_UNICODE | (KEYEVENTF_KEYUP if up else 0)
    inp.ki = KEYBDINPUT(0, ord(ch), flags, 0, None)
    return inp


def tool_click(args):
    x = int(args["x"])
    y = int(args["y"])
    button = str(args.get("button", "left")).lower()
    clicks = int(args.get("clicks", 1))
    down, up = {
        "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    }[button]
    sw = user32.GetSystemMetrics(SM_CXSCREEN)
    sh = user32.GetSystemMetrics(SM_CYSCREEN)
    ax = int(x * 65535 / max(1, sw - 1))
    ay = int(y * 65535 / max(1, sh - 1))
    seq = [_mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, ax, ay)]
    for _ in range(clicks):
        seq.append(_mouse(down | MOUSEEVENTF_ABSOLUTE, ax, ay))
        seq.append(_mouse(up | MOUSEEVENTF_ABSOLUTE, ax, ay))
    _send(seq)
    return {"clicked": [x, y], "button": button, "clicks": clicks,
            "screen": [sw, sh]}


def tool_type_text(args):
    text = str(args.get("text", ""))
    per_char_ms = int(args.get("per_char_ms", 0))
    inputs = []
    for ch in text:
        inputs.append(_key_unicode(ch))
        inputs.append(_key_unicode(ch, up=True))
    # Send in chunks so very long strings do not fail as one giant batch.
    sent = 0
    chunk = 200
    for i in range(0, len(inputs), chunk):
        _send(inputs[i:i + chunk])
        sent += len(inputs[i:i + chunk])
        if per_char_ms:
            time.sleep(per_char_ms / 1000.0)
    return {"typed_chars": len(text), "inputs_sent": sent}


VK = {
    "enter": 0x0D, "return": 0x0D, "tab": 0x09, "esc": 0x1B, "escape": 0x1B,
    "backspace": 0x08, "delete": 0x2E, "del": 0x2E, "space": 0x20,
    "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
    "home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
    "insert": 0x2D, "ctrl": 0x11, "control": 0x11, "alt": 0x12,
    "shift": 0x10, "win": 0x5B, "capslock": 0x14,
}
for _i in range(1, 25):
    VK["f%d" % _i] = 0x6F + _i
MODS = {"ctrl": 0x11, "control": 0x11, "alt": 0x12, "shift": 0x10,
        "win": 0x5B}


def _vk_for(token):
    t = token.strip().lower()
    if t in VK:
        return VK[t]
    if len(t) == 1:
        return user32.VkKeyScanW(t) & 0xFF
    raise ValueError("unknown key token: %r" % token)


def tool_key(args):
    spec = str(args.get("key", ""))
    parts = [p for p in spec.replace("+", " ").split(" ") if p]
    if not parts:
        raise ValueError("empty key spec")
    mods = [p.lower() for p in parts[:-1]]
    main = parts[-1]
    seq = []
    for m in mods:
        seq.append(_key_vk(MODS[m]))
    seq.append(_key_vk(_vk_for(main)))
    seq.append(_key_vk(_vk_for(main), up=True))
    for m in reversed(mods):
        seq.append(_key_vk(MODS[m], up=True))
    _send(seq)
    return {"key": spec}


# --------------------------------------------------------------------------
# Screenshot (GDI BitBlt -> BMP)
# --------------------------------------------------------------------------
class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wt.DWORD), ("biWidth", wt.LONG),
                ("biHeight", wt.LONG), ("biPlanes", wt.WORD),
                ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
                ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", wt.LONG),
                ("biYPelsPerMeter", wt.LONG), ("biClrUsed", wt.DWORD),
                ("biClrImportant", wt.DWORD)]


SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0


def tool_screenshot(args):
    w = user32.GetSystemMetrics(SM_CXSCREEN)
    h = user32.GetSystemMetrics(SM_CYSCREEN)
    hdc_screen = user32.GetDC(0)
    try:
        hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
        hbmp = gdi32.CreateCompatibleBitmap(hdc_screen, w, h)
        old = gdi32.SelectObject(hdc_mem, hbmp)
        try:
            gdi32.BitBlt(hdc_mem, 0, 0, w, h, hdc_screen, 0, 0, SRCCOPY)
            bmi = BITMAPINFOHEADER()
            bmi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
            bmi.biWidth = w
            bmi.biHeight = -h  # top-down
            bmi.biPlanes = 1
            bmi.biBitCount = 32
            bmi.biCompression = 0
            buf = ctypes.create_string_buffer(w * h * 4)
            got = gdi32.GetDIBits(hdc_mem, hbmp, 0, h, buf,
                                  ctypes.byref(bmi), DIB_RGB_COLORS)
            if not got:
                raise OSError("GetDIBits failed")
            pixels = buf.raw
        finally:
            gdi32.SelectObject(hdc_mem, old)
            gdi32.DeleteObject(hbmp)
            gdi32.DeleteDC(hdc_mem)
    finally:
        user32.ReleaseDC(0, hdc_screen)
    file_header = struct.pack("<2sIHHI", b"BM", 14 + 40 + len(pixels),
                              0, 0, 14 + 40)
    bmp = file_header + bytes(bmi) + pixels
    return {"width": w, "height": h, "format": "bmp",
            "image_base64": base64.b64encode(bmp).decode("ascii")}


# --------------------------------------------------------------------------
# Windows
# --------------------------------------------------------------------------
def _enum_windows():
    results = []
    WNDENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND,
                                     ctypes.POINTER(ctypes.c_long))

    def cb(hwnd, _lparam):
        if user32.IsWindowVisible(hwnd):
            n = user32.GetWindowTextLengthW(hwnd)
            if n:
                buf = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(hwnd, buf, n + 1)
                rect = wt.RECT()
                user32.GetWindowRect(hwnd, ctypes.byref(rect))
                results.append({
                    "hwnd": int(hwnd), "title": buf.value,
                    "rect": [rect.left, rect.top, rect.right, rect.bottom],
                })
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return results


def tool_window_list(args):
    return {"windows": _enum_windows()}


def tool_focus_window(args):
    needle = str(args.get("title_contains", "")).lower()
    for win in _enum_windows():
        if needle in win["title"].lower():
            hwnd = win["hwnd"]
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            user32.SetForegroundWindow(hwnd)
            return {"focused": win}
    raise ValueError("no visible window title contains %r" % needle)


def tool_foreground(args):
    hwnd = user32.GetForegroundWindow()
    n = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return {"hwnd": int(hwnd), "title": buf.value}


# --------------------------------------------------------------------------
# PowerShell execution (the power tool; token-gated)
# --------------------------------------------------------------------------
def tool_run_ps(args):
    cmd = str(args.get("command", ""))
    timeout = float(args.get("timeout", 120))
    if not cmd.strip():
        raise ValueError("empty command")
    proc = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd],
        capture_output=True, timeout=timeout)
    out = proc.stdout.decode("utf-8", errors="replace")
    err = proc.stderr.decode("utf-8", errors="replace")
    return {"returncode": proc.returncode, "stdout": out[-60000:],
            "stderr": err[-20000:]}


def tool_ping(args):
    return {
        "pong": True, "version": VERSION,
        "hostname": os.environ.get("COMPUTERNAME", ""),
        "user": os.environ.get("USERNAME", ""),
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "pid": os.getpid(),
        "screen": [user32.GetSystemMetrics(SM_CXSCREEN),
                   user32.GetSystemMetrics(SM_CYSCREEN)],
    }


TOOLS = {
    "ping": tool_ping,
    "screenshot": tool_screenshot,
    "click": tool_click,
    "type_text": tool_type_text,
    "key": tool_key,
    "window_list": tool_window_list,
    "focus_window": tool_focus_window,
    "foreground": tool_foreground,
    "run_ps": tool_run_ps,
}


# --------------------------------------------------------------------------
# HTTP server
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):  # keep stderr quiet
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json(200, {"ok": True, "version": VERSION})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/rpc"):
            self._json(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            req = json.loads(raw.decode("utf-8"))
        except Exception as e:
            self._json(400, {"ok": False, "error": "bad request: %s" % e})
            return
        token = req.get("token") or self.headers.get("X-TP-Token", "")
        if not TOKEN or token != TOKEN:
            self._json(403, {"ok": False, "error": "bad token"})
            return
        tool = str(req.get("tool", ""))
        args = req.get("args") or {}
        fn = TOOLS.get(tool)
        if fn is None:
            self._json(404, {"ok": False, "error": "unknown tool %r" % tool,
                             "tools": sorted(TOOLS)})
            return
        try:
            result = fn(args)
            log("tool=%s ok" % tool)
            self._json(200, {"ok": True, "tool": tool, "result": result})
        except Exception as e:
            log("tool=%s ERROR %s" % (tool, e))
            self._json(500, {"ok": False, "tool": tool,
                             "error": "%s: %s" % (type(e).__name__, e),
                             "trace": traceback.format_exc()[-3000:]})


def main():
    if not TOKEN:
        log("FATAL: no token in config; refusing to start")
        print("tp-agent: no token configured in tp_agent_config.json")
        return 2
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    log("tp-agent v%s listening on %s:%d (pid %d)"
        % (VERSION, BIND, PORT, os.getpid()))
    print("tp-agent v%s listening on port %d" % (VERSION, PORT))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
