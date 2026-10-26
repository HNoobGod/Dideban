"""Dideban server.

Bridges the Arma 3 extension (TCP, 127.0.0.1 only) and browsers (HTTP + Server-Sent Events).
Standard library only.
"""
import argparse
import json
import logging
import queue
import re
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import installer
from arty import Arty
import satextract
import sqf
from capture import Capturer
from satellite import SatelliteStore
from terrain import TerrainBuilder, TerrainStore, world_key

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
CACHE_DIR = ROOT / "cache"
LOGS_DIR = ROOT / "logs"  # combat log files (kills, deaths, friendly fire), one per day

log = logging.getLogger("dideban")

USER_MARKER = re.compile(r"^_USER_DEFINED #(\d+)/([^/]*)/(\d+)$")
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/manifest+json",
    ".ico": "image/x-icon",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
}


def event_bytes(event: str, data) -> bytes:
    body = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    return f"event: {event}\ndata: {body}\n\n".encode("utf-8")


class Hub:
    """Fan-out of events to every connected browser."""

    def __init__(self):
        self.lock = threading.Lock()
        self.clients: set[queue.Queue] = set()

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=100)
        with self.lock:
            self.clients.add(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self.lock:
            self.clients.discard(q)

    def publish(self, event: str, data) -> None:
        payload = event_bytes(event, data)
        with self.lock:
            clients = list(self.clients)
        for q in clients:
            try:
                q.put_nowait(payload)
            except queue.Full:
                # Slow client: drop its oldest event to make room.
                try:
                    q.get_nowait()
                    q.put_nowait(payload)
                except (queue.Empty, queue.Full):
                    pass


def convert_state(m: list) -> dict:
    _, t, me, groups, units, vehicles, markers = m[:7]
    out_markers = []
    for mk in markers:
        name = mk[0]
        um = USER_MARKER.match(name)
        out_markers.append({
            "name": name,
            "shape": mk[1],
            "type": mk[2],
            "rgba": mk[3],
            "text": mk[4],
            "x": mk[5], "y": mk[6],
            "a": mk[7], "b": mk[8],
            "dir": mk[9],
            "alpha": mk[10],
            "brush": mk[11],
            "poly": mk[12],
            "user": bool(um),
            "owner": int(um.group(1)) if um else None,
            "channel": int(um.group(3)) if um else None,
        })
    return {
        "time": t,
        "me": {"id": me[0], "x": me[1], "y": me[2], "dir": me[3], "alive": me[4], "side": me[5],
               # All-sides view: allowed (admin / Zeus / single player, checked in game) and active.
               "allSidesAllowed": bool(me[6]) if len(me) > 6 else False,
               "allSides": bool(me[7]) if len(me) > 7 else False},
        "groups": [{"name": g[0], "side": g[1], "leader": g[2]} for g in groups],
        "units": [{
            "id": u[0], "name": u[1], "x": u[2], "y": u[3], "dir": u[4], "group": u[5],
            "veh": u[6], "player": u[7], "life": u[8], "type": u[9], "rank": u[10], "leader": u[11],
            "hp": u[12] if len(u) > 12 else 1,
        } for u in units],
        "vehicles": [{
            "id": v[0], "cls": v[1], "type": v[2], "x": v[3], "y": v[4], "dir": v[5],
            "kind": v[6], "speed": v[7], "alt": v[8],
        } for v in vehicles],
        "markers": out_markers,
        # Unoccupied friendly vehicles (sent by mod versions that support it).
        "empty": [{
            "id": e[0], "cls": e[1], "type": e[2], "x": e[3], "y": e[4], "dir": e[5], "kind": e[6], "side": e[7],
        } for e in (m[7] if len(m) > 7 else [])],
        # Friendly fallen kept on the roster until respawn (name, side, x, y, killer, group).
        "dead": [{
            "name": d[0], "side": d[1], "x": d[2], "y": d[3],
            "killer": d[4] if len(d) > 4 else "", "group": d[5] if len(d) > 5 else "",
        } for d in (m[8] if len(m) > 8 else [])],
    }


def convert_detail(m: list) -> dict:
    """Deep per-entity info (vehicle/unit page). Mirrors dideban_fnc_collectDetail's array."""
    def g(i, d=None):
        return m[i] if len(m) > i else d
    ace = g(21, []) or []
    return {
        "t": g(1, 0), "id": g(2, ""), "found": bool(g(3, False)),
        "cls": g(4, ""), "name": g(5, ""), "kind": g(6, ""), "side": g(7, ""),
        "alive": bool(g(8, False)), "x": g(9, 0), "y": g(10, 0), "dir": g(11, 0),
        "hp": g(12, 1),
        "hit": [{"label": h[0], "dmg": h[1]} for h in (g(13, []) or [])],
        "fuel": g(14, -1), "speed": g(15, 0), "alt": g(16, 0),
        "crew": [{"role": c[0], "name": c[1], "player": bool(c[2]), "id": c[3],
                  "hp": c[4] if len(c) > 4 else 1} for c in (g(17, []) or [])],
        "weapons": [{"name": w[0], "ammo": w[1]} for w in (g(18, []) or [])],
        "pylons": [{"name": p[0], "count": p[1]} for p in (g(19, []) or [])],
        "inv": [{"section": s[0], "items": [
            {"name": it[0], "count": it[1], "note": it[2] if len(it) > 2 else ""} for it in s[1]
        ]} for s in (g(20, []) or [])],
        "ace": {"blood": ace[0], "pain": ace[1], "hr": ace[2],
                "fractured": bool(ace[3]), "tourniquets": ace[4],
                # head, body, left arm, right arm, left leg, right leg; None = not reported
                "parts": ace[5] if len(ace) > 5 and isinstance(ace[5], list) and len(ace[5]) == 6 else None} if ace else None,
        # Fields below come from newer mod versions; None means "this mod version does not send it",
        # which the app shows as unavailable rather than as zero.
        "hitAll": [{"label": h[0], "dmg": h[1]} for h in g(22)] if isinstance(g(22), list) else None,
        # turret: None = old mod; {"none": True} = this vehicle has no main turret
        "turret": ({"ok": bool(tu[0]), "az": tu[1], "rel": tu[2], "gunner": tu[3], "gunnerName": tu[4]}
                   if len(tu := g(23)) >= 5 else {"ok": False, "none": True}) if isinstance(g(23), list) else None,
        "pylonsFull": [{"index": p[0], "name": p[1], "ammo": p[2], "max": p[3], "ux": p[4], "uy": p[5],
                        "mag": p[6] if len(p) > 6 else "",
                        # the weapon firing this pylon's magazine (lower case) and the turret owning it
                        "weapon": p[7] if len(p) > 7 else None,
                        "turret": p[8] if len(p) > 8 else None} for p in g(24)] if isinstance(g(24), list) else None,
        "seats": [{"role": s[0], "cargo": s[1], "turret": s[2], "ffv": bool(s[3]), "pos": s[4], "gunnerName": s[5],
                   "id": s[6], "name": s[7], "player": bool(s[8]), "hp": s[9],
                   # personal weapons: None = this mod version does not report them
                   "personal": [{"name": p[0], "ammo": p[1], "mags": p[2], "kind": p[3]} for p in s[10]]
                               if len(s) > 10 and isinstance(s[10], list) else None,
                   "ffvMode": s[11] if len(s) > 11 else None,
                   "turnedOut": bool(s[12]) if len(s) > 12 else None,
                   # occupant's life state and health source ("dmg" | "ace"); None = not reported
                   "life": (s[13] or None) if len(s) > 13 else None,
                   "hpSrc": (s[14] or None) if len(s) > 14 else None} for s in g(25)]
                 if isinstance(g(25), list) else None,
        "weaponsFull": [{"cls": w[0], "name": w[1], "ammo": w[2], "cap": w[3], "mags": w[4], "turret": w[5],
                         "tag": w[6], "mag": w[7],
                         # 1 lasing / 0 off / -1 not a laser; None = not reported
                         "laser": w[8] if len(w) > 8 else None,
                         "loadedMag": w[9] if len(w) > 9 else None,
                         "loaded": w[10] if len(w) > 10 and w[10] >= 0 else None,
                         "types": [{"name": m[0], "ammo": m[1], "cap": m[2], "count": m[3]} for m in w[11]]
                                  if len(w) > 11 and isinstance(w[11], list) else None,
                         # pylons feeding this weapon (0 = not pylon-fed); None = not reported
                         "pylons": w[12] if len(w) > 12 else None}
                        for w in g(26)] if isinstance(g(26), list) else None,
        "flags": {"subcat": g(27)[0], "uav": bool(g(27)[1])} if isinstance(g(27), list) and len(g(27)) > 1 else None,
        "turrets": [{"path": tu[0], "ok": bool(tu[1]), "az": tu[2], "rel": tu[3]} for tu in g(28)]
                   if isinstance(g(28), list) else None,
        "att": {"pitch": g(29)[0], "bank": g(29)[1]} if isinstance(g(29), list) and len(g(29)) == 2 else None,
        "laser": g(30) if isinstance(g(30), (int, float)) and g(30) >= 0 else None,
        "altASL": g(31) if isinstance(g(31), (int, float)) else None,
        "kit": convert_kit(g(32)),
    }


def convert_kit(k) -> dict | None:
    """A man's itemised kit (collectDetail, "a man's kit"); None when the mod does not send it."""
    if not isinstance(k, list) or len(k) < 4:
        return None
    ws, ms, its, ld = k[:4]
    return {
        "weapons": [{"slot": w[0], "cls": w[1], "name": w[2], "loadedMag": w[3],
                     "loaded": w[4] if w[4] >= 0 else None, "cap": w[5],
                     "spare": w[6], "spareRounds": w[7], "current": bool(w[8])} for w in ws],
        "mags": [{"cls": m[0], "name": m[1], "spare": m[2], "spareRounds": m[3], "cap": m[4],
                  "hint": m[5], "loaded": m[6]} for m in ms],
        "items": [{"cls": i[0], "name": i[1], "count": i[2], "hint": i[3], "equipped": bool(i[4])} for i in its],
        "load": {"total": ld[0], "uniform": ld[1], "vest": ld[2], "backpack": ld[3]} if len(ld) >= 4 else None,
    }


# How long a watched entity stays live after the last browser heartbeat.
DETAIL_TTL = 6.0


class App:
    def __init__(self, store: TerrainStore, hub: Hub, sat: SatelliteStore | None = None, settings=None):
        self.store = store
        self.hub = hub
        self.sat = sat
        self.settings = settings
        self.capture = Capturer()
        self.helmet_id = None  # unit whose helmet cam the game is currently drawing
        self.lock = threading.Lock()
        self.game = None  # GameLink, set later
        self.status = {"connected": False, "world": None, "worldSize": None, "worldDesc": "",
                       "profile": "", "mission": "", "owner": None, "terrain": False, "wrp": "",
                       # one mission run: changes on every mission start or restart (see on hello)
                       "session": "", "sessionAt": 0}
        self._hello_count = 0
        self.meta = {"colors": [], "types": []}
        self.state = None
        self.builder: TerrainBuilder | None = None
        self.progress = {"active": False, "stage": "", "value": 0.0, "world": None}
        # Entities any browser currently wants deep detail for: {netId: expiry_time}.
        self.watched: dict[str, float] = {}
        self.watched_set: list[str] = []
        # Artillery calculator: weapon database per mod set, and height/conditions queries.
        self.arty = Arty(CACHE_DIR, hub.publish, lambda cmd: self.game.send(cmd) if self.game else False)

    # ---- available maps (exported terrain and/or satellite imagery)
    def maps(self) -> list[dict]:
        out: dict[str, dict] = {}
        for key, t in self.store.list().items():
            out[key] = {"key": key, "world": t["world"], "desc": t.get("desc") or "", "size": t.get("size"),
                        "terrain": True, "sat": {"state": "none"}}
        if self.sat:
            keys = (set(out) | set(self.sat.building) | set(self.sat.failed)
                    | {p.name for p in self.sat.cache.iterdir() if p.is_dir()})
            for key in keys:
                if key.endswith(".building"):
                    continue
                st = self.sat.status(key)
                if st["state"] == "none" and key not in out:
                    continue
                m = out.setdefault(key, {"key": key, "world": key, "desc": "", "size": None, "terrain": False})
                m["sat"] = st
                info = self.sat.info(key)
                if info:
                    m["desc"] = m["desc"] or info.get("desc", "")
                    m["size"] = m["size"] or info.get("worldSize")
        return sorted(out.values(), key=lambda m: (m["desc"] or m["world"]).lower())

    def publish_maps(self):
        self.hub.publish("maps", self.maps())

    # ---- snapshot for newly connected browsers
    def snapshot_events(self) -> list[bytes]:
        with self.lock:
            out = [event_bytes("status", self.status), event_bytes("meta", self.meta),
                   event_bytes("progress", self.progress), event_bytes("maps", self.maps()),
                   event_bytes("settings", self.settings.public()), event_bytes("arty_db", self.arty.status()),
                   event_bytes("arty_state", self.arty.public_state())]
            if self.state is not None:
                out.append(event_bytes("state", self.state))
        return out

    def _publish_status(self):
        self.hub.publish("status", dict(self.status))

    def _set_progress(self, **kw):
        self.progress.update(kw)
        self.hub.publish("progress", dict(self.progress))

    # ---- game events
    def on_game_connected(self):
        log.info("game extension connected")
        with self.lock:
            self.status["connected"] = True
            self._publish_status()

    def on_game_disconnected(self):
        log.info("game extension disconnected")
        with self.lock:
            self.status["connected"] = False
            self.helmet_id = None
            self.capture.set_helmet_rect(None)
            if self.builder is not None:
                self.builder = None
                self._set_progress(active=False, stage="failed", value=0.0)
            self._publish_status()
        self.arty.on_disconnect()

    def on_game_message(self, msg: list):
        if not isinstance(msg, list) or not msg or not isinstance(msg[0], str):
            return
        kind = msg[0]
        with self.lock:
            if kind == "pos":
                _, t, me, units, vehicles = msg[:5]
                self.hub.publish("pos", {"t": t, "me": me, "units": units, "vehicles": vehicles})
            elif kind == "state":
                self.state = convert_state(msg)
                self.hub.publish("state", self.state)
            elif kind == "detail":
                d = convert_detail(msg)
                # netIds and mission time belong to one mission run; the app checks this tag so a
                # payload is never compared with (or mistaken for) one from the previous run
                d["session"] = self.status["session"]
                self.hub.publish("detail", d)
            elif kind == "event":
                self._log_event(msg)
            elif kind.startswith("arty_"):
                self.arty.on_message(kind, msg)
            elif kind == "hello":
                _, version, world, size, desc, profile, mission, colors, types, owner = msg[:10]
                wrp = msg[10] if len(msg) > 10 and isinstance(msg[10], str) else ""  # map's .wrp path from config
                log.info("hello from %s (mod %s): world=%s mission=%s", profile, version, world, mission)
                # Mission run: the mod sends one (new on every start/restart). Older mods do not, so
                # every hello is then treated as a new run (a reconnect costs one re-subscription).
                self._hello_count += 1
                session = msg[11] if len(msg) > 11 and isinstance(msg[11], str) and msg[11] else \
                    f"legacy-{self._hello_count}"
                new_run = session != self.status["session"]
                if new_run:
                    log.info("mission run %s -> %s: detail subscriptions cleared", self.status["session"] or "-", session)
                    # the old netIds now point at nothing, or at a different object: drop them
                    self.watched.clear()
                    self.watched_set = []
                    self.status.update(session=session, sessionAt=time.time())
                # the loaded mods (newer mods only): one artillery database per mod set
                self.arty.set_modset(msg[12] if len(msg) > 12 else None)
                self.status["modset"] = self.arty.key
                self.status.update(connected=True, world=world, worldSize=size, worldDesc=desc,
                                   profile=profile, mission=mission, owner=owner, wrp=wrp,
                                   terrain=self.store.has(world))
                self.meta = {
                    "colors": [{"cls": c[0], "name": c[1], "rgba": c[2]} for c in colors],
                    "types": [{"cls": t[0], "name": t[1], "group": t[2]} for t in types],
                }
                self.state = None
                self.hub.publish("meta", self.meta)
                self.hub.publish("state_reset", {"session": session, "newRun": new_run})
                if self.game:
                    self.game.send(["pos_interval", self.settings.get("pos_interval", 0.05)])
                    self.game.send(["all_sides", bool(self.settings.get("all_sides", False))])
                    # same run (the extension reconnected): restore the open detail pages; a new run
                    # starts empty and the pages subscribe again with the new ids
                    self.game.send(["detail_set", self.watched_set])
                self._publish_status()
            elif kind == "t_begin":
                _, world, size, n, step, desc = msg[:6]
                log.info("terrain export started: %s (%dx%d, %.1f m)", world, n, n, step)
                self.builder = TerrainBuilder(world, size, int(n), float(step), desc)
                self._set_progress(active=True, stage="heights", value=0.0, world=world)
            elif kind == "t_end":
                b, self.builder = self.builder, None
                if b is None:
                    return
                data = b.finish()
                self.store.save(b.world, data)
                log.info("terrain saved: %s (%d roads, %d buildings, %d locations)",
                         b.world, len(b.roads), len(b.buildings), len(b.locations))
                if self.status["world"] == b.world:
                    self.status["terrain"] = True
                self._set_progress(active=False, stage="done", value=1.0)
                self.hub.publish("terrain", {"world": b.world})
                self._publish_status()
                self.publish_maps()
            elif kind == "hc_rect":
                # [_, unitId, x, y, w, h, resW, resH]: where the helmet-cam box is on the game screen
                self.helmet_id = msg[1]
                self.capture.set_helmet_rect(tuple(float(v) for v in msg[2:8]))
                self.hub.publish("helmet", {"id": self.helmet_id})
            elif kind == "hc_stop":
                self.helmet_id = None
                self.capture.set_helmet_rect(None)
                self.hub.publish("helmet", {"id": None})
            elif kind.startswith("t_") and self.builder is not None:
                self.builder.add(kind, msg)
                if kind in ("t_prog", "t_loc"):
                    self._set_progress(stage=self.builder.stage, value=self.builder.progress)

    # ---- combat log: write meaningful events (kills, deaths, friendly fire) to a file
    def _log_event(self, msg: list):
        try:
            t, kind = msg[1], msg[2]
        except (IndexError, TypeError):
            return
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        data = {"t": t, "type": kind}
        if kind == "kill":
            v = str(msg[3]) if len(msg) > 3 else "?"
            vside = str(msg[4]) if len(msg) > 4 else ""
            k = str(msg[5]) if len(msg) > 5 else ""
            kside = str(msg[6]) if len(msg) > 6 else ""
            weapon = str(msg[7]) if len(msg) > 7 else ""
            ff = bool(msg[8]) if len(msg) > 8 else False
            data.update(victim=v, victimSide=vside, killer=k, killerSide=kside, weapon=weapon, ff=ff)
            if k:
                line = f"KILL   {k} ({kside}) killed {v} ({vside})"
                if weapon:
                    line += f"  [{weapon}]"
                if ff:
                    line += "   *** FRIENDLY FIRE ***"
            else:
                line = f"DEATH  {v} ({vside}) died"
        else:
            line = f"{kind}  " + " ".join(str(x) for x in msg[3:])
        try:
            LOGS_DIR.mkdir(parents=True, exist_ok=True)
            with (LOGS_DIR / f"dideban-{time.strftime('%Y%m%d')}.log").open("a", encoding="utf-8") as f:
                f.write(f"{ts}  {line}\n")
        except OSError:
            log.exception("could not write the combat log")
        self.hub.publish("logevent", {**data, "ts": ts, "line": line})

    # ---- deep per-entity detail: which entities the browsers want info for
    def _recompute_watch_locked(self, now: float) -> tuple[bool, list[str]]:
        self.watched = {k: v for k, v in self.watched.items() if v > now}
        newset = sorted(self.watched.keys())
        changed = newset != self.watched_set
        if changed:
            self.watched_set = newset
        return changed, newset

    def _detail_watch(self, body: dict) -> tuple[int, dict]:
        ids = body.get("ids", [])
        if not isinstance(ids, list):
            return 400, {"ok": False, "error": "bad ids"}
        clean = [i for i in ids if isinstance(i, str) and i and len(i) <= 64][:8]
        # ids picked during an earlier mission run are not valid in this one (the page re-picks them)
        sess = body.get("session")
        if isinstance(sess, str) and sess and sess != self.status["session"]:
            return 200, {"ok": True, "stale": True, "session": self.status["session"]}
        now = time.time()
        with self.lock:
            for i in clean:
                self.watched[i] = now + DETAIL_TTL
            changed, newset = self._recompute_watch_locked(now)
        if changed and self.game is not None:
            self.game.send(["detail_set", newset])
        return 200, {"ok": True}

    def watch_sweeper(self):
        """Drops entities whose browser went away, so the game stops collecting them."""
        while True:
            time.sleep(3)
            with self.lock:
                changed, newset = self._recompute_watch_locked(time.time())
            if changed and self.game is not None:
                self.game.send(["detail_set", newset])

    # ---- browser commands
    def command(self, body: dict) -> tuple[int, dict]:
        action = body.get("action")
        if action == "detail_watch":  # a heartbeat; works even before the game connects
            return self._detail_watch(body)
        if action == "arty_set":  # calculator settings / inputs: stored here, works without the game
            snap = self.arty.update_state(body, float(self.status.get("worldSize") or 1e6))
            return 200, {"ok": True, "state": snap}
        if self.game is None or not self.status["connected"]:
            return 409, {"ok": False, "error": "game not connected"}
        if action == "arty_query":
            # exact terrain heights and the shot's conditions, answered by the game (waits up to 3 s)
            pts = body.get("points", [])
            if not isinstance(pts, list):
                return 400, {"ok": False, "error": "bad points"}
            return self.arty.query(pts, str(body.get("gun", "") or ""))
        if action == "arty_scan":
            ok, state = self.arty.request_scan(force=bool(body.get("force", False)))
            return (200, {"ok": True, "state": state}) if ok else (409, {"ok": False, "error": state})
        size = self.status.get("worldSize") or 1e6
        known_colors = {c["cls"] for c in self.meta["colors"]}
        if action in ("marker_create", "marker_text", "marker_line"):
            try:
                channel = int(body.get("channel", 1))
            except (TypeError, ValueError):
                return 400, {"ok": False, "error": "bad channel"}
            color = str(body.get("color", "ColorBlack"))
            if not 0 <= channel <= 5:
                return 400, {"ok": False, "error": "out of range"}
            if known_colors and color not in known_colors:
                return 400, {"ok": False, "error": "unknown color"}
        if action in ("marker_create", "marker_text"):
            try:
                x, y = float(body["x"]), float(body["y"])
            except (KeyError, TypeError, ValueError):
                return 400, {"ok": False, "error": "bad position"}
            if not (0 <= x <= size and 0 <= y <= size):
                return 400, {"ok": False, "error": "out of range"}
            text = " ".join(str(body.get("text", "")).split())[:200]
        if action == "marker_create":
            mtype = str(body.get("type", "mil_dot"))
            known_types = {t["cls"] for t in self.meta["types"]}
            if known_types and mtype not in known_types:
                return 400, {"ok": False, "error": "unknown marker type"}
            cmd = ["mk_create", [round(x, 1), round(y, 1)], mtype, color, text, channel]
        elif action == "marker_text":
            if not text:
                return 400, {"ok": False, "error": "empty text"}
            cmd = ["mk_text", [round(x, 1), round(y, 1)], text, color, channel]
        elif action == "marker_line":
            try:
                pts = [(float(p[0]), float(p[1])) for p in body.get("points", [])]
            except (TypeError, ValueError, IndexError):
                return 400, {"ok": False, "error": "bad points"}
            if not 2 <= len(pts) <= 200 or not all(0 <= px <= size and 0 <= py <= size for px, py in pts):
                return 400, {"ok": False, "error": "bad points"}
            cmd = ["mk_line", [round(v, 1) for p in pts for v in p], color, channel]
        elif action == "marker_delete":
            name = str(body.get("name", ""))
            if not name:
                return 400, {"ok": False, "error": "missing name"}
            cmd = ["mk_delete", name]
        elif action == "terrain_export":
            if self.builder is not None:
                return 409, {"ok": False, "error": "export already running"}
            cmd = ["terrain_export"]
            with self.lock:
                self._set_progress(active=True, stage="starting", value=0.0, world=self.status["world"])
        elif action == "sat_export":
            # Read the satellite straight from the game's own map files (no grad_meh, no screenshots).
            if not (self.sat and self.sat.available):
                return 503, {"ok": False, "error": "server needs Pillow for satellite extraction (python -m pip install pillow)"}
            world = self.status.get("world")
            ws = self.status.get("worldSize")
            if not world or not ws:
                return 409, {"ok": False, "error": "no map is loaded in the game yet"}
            arma = installer.arma_dir(self.settings)
            if not arma:
                return 404, {"ok": False, "error": "Arma 3 folder not found; set it in Setup"}
            key = world_key(world)
            if key in self.sat.building:
                return 409, {"ok": False, "error": "already extracting this map"}
            threading.Thread(target=self._extract_sat,
                             args=(key, world, self.status.get("worldDesc") or world, float(ws), arma,
                                   self.status.get("wrp", "")),
                             daemon=True).start()
            return 200, {"ok": True}
        elif action == "all_sides":
            on = bool(body.get("value", False))
            self.settings.set(all_sides=on)
            self.hub.publish("settings", self.settings.public())
            cmd = ["all_sides", on]
        elif action == "helmet_start":
            uid = str(body.get("id", ""))
            if not uid or len(uid) > 64:
                return 400, {"ok": False, "error": "bad id"}
            cmd = ["hc_start", uid]
        elif action == "helmet_stop":
            cmd = ["hc_stop"]
        elif action == "pos_interval":
            try:
                value = min(2.0, max(0.03, float(body.get("value", 0.05))))
            except (TypeError, ValueError):
                return 400, {"ok": False, "error": "bad value"}
            self.settings.set(pos_interval=value)
            self.hub.publish("settings", self.settings.public())
            cmd = ["pos_interval", value]
        else:
            return 400, {"ok": False, "error": "unknown action"}
        ok = self.game.send(cmd)
        return (200, {"ok": True}) if ok else (409, {"ok": False, "error": "send failed"})

    # ---- satellite straight from the game's map files (background worker)
    def _extract_sat(self, key: str, world: str, desc: str, ws: float, arma, wrp: str = ""):
        import shutil
        with self.sat.lock:
            self.sat.building[key] = 0.0
            self.sat.failed.pop(key, None)
        self.publish_maps()
        src_dir = CACHE_DIR / "sat_src" / key
        try:
            pbos = satextract.find_layer_pbos(arma, world, wrp)
            if not pbos:
                raise RuntimeError("satellite files for this map were not found in the game folder")
            log.info("extracting satellite for %s from %d map file(s)", key, len(pbos))

            def prog(d, t):
                with self.sat.lock:
                    self.sat.building[key] = d / t
                if d % 8 == 0 or d == t:
                    self.publish_maps()
            satextract.extract_to_dir(pbos, src_dir, world, desc, ws, progress=prog)
            self.sat._build(key, src_dir)  # reuse the memory-safe pyramid builder
        except Exception as e:
            log.exception("satellite extraction failed for %s", key)
            with self.sat.lock:
                self.sat.failed[key] = str(e)
                self.sat.building.pop(key, None)
            self.publish_maps()
        finally:
            shutil.rmtree(src_dir, ignore_errors=True)


class GameLink:
    """Accepts the extension's TCP connection; newest connection wins."""

    def __init__(self, app: App, port: int):
        self.app = app
        self.port = port
        self.lock = threading.Lock()
        self.conn: socket.socket | None = None

    def serve_forever(self):
        srv = socket.create_server(("127.0.0.1", self.port))
        log.info("waiting for the game on 127.0.0.1:%d", self.port)
        while True:
            conn, _ = srv.accept()
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn: socket.socket):
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        with self.lock:
            old, self.conn = self.conn, conn
        if old is not None:
            try:
                old.close()
            except OSError:
                pass
        self.app.on_game_connected()
        try:
            with conn.makefile("rb") as f:
                for raw in f:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line:
                        continue
                    try:
                        msg = sqf.loads(line)
                    except ValueError as e:
                        log.warning("unparsable message (%s): %.200s", e, line)
                        continue
                    try:
                        self.app.on_game_message(msg)
                    except Exception:
                        log.exception("error handling %.100s", line)
        except OSError:
            pass
        finally:
            with self.lock:
                current = self.conn is conn
                if current:
                    self.conn = None
            if current:
                self.app.on_game_disconnected()

    def send(self, cmd: list) -> bool:
        data = (sqf.dumps(cmd) + "\n").encode("utf-8")
        with self.lock:
            if self.conn is None:
                return False
            try:
                self.conn.sendall(data)
                return True
            except OSError:
                return False


