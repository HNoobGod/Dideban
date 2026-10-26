"""Satellite imagery straight from the game's own map files (no grad_meh / Intercept, no screenshots).

The satellite texture of every terrain is stored as DXT1 PAA tiles named
``s_<row>_<col>_lco.paa`` inside that map's ``map_<world>_data_layers*.pbo``.
We read those PBOs, decode the PAA/DXT1 (LZO-decompressing the full-resolution mip),
and write the tiles into a grad_meh-style folder so the existing SatelliteStore.build
pipeline can turn them into the web map's JPEG pyramid.
"""
import logging
import re
import struct
from pathlib import Path

try:
    from PIL import Image, ImageStat, ImageChops
except ImportError:  # pragma: no cover
    Image = None

log = logging.getLogger("dideban.satextract")
_TILE_RE = re.compile(r"(?:^|[\\/])s_(\d+)_(\d+)_lco\.paa$", re.I)         # big maps: a grid of tiles
_SATOUT_RE = re.compile(r"(?:^|[\\/])[^\\/]*satout[^\\/]*_co\.paa$", re.I)  # smaller/workshop maps: one file


# ---------------------------------------------------------------- PBO reading
def _read_pbo(path: Path, needle: str) -> dict:
    """Return {entry_name: bytes} for entries whose name contains `needle` (raw PBOs)."""
    data = path.read_bytes()
    pos, first, meta = 0, True, []
    while True:
        end = data.index(b"\0", pos)
        name = data[pos:end].decode("ascii", "replace"); pos = end + 1
        method, _orig, _res, _ts, size = struct.unpack_from("<5I", data, pos); pos += 20
        if name == "":
            if first and method == 0x56657273:  # 'Vers' product entry -> properties list
                while data[pos] != 0:
                    pos = data.index(b"\0", pos) + 1   # key
                    pos = data.index(b"\0", pos) + 1   # value
                pos += 1
                first = False
                continue
            break
        meta.append((name, size)); first = False
    out = {}
    for name, size in meta:
        blob = data[pos:pos + size]; pos += size
        if needle in name.lower():
            out[name] = blob
    return out


def _pbo_entry_names(path: Path, max_header: int = 64 * 1024 * 1024) -> list:
    """Read just the entry table (names) of a PBO, without loading the data blobs (cheap)."""
    names = []
    try:
        with open(path, "rb") as f:
            buf = bytearray(f.read(1 << 20))
            pos, first = 0, True

            def ensure(n):
                while len(buf) - pos < n and len(buf) < max_header:
                    chunk = f.read(1 << 20)
                    if not chunk:
                        break
                    buf.extend(chunk)

            while True:
                ensure(1)
                z = buf.find(b"\0", pos)
                while z < 0 and len(buf) < max_header:
                    ensure(1 << 20)
                    z = buf.find(b"\0", pos)
                if z < 0:
                    break
                name = bytes(buf[pos:z]).decode("ascii", "replace"); pos = z + 1
                ensure(20)
                if len(buf) - pos < 20:
                    break
                method = struct.unpack_from("<I", buf, pos)[0]; pos += 20
                if name == "":
                    if first and method == 0x56657273:
                        while True:
                            ensure(1)
                            z = buf.find(b"\0", pos)
                            if z < 0:
                                break
                            k = bytes(buf[pos:z]); pos = z + 1
                            if k == b"":
                                break
                            ensure(1)
                            z2 = buf.find(b"\0", pos)
                            if z2 < 0:
                                break
                            pos = z2 + 1
                        first = False
                        continue
                    break
                names.append(name); first = False
    except OSError:
        pass
    return names


def _pbo_has(path: Path, regex) -> bool:
    return any(regex.search(n) for n in _pbo_entry_names(path))


