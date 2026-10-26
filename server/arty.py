"""Artillery calculator: the weapon database (per mod set) and request/answer queries to the game.

The database is read from the game config by dideban_fnc_artyScan the first time a mod set is
seen, and cached as cache/arty/db_<key>.json, so later sessions with the same mods skip the scan.
The key is a hash of the mod folders, the number of loaded addons and the game build that the
mod reports in its hello.
"""
import hashlib
import itertools
import json
import logging
import threading
import time
from pathlib import Path

log = logging.getLogger("dideban")

DB_VERSION = 1           # bump when the database layout changes: older caches are then rebuilt
QUERY_TIMEOUT = 3.0      # seconds the server waits for the game to answer a query
MAX_POINTS = 128


def modset_key(raw) -> str:
    """Stable key for the mod set the game reported (hello field 12)."""
    if not isinstance(raw, list) or not raw:
        return ""
    text = json.dumps([DB_VERSION] + raw, ensure_ascii=False)
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def _num(v, default=0.0):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else default


class ArtyDB:
    """Assembles arty_db_* messages into one database."""

    def __init__(self, key: str, total: int):
        self.key = key
        self.total = max(1, int(total))
        self.done = 0
        self.vehicles: dict[str, dict] = {}
        self.weapons: dict[str, dict] = {}
        self.magazines: dict[str, dict] = {}
        self.ammo: dict[str, dict] = {}

    def add(self, kind: str, msg: list) -> None:
        rows = msg[1] if len(msg) > 1 and isinstance(msg[1], list) else []
        if kind == "arty_db_veh":
            for v in rows:
                if len(v) < 9:
                    continue
                self.vehicles[v[0]] = {
                    "cls": v[0], "name": v[1], "kind": v[2], "scanner": int(_num(v[3])),
                    "aceApply": int(v[4]) if isinstance(v[4], (int, float)) and not isinstance(v[4], bool) else None,
                    "mk6": bool(v[5]), "side": int(_num(v[6], -1)), "faction": v[7],
                    "turrets": [{
                        "path": t[0], "name": t[1], "minElev": _num(t[2]), "maxElev": _num(t[3]),
                        "minTurn": _num(t[4]), "maxTurn": _num(t[5]), "weapons": t[6], "mags": t[7],
                    } for t in v[8] if isinstance(t, list) and len(t) >= 8],
                }
        elif kind == "arty_db_wpn":
            for w in rows:
                if len(w) < 5:
                    continue
                self.weapons[w[0]] = {
                    "cls": w[0], "name": w[1], "initSpeed": _num(w[2]),
                    "modes": [{"cls": m[0], "charge": _num(m[1], 1.0) or 1.0, "shown": bool(m[2]), "name": m[3]}
                              for m in w[3] if isinstance(m, list) and len(m) >= 4],
                    "mags": w[4],
                }
        elif kind == "arty_db_mag":
            for m in rows:
                if len(m) < 6:
                    continue
                self.magazines[m[0]] = {
                    "cls": m[0], "name": m[1], "initSpeed": _num(m[2]), "ammo": m[3], "count": int(_num(m[4])),
                    "aceAF": _num(m[5]) if isinstance(m[5], (int, float)) and not isinstance(m[5], bool) else None,
                }
        elif kind == "arty_db_ammo":
            for a in rows:
                if len(a) < 8:
                    continue
                self.ammo[a[0]] = {
                    "cls": a[0], "airFriction": _num(a[1]), "simulation": a[2], "artilleryLock": int(_num(a[3])),
                    "hit": _num(a[4]), "indirectHit": _num(a[5]), "indirectHitRange": _num(a[6]), "submunition": a[7],
                }
        elif kind == "arty_db_prog":
            self.done = int(_num(msg[1])) if len(msg) > 1 else self.done

    def finish(self) -> dict:
        return {"version": DB_VERSION, "key": self.key, "built": int(time.time()),
                "vehicles": sorted(self.vehicles.values(), key=lambda v: (v["name"] or v["cls"]).lower()),
                "weapons": self.weapons, "magazines": self.magazines, "ammo": self.ammo}


# ---- calculator state shared by every page of this server (main app, pop-outs, phones)
ANGLE_UNITS = ("nato", "wp", "deg")
FIELDS = ("az", "el", "charge", "tof", "range", "dz", "maxOrd", "impact", "drift", "mv")
SETTINGS_DEFAULT = {
    "angle": "nato", "angle2": "", "dist": "m", "grid": 8, "dec": 0,
    "fields": ["az", "el", "charge", "tof"],
    "sound": True, "vibrate": True, "splash": 5, "tol": 2.0,
}
CALC_DEFAULT = {
    "gunMode": "mine", "gunId": "", "manual": None, "veh": "", "weapon": "", "mag": "",
    "target": None, "arc": "low", "charge": -1, "gunZ": None, "targetZ": None,
}


