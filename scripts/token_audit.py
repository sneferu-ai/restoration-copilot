#!/usr/bin/env python3
"""Closed-token-layer audit: raw hex colors / px / ms durations must not appear
in component source outside shared/base-tokens.css and the per-app styles.css
component-class files (which define .btn/.input ONCE from tokens)."""
import re
import sys
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "orchestrator" / "ui" / "app"
ALLOWED = {
    APP / "shared" / "base-tokens.css",
    APP / "console" / "src" / "styles.css",
    APP / "guide" / "src" / "styles.css",
}
violations = []
hex_re = re.compile(r"#[0-9a-fA-F]{3,8}\b")
px_re = re.compile(r"\b\d+(?:\.\d+)?px\b")
ms_re = re.compile(r"\b\d+(?:\.\d+)?ms\b")

for path in list(APP.glob("shared/**/*.ts*")) + list(APP.glob("console/src/**/*.ts*")) + list(APP.glob("guide/src/**/*.ts*")):
    if path in ALLOWED:
        continue
    text = path.read_text(encoding="utf-8")
    for i, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if stripped.startswith("//") or stripped.startswith("*"):
            continue
        for name, rx in (("hex", hex_re), ("px", px_re), ("ms", ms_re)):
            for m in rx.finditer(line):
                violations.append(f"{path}:{i} [{name}] {stripped[:100]}")

print("\n".join(violations) if violations else "TOKEN AUDIT CLEAN")
sys.exit(1 if violations else 0)