def _pbo_prefix(path: Path) -> str:
    """The PBO's own 'prefix' property (its virtual path root), read cheaply from the header."""
    try:
        with open(path, "rb") as f:
            head = f.read(8192)
        if not head or head[0] != 0:          # first entry must be the empty-name version entry
            return ""
        if struct.unpack_from("<I", head, 1)[0] != 0x56657273:  # 'Vers'
            return ""
        pos = 1 + 20
        while pos < len(head):
            z = head.index(b"\0", pos); key = head[pos:z]; pos = z + 1
            if key == b"":
                break
            z = head.index(b"\0", pos); val = head[pos:z]; pos = z + 1
            if key.lower() == b"prefix":
                return val.decode("ascii", "replace")
    except (OSError, ValueError):
        pass
    return ""


# ---------------------------------------------------------------- PAA / DXT1 / LZO
def _lzo1x(src: bytes, out_len: int) -> bytearray:
    dst = bytearray()

    def u16(p):
        return src[p] | (src[p + 1] << 8)

    def copy(m, length):
        for i in range(length):
            dst.append(dst[m + i])

    ip = 0
    t = src[ip]
    if t > 17:
        t -= 17; ip += 1
        dst += src[ip:ip + t]; ip += t
        if t < 4:
            t = src[ip]; ip += 1; go = "match"
        else:
            go = "first_literal_run"
    else:
        go = "loop"

    while True:
        if go == "loop":
            t = src[ip]; ip += 1
            if t < 16:
                if t == 0:
                    while src[ip] == 0:
                        t += 255; ip += 1
                    t += 15 + src[ip]; ip += 1
                dst += src[ip:ip + t + 3]; ip += t + 3
                go = "first_literal_run"
            else:
                go = "match"
        if go == "first_literal_run":
            t = src[ip]; ip += 1
            if t >= 16:
                go = "match"
            else:
                m = len(dst) - (1 + 0x0800) - (t >> 2) - (src[ip] << 2); ip += 1
                copy(m, 3); go = "match_done"
        if go == "match":
            if t >= 64:
                m = len(dst) - 1 - ((t >> 2) & 7) - (src[ip] << 3); ip += 1
                copy(m, (t >> 5) - 1 + 2)
            elif t >= 32:
                n = t & 31
                if n == 0:
                    while src[ip] == 0:
                        n += 255; ip += 1
                    n += 31 + src[ip]; ip += 1
                m = len(dst) - 1 - (u16(ip) >> 2); ip += 2
                copy(m, n + 2)
            elif t >= 16:
                m = len(dst) - ((t & 8) << 11)
                n = t & 7
                if n == 0:
                    while src[ip] == 0:
                        n += 255; ip += 1
                    n += 7 + src[ip]; ip += 1
                m -= (u16(ip) >> 2); ip += 2
                if m == len(dst):
                    break
                m -= 0x4000
                copy(m, n + 2)
            else:
                m = len(dst) - 1 - (t >> 2) - (src[ip] << 2); ip += 1
                copy(m, 2)
            go = "match_done"
        if go == "match_done":
            tt = src[ip - 2] & 3
            if tt:
                dst += src[ip:ip + tt]; ip += tt
                t = src[ip]; ip += 1; go = "match"
            else:
                go = "loop"
        if len(dst) >= out_len:
            break
    return dst[:out_len]


def _c565(v):
    r, g, b = (v >> 11) & 0x1f, (v >> 5) & 0x3f, v & 0x1f
    return (r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)


