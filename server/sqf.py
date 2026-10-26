"""Conversion between SQF array literals (as produced by `str` / read by `parseSimpleArray`) and Python."""
import json
import math
import re

# A string ("" escapes a quote), a number, or a bare word such as true/false/<null>.
_TOKEN = re.compile(r'"((?:[^"]|"")*)"|(-?[0-9.][0-9.eE+\-]*)|([^\s,\[\]"]+)')


def _replace(m: re.Match) -> str:
    if m.group(1) is not None:
        return json.dumps(m.group(1).replace('""', '"'), ensure_ascii=False)
    if m.group(2) is not None:
        return m.group(2)
    word = m.group(3).lower()
    return word if word in ("true", "false") else "null"


def loads(text: str):
    """Parse the output of SQF `str` for arrays of numbers, strings and booleans."""
    return json.loads(_TOKEN.sub(_replace, text))


def dumps(value) -> str:
    """Serialise to a literal that `parseSimpleArray` accepts."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            return "0"
        return repr(round(value, 3))
    if isinstance(value, str):
        return '"' + value.replace('"', '""') + '"'
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(dumps(v) for v in value) + "]"
    if value is None:
        return '""'
    raise TypeError(f"cannot serialise {type(value).__name__} to SQF")
