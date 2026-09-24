"""Minimal YAML-subset loader/dumper for Restoration Copilot pack files.

The sandbox build environment has no PyYAML and no network access, so the
restoration module ships this small, well-tested subset instead. The subset
is deliberately chosen to be *valid YAML*: every file this module emits or
parses also loads cleanly under PyYAML in the production claudopus host.

Supported subset:
  * block mappings (``key: value`` / ``key:`` + indented block)
  * block sequences (``- item`` / ``- key: value`` + indented continuation)
  * flow collections written as JSON (``["a", "b"]`` / ``{"k": 1}``) — valid
    YAML flow syntax, parsed with json.loads (lenient fallback for unquoted
    scalars)
  * scalars: quoted strings, bare strings, int, float, bool, null
  * comments: full-line ``#`` and inline `` #`` outside quotes

Not supported (raises YAMLError loudly, never silently mis-parses):
  anchors, aliases, multi-line scalars (| >), tags, multi-document streams.
"""

from __future__ import annotations

import json
import re
from typing import Any, List, Tuple


class YAMLError(ValueError):
    pass


_INT_RE = re.compile(r"^-?\d+$")
_FLOAT_RE = re.compile(r"^-?\d+\.\d+([eE][-+]?\d+)?$")


def _strip_comment(line: str) -> str:
    """Strip an inline `` #`` comment outside of quotes."""
    in_s = in_d = False
    for i, ch in enumerate(line):
        if ch == '"' and not in_s:
            in_d = not in_d
        elif ch == "'" and not in_d:
            in_s = not in_s
        elif ch == "#" and not in_s and not in_d:
            if i == 0 or line[i - 1] in (" ", "\t"):
                return line[:i].rstrip()
    return line.rstrip()


def _preprocess(text: str) -> List[Tuple[int, str]]:
    out: List[Tuple[int, str]] = []
    for raw in text.splitlines():
        if "\t" in raw[: len(raw) - len(raw.lstrip())]:
            raise YAMLError("tab indentation is not supported")
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        body = _strip_comment(raw)
        if not body.strip():
            continue
        indent = len(body) - len(body.lstrip(" "))
        out.append((indent, body.strip()))
    return out


def _unquote(s: str) -> str:
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        try:
            return json.loads(s)
        except Exception as exc:  # pragma: no cover - defensive
            raise YAMLError(f"bad quoted string {s!r}: {exc}")
    if len(s) >= 2 and s[0] == "'" and s[-1] == "'":
        return s[1:-1].replace("''", "'")
    return s


def _parse_scalar(tok: str) -> Any:
    tok = tok.strip()
    if tok == "" or tok in ("null", "Null", "NULL", "~"):
        return None
    if tok in ("true", "True", "TRUE"):
        return True
    if tok in ("false", "False", "FALSE"):
        return False
    if tok[0:1] in ('"', "'"):
        return _unquote(tok)
    if _INT_RE.match(tok):
        try:
            return int(tok)
        except ValueError:
            pass
    if _FLOAT_RE.match(tok):
        try:
            return float(tok)
        except ValueError:
            pass
    return tok


def _split_flow(tok: str) -> List[str]:
    """Split a flow collection body on top-level commas."""
    parts, depth, cur, in_s, in_d = [], 0, [], False, False
    for ch in tok:
        if ch == '"' and not in_s:
            in_d = not in_d
        elif ch == "'" and not in_d:
            in_s = not in_s
        if ch in "[{" and not in_s and not in_d:
            depth += 1
        elif ch in "]}" and not in_s and not in_d:
            depth -= 1
        if ch == "," and depth == 0 and not in_s and not in_d:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    if "".join(cur).strip():
        parts.append("".join(cur))
    return [p.strip() for p in parts]


def _parse_flow(tok: str) -> Any:
    tok = tok.strip()
    try:
        return json.loads(tok)
    except Exception:
        pass
    if tok.startswith("[") and tok.endswith("]"):
        body = tok[1:-1].strip()
        if not body:
            return []
        return [_parse_value(p) for p in _split_flow(body)]
    if tok.startswith("{") and tok.endswith("}"):
        body = tok[1:-1].strip()
        if not body:
            return {}
        out = {}
        for part in _split_flow(body):
            k, v = _split_key(part)
            out[_parse_scalar(k)] = _parse_value(v)
        return out
    raise YAMLError(f"cannot parse flow collection: {tok!r}")


def _parse_value(tok: str) -> Any:
    tok = tok.strip()
    if tok.startswith("[") or tok.startswith("{"):
        return _parse_flow(tok)
    return _parse_scalar(tok)


def _split_key(line: str) -> Tuple[str, str]:
    """Split ``key: value`` on the first ``:`` followed by space/EOL."""
    in_s = in_d = False
    for i, ch in enumerate(line):
        if ch == '"' and not in_s:
            in_d = not in_d
        elif ch == "'" and not in_d:
            in_s = not in_s
        elif ch == ":" and not in_s and not in_d:
            if i + 1 >= len(line):
                return line[:i].strip(), ""
            if line[i + 1] == " ":
                return line[:i].strip(), line[i + 2 :].strip()
    raise YAMLError(f"expected 'key: value' mapping entry, got: {line!r}")


def _parse_block(lines: List[Tuple[int, str]], i: int, indent: int) -> Tuple[Any, int]:
    if i >= len(lines):
        return None, i
    first_indent, first = lines[i]
    if first_indent < indent:
        return None, i
    is_seq = first == "-" or first.startswith("- ")
    if is_seq:
        return _parse_seq(lines, i, first_indent)
    return _parse_map(lines, i, first_indent)