def _dxt1(data: bytes, w: int, h: int) -> bytes:
    out = bytearray(w * h * 3)
    off = 0
    for by in range(h // 4):
        for bx in range(w // 4):
            c0, c1 = struct.unpack_from("<HH", data, off)
            bits = struct.unpack_from("<I", data, off + 4)[0]; off += 8
            r0, g0, b0 = _c565(c0)
            r1, g1, b1 = _c565(c1)
            cols = [(r0, g0, b0), (r1, g1, b1)]
            if c0 > c1:
                cols.append(((2 * r0 + r1) // 3, (2 * g0 + g1) // 3, (2 * b0 + b1) // 3))
                cols.append(((r0 + 2 * r1) // 3, (g0 + 2 * g1) // 3, (b0 + 2 * b1) // 3))
            else:
                cols.append(((r0 + r1) // 2, (g0 + g1) // 2, (b0 + b1) // 2))
                cols.append((0, 0, 0))
            for py in range(4):
                for px in range(4):
                    r, g, b = cols[(bits >> (2 * (py * 4 + px))) & 3]
                    o = ((by * 4 + py) * w + (bx * 4 + px)) * 3
                    out[o] = r; out[o + 1] = g; out[o + 2] = b
    return bytes(out)


def _decode_paa_top(data: bytes):
    """Decode the largest mipmap of a DXT1 PAA into a PIL image."""
    pos, offs = 2, None
    while data[pos:pos + 4] == b"GGAT":
        name = data[pos + 4:pos + 8][::-1].decode("ascii", "replace")
        ln = struct.unpack_from("<I", data, pos + 8)[0]
        if name == "OFFS":
            offs = [o for o in struct.unpack_from("<%dI" % (ln // 4), data, pos + 12) if o]
        pos += 12 + ln
    o = offs[0]
    w, h = struct.unpack_from("<HH", data, o)
    length = data[o + 4] | (data[o + 5] << 8) | (data[o + 6] << 16)
    comp = bool(w & 0x8000)
    w &= 0x7fff
    raw = data[o + 7:o + 7 + length]
    dxt = _lzo1x(raw, (w // 4) * (h // 4) * 8) if comp else raw
    return Image.frombytes("RGB", (w, h), _dxt1(dxt, w, h))


def _paa_size(data: bytes) -> tuple:
    """Dimensions of the largest mipmap, read from the PAA header (no decoding)."""
    pos, offs = 2, None
    try:
        while data[pos:pos + 4] == b"GGAT":
            name = data[pos + 4:pos + 8][::-1].decode("ascii", "replace")
            ln = struct.unpack_from("<I", data, pos + 8)[0]
            if name == "OFFS":
                offs = [o for o in struct.unpack_from("<%dI" % (ln // 4), data, pos + 12) if o]
            pos += 12 + ln
        if offs:
            w, h = struct.unpack_from("<HH", data, offs[0])
            return (w & 0x7fff, h & 0x7fff)
    except (struct.error, IndexError):
        pass
    return (0, 0)


# ---------------------------------------------------------------- discovery + extraction
def _iter_pbos(arma_dir: Path):
    """Yield every PBO in the game's mod folders (main Addons, DLC/content <sub>/Addons,
    local !Workshop and Steam Workshop mods), each once."""
    flat = [arma_dir / "Addons"]
    try:
        for d in arma_dir.iterdir():
            if d.is_dir():
                flat.append(d / "Addons")
    except OSError:
        pass
    deep = [arma_dir / "!Workshop", arma_dir.parent.parent / "workshop" / "content" / "107410"]
    seen = set()
    for root, recursive in [(r, False) for r in flat] + [(r, True) for r in deep]:
        if not root.is_dir():
            continue
        try:
            for p in (root.rglob("*.pbo") if recursive else root.glob("*.pbo")):
                rp = p.resolve()
                if rp not in seen:
                    seen.add(rp)
                    yield p
        except OSError:
            pass


def _norm_prefix(s: str) -> str:
    return (s or "").replace("/", "\\").strip("\\").lower()


def _pick_sat(cands: list) -> list:
    """Of the candidate PBOs keep those with satellite data: the tile grid if any, else one composite."""
    tiled = [p for p in cands if _pbo_has(p, _TILE_RE)]
    if tiled:
        return tiled
    single = [p for p in cands if _pbo_has(p, _SATOUT_RE)]
    return single[:1]


def _find_by_prefix(arma_dir: Path, wrp_path: str) -> list:
    """Authoritative: the map's addon prefix comes from the game config (the .wrp path the
    mod sends), so find PBOs whose own prefix sits under it — like grad_meh via the engine."""
    wp = _norm_prefix(wrp_path)
    if not wp:
        return []
    mp = wp.rsplit("\\", 1)[0] if "\\" in wp else wp   # drop the <world>.wrp file name
    if not mp:
        return []
    cands = [p for p in _iter_pbos(arma_dir)
             if (lambda pre: pre and (pre == mp or pre.startswith(mp + "\\")))(_norm_prefix(_pbo_prefix(p)))]
    return _pick_sat(cands)


def _find_by_name(arma_dir: Path, world: str) -> list:
    """Fallback: match candidate PBOs by the world key in the file name, confirmed by content."""
    key = re.sub(r"[^a-z0-9]", "", (world or "").lower())
    if not key:
        return []
    cands = [p for p in _iter_pbos(arma_dir) if key in p.name.lower().replace("_", "")]
    return _pick_sat(cands)


def find_layer_pbos(arma_dir, world: str, wrp_path: str = "") -> list:
    """Find the map PBO(s) that hold this world's satellite imagery — either the
    s_<col>_<row>_lco.paa tile grid or a single s_satout_co.paa. Prefers the map's addon
    prefix from the game config (the .wrp path the mod sends); otherwise falls back to
    matching the world key in the PBO file name."""
    if not arma_dir:
        return []
    arma_dir = Path(arma_dir)
    return _find_by_prefix(arma_dir, wrp_path) or _find_by_name(arma_dir, world)


def _detect_overlap(tiles: dict) -> int:
    """Arma's satellite tiles share a border with their neighbours; return that overlap in
    pixels (0 if none), found from an adjacent pair of land tiles near the map centre."""
    cols = max(a for a, b in tiles) + 1
    rows = max(b for a, b in tiles) + 1

    def best(a_img, b_img):
        W = a_img.width
        for v in (64, 48, 32, 24, 16, 12, 8, 4):
            if v >= W:
                continue
            a_strip = a_img.crop((W - v, 0, W, a_img.height)).convert("L")
            if ImageStat.Stat(a_strip).stddev[0] < 6:   # near-uniform (ocean): can't trust it
                continue
            b_strip = b_img.crop((0, 0, v, b_img.height)).convert("L")
            if ImageStat.Stat(ImageChops.difference(a_strip, b_strip)).mean[0] < 1.5:
                return v
        return 0

    tried = 0
    for c in range(cols // 2, min(cols - 1, cols // 2 + 6)):
        for r in range(rows // 2, min(rows, rows // 2 + 6)):
            if (c, r) in tiles and (c + 1, r) in tiles:
                v = best(_decode_paa_top(tiles[(c, r)]), _decode_paa_top(tiles[(c + 1, r)]))
                if v:
                    return v
                tried += 1
                if tried >= 6:
                    return 0
    return 0


def extract_to_dir(pbos: list, out_dir: Path, world: str, desc: str, world_size: float,
                   progress=None) -> int:
    """Decode every s_<row>_<col>_lco tile from the PBOs into a grad_meh-style folder
    (sat/<col>/<row>.png + meta.json). Returns the number of tiles written."""
    if Image is None:
        raise RuntimeError("Pillow is required")
    tiles = {}
    for pbo in pbos:
        for name, blob in _read_pbo(pbo, "_lco.paa").items():
            m = _TILE_RE.search(name)
            if m:
                tiles.setdefault((int(m.group(1)), int(m.group(2))), blob)
    if not tiles:
        return _extract_single(pbos, out_dir, world, desc, world_size, progress)
    cols = max(a for a, b in tiles) + 1
    rows = max(b for a, b in tiles) + 1
    # Tiles vary in resolution (ocean / low-detail cells are stored tiny, e.g. 4x4), so every
    # cell is normalised to the map's largest tile size; small ones are just upscaled to fit.
    tsize = max((d for b in tiles.values() for d in _paa_size(b)), default=0)
    if tsize < 4:
        raise RuntimeError("this map has no usable satellite image")
    ov = _detect_overlap(tiles) if len(tiles) > 1 else 0   # shared border between neighbouring tiles
    if ov >= tsize:
        ov = 0
    if ov:
        log.info("satellite tiles for %s overlap by %d px; trimming the shared seams", world, ov)
    sat = out_dir / "sat"
    if out_dir.exists():
        import shutil
        shutil.rmtree(out_dir)
    sat.mkdir(parents=True)
    total, done = len(tiles), 0
    sea_samples = []  # (grayscale stddev, mean RGB) per decoded tile, to estimate the sea colour
    for (a, b), blob in sorted(tiles.items()):
        img = _decode_paa_top(blob)
        if img.size != (tsize, tsize):
            img = img.resize((tsize, tsize), Image.LANCZOS)
        # Trim the shared overlap off the right/bottom so tiles abut exactly (keep it on the
        # map's outer edge, which has no neighbour). Arma names tiles s_<col>_<row>:
        # FIRST index = column (east, +X), SECOND = row (top = north, +Y down).
        if ov:
            cw = tsize - ov if a < cols - 1 else tsize
            ch = tsize - ov if b < rows - 1 else tsize
            img = img.crop((0, 0, cw, ch))
        st = ImageStat.Stat(img.resize((32, 32)))
        sea_samples.append((sum(st.stddev) / 3.0, tuple(round(v) for v in st.mean)))
        cdir = sat / str(a)
        cdir.mkdir(exist_ok=True)
        img.save(cdir / f"{b}.png")   # grad_meh layout: sat/<col>/<row>.png
        done += 1
        if progress:
            progress(done, total)
    # Arma omits all-ocean tiles, but the build pipeline needs a full rectangle:
    # fill the gaps with a flat tile in this map's own sea colour (matching each cell's trimmed size).
    sea_samples.sort(key=lambda s: s[0])
    k = max(1, len(sea_samples) // 20)
    sea_rgb = tuple(sum(s[1][i] for s in sea_samples[:k]) // k for i in range(3))
    for a in range(cols):
        cw = tsize - ov if (ov and a < cols - 1) else tsize
        cdir = sat / str(a)
        cdir.mkdir(exist_ok=True)
        for b in range(rows):
            f = cdir / f"{b}.png"
            if not f.exists():
                ch = tsize - ov if (ov and b < rows - 1) else tsize
                Image.new("RGB", (cw, ch), sea_rgb).save(f)
    import json
    (out_dir / "meta.json").write_text(json.dumps({
        "worldName": world, "displayName": desc or world, "worldSize": world_size,
        "elevationOffset": 0, "gridOffsetX": 0, "gridOffsetY": 0,
    }), "utf-8")
    log.info("decoded %d satellite tiles for %s (grid %dx%d) from %d PBO(s)",
             total, world, cols, rows, len(pbos))
    return total


def _extract_single(pbos, out_dir, world, desc, world_size, progress):
    """Smaller / Workshop maps keep the whole satellite in a single s_satout_co.paa."""
    blob = None
    for pbo in pbos:
        for name, b in _read_pbo(pbo, "satout").items():
            if _SATOUT_RE.search(name):
                blob = b
                break
        if blob is not None:
            break
    if blob is None:
        raise RuntimeError("no satellite image found in the map files")
    img = _decode_paa_top(blob)
    sat = out_dir / "sat"
    if out_dir.exists():
        import shutil
        shutil.rmtree(out_dir)
    (sat / "0").mkdir(parents=True)
    img.save(sat / "0" / "0.png")   # one tile = the whole map
    if progress:
        progress(1, 1)
    import json
    (out_dir / "meta.json").write_text(json.dumps({
        "worldName": world, "displayName": desc or world, "worldSize": world_size,
        "elevationOffset": 0, "gridOffsetX": 0, "gridOffsetY": 0,
    }), "utf-8")
    log.info("decoded the composite satellite image for %s (%dx%d px)", world, img.width, img.height)
    return 1