def _clean_settings(raw: dict, cur: dict) -> dict:
    out = dict(cur)
    if not isinstance(raw, dict):
        return out
    if raw.get("angle") in ANGLE_UNITS:
        out["angle"] = raw["angle"]
    if raw.get("angle2") in ("",) + ANGLE_UNITS:
        out["angle2"] = raw["angle2"]
    if raw.get("dist") in ("m", "km"):
        out["dist"] = raw["dist"]
    if raw.get("grid") in (6, 8, 10):
        out["grid"] = raw["grid"]
    if isinstance(raw.get("dec"), int) and not isinstance(raw.get("dec"), bool) and 0 <= raw["dec"] <= 3:
        out["dec"] = raw["dec"]
    if isinstance(raw.get("fields"), list):
        f = []
        for k in raw["fields"]:
            if k in FIELDS and k not in f:
                f.append(k)
        out["fields"] = f[:8]
    for k in ("sound", "vibrate"):
        if isinstance(raw.get(k), bool):
            out[k] = raw[k]
    if isinstance(raw.get("splash"), (int, float)) and not isinstance(raw.get("splash"), bool):
        out["splash"] = int(min(30, max(1, raw["splash"])))
    if isinstance(raw.get("tol"), (int, float)) and not isinstance(raw.get("tol"), bool):
        out["tol"] = round(min(50.0, max(0.5, float(raw["tol"]))), 1)
    return out


def _pos(v, size: float):
    """{x, y} inside the map, or None."""
    if not isinstance(v, dict):
        return None
    try:
        x, y = float(v["x"]), float(v["y"])
    except (KeyError, TypeError, ValueError):
        return None
    if not (0 <= x <= size and 0 <= y <= size):
        return None
    return {"x": round(x, 1), "y": round(y, 1)}


def _clean_calc(raw: dict, cur: dict, size: float) -> dict:
    out = dict(cur)
    if not isinstance(raw, dict):
        return out
    if raw.get("gunMode") in ("mine", "unit", "manual"):
        out["gunMode"] = raw["gunMode"]
    for k in ("gunId", "veh", "weapon", "mag"):
        if isinstance(raw.get(k), str):
            out[k] = raw[k][:96]
    if "manual" in raw:
        m = _pos(raw["manual"], size)
        out["manual"] = m
    if "target" in raw:
        tg = _pos(raw["target"], size)
        if tg is not None and isinstance(raw["target"].get("name"), str):
            tg["name"] = raw["target"]["name"][:40]
        out["target"] = tg
    if raw.get("arc") in ("low", "high"):
        out["arc"] = raw["arc"]
    if isinstance(raw.get("charge"), int) and not isinstance(raw.get("charge"), bool):
        out["charge"] = max(-1, min(31, raw["charge"]))
    for k in ("gunZ", "targetZ"):
        if k in raw:
            v = raw[k]
            out[k] = round(float(v), 2) if isinstance(v, (int, float)) and not isinstance(v, bool) and -500 <= v <= 9000 else None
    return out


