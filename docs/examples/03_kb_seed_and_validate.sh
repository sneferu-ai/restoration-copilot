#!/usr/bin/env bash
# Knowledge-base bootstrap and validation (spec §1, FR-049).
#
# The seed CSV (orchestrator/prompts/packs/restoration_kb_seed.csv) is the
# source of truth for the reference KB. seed_restoration_kb.py converts it to
# the runtime YAML and enforces per-category minimums + part_id uniqueness;
# validate_kb_seed.py independently re-checks BOTH files.
#
# Run from the repository root:
#     bash docs/examples/03_kb_seed_and_validate.sh
#
# Both scripts exit non-zero on any validation failure. Note: seeding rewrites
# restoration_kb.yaml deterministically from the CSV — any operator_entries
# added via the KB API are NOT preserved by regeneration (back them up first).
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "== Seed: CSV → YAML =="
python3 scripts/seed_restoration_kb.py

echo
echo "== Independent validation (CSV and YAML) =="
python3 scripts/validate_kb_seed.py

echo
echo "== Spot-check the generated YAML =="
python3 - <<'PY'
import sys
from pathlib import Path
sys.path.insert(0, str(Path(".").resolve()))
from orchestrator.core import restoration_yaml

data = restoration_yaml.load_file("orchestrator/prompts/packs/restoration_kb.yaml")
makes = data.get("makes") or {}
total = sum(
    len(year_block.get("parts") or [])
    for make in makes.values()
    for model in (make.get("models") or {}).values()
    for year_block in (model.get("years") or {}).values()
)
print(f"makes: {sorted(makes)}")
print(f"total parts: {total}")
first_make = sorted(makes)[0]
first_model = sorted(makes[first_make]["models"])[0]
first_year = sorted(makes[first_make]["models"][first_model]["years"])[0]
part = makes[first_make]["models"][first_model]["years"][first_year]["parts"][0]
print(f"sample entry ({first_make} {first_model} {first_year}):")
for key, value in part.items():
    print(f"  {key}: {value}")
PY
