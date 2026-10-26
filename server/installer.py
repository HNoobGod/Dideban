"""Settings (config.json) and checking the @dideban mod files.

This folder is the mod itself (the Steam Workshop folder). Its addons/dideban.pbo and
dideban_x64.dll are built and signed once by tools/release.py, so nothing is built or copied here.
The mod needs no other mods: the satellite image is read from the game's own
map files by the server, so grad_meh / Intercept / CBA are not required.

    python server/installer.py --status             show what was detected
"""
import argparse
import json
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config.json"
PBO = ROOT / "addons" / "dideban.pbo"
DLL = ROOT / "dideban_x64.dll"


class Settings:
    DEFAULTS = {"arma_dir": "", "pos_interval": 0.05}

    def __init__(self, path: Path = CONFIG):
        self.path = path
        self.lock = threading.Lock()
        self.data = dict(self.DEFAULTS)
        try:
            self.data.update(json.loads(path.read_text("utf-8")))
        except (OSError, ValueError):
            pass

    def get(self, key, default=None):
        with self.lock:
            return self.data.get(key, default)

    def set(self, **kw):
        with self.lock:
            self.data.update(kw)
            self.path.write_text(json.dumps(self.data, indent=2, ensure_ascii=False), "utf-8")

    def public(self) -> dict:
        """Safe to show on any device."""
        with self.lock:
            return {"pos_interval": self.data.get("pos_interval", 0.05),
                    "all_sides": bool(self.data.get("all_sides", False))}


def arma_dir(settings: Settings):
    p = settings.get("arma_dir")
    if p and Path(p).is_dir():
        return Path(p)
    from satellite import find_arma_dir
    return find_arma_dir()


def status(settings: Settings) -> dict:
    a = arma_dir(settings)
    installed = PBO.is_file() and DLL.is_file()
    return {
        "arma_dir": str(a) if a else "",
        "arma_dir_setting": settings.get("arma_dir"),
        "target": str(ROOT),
        "installed": installed,
        "installed_at": time.strftime("%Y-%m-%d %H:%M", time.localtime(PBO.stat().st_mtime))
        if installed else "",
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--status", action="store_true")
    ap.parse_args()
    print(json.dumps(status(Settings()), indent=2))


if __name__ == "__main__":
    main()
