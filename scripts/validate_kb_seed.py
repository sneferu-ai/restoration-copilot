#!/usr/bin/env python3
"""Independent KB seed validator (spec B13 §1/§5, OBL-28).

Re-checks, AFTER seeding: total entry count, non-empty OEM numbers,
price-range validity, per-category minimums, and duplicate ``part_id``
uniqueness — against BOTH the CSV seed and the generated KB YAML. Exit 0 on
success, 1 on any failure.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from scripts.seed_restoration_kb import (  # noqa: E402
    CATEGORY_MINIMUMS,
    CSV_PATH,
    YAML_PATH,
    read_seed,
    validate_rows,
)
from orchestrator.core import restoration_yaml  # noqa: E402


def validate_yaml() -> list:
    errors = []
    if not YAML_PATH.exists():
        return [f"KB YAML missing: {YAML_PATH} (run scripts/seed_restoration_kb.py)"]
    try:
        data = restoration_yaml.load_file(str(YAML_PATH)) or {}
    except Exception as exc:
        return [f"KB YAML malformed: {exc}"]
    seen = set()
    counts = {}
    total = 0
    makes = data.get("makes") or {}
    combos = set()
    for make, make_block in makes.items():
        for model, model_block in (make_block.get("models") or {}).items():
            for year, year_block in (model_block.get("years") or {}).items():
                combos.add((make, model, year))
                for part in year_block.get("parts") or []:
                    total += 1
                    pid = part.get("part_id")
                    if pid in seen:
                        errors.append(f"YAML duplicate part_id: {pid}")
                    seen.add(pid)
                    cat = part.get("category")
                    counts[cat] = counts.get(cat, 0) + 1
                    if not (part.get("oem_number") or "").strip():
                        errors.append(f"{pid}: empty oem_number in YAML")
                    rng = part.get("indicative_price_range_usd") or {}
                    try:
                        if not (0 < float(rng.get("min")) <= float(rng.get("mid")) <= float(rng.get("max"))):
                            errors.append(f"{pid}: invalid YAML price range {rng}")
                    except (TypeError, ValueError):
                        errors.append(f"{pid}: non-numeric YAML price range {rng}")
    if total < 205:
        errors.append(f"YAML entry count {total} below 205")
    for cat, minimum in CATEGORY_MINIMUMS.items():
        if counts.get(cat, 0) < minimum:
            errors.append(f"YAML category {cat!r}: {counts.get(cat, 0)} below minimum {minimum}")
    if len(combos) < 5:
        errors.append(f"YAML vehicle combos {len(combos)} below 5")
    return errors


def main() -> int:
    rows = read_seed(CSV_PATH)
    csv_errors = validate_rows(rows)
    yaml_errors = validate_yaml()
    errors = csv_errors + yaml_errors
    if errors:
        for err in errors:
            print(f"KB VALIDATION FAILED: {err}", file=sys.stderr)
        return 1
    categories = sorted({r["category"] for r in rows})
    print(f"KB validation passed: {len(rows)} entries across {len(categories)} categories")
    return 0


if __name__ == "__main__":
    sys.exit(main())