def make_handler(app: App, hub: Hub, store: TerrainStore):
    own_ips = set(lan_addresses())  # this PC's own addresses count as local

    class Handler(BaseHTTPRequestHandler):
        server_version = "Dideban/1.0"

        def log_message(self, fmt, *args):
            log.debug("%s - %s", self.address_string(), fmt % args)

        def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            extra = extra or {}
            if "Cache-Control" not in extra:
                self.send_header("Cache-Control", "no-cache")
            for k, v in extra.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code: int, data):
            self._send(code, json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

        def do_GET(self):
            path = unquote(urlparse(self.path).path)
            if path == "/events":
                return self._events()
            if path == "/api/status":
                return self._json(200, {"status": app.status, "progress": app.progress})
            if path.startswith("/api/terrain/"):
                return self._terrain(path[len("/api/terrain/"):])
            if path == "/api/maps":
                return self._json(200, app.maps())
            if path == "/api/arty/db":
                return self._arty_db()
            if path in ("/api/stream/game.mjpg", "/api/stream/helmet.mjpg"):
                return self._mjpeg(path.rsplit("/", 1)[1].split(".")[0])
            if path == "/api/setup":
                if not self._local():
                    return self._json(403, {"ok": False, "error": "local_only"})
                return self._json(200, {"ok": True, "status": installer.status(app.settings)})
            if path.startswith("/api/sat/"):
                return self._sat(path[len("/api/sat/"):].split("/"))
            return self._static(path)

        # The artillery weapon database for the connected game's mod set. When there is none yet
        # the game is asked to build it (once; it takes a few seconds and arrives as "arty_db").
        def _arty_db(self):
            db = app.arty.database()
            if db is None and app.status.get("connected") and "noscan" not in (urlparse(self.path).query or ""):
                app.arty.request_scan()
            return self._json(200, {"status": app.arty.status(), "db": db})

        def _sat(self, parts: list[str]):
            sat = app.sat
            if sat is None:
                return self._json(404, {"ok": False})
            if len(parts) == 2 and parts[1] == "info":
                info = sat.info(parts[0])
                return self._json(200, info) if info else self._json(404, {"ok": False})
            if len(parts) == 2 and parts[1] == "dem":
                p = sat.dem_path(parts[0])
                if not p.is_file():
                    return self._json(404, {"ok": False})
                return self._send(200, p.read_bytes(), "application/json")
            m = re.fullmatch(r"(\d+)_(\d+)\.jpg", parts[2]) if len(parts) == 3 and parts[1].isdigit() else None
            if not m:
                return self._json(404, {"ok": False})
            p = sat.tile_path(parts[0], int(parts[1]), int(m.group(1)), int(m.group(2)))
            if not p.is_file():
                return self._send(404, b"", "text/plain")
            self._send(200, p.read_bytes(), "image/jpeg", {"Cache-Control": "max-age=86400"})

        def _local(self) -> bool:
            ip = self.client_address[0]
            return ip in ("127.0.0.1", "::1", "::ffff:127.0.0.1") or ip in own_ips

        def do_POST(self):
            path = urlparse(self.path).path
            if path != "/api/command" and not path.startswith("/api/setup"):
                return self._json(404, {"ok": False})
            try:
                # clamp: a negative length would make read() block until the client hangs up
                length = max(0, min(int(self.headers.get("Content-Length", 0)), 65536))
                body = json.loads(self.rfile.read(length) or b"{}")
                if not isinstance(body, dict):
                    raise ValueError
            except ValueError:
                return self._json(400, {"ok": False, "error": "bad json"})
            if path.startswith("/api/setup"):
                return self._setup_post(path, body)
            code, resp = app.command(body)
            self._json(code, resp)

        # Folder settings write to disk, so only the PC itself may change them.
        def _setup_post(self, path: str, body: dict):
            if not self._local():
                return self._json(403, {"ok": False, "error": "local_only"})
            if path != "/api/setup":
                return self._json(404, {"ok": False})
            s = app.settings
            try:
                if "arma_dir" in body:
                    s.set(arma_dir=str(body["arma_dir"]).strip().strip('"'))
                app.sat.arma_dir = installer.arma_dir(s)
                app.publish_maps()
            except OSError as e:
                return self._json(500, {"ok": False, "error": str(e), "status": installer.status(s)})
            self._json(200, {"ok": True, "status": installer.status(s)})

        def _static(self, path: str):
            if path in ("", "/"):
                path = "/index.html"
            target = (WEB_DIR / path.lstrip("/")).resolve()
            if WEB_DIR not in target.parents or not target.is_file():
                return self._send(404, b"not found", "text/plain")
            ctype = CONTENT_TYPES.get(target.suffix, "application/octet-stream")
            self._send(200, target.read_bytes(), ctype)

        def _terrain(self, world: str):
            data = store.read_gz(world)
            if data is None:
                return self._json(404, {"ok": False, "error": "terrain not exported"})
            if "gzip" in self.headers.get("Accept-Encoding", ""):
                self._send(200, data, "application/json", {"Content-Encoding": "gzip"})
            else:
                import gzip
                self._send(200, gzip.decompress(data), "application/json")

        # Live picture from the game as MJPEG (an <img> shows it on any browser, phones included).
        def _mjpeg(self, name: str):
            cap = app.capture
            if not cap.available:
                return self._json(503, {"ok": False, "error": "install mss: python -m pip install --user mss"})
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            cap.add_viewer(name, 1)
            last = None
            try:
                while True:
                    frame = cap.wait_frame(name, last)
                    if not frame or frame[0] == last:
                        continue
                    last, jpg = frame
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                     + str(len(jpg)).encode() + b"\r\n\r\n" + jpg + b"\r\n")
                    self.wfile.flush()
            except OSError:
                pass
            finally:
                cap.add_viewer(name, -1)

        def _events(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            q = hub.subscribe()
            try:
                for payload in app.snapshot_events():
                    self.wfile.write(payload)
                self.wfile.flush()
                while True:
                    try:
                        payload = q.get(timeout=15)
                    except queue.Empty:
                        payload = b": ping\n\n"
                    self.wfile.write(payload)
                    self.wfile.flush()
            except OSError:
                pass
            finally:
                hub.unsubscribe(q)

    return Handler


def lan_addresses() -> list[str]:
    addrs = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            addrs.add(s.getsockname()[0])
    except OSError:
        pass
    try:
        for a in socket.gethostbyname_ex(socket.gethostname())[2]:
            addrs.add(a)
    except OSError:
        pass
    return sorted(a for a in addrs if not a.startswith("127."))


def main():
    ap = argparse.ArgumentParser(description="Dideban server")
    ap.add_argument("--host", default="0.0.0.0", help="HTTP bind address (0.0.0.0 = reachable from phone/tablet on your network)")
    ap.add_argument("--http-port", type=int, default=8080)
    ap.add_argument("--game-port", type=int, default=28901, help="must match the extension (28901)")
    ap.add_argument("--arma-dir", type=Path, help="Arma 3 folder (default: from the registry); satellite tiles are read from its map files")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")

    hub = Hub()
    store = TerrainStore(CACHE_DIR)
    settings = installer.Settings()
    app_ref: list[App] = []
    sat = SatelliteStore(CACHE_DIR, args.arma_dir or installer.arma_dir(settings),
                         lambda: app_ref and app_ref[0].publish_maps())
    app = App(store, hub, sat, settings)
    app_ref.append(app)
    if not sat.available:
        log.warning("Pillow is not installed: satellite maps are disabled (python -m pip install pillow)")
    # Satellite comes from the game's own map files (press the button in the app),
    # cached inside this folder's cache/. There is no external grad_meh dependency.
    game = GameLink(app, args.game_port)
    app.game = game
    threading.Thread(target=game.serve_forever, daemon=True).start()
    threading.Thread(target=app.watch_sweeper, daemon=True).start()

    httpd = ThreadingHTTPServer((args.host, args.http_port), make_handler(app, hub, store))
    httpd.daemon_threads = True
    print()
    print("  Dideban is running")
    print(f"  This PC:        http://localhost:{args.http_port}")
    if args.host == "0.0.0.0":
        for a in lan_addresses():
            print(f"  Phone / tablet: http://{a}:{args.http_port}")
    print("  Press Ctrl+C to stop.")
    print()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
