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
import re
import struct
import subprocess
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "0.4.0"
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
    # Downscale (nearest neighbor) — a full 2560px 32-bit BMP is ~17MB of
    # base64, which chokes the tunnel transfer. Default max width 1400.
    max_w = int(args.get("max_width", 1400))
    step = 1
    if w > max_w:
        step = -(-w // max_w)  # ceil
    ow, oh = w // step, h // step
    if step > 1:
        out = bytearray(ow * oh * 4)
        for oy in range(oh):
            srow = (oy * step) * w * 4
            orow = oy * ow * 4
            for ox in range(ow):
                s = srow + (ox * step) * 4
                d = orow + ox * 4
                out[d:d + 4] = pixels[s:s + 4]
        pixels = bytes(out)
    else:
        ow, oh = w, h
    bmi.biWidth = ow
    bmi.biHeight = -oh
    file_header = struct.pack("<2sIHHI", b"BM", 14 + 40 + len(pixels),
                              0, 0, 14 + 40)
    bmp = file_header + bytes(bmi) + pixels
    return {"width": ow, "height": oh, "format": "bmp",
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


# --------------------------------------------------------------------------
# HWND-level Win32 control tools (v0.3): direct window messages, no pixels.
# WM_GETTEXT / WM_SETTEXT are marshalled by the OS across processes.
# Pointer-carrying messages (CB_GETLBTEXT) go through memory allocated
# inside the target process (VirtualAllocEx + ReadProcessMemory).
# --------------------------------------------------------------------------
kernel32 = ctypes.windll.kernel32

_WM_SETTEXT = 0x000C
_WM_GETTEXT = 0x000D
_WM_GETTEXTLENGTH = 0x000E
_WM_COMMAND = 0x0111
_BM_CLICK = 0x00F5
_BM_GETCHECK = 0x00F0
_BM_SETCHECK = 0x00F1
_CB_GETCOUNT = 0x0146
_CB_GETLBTEXT = 0x0148
_CB_GETLBTEXTLEN = 0x0149
_CB_SETCURSEL = 0x014E
_SMTO_ABORTIFHUNG = 0x0002

user32.SendMessageTimeoutW.argtypes = [
    wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM, wt.UINT, wt.UINT,
    ctypes.POINTER(ctypes.c_size_t)]
user32.SendMessageTimeoutW.restype = ctypes.c_size_t
kernel32.OpenProcess.restype = ctypes.c_void_p
kernel32.VirtualAllocEx.restype = ctypes.c_void_p


def _send_t(hwnd, msg, wp=0, lp=0, timeout=2000):
    res = ctypes.c_size_t(0)
    r = user32.SendMessageTimeoutW(hwnd, msg, wp, lp, _SMTO_ABORTIFHUNG,
                                   timeout, ctypes.byref(res))
    if not r:
        raise OSError("control %s did not answer msg 0x%04x" % (hwnd, msg))
    return res.value


def _win_text(hwnd):
    try:
        n = _send_t(hwnd, _WM_GETTEXTLENGTH, 0, 0, 800)
    except OSError:
        return None
    if n <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(n + 2)
    try:
        _send_t(hwnd, _WM_GETTEXT, n + 2,
                ctypes.cast(buf, ctypes.c_void_p).value, 800)
    except OSError:
        return None
    return buf.value


def _class_name(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def tool_win_tree(args):
    needle = str(args.get("title_contains", "")).lower()
    root_hwnd = None
    for win in _enum_windows():
        if needle in win["title"].lower():
            root_hwnd = win["hwnd"]
            break
    if root_hwnd is None:
        raise ValueError("no top window title contains %r" % needle)
    found = []

    CB = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, ctypes.c_void_p)

    def cb(hwnd, _lp):
        depth = 0
        p = user32.GetParent(hwnd)
        seen = set()
        while p and p != root_hwnd and depth < 30 and p not in seen:
            seen.add(p)
            depth += 1
            p = user32.GetParent(p)
        rect = wt.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        found.append({
            "hwnd": int(hwnd),
            "parent": int(user32.GetParent(hwnd) or 0),
            "depth": depth + 1,
            "class": _class_name(hwnd),
            "text": _win_text(hwnd),
            "id": int(user32.GetDlgCtrlID(hwnd)),
            "visible": bool(user32.IsWindowVisible(hwnd)),
            "enabled": bool(user32.IsWindowEnabled(hwnd)),
            "rect": [rect.left, rect.top, rect.right, rect.bottom],
        })
        return True

    user32.EnumChildWindows(root_hwnd, CB(cb), 0)
    return {"root": root_hwnd, "controls": found}


def tool_get_text(args):
    hwnd = int(args["hwnd"])
    return {"hwnd": hwnd, "text": _win_text(hwnd)}


def tool_set_text(args):
    hwnd = int(args["hwnd"])
    text = str(args.get("text", ""))
    buf = ctypes.create_unicode_buffer(text)
    _send_t(hwnd, _WM_SETTEXT, 0,
            ctypes.cast(buf, ctypes.c_void_p).value, 3000)
    if args.get("notify", True):
        parent = user32.GetParent(hwnd)
        if parent:
            cid = int(user32.GetDlgCtrlID(hwnd))
            cls = _class_name(hwnd).lower()
            notif = 5 if "combo" in cls else 0x0300  # CBN_EDITCHANGE / EN_CHANGE
            user32.PostMessageW(parent, _WM_COMMAND,
                                (notif << 16) | (cid & 0xFFFF), hwnd)
    return {"hwnd": hwnd, "text": _win_text(hwnd)}


def tool_click_ctl(args):
    hwnd = int(args["hwnd"])
    cls = _class_name(hwnd)
    if "button" in cls.lower():
        _send_t(hwnd, _BM_CLICK, 0, 0, 3000)
        return {"hwnd": hwnd, "clicked": "BM_CLICK"}
    rect = wt.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(rect))
    cx = (rect.right - rect.left) // 2
    cy = (rect.bottom - rect.top) // 2
    lp = (cy << 16) | (cx & 0xFFFF)
    user32.PostMessageW(hwnd, 0x0201, 1, lp)   # WM_LBUTTONDOWN
    user32.PostMessageW(hwnd, 0x0202, 0, lp)   # WM_LBUTTONUP
    return {"hwnd": hwnd, "clicked": "mouse-post", "class": cls}


def tool_check_state(args):
    hwnd = int(args["hwnd"])
    return {"hwnd": hwnd, "state": int(_send_t(hwnd, _BM_GETCHECK))}


def tool_set_check(args):
    hwnd = int(args["hwnd"])
    want = 1 if args.get("checked", True) else 0
    _send_t(hwnd, _BM_SETCHECK, want, 0)
    return {"hwnd": hwnd, "state": int(_send_t(hwnd, _BM_GETCHECK))}


def _combo_items(hwnd):
    pid = wt.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    proc = kernel32.OpenProcess(0x0400 | 0x0008 | 0x0010 | 0x0020,
                                 False, pid.value)
    if not proc:
        raise OSError("OpenProcess failed for pid %s" % pid.value)
    items = []
    try:
        count = _send_t(hwnd, _CB_GETCOUNT)
        if count > 10000:
            raise ValueError("combo count implausible: %s" % count)
        for i in range(count):
            ln = _send_t(hwnd, _CB_GETLBTEXTLEN, i, 0)
            size = (ln + 2) * 2
            addr = kernel32.VirtualAllocEx(proc, None, size, 0x3000, 4)
            if not addr:
                raise OSError("VirtualAllocEx failed")
            try:
                _send_t(hwnd, _CB_GETLBTEXT, i, addr)
                buf = ctypes.create_string_buffer(size)
                read = ctypes.c_size_t(0)
                kernel32.ReadProcessMemory(proc, addr, buf, size,
                                           ctypes.byref(read))
                items.append(buf.raw[:ln * 2].decode("utf-16-le",
                                                     errors="replace"))
            finally:
                kernel32.VirtualFreeEx(proc, addr, 0, 0x8000)
    finally:
        kernel32.CloseHandle(proc)
    return items


def tool_combo_items(args):
    hwnd = int(args["hwnd"])
    items = _combo_items(hwnd)
    cur = _win_text(hwnd)
    return {"hwnd": hwnd, "count": len(items), "items": items,
            "current_text": cur}


def tool_combo_select(args):
    hwnd = int(args["hwnd"])
    items = _combo_items(hwnd)
    idx = args.get("index")
    if idx is None:
        want = str(args.get("text", "")).lower()
        idx = -1
        for i, it in enumerate(items):
            if it.lower() == want:
                idx = i
                break
        if idx < 0:
            for i, it in enumerate(items):
                if it.lower().startswith(want):
                    idx = i
                    break
        if idx < 0:
            raise ValueError("no combo item matches %r" % args.get("text"))
    idx = int(idx)
    _send_t(hwnd, _CB_SETCURSEL, idx, 0)
    parent = user32.GetParent(hwnd)
    if parent:
        cid = int(user32.GetDlgCtrlID(hwnd))
        user32.PostMessageW(parent, _WM_COMMAND,
                            (5 << 16) | (cid & 0xFFFF), hwnd)  # CBN_SELCHANGE
    return {"hwnd": hwnd, "selected_index": idx,
            "selected": items[idx] if 0 <= idx < len(items) else None,
            "current_text": _win_text(hwnd)}


# --------------------------------------------------------------------------
# ListView tools (v0.3.1): LVITEM structs marshalled through memory
# allocated in the target process. The target is a 32-bit VB6 process,
# so LVITEM uses the 32-bit ANSI layout (pszText at offset 20).
# --------------------------------------------------------------------------
_LVM_GETITEMCOUNT = 0x1004
_LVM_INSERTITEMA = 0x1007
_LVM_GETHEADER = 0x101F
_LVM_GETITEMTEXTA = 0x102D
_LVM_SETITEMTEXTA = 0x102E
_HDM_GETITEMCOUNT = 0x1200


class _Remote(object):
    def __init__(self, hwnd):
        pid = wt.DWORD(0)
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        self.proc = kernel32.OpenProcess(0x0400 | 0x0008 | 0x0010 | 0x0020,
                                         False, pid.value)
        if not self.proc:
            raise OSError("OpenProcess failed for pid %s" % pid.value)
        self.addrs = []

    def alloc(self, data):
        if isinstance(data, int):
            size, blob = data, None
        else:
            size, blob = len(data), data
        addr = kernel32.VirtualAllocEx(self.proc, None, max(size, 1),
                                       0x3000, 4)
        if not addr:
            raise OSError("VirtualAllocEx failed")
        self.addrs.append(addr)
        if blob:
            self.write(addr, blob)
        return addr

    def write(self, addr, data):
        written = ctypes.c_size_t(0)
        buf = ctypes.create_string_buffer(data, len(data))
        if not kernel32.WriteProcessMemory(self.proc, addr, buf, len(data),
                                           ctypes.byref(written)):
            raise OSError("WriteProcessMemory failed")

    def read(self, addr, size):
        buf = ctypes.create_string_buffer(size)
        got = ctypes.c_size_t(0)
        if not kernel32.ReadProcessMemory(self.proc, addr, buf, size,
                                          ctypes.byref(got)):
            raise OSError("ReadProcessMemory failed")
        return buf.raw[:got.value]

    def close(self):
        for a in self.addrs:
            kernel32.VirtualFreeEx(self.proc, a, 0, 0x8000)
        kernel32.CloseHandle(self.proc)


def _lvitem(remote, iitem, isub, text_addr, text_max=0):
    raw = bytearray(48)
    struct.pack_into("<I", raw, 0, 1)            # mask = LVIF_TEXT
    struct.pack_into("<i", raw, 4, iitem)
    struct.pack_into("<i", raw, 8, isub)
    struct.pack_into("<I", raw, 20, text_addr)   # pszText (32-bit ptr)
    struct.pack_into("<i", raw, 24, text_max)
    return remote.alloc(bytes(raw))


def _list_col_count(hwnd):
    header = _send_t(hwnd, _LVM_GETHEADER)
    if not header:
        return 0
    return int(_send_t(header, _HDM_GETITEMCOUNT))


def tool_list_info(args):
    hwnd = int(args["hwnd"])
    return {"hwnd": hwnd,
            "count": int(_send_t(hwnd, _LVM_GETITEMCOUNT)),
            "columns": _list_col_count(hwnd)}


def tool_list_insert(args):
    hwnd = int(args["hwnd"])
    texts = [str(t) for t in args.get("texts", [])]
    if not texts:
        raise ValueError("texts required")
    remote = _Remote(hwnd)
    try:
        idx = args.get("index")
        if idx is None:
            idx = int(_send_t(hwnd, _LVM_GETITEMCOUNT))
        t0 = remote.alloc(texts[0].encode("mbcs", errors="replace") + b"\x00")
        item = _lvitem(remote, int(idx), 0, t0)
        newidx = _send_t(hwnd, _LVM_INSERTITEMA, 0, item, 3000)
        if newidx > 0x7FFFFFFF:
            raise OSError("LVM_INSERTITEM failed")
        for j, t in enumerate(texts[1:], start=1):
            ta = remote.alloc(t.encode("mbcs", errors="replace") + b"\x00")
            it = _lvitem(remote, int(newidx), j, ta)
            _send_t(hwnd, _LVM_SETITEMTEXTA, int(newidx), it, 3000)
        return {"hwnd": hwnd, "index": int(newidx),
                "count": int(_send_t(hwnd, _LVM_GETITEMCOUNT))}
    finally:
        remote.close()


def tool_list_items(args):
    hwnd = int(args["hwnd"])
    cols = _list_col_count(hwnd) or 1
    cols = min(cols, int(args.get("max_cols", 16)))
    rows = int(_send_t(hwnd, _LVM_GETITEMCOUNT))
    rows = min(rows, int(args.get("max_rows", 50)))
    remote = _Remote(hwnd)
    try:
        out = []
        buf = remote.alloc(1024)
        for i in range(rows):
            row = []
            for j in range(cols):
                item = _lvitem(remote, i, j, buf, 1023)
                _send_t(hwnd, _LVM_GETITEMTEXTA, i, item, 3000)
                raw = remote.read(buf, 1024)
                row.append(raw.split(b"\x00")[0].decode("mbcs",
                                                        errors="replace"))
            out.append(row)
        return {"hwnd": hwnd, "rows": out}
    finally:
        remote.close()


# --------------------------------------------------------------------------
# Read-only TigerPaw database queries (v0.4). SELECT only, enforced in
# layers so a query can never change or corrupt the production data:
#   1. The statement must be a single SELECT (or WITH...SELECT); write
#      keywords are rejected outside string literals/comments.
#   2. It runs inside a transaction that is ALWAYS rolled back.
#   3. Isolation is READ UNCOMMITTED: the query takes no locks on live
#      data, so it cannot block or slow down TigerPaw for anyone.
#   4. Server/database are fixed; auth is Brandon's own Windows login
#      (the same access TigerPaw itself uses from his workstation).
#   5. Every query is appended to db_query.log next to this file so the
#      owner can audit exactly what was asked, and when.
# Values travel as bound parameters (@name), never string-spliced.
# --------------------------------------------------------------------------
DB_CONN = ("Server=asap-tp;Database=Tigerpaw_v11;Integrated Security=True;"
           "ApplicationIntent=ReadOnly;Connect Timeout=10")
DB_LOG_PATH = os.path.join(HERE, "db_query.log")
DB_MAX_ROWS = 1000
_DB_BAD = re.compile(
    r"\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|"
    r"GRANT|REVOKE|DENY|BACKUP|RESTORE|DBCC|SHUTDOWN|KILL|OPENROWSET|"
    r"OPENDATASOURCE|BULK|INTO|WAITFOR)\b", re.I)

_DB_PS = r"""
$ErrorActionPreference = "Stop"
try {
  $j = [System.Text.Encoding]::UTF8.GetString(
    [System.Convert]::FromBase64String("__PAYLOAD__")) | ConvertFrom-Json
  $conn = New-Object System.Data.SqlClient.SqlConnection("__CONN__")
  $conn.Open()
  $tx = $conn.BeginTransaction([System.Data.IsolationLevel]::ReadUncommitted)
  try {
    $cmd = $conn.CreateCommand()
    $cmd.Transaction = $tx
    $cmd.CommandTimeout = 30
    $cmd.CommandText = [string]$j.sql
    foreach ($p in $j.params.PSObject.Properties) {
      $v = $p.Value
      if ($null -eq $v) { $v = [DBNull]::Value }
      [void]$cmd.Parameters.AddWithValue("@" + $p.Name, $v)
    }
    $da = New-Object System.Data.SqlClient.SqlDataAdapter($cmd)
    $dt = New-Object System.Data.DataTable
    [void]$da.Fill($dt)
    $rows = @()
    foreach ($row in $dt.Rows) {
      $o = [ordered]@{}
      foreach ($col in $dt.Columns) {
        $val = $row[$col]
        if ($val -is [DBNull]) { $val = $null }
        elseif ($val -is [datetime]) {
          $val = $val.ToString("yyyy-MM-dd HH:mm:ss") }
        elseif ($val -is [byte[]]) {
          $val = "<bytes " + $val.Length + ">" }
        $o[$col.ColumnName] = $val
      }
      $rows += [pscustomobject]$o
      if ($rows.Count -ge __MAXROWS__) { break }
    }
    $out = @{ rows = $rows; rowcount = $rows.Count;
              truncated = ($dt.Rows.Count -gt $rows.Count) } |
      ConvertTo-Json -Depth 4 -Compress
    Write-Output ("DBJSON:" + $out)
  } finally {
    $tx.Rollback()
    $conn.Close()
  }
} catch {
  Write-Output ("DBJSON:" + (@{ error = $_.Exception.Message } |
    ConvertTo-Json -Compress))
}
"""


def _strip_sql_literals(sql):
    out = []
    i = 0
    n = len(sql)
    while i < n:
        c = sql[i]
        if c == "'":
            i += 1
            while i < n:
                if sql[i] == "'":
                    if i + 1 < n and sql[i + 1] == "'":
                        i += 2
                        continue
                    i += 1
                    break
                i += 1
            out.append("''")
        elif c == "-" and i + 1 < n and sql[i + 1] == "-":
            while i < n and sql[i] not in "\r\n":
                i += 1
        elif c == "/" and i + 1 < n and sql[i + 1] == "*":
            i += 2
            while i + 1 < n and not (sql[i] == "*" and sql[i + 1] == "/"):
                i += 1
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _validate_select(sql):
    if not isinstance(sql, str) or not sql.strip():
        raise ValueError("empty sql")
    probe = _strip_sql_literals(sql)
    body = probe.strip().rstrip(";").strip()
    if ";" in body:
        raise ValueError("multiple statements are not allowed")
    if not re.match(r"(?is)^(SELECT|WITH)\b", body):
        raise ValueError("only SELECT queries are allowed")
    m = _DB_BAD.search(body)
    if m:
        raise ValueError("forbidden keyword in query: %s" % m.group(1).upper())
    return sql.strip().rstrip(";")


def tool_db_query(args):
    sql = _validate_select(args.get("sql", ""))
    params = args.get("params") or {}
    if not isinstance(params, dict):
        raise ValueError("params must be an object")
    for k in params:
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", str(k)):
            raise ValueError("bad param name: %r" % k)
    timeout = int(args.get("timeout", 30))
    timeout = max(5, min(timeout, 120))
    payload = {"sql": sql, "params": params}
    b64 = base64.b64encode(
        json.dumps(payload).encode("utf-8")).decode("ascii")
    ps = (_DB_PS.replace("__PAYLOAD__", b64)
                .replace("__CONN__", DB_CONN)
                .replace("__MAXROWS__", str(DB_MAX_ROWS)))
    proc = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
        capture_output=True, timeout=timeout + 30)
    out = proc.stdout.decode("utf-8", errors="replace")
    err = proc.stderr.decode("utf-8", errors="replace")
    try:
        with open(DB_LOG_PATH, "a", encoding="utf-8") as f:
            f.write("%s | %s | params=%s\n" % (
                time.strftime("%Y-%m-%d %H:%M:%S"), sql,
                json.dumps(params)[:500]))
    except Exception:
        pass
    line = [l for l in out.splitlines() if l.strip().startswith("DBJSON:")]
    if not line:
        raise RuntimeError("db query failed: %s %s" % (
            err.strip()[-500:], out.strip()[-500:]))
    result = json.loads(line[-1][len("DBJSON:"):])
    if isinstance(result, dict) and result.get("error"):
        raise RuntimeError("db query error: %s" % result["error"])
    return result


TOOLS = {
    "ping": tool_ping,
    "db_query": tool_db_query,
    "screenshot": tool_screenshot,
    "click": tool_click,
    "type_text": tool_type_text,
    "key": tool_key,
    "window_list": tool_window_list,
    "focus_window": tool_focus_window,
    "foreground": tool_foreground,
    "run_ps": tool_run_ps,
    "win_tree": tool_win_tree,
    "get_text": tool_get_text,
    "set_text": tool_set_text,
    "click_ctl": tool_click_ctl,
    "check_state": tool_check_state,
    "set_check": tool_set_check,
    "combo_items": tool_combo_items,
    "combo_select": tool_combo_select,
    "list_info": tool_list_info,
    "list_insert": tool_list_insert,
    "list_items": tool_list_items,
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
