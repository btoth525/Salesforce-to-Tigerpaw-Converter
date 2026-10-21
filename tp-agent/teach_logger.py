"""Teach-mode recorder v2 for tp-agent — POLLING ONLY, no hooks.
Brandon performs a procedure once in TigerPaw; this records foreground
window changes, mouse clicks (with the control under the point) and
keystrokes as JSONL so Papi can learn the flow. Nothing here sits in the
input path: worst case it misses an event, it can never block one.
Stops on the stop-file, pidfile removal, or after MAX_SECONDS.
"""
import ctypes, json, os, time
from ctypes import wintypes

BASE = r"C:\Users\btoth\tp-agent"
LOG = os.path.join(BASE, "teach-log.jsonl")
PIDF = os.path.join(BASE, "teach.pid")
STOPF = os.path.join(BASE, "teach.stop")
MAX_SECONDS = 20 * 60
POLL = 0.03

u32 = ctypes.windll.user32
k32 = ctypes.windll.kernel32

VK_NAMES = {0x0D: "[ENTER]", 0x09: "[TAB]", 0x1B: "[ESC]", 0x08: "[BKSP]",
            0x2E: "[DEL]", 0x25: "[LEFT]", 0x26: "[UP]", 0x27: "[RIGHT]",
            0x28: "[DOWN]", 0x24: "[HOME]", 0x23: "[END]", 0x21: "[PGUP]",
            0x22: "[PGDN]", 0x2D: "[INS]", 0x14: "[CAPS]", 0x70: "[F1]",
            0x71: "[F2]", 0x72: "[F3]", 0x73: "[F4]", 0x74: "[F5]",
            0x75: "[F6]", 0x76: "[F7]", 0x77: "[F8]", 0x78: "[F9]",
            0x79: "[F10]", 0x7A: "[F11]", 0x7B: "[F12]", 0x20: " "}
MOD_VKS = {0x10, 0x11, 0x12, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C, 0xA6, 0xA7}

def emit(f, t0, obj):
    obj["t"] = round(time.time() - t0, 2)
    f.write(json.dumps(obj, ensure_ascii=False) + "\n")
    f.flush()

def win_text(hwnd):
    # SendMessageTimeout so a hung window can never stall the recorder.
    buf = ctypes.create_unicode_buffer(512)
    res = ctypes.c_void_p()
    ok = u32.SendMessageTimeoutW(hwnd, 0x000D, 512, ctypes.cast(buf, ctypes.c_void_p),
                                 0x0002, 300, ctypes.byref(res))  # WM_GETTEXT, SMTO_ABORTIFHUNG
    return buf.value if ok else ""

def win_class(hwnd):
    buf = ctypes.create_unicode_buffer(128)
    u32.GetClassNameW(hwnd, buf, 128)
    return buf.value

def fg_title():
    h = u32.GetForegroundWindow()
    return win_text(h) if h else ""

def resolve_char(vk):
    state = (ctypes.c_ubyte * 256)()
    for mvk in (0x10, 0xA0, 0xA1):  # SHIFT, LSHIFT, RSHIFT
        if u32.GetAsyncKeyState(mvk) & 0x8000:
            state[0x10] = 0x80
    if u32.GetKeyState(0x14) & 0x0001:  # CAPS LOCK toggled
        state[0x14] = 0x01
    scan = u32.MapVirtualKeyW(vk, 0)
    buf = ctypes.create_unicode_buffer(8)
    n = u32.ToUnicodeEx(vk, scan, state, buf, 8, 0, u32.GetKeyboardLayout(0))
    if n > 0:
        return buf.value[:n]
    return None

def main():
    with open(PIDF, "w") as p:
        p.write(str(os.getpid()))
    if os.path.exists(STOPF):
        os.remove(STOPF)
    f = open(LOG, "a", buffering=1, encoding="utf-8")
    t0 = time.time()
    emit(f, t0, {"type": "session_start", "mode": "poll",
                 "screen": [u32.GetSystemMetrics(0), u32.GetSystemMetrics(1)]})
    last_fg = None
    prev_btn = {1: False, 2: False}  # VK_LBUTTON, VK_RBUTTON
    pt = wintypes.POINT()
    while True:
        if os.path.exists(STOPF) or not os.path.exists(PIDF):
            emit(f, t0, {"type": "session_end", "reason": "stop"})
            return
        if time.time() - t0 > MAX_SECONDS:
            emit(f, t0, {"type": "session_end", "reason": "timeout"})
            return
        title = fg_title()
        if title != last_fg:
            last_fg = title
            emit(f, t0, {"type": "fg", "title": title})
        for vk, name in ((1, "left"), (2, "right")):
            down = bool(u32.GetAsyncKeyState(vk) & 0x8000)
            if down and not prev_btn[vk]:
                u32.GetCursorPos(ctypes.byref(pt))
                hwnd = u32.WindowFromPoint(pt)
                root = u32.GetAncestor(hwnd, 2) if hwnd else None
                emit(f, t0, {"type": "click", "button": name, "x": pt.x, "y": pt.y,
                             "ctl_class": win_class(hwnd) if hwnd else "",
                             "ctl_text": (win_text(hwnd) or "")[:80] if hwnd else "",
                             "win": (win_text(root) or "")[:120] if root else ""})
            prev_btn[vk] = down
        for vk in range(8, 256):
            if vk in (1, 2, 4, 5, 6) or vk in MOD_VKS:
                continue
            if u32.GetAsyncKeyState(vk) & 0x0001:  # pressed since last poll
                if vk in VK_NAMES:
                    emit(f, t0, {"type": "key", "text": VK_NAMES[vk], "fg": title})
                else:
                    ch = resolve_char(vk)
                    if ch and all(ord(c) >= 32 for c in ch):
                        emit(f, t0, {"type": "key", "text": ch, "fg": title})
                    else:
                        emit(f, t0, {"type": "key", "text": "[VK%d]" % vk, "fg": title})
        time.sleep(POLL)

if __name__ == "__main__":
    main()
