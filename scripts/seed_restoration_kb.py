#!/usr/bin/env python3
"""KB bootstrap (spec B13 §1, FR-049): convert the bundled
``orchestrator/prompts/packs/restoration_kb_seed.csv`` into
``orchestrator/prompts/packs/restoration_kb.yaml`` at install time.

Validates per-category minimums AND duplicate ``part_id`` uniqueness; exits
non-zero on any shortfall or duplicate. One-time offline import — not a
runtime API dependency.
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from orchestrator.core import restoration_yaml  # noqa: E402

CSV_PATH = REPO_ROOT / "orchestrator" / "prompts" / "packs" / "restoration_kb_seed.csv"
YAML_PATH = REPO_ROOT / "orchestrator" / "prompts" / "packs" / "restoration_kb.yaml"

CATEGORY_MINIMUMS = {
    "brake": 30,
    "suspension": 25,
    "engine": 40,
    "body": 30,
    "interior": 25,
    "electrical": 15,
    "exhaust": 10,
    "fuel": 10,
    "cooling": 10,
    "transmission": 10,
}
TOTAL_MINIMUM = 205

# Vehicle make/model/year is encoded in the part_id prefix by the generator:
# {slug}_{model}_{year}_{category}_... — the interchange column carries the
# human-readable ranges. The KB YAML nests by make/model/year parsed from
# part_id where possible, falling back to a "general" bucket.
MAKE_OF = {"chevy": "Chevrolet", "ford": "Ford", "dodge": "Dodge"}
MODEL_TITLE = {"camaro": "Camaro", "mustang": "Mustang", "charger": "Charger",
               "chevelle": "Chevelle", "nova": "Nova", "c10": "C10"}


def read_seed(csv_path: Path = CSV_PATH) -> list:
    rows = []
    with open(csv_path, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader((line for line in fh if not line.startswith("#")))
        for raw in reader:
            if not raw or not raw.get("part_id"):
                continue
            rows.append(raw)
    return rows


def validate_rows(rows: list) -> list:
    errors = []
    if len(rows) < TOTAL_MINIMUM:
        errors.append(f"entry count {len(rows)} below total minimum {TOTAL_MINIMUM}")
    counts = {}
    seen = set()
    for row in rows:
        pid = row["part_id"]
        if pid in seen:
            errors.append(f"duplicate part_id: {pid}")
        seen.add(pid)
        cat = (row.get("category") or "").strip()
        counts[cat] = counts.get(cat, 0) + 1
        if not (row.get("oem_number") or "").strip():
            errors.append(f"{pid}: empty oem_number")
        try:
            pmin = float(row.get("indicative_price_min_usd") or 0)
            pmax = float(row.get("indicative_price_max_usd") or 0)
            pmid = float(row.get("indicative_price_mid_usd") or 0)
            if not (0 < pmin <= pmid <= pmax):
                errors.append(f"{pid}: invalid price range {pmin}/{pmid}/{pmax}")
        except ValueError:
            errors.append(f"{pid}: non-numeric price range")
    for cat, minimum in CATEGORY_MINIMUMS.items():
        if counts.get(cat, 0) < minimum:
            errors.append(f"category {cat!r}: {counts.get(cat, 0)} entries below minimum {minimum}")
    return errors


def vehicle_of(part_id: str) -> tuple:
    parts = part_id.split("_")
    if len(parts) >= 3:
        make = MAKE_OF.get(parts[0], parts[0].title())
        model = MODEL_TITLE.get(parts[1], parts[1].title())
        year = parts[2]
        return make, model, year
    return "General", "General", ""


def build_kb(rows: list) -> dict:
    makes: dict = {}
    for row in rows:
        make, model, year = vehicle_of(row["part_id"])
        models = makes.setdefault(make, {"models": {}})["models"]
        model_block = models.setdefault(model, {"years": {}})
        year_block = model_block["years"].setdefault(year, {"parts": []})
        dims = {
            "length": float(row["reference_dimensions_length_mm"]),
            "width": float(row["reference_dimensions_width_mm"]),
            "height": float(row["reference_dimensions_height_mm"]),
        }
        prices = {
            "min": float(row["indicative_price_min_usd"]),
            "max": float(row["indicative_price_max_usd"]),
            "mid": float(row["indicative_price_mid_usd"]),
        }
        year_block["parts"].append(
            {
                "part_id": row["part_id"],
                "name": row["name"],
                "oem_number": row["oem_number"],
                "aftermarket_alternatives": [
                    a for a in (row.get("aftermarket_alternatives") or "").split(";") if a
                ],
                "category": row["category"],
                "criticality": row["criticality"],
                "reference_dimensions_mm": dims,
                "indicative_price_range_usd": prices,
                "interchange": [i for i in (row.get("interchange") or "").split(";") if i],
            }
        )
    return {"makes": makes}


def main() -> int:
    rows = read_seed()
    errors = validate_rows(rows)
    if errors:
        for err in errors:
            print(f"SEED VALIDATION FAILED: {err}", file=sys.stderr)
        return 1
    kb = build_kb(rows)
    restoration_yaml.dump_file(kb, str(YAML_PATH))
    categories = sorted({r["category"] for r in rows})
    print(f"KB seeded: {len(rows)} entries across {len(categories)} categories -> {YAML_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
