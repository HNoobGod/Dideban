"""Live picture from the game: captures the Arma 3 window and serves it as MJPEG streams.

    game    the whole Arma window (what the player sees)
    helmet  only the picture-in-picture box the mod draws for another unit's helmet cam

Arma cannot hand its rendered frames to an outside program, so this captures the screen.
Works with Arma in Windowed or Borderless mode; exclusive fullscreen may capture black.
Capturing only runs while someone is watching a stream.
"""
import ctypes
import io
import logging
import sys
import threading
import time

log = logging.getLogger("dideban.capture")

try:
    import mss
    from PIL import Image, ImageDraw
    _MSS = getattr(mss, "MSS", None) or mss.mss
except ImportError:  # pragma: no cover
    mss = None

MAX_WIDTH = {"game": 1280, "helmet": 960}


def _dpi_aware():
    if sys.platform != "win32":
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # coordinates in real pixels
    except (AttributeError, OSError):
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except (AttributeError, OSError):
            pass


def find_arma_client_rect():
    """Screen rectangle (left, top, width, height) of the Arma window's client area, or None."""
    if sys.platform != "win32":
        return None
    from ctypes import wintypes
    user32 = ctypes.windll.user32
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            n = user32.GetWindowTextLengthW(hwnd)
            if n:
                buf = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(hwnd, buf, n + 1)
                if buf.value == "Arma 3" or buf.value.startswith("Arma 3 "):
                    found.append(hwnd)
        return True

    user32.EnumWindows(cb, 0)
    for hwnd in found:
        if user32.IsIconic(hwnd):
            continue
        rc = wintypes.RECT()
        user32.GetClientRect(hwnd, ctypes.byref(rc))
        pt = wintypes.POINT(0, 0)
        user32.ClientToScreen(hwnd, ctypes.byref(pt))
        if rc.right > 50 and rc.bottom > 50:
            return pt.x, pt.y, rc.right, rc.bottom
    return None


class Capturer:
    def __init__(self, fps: float = 12):
        self.available = mss is not None
        self.fps = fps
        self.cond = threading.Condition()
        self.frames = {"game": None, "helmet": None}  # name -> (seq, jpeg bytes)
        self.seq = 0
        self.viewers = {"game": 0, "helmet": 0}
        self.helmet = None  # (x, y, w, h, resW, resH) in game pixels, from the mod
        self.thread = None

    # ---- the mod tells us where the helmet-cam box is drawn
    def set_helmet_rect(self, rect):
        with self.cond:
            self.helmet = rect

    def add_viewer(self, name: str, delta: int):
        with self.cond:
            self.viewers[name] = max(0, self.viewers[name] + delta)
            if self.available and self.thread is None:
                self.thread = threading.Thread(target=self._run, daemon=True)
                self.thread.start()

    def wait_frame(self, name: str, last_seq: int, timeout: float = 5):
        with self.cond:
            self.cond.wait_for(lambda: self.frames[name] and self.frames[name][0] != last_seq, timeout)
            return self.frames[name]

    # ---- capture loop
    def _publish(self, name, jpg):
        with self.cond:
            self.seq += 1
            self.frames[name] = (self.seq, jpg)
            self.cond.notify_all()

    @staticmethod
    def _jpeg(img, name):
        mw = MAX_WIDTH[name]
        if img.width > mw:
            img = img.resize((mw, round(img.height * mw / img.width)), Image.BILINEAR)
        out = io.BytesIO()
        img.save(out, "JPEG", quality=72)
        return out.getvalue()

    @staticmethod
    def _placeholder(text):
        img = Image.new("RGB", (640, 360), (16, 19, 22))
        d = ImageDraw.Draw(img)
        d.text((20, 165), text, fill=(232, 232, 232))
        out = io.BytesIO()
        img.save(out, "JPEG", quality=80)
        return out.getvalue()

    def _run(self):
        _dpi_aware()
        sct = _MSS()
        last_placeholder = 0
        while True:
            with self.cond:
                watching = {k for k, v in self.viewers.items() if v > 0}
                helmet = self.helmet
            if not watching:
                time.sleep(0.2)
                continue
            t0 = time.time()
            rect = find_arma_client_rect()
            if rect is None:
                if t0 - last_placeholder > 1:
                    last_placeholder = t0
                    msg = self._placeholder("Arma 3 window not found or minimized (use Windowed or Borderless mode)")
                    for name in watching:
                        self._publish(name, msg)
                time.sleep(0.5)
                continue
            left, top, w, h = rect
            try:
                shot = sct.grab({"left": left, "top": top, "width": w, "height": h})
                img = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
            except Exception as e:  # screen locked, window moved off-screen, ...
                log.debug("capture failed: %s", e)
                time.sleep(0.5)
                continue
            if "game" in watching:
                self._publish("game", self._jpeg(img, "game"))
            if "helmet" in watching:
                if helmet:
                    x, y, hw, hh, rw, rh = helmet
                    sx, sy = w / max(1, rw), h / max(1, rh)  # game pixels -> window pixels
                    box = (round(x * sx), round(y * sy), round((x + hw) * sx), round((y + hh) * sy))
                    self._publish("helmet", self._jpeg(img.crop(box), "helmet"))
                elif t0 - last_placeholder > 1:
                    last_placeholder = t0
                    self._publish("helmet", self._placeholder("Starting helmet camera..."))
            time.sleep(max(0.0, 1 / self.fps - (time.time() - t0)))