class Arty:
    def __init__(self, cache_dir: Path, publish, send):
        """publish(event, data) goes to every browser; send(cmd) -> bool goes to the game."""
        self.dir = cache_dir / "arty"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.publish = publish
        self.send = send
        self.lock = threading.Lock()
        self.key = ""                         # mod set of the connected game
        self.builder: ArtyDB | None = None
        self.scan_started = 0.0
        self.failed = ""
        self._db_cache: tuple[str, dict] | None = None
        self._ids = itertools.count(1)
        self._pending: dict[int, dict] = {}   # request id -> {"event": Event, "answer": list}
        self.state = {"settings": dict(SETTINGS_DEFAULT), "calc": dict(CALC_DEFAULT), "rev": 0}
        try:
            saved = json.loads((self.dir / "state.json").read_text("utf-8"))
            self.state["settings"] = _clean_settings(saved.get("settings"), self.state["settings"])
            self.state["calc"] = _clean_calc(saved.get("calc"), self.state["calc"], 1e6)
            if isinstance(saved.get("rev"), int):
                self.state["rev"] = max(0, saved["rev"])
        except (OSError, ValueError, AttributeError):
            pass

    # ---- calculator settings and current inputs (one copy, shared by every page)
    def public_state(self) -> dict:
        with self.lock:
            return json.loads(json.dumps(self.state))

    def update_state(self, body: dict, world_size: float) -> dict:
        with self.lock:
            st = self.state
            if "settings" in body:
                st["settings"] = _clean_settings(body["settings"], st["settings"])
            if "calc" in body:
                st["calc"] = _clean_calc(body["calc"], st["calc"], world_size or 1e6)
            st["rev"] += 1
            snap = json.loads(json.dumps(st))
            try:
                tmp = self.dir / "state.tmp"
                tmp.write_text(json.dumps(snap, ensure_ascii=False), "utf-8")
                tmp.replace(self.dir / "state.json")
            except OSError:
                log.exception("could not save the calculator state")
        snap["by"] = body.get("by") if isinstance(body.get("by"), str) else ""
        self.publish("arty_state", snap)
        return snap

    # ---- database
    def _path(self, key: str) -> Path:
        return self.dir / f"db_{key}.json"

    def status(self) -> dict:
        with self.lock:
            b = self.builder
            state = "scanning" if b else ("ready" if self.key and self._path(self.key).is_file() else "none")
            return {"key": self.key, "state": state, "progress": (b.done / b.total) if b else (1.0 if state == "ready" else 0.0),
                    "error": self.failed}

    def _publish_status(self):
        self.publish("arty_db", self.status())

    def set_modset(self, raw) -> None:
        key = modset_key(raw)
        with self.lock:
            if key != self.key:
                self.key = key
                self.failed = ""
                self.builder = None
        self._publish_status()

    def database(self) -> dict | None:
        key = self.key
        if not key:
            return None
        with self.lock:
            if self._db_cache and self._db_cache[0] == key:
                return self._db_cache[1]
        p = self._path(key)
        try:
            db = json.loads(p.read_text("utf-8"))
        except (OSError, ValueError):
            return None
        if db.get("version") != DB_VERSION:
            return None
        with self.lock:
            self._db_cache = (key, db)
        return db

    def request_scan(self, force: bool = False) -> tuple[bool, str]:
        """Starts a scan unless the database for this mod set exists (or one is running)."""
        with self.lock:
            if not self.key:
                return False, "no mod set reported yet (update the mod, or join a mission)"
            if self.builder is not None and time.time() - self.scan_started < 600:
                return True, "scanning"
            if not force and self._path(self.key).is_file():
                return True, "ready"
            self.failed = ""
            self.builder = ArtyDB(self.key, 1)
            self.scan_started = time.time()
        if not self.send(["arty_scan", self.key]):
            with self.lock:
                self.builder = None
            return False, "game not connected"
        log.info("artillery database: scanning the game config (mod set %s)", self.key)
        self._publish_status()
        return True, "scanning"

    def on_disconnect(self) -> None:
        with self.lock:
            if self.builder is not None:
                self.builder = None
                self.failed = "game disconnected during the scan"
            for p in self._pending.values():
                p["event"].set()
        self._publish_status()

    # ---- game messages (arty_*)
    def on_message(self, kind: str, msg: list) -> None:
        if kind == "arty_h":
            self._answer(msg)
            return
        done = None
        with self.lock:
            b = self.builder
            if kind == "arty_db_begin":
                key = msg[1] if len(msg) > 1 else ""
                if key != self.key:
                    log.warning("artillery scan for another mod set (%s, expected %s): ignored", key, self.key)
                    return
                self.builder = b = ArtyDB(key, int(_num(msg[2], 1)) if len(msg) > 2 else 1)
                self.scan_started = time.time()
            elif b is None:
                return
            elif kind == "arty_db_end":
                self.builder = None
                done = b.finish()
                tmp = self._path(b.key).with_suffix(".tmp")
                tmp.write_text(json.dumps(done, separators=(",", ":"), ensure_ascii=False), "utf-8")
                tmp.replace(self._path(b.key))
                self._db_cache = (b.key, done)
            else:
                b.add(kind, msg)
        if done is not None:
            log.info("artillery database ready: %d vehicles, %d weapons, %d magazines",
                     len(done["vehicles"]), len(done["weapons"]), len(done["magazines"]))
            self._publish_status()
        elif kind in ("arty_db_begin", "arty_db_prog"):
            self._publish_status()

    # ---- request / answer
    def query(self, points, gun_id: str = "", timeout: float = QUERY_TIMEOUT) -> tuple[int, dict]:
        try:
            pts = [[round(float(p[0]), 2), round(float(p[1]), 2)] for p in points][:MAX_POINTS]
        except (TypeError, ValueError, IndexError):
            return 400, {"ok": False, "error": "bad points"}
        gid = str(gun_id or "")[:64]
        rid = next(self._ids)
        slot = {"event": threading.Event(), "answer": None}
        with self.lock:
            self._pending[rid] = slot
        try:
            if not self.send(["arty_q", rid, pts, gid]):
                return 409, {"ok": False, "error": "game not connected"}
            if not slot["event"].wait(timeout) or slot["answer"] is None:
                return 504, {"ok": False, "error": "the game did not answer"}
        finally:
            with self.lock:
                self._pending.pop(rid, None)
        a = slot["answer"]
        g = a[3] if len(a) > 3 and isinstance(a[3], list) else []
        e = a[4] if len(a) > 4 and isinstance(a[4], list) else []
        return 200, {
            "ok": True,
            "heights": a[2] if len(a) > 2 else [],
            "gun": {"x": g[0], "y": g[1], "z": g[2], "muzzleZ": g[3], "cls": g[4], "alive": bool(g[5]), "dir": g[6]}
                   if len(g) >= 7 else None,
            "env": {"ace": {"tables": bool(e[0]), "mk6": bool(e[1]), "adv": bool(e[2]), "mk6Air": bool(e[3])},
                    "tempC": _num(e[4], 15.0), "density": _num(e[5], 1.225), "wind": e[6],
                    "aceWeather": bool(e[7])} if len(e) >= 8 else None,
        }

    def _answer(self, msg: list) -> None:
        rid = int(_num(msg[1], -1)) if len(msg) > 1 else -1
        with self.lock:
            slot = self._pending.get(rid)
        if slot is not None:
            slot["answer"] = msg
            slot["event"].set()
