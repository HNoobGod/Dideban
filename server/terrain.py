"""Assembles terrain streamed from the game and caches it on disk, one gzip'd JSON file per world."""
import gzip
import json
import re
import threading
from pathlib import Path


def world_key(world: str) -> str:
    return re.sub(r"[^a-z0-9_\-]", "_", world.lower()) or "unknown"


class TerrainStore:
    def __init__(self, directory: Path):
        self.dir = directory
        self.dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()

    def path(self, world: str) -> Path:
        return self.dir / f"{world_key(world)}.json.gz"

    def has(self, world: str) -> bool:
        return bool(world) and self.path(world).is_file()

    def read_gz(self, world: str) -> bytes | None:
        p = self.path(world)
        with self.lock:
            return p.read_bytes() if p.is_file() else None

    def _index_path(self) -> Path:
        return self.dir / "index.json"

    def _read_index(self) -> dict:
        try:
            return json.loads(self._index_path().read_text("utf-8"))
        except (OSError, ValueError):
            return {}

    def list(self) -> dict[str, dict]:
        """world key -> {world, desc, size} for every exported terrain."""
        with self.lock:
            index = self._read_index()
            changed = False
            out = {}
            for p in self.dir.glob("*.json.gz"):
                key = p.name[: -len(".json.gz")]
                if key not in index:  # exported before the index existed: read it once
                    try:
                        d = json.loads(gzip.decompress(p.read_bytes()))
                        index[key] = {"world": d.get("world", key), "desc": d.get("desc", ""), "size": d.get("size")}
                    except (OSError, ValueError):
                        index[key] = {"world": key, "desc": "", "size": None}
                    changed = True
                out[key] = index[key]
            if changed:
                self._index_path().write_text(json.dumps(index, ensure_ascii=False), "utf-8")
        return out

    def save(self, world: str, data: dict) -> None:
        raw = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        p = self.path(world)
        tmp = p.with_suffix(".tmp")
        with self.lock:
            tmp.write_bytes(gzip.compress(raw, compresslevel=6))
            tmp.replace(p)
            index = self._read_index()
            index[world_key(world)] = {"world": world, "desc": data.get("desc", ""), "size": data.get("size")}
            self._index_path().write_text(json.dumps(index, ensure_ascii=False), "utf-8")


class TerrainBuilder:
    """Collects t_* messages from dideban_fnc_exportTerrain."""

    def __init__(self, world: str, size: float, n: int, step: float, desc: str):
        self.world = world
        self.size = size
        self.n = n
        self.step = step
        self.desc = desc
        self.heights: list[list[int] | None] = [None] * n
        self.trees = [0] * (n * n)
        self.roads: list = []
        self.buildings: list = []
        self.locations: list = []
        self.stage = "heights"
        self.progress = 0.0

    def add(self, kind: str, msg: list) -> None:
        if kind == "t_h":
            j, row = int(msg[1]), msg[2]
            if 0 <= j < self.n and len(row) == self.n:
                self.heights[j] = [int(h) for h in row]
        elif kind == "t_trees":
            total = self.n * self.n
            for k, c in msg[1]:
                k = int(k)
                if 0 <= k < total:
                    self.trees[k] += int(c)
        elif kind == "t_roads":
            self.roads.extend(msg[1])
        elif kind == "t_bld":
            self.buildings.extend(msg[1])
        elif kind == "t_loc":
            self.locations = [l for l in msg[1] if len(l) >= 4]
            self.stage, self.progress = "locations", 1.0
        elif kind == "t_prog":
            self.stage, self.progress = str(msg[1]), float(msg[2])

    def finish(self) -> dict:
        heights: list[int] = []
        for row in self.heights:
            heights.extend(row if row is not None else [0] * self.n)
        return {
            "version": 1,
            "world": self.world,
            "desc": self.desc,
            "size": self.size,
            "n": self.n,
            "step": self.step,
            "heights": heights,
            "trees": self.trees,
            # [type, width, x1, y1, x2, y2, bridge]
            "roads": self.roads,
            # [x, y, dir, width, length]
            "buildings": self.buildings,
            # [name, type, x, y]
            "locations": self.locations,
        }