def _parse_map(lines: List[Tuple[int, str]], i: int, indent: int) -> Tuple[Any, int]:
    out = {}
    n = len(lines)
    while i < n:
        ind, content = lines[i]
        if ind < indent:
            break
        if ind > indent:
            raise YAMLError(f"unexpected indentation at line content {content!r}")
        if content == "-" or content.startswith("- "):
            break
        key, value = _split_key(content)
        key = _unquote(key)
        if value == "":
            # nested block or null
            if i + 1 < n and lines[i + 1][0] > indent:
                child, j = _parse_block(lines, i + 1, lines[i + 1][0])
                out[key] = child
                i = j
            else:
                out[key] = None
                i += 1
        else:
            out[key] = _parse_value(value)
            i += 1
    return out, i


def _parse_seq(lines: List[Tuple[int, str]], i: int, indent: int) -> Tuple[Any, int]:
    out: List[Any] = []
    n = len(lines)
    while i < n:
        ind, content = lines[i]
        if ind < indent:
            break
        if ind > indent:
            raise YAMLError(f"unexpected indentation in sequence: {content!r}")
        if not (content == "-" or content.startswith("- ")):
            break
        item = content[1:].strip()
        if item == "":
            # nested block on following lines
            if i + 1 < n and lines[i + 1][0] > indent:
                child, j = _parse_block(lines, i + 1, lines[i +1][0])
                out.append(child)
                i = j
            else:
                out.append(None)
                i += 1
        elif ":" in item and not item.startswith(("[", "{", '"', "'")):
            # inline mapping start: `- key: value` with continuation lines
            key, value = _split_key(item)
            item_map = {}
            item_indent = indent + (len(content) - len(item))
            key = _unquote(key)
            if value == "":
                if i + 1 < n and lines[i + 1][0] > item_indent:
                    child, j = _parse_block(lines, i + 1, lines[i + 1][0])
                    item_map[key] = child
                    i = j
                else:
                    item_map[key] = None
                    i += 1
            else:
                item_map[key] = _parse_value(value)
                i += 1
            # continuation entries of this item's map at item_indent
            while i < n and lines[i][0] == item_indent and not lines[i][1].startswith("- "):
                k2, v2 = _split_key(lines[i][1])
                k2 = _unquote(k2)
                if v2 == "":
                    if i + 1 < n and lines[i + 1][0] > item_indent:
                        child, j = _parse_block(lines, i + 1, lines[i + 1][0])
                        item_map[k2] = child
                        i = j
                    else:
                        item_map[k2] = None
                        i += 1
                else:
                    item_map[k2] = _parse_value(v2)
                    i += 1
            out.append(item_map)
        else:
            out.append(_parse_value(item))
            i += 1
    return out, i


def load(text: str) -> Any:
    lines = _preprocess(text)
    if not lines:
        return None
    obj, i = _parse_block(lines, 0, lines[0][0])
    if i != len(lines):
        raise YAMLError(f"trailing unparsed content at line {i}: {lines[i][1]!r}")
    return obj


def load_file(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as fh:
        return load(fh.read())


# ---------------------------------------------------------------------------
# Emitter (block style; strings JSON-quoted when they could mis-parse)
# ---------------------------------------------------------------------------

_BARE_RE = re.compile(r"^[A-Za-z0-9_./+@-][A-Za-z0-9_ ./+@()-]*$")


def _emit_scalar(v: Any) -> str:
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return repr(v)
    s = str(v)
    if s and _BARE_RE.match(s) and _parse_scalar(s) == s and not s.startswith(("- ", "#")):
        return s
    return json.dumps(s)


def _emit_flow(v: Any) -> str:
    return json.dumps(v)


def dump(data: Any, _indent: int = 0) -> str:
    lines: List[str] = []
    _dump_into(data, _indent, lines)
    return "\n".join(lines) + ("\n" if lines else "")


def _dump_into(data: Any, indent: int, lines: List[str]) -> None:
    pad = " " * indent
    if isinstance(data, dict):
        if not data:
            lines.append(pad + "{}")
            return
        for key, value in data.items():
            k = _emit_scalar(key)
            if isinstance(value, dict) and value:
                lines.append(f"{pad}{k}:")
                _dump_into(value, indent + 2, lines)
            elif isinstance(value, list) and value:
                lines.append(f"{pad}{k}:")
                _dump_into(value, indent + 2, lines)
            elif isinstance(value, (dict, list)):
                lines.append(f"{pad}{k}: {_emit_flow(value)}")
            else:
                lines.append(f"{pad}{k}: {_emit_scalar(value)}")
    elif isinstance(data, list):
        if not data:
            lines.append(pad + "[]")
            return
        for item in data:
            if isinstance(item, dict) and item:
                first = True
                for key, value in item.items():
                    k = _emit_scalar(key)
                    prefix = f"{pad}- " if first else f"{pad}  "
                    first = False
                    if isinstance(value, dict) and value:
                        lines.append(f"{prefix}{k}:")
                        _dump_into(value, indent + 4, lines)
                    elif isinstance(value, list) and value:
                        lines.append(f"{prefix}{k}:")
                        _dump_into(value, indent + 4, lines)
                    elif isinstance(value, (dict, list)):
                        lines.append(f"{prefix}{k}: {_emit_flow(value)}")
                    else:
                        lines.append(f"{prefix}{k}: {_emit_scalar(value)}")
            elif isinstance(item, (dict, list)):
                lines.append(f"{pad}- {_emit_flow(item)}")
            else:
                lines.append(f"{pad}- {_emit_scalar(item)}")
    else:
        lines.append(pad + _emit_scalar(data))


def dump_file(data: Any, path: str) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(dump(data))
