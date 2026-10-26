"""Re-tiles a satellite image into a JPEG pyramid for the web map.

The tiles are produced by satextract.py straight from the game's own map files
(sat/<col>/<row>.png + meta.json, origin top-left = north-west). We cut that into
256 px tiles at native resolution and every halving below it:

    cache/sat/<world>/info.json
    cache/sat/<world>/<level>/<x>_<y>.jpg     level 0 = whole map in one tile, `top` = native
"""
import gzip
import json
import logging
import math
import shutil
import threading
import time
from pathlib import Path

from terrain import world_key

log = logging.getLogger("dideban.sat")
TILE = 256

try:
    from PIL import Image, ImageFile
    Image.MAX_IMAGE_PIXELS = None  # satellite tiles are legitimately huge
    ImageFile.LOAD_TRUNCATED_IMAGES = True  # tolerate a partially-written source tile
except ImportError:  # pragma: no cover
    Image = None


def find_arma_dir() -> Path | None:
    try:
        import winreg
        for root, key in ((winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Bohemia Interactive\arma 3"),
                          (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Bohemia Interactive\arma 3")):
            try:
                with winreg.OpenKey(root, key) as k:
                    p = Path(winreg.QueryValueEx(k, "main")[0])
                    if p.is_dir():
                        return p
            except OSError:
                continue
    except ImportError:
        pass
    return None


def read_dem(path: Path, offset: float = 0.0, max_n: int = 1024) -> dict:
    """Reads grad_meh's gzipped ESRI ASCII grid into {n, step, heights} (rows south -> north),
    the same layout as our own terrain export, downsampled to at most max_n samples per side."""
    with gzip.open(path, "rt", encoding="ascii", errors="replace") as f:
        header = {}
        line = f.readline()
        while line and line.split() and line.split()[0][0].isalpha():
            k, v = line.split()[:2]
            header[k.lower()] = float(v)
            line = f.readline()
        ncols, nrows = int(header["ncols"]), int(header["nrows"])
        cell = header["cellsize"]
        nodata = header.get("nodata_value")
        stride = max(1, math.ceil(max(ncols, nrows) / max_n))
        rows = []
        r = 0
        while line:
            if r % stride == 0:
                vals = line.split()[::stride]
                rows.append([0 if nodata is not None and float(v) == nodata else round(float(v) + offset) for v in vals])
            r += 1
            line = f.readline()
    n = len(rows[0]) if rows else 0
    if not n:
        raise ValueError("empty DEM")
    rows = [row[:n] + [0] * (n - len(row)) for row in rows][:n]
    while len(rows) < n:
        rows.insert(0, [0] * n)
    rows.reverse()  # the file starts at the north edge
    return {"n": n, "step": cell * stride, "heights": [h for row in rows for h in row]}


def _source_grid(sat_dir: Path):
    """Returns ({(col,row): path}, cols, rows) or None if the export is incomplete."""
    cols = sorted(int(p.name) for p in sat_dir.iterdir() if p.is_dir() and p.name.isdigit())
    if not cols:
        return None
    grid = {}
    rows = None
    for c in cols:
        rs = sorted(int(p.stem) for p in (sat_dir / str(c)).glob("*.png") if p.stem.isdigit())
        if rows is None:
            rows = rs
        if not rs or rs != rows:
            return None
        for r in rs:
            grid[(c, r)] = sat_dir / str(c) / f"{r}.png"
    return grid, len(cols), len(rows)


class SatelliteStore:
    def __init__(self, cache_dir: Path, arma_dir: Path | None, on_change):
        self.cache = cache_dir / "sat"
        self.cache.mkdir(parents=True, exist_ok=True)
        self.arma_dir = arma_dir
        self.on_change = on_change  # called (from any thread) when the map list changes
        self.lock = threading.Lock()
        self.building: dict[str, float] = {}  # world key -> progress 0..1
        self.failed: dict[str, str] = {}

    @property
    def available(self) -> bool:
        return Image is not None

    def source_root(self) -> Path | None:
        return self.arma_dir / "grad_meh" if self.arma_dir else None

    def sources(self) -> dict[str, Path]:
        root = self.source_root()
        out = {}
        if root and root.is_dir():
            for d in root.iterdir():
                if (d / "meta.json").is_file() and (d / "sat").is_dir():
                    out[world_key(d.name)] = d
        return out

    def info(self, world: str) -> dict | None:
        p = self.cache / world_key(world) / "info.json"
        try:
            return json.loads(p.read_text("utf-8"))
        except (OSError, ValueError):
            return None

    def dem_path(self, world: str) -> Path:
        return self.cache / world_key(world) / "dem.json"

    def tile_path(self, world: str, level: int, x: int, y: int) -> Path:
        return self.cache / world_key(world) / str(level) / f"{x}_{y}.jpg"

    def status(self, world: str) -> dict:
        key = world_key(world)
        with self.lock:
            if key in self.building:
                return {"state": "building", "progress": self.building[key]}
            if key in self.failed:
                return {"state": "failed", "error": self.failed[key]}
        if self.info(key):
            return {"state": "ready"}
        return {"state": "none"}

    def scan(self) -> None:
        """Starts building any finished grad_meh export that has no tiles yet."""
        if not self.available:
            return
        for key, src in self.sources().items():
            with self.lock:
                busy = key in self.building or key in self.failed
            if busy or self.info(key):
                continue
            # grad_meh writes files over several minutes; wait until nothing changed for 20 s.
            newest = max((p.stat().st_mtime for p in src.rglob("*") if p.is_file()), default=0)
            if time.time() - newest < 20:
                continue
            self.build(key, src)

    def build(self, key: str, src: Path) -> None:
        with self.lock:
            if key in self.building:
                return
            self.building[key] = 0.0
            self.failed.pop(key, None)
        threading.Thread(target=self._build, args=(key, src), daemon=True).start()
        self.on_change()

    @staticmethod
    def _term_bar(key: str, frac: float, done: bool = False, failed: bool = False) -> None:
        """A live progress bar for the satellite build, printed in the server terminal."""
        width = 30
        frac = max(0.0, min(1.0, frac))
        filled = int(round(frac * width))
        bar = "#" * filled + "." * (width - filled)
        tail = "  done\n" if done else ("  FAILED\n" if failed else "")
        print(f"\r  satellite {key}: [{bar}] {frac * 100:5.1f}%{tail}", end="", flush=True)

    def _build(self, key: str, src: Path) -> None:
        out = self.cache / key
        try:
            meta = json.loads((src / "meta.json").read_text("utf-8"))
            found = _source_grid(src / "sat")
            if not found:
                raise ValueError("satellite export is incomplete")
            grid, ncols, nrows = found

            def _dim(path, axis):
                try:
                    with Image.open(path) as im:
                        return im.size[axis]
                except Exception:
                    return TILE
            # Pixel offsets of each source column/row (tolerant of an unreadable header).
            widths = [_dim(grid[(c, 0)], 0) for c in range(ncols)]
            heights = [_dim(grid[(0, r)], 1) for r in range(nrows)]
            ox = [sum(widths[:c]) for c in range(ncols)]
            oy = [sum(heights[:r]) for r in range(nrows)]
            W, H = sum(widths), sum(heights)
            top = max(0, math.ceil(math.log2(max(W, H) / TILE)))
            log.info("building satellite tiles for %s: %dx%d px, %d levels", key, W, H, top + 1)

            tmp = out.with_name(key + ".building")
            if tmp.exists():
                shutil.rmtree(tmp)
            tmp.mkdir(parents=True)
            total = ncols * nrows * (top + 1)
            done = 0
            for (c, r), path in sorted(grid.items()):
                try:
                    with Image.open(path) as im:
                        src_img = im.convert("RGB")
                except Exception as e:
                    log.warning("source tile unreadable (%s): %s; using a blank tile", path, e)
                    src_img = Image.new("RGB", (widths[c], heights[r]), (58, 70, 98))
                for level in range(top, -1, -1):
                    f = 1 / (2 ** (top - level))
                    x0, y0 = ox[c] * f, oy[r] * f
                    w = max(1, round(widths[c] * f))
                    h = max(1, round(heights[r] * f))
                    part = src_img if f == 1 else src_img.resize((w, h), Image.LANCZOS)
                    self._paste(tmp / str(level), part, round(x0), round(y0))
                    if f != 1:
                        src_img = part  # next level downsamples this one (cheaper)
                    done += 1
                    frac = done / total
                    with self.lock:
                        self.building[key] = frac
                    self._term_bar(key, frac)
                del src_img
                self.on_change()

            levels = []
            for level in range(top + 1):
                f = 1 / (2 ** (top - level))
                lw, lh = max(1, round(W * f)), max(1, round(H * f))
                levels.append({"w": lw, "h": lh, "cols": math.ceil(lw / TILE), "rows": math.ceil(lh / TILE)})
            has_dem = False
            dem_file = src / "dem.asc.gz"
            if dem_file.is_file():
                try:
                    dem = read_dem(dem_file, float(meta.get("elevationOffset", 0) or 0))
                    (tmp / "dem.json").write_text(json.dumps(dem, separators=(",", ":")), "utf-8")
                    has_dem = True
                except (OSError, ValueError) as e:
                    log.warning("could not read %s: %s", dem_file, e)
            info = {"world": meta.get("worldName", key), "desc": meta.get("displayName", ""),
                    "worldSize": meta.get("worldSize"), "tile": TILE, "top": top, "levels": levels,
                    "gridOffsetX": meta.get("gridOffsetX", 0), "gridOffsetY": meta.get("gridOffsetY", 0),
                    "dem": has_dem, "ts": int(time.time())}  # build version, for browser cache-busting
            (tmp / "info.json").write_text(json.dumps(info), "utf-8")
            if out.exists():
                shutil.rmtree(out)
            tmp.rename(out)
            self._term_bar(key, 1.0, done=True)
            log.info("satellite tiles ready for %s", key)
        except Exception as e:
            self._term_bar(key, 0.0, failed=True)
            log.exception("satellite build failed for %s", key)
            with self.lock:
                self.failed[key] = str(e)
        finally:
            with self.lock:
                self.building.pop(key, None)
            self.on_change()

    @staticmethod
    def _paste(level_dir: Path, img, x0: int, y0: int) -> None:
        """Pastes img at pixel (x0, y0) of the level into its 256 px tiles (merging at seams)."""
        level_dir.mkdir(exist_ok=True)
        w, h = img.size
        for ty in range(y0 // TILE, (y0 + h - 1) // TILE + 1):
            for tx in range(x0 // TILE, (x0 + w - 1) // TILE + 1):
                p = level_dir / f"{tx}_{ty}.jpg"
                if p.exists():  # tile on a seam between source images: keep what is already there
                    with Image.open(p) as old:
                        tile = old.convert("RGB")
                else:
                    tile = Image.new("RGB", (TILE, TILE), (58, 70, 98))
                bx, by = tx * TILE - x0, ty * TILE - y0
                crop = img.crop((max(0, bx), max(0, by), min(w, bx + TILE), min(h, by + TILE)))
                tile.paste(crop, (max(0, -bx), max(0, -by)))
                tile.save(p, "JPEG", quality=85)
