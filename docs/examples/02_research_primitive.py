#!/usr/bin/env python3
"""The sourcing research primitive (FR-012) with a mock bridge dispatcher.

Demonstrates the pinned contract — tier order, template interpolation, dedup,
budget enforcement, retry/backoff — hermetically, with no network:

    python3 docs/examples/02_research_primitive.py
"""

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from orchestrator.core.research_primitives import (  # noqa: E402
    deduplicate,
    interpolate_template,
    research_part_sourcing,
)
from orchestrator.core.restoration_models import (  # noqa: E402
    PartSourcingQuery,
    SourceRegistryEntry,
)

QUERY = PartSourcingQuery(
    part_id="part-demo01",
    part_name="front brake caliper",
    oem_number="BC-1969-X",
    vehicle_make="Chevrolet",
    vehicle_model="Camaro",
    vehicle_year="1969",
    per_part_budget_ceiling_usd=300.0,
)

REGISTRY = [
    SourceRegistryEntry(
        source_id="classic_industries",
        vendor_name="Classic Industries",
        url="https://www.classicindustries.com/search",
        search_template="https://www.classicindustries.com/search?q={part_name}+{oem_number}",
        rate_limit_seconds=0,
    ),
    SourceRegistryEntry(
        source_id="joes_rebuilder",
        vendor_name="Joe's Brake Rebuilding",
        url="tel:555-123-4567",
        search_template=None,  # trade partner: skipped by the primitive (OBL-49)
        is_trade_partner=True,
        rate_limit_seconds=0,
    ),
]


def fake_bridge(kind: str, payload: dict, timeout_s: float):
    """A deterministic stand-in for the production bridge dispatcher."""
    print(f"  bridge call: kind={kind} timeout={timeout_s}s")
    if kind == "registry_query":
        print(f"    url = {payload['url']}")
        return [
            {"vendor": "Classic Industries", "price_usd": 249.99, "condition": "new",
             "availability": "in_stock", "oem_number": "BC-1969-X"},
            # duplicate identity + price within ±5% → deduplicated away
            {"vendor": "classic industries", "price_usd": 254.00, "condition": "new",
             "availability": "in_stock", "oem_number": "BC-1969-X"},
            # over the per-part ceiling → dropped (exceeds_budget only if it's ALL we find)
            {"vendor": "Concours Parts", "price_usd": 519.00, "condition": "nos",
             "availability": "special_order", "oem_number": "BC-1969-X"},
        ]
    raise AssertionError("LLM fallback should not fire: ≥3 registry candidates not required here")


def main() -> None:
    print("== Template interpolation (FR-012) ==")
    url = interpolate_template(REGISTRY[0].search_template, QUERY)
    print(f"  {url}")
    no_oem = interpolate_template(
        "https://x.test/s?oem={oem_number}&q={part_name}",
        QUERY.model_copy(update={"oem_number": None}),
    )
    print(f"  null oem_number drops the sole-value param: {no_oem}")

    print("\n== Tiered hunt with a mock bridge ==")
    result = research_part_sourcing(QUERY, REGISTRY, fake_bridge, per_query_timeout_s=30.0)
    print(json.dumps(result, indent=2, default=str))

    print("\n== Dedup is pairwise: part_id + vendor + oem_number + price ±5% ==")
    kept = deduplicate([
        {"part_id": "p", "vendor": "A", "oem_number": "X", "price_usd": 100.0},
        {"part_id": "p", "vendor": "a", "oem_number": "X", "price_usd": 104.9},  # dupe (within 5%)
        {"part_id": "p", "vendor": "A", "oem_number": "X", "price_usd": 120.0},  # kept
        {"part_id": "p", "vendor": "B", "oem_number": "X", "price_usd": 100.0},  # kept (other vendor)
    ])
    print(f"  4 candidates in → {len(kept)} out")


if __name__ == "__main__":
    main()
