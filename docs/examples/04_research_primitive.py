#!/usr/bin/env python3
"""04 — The FR-012 sourcing primitive, offline, with a fake bridge dispatcher.

No server, no network. Shows the pinned contract from docs/API.md:
  * tier order (registry first, LLM fallback only when <3 registry candidates)
  * search_template interpolation (RFC 3986, null-OEM token removal)
  * dedup (part_id + vendor + oem_number + price ±5%)
  * over-budget -> unsourceable(exceeds_budget); nothing found -> no_vendor_response
  * output schema validation

    python3 docs/examples/04_research_primitive.py
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from orchestrator.core.research_primitives import (  # noqa: E402
    deduplicate,
    interpolate_template,
    research_part_sourcing,
    validate_result,
)
from orchestrator.core.restoration_models import (  # noqa: E402
    PartSourcingQuery,
    SourceRegistryEntry,
)

QUERY = PartSourcingQuery(
    part_id="part-demo",
    part_name="Brake booster",
    oem_number=None,  # exercises the null-OEM token removal
    vehicle_make="Chevrolet",
    vehicle_model="Camaro",
    vehicle_year="1969",
    per_part_budget_ceiling_usd=200.0,
)

REGISTRY = [
    SourceRegistryEntry(
        source_id="hemmings",
        vendor_name="Hemmings",
        url="https://hemmings.com/search",
        search_template="https://hemmings.com/search?q={part_name}+{vehicle_make}+{vehicle_year}&oem={oem_number}",
        rate_limit_seconds=0,
    ),
    SourceRegistryEntry(
        source_id="joes_rebuilder",
        vendor_name="Joe's Brake Rebuilding",
        url="tel:555-123-4567",
        search_template=None,  # trade partner: skipped by the primitive
        is_trade_partner=True,
        contact_info="Joe, 555-123-4567",
    ),
]


def main() -> int:
    # 1. Template interpolation — placeholder VALUES are RFC 3986 percent-encoded
    #    (the literal '+' separators in the template stay literal), and a null
    #    oem_number drops the sole-value &oem={oem_number} parameter entirely.
    url = interpolate_template(REGISTRY[0].search_template, QUERY)
    expected = "https://hemmings.com/search?q=Brake%20booster+Chevrolet+1969"
    assert url == expected, url
    print(f"1. interpolation OK: {url}")
    print("   (null oem_number -> &oem={oem_number} parameter dropped entirely)")

    # 2. Tier order + dedup. The fake dispatcher returns two registry
    #    candidates (one a ±5% duplicate) and one LLM candidate.
    calls = []

    def fake_dispatcher(kind, payload, timeout_s):
        calls.append(kind)
        if kind == "registry_query":
            return [
                {"vendor": "Hemmings", "price_usd": 150.0, "condition": "rebuilt",
                 "availability": "in_stock", "url_or_contact": payload["url"]},
                {"vendor": "hemmings", "price_usd": 152.0, "condition": "rebuilt",
                 "availability": "in_stock"},  # dupe: same vendor/part, price within 5%
            ]
        if kind == "llm_search":
            return [{"vendor": "ForumSeller99", "price_usd": 120.0, "condition": "used",
                     "availability": "backorder", "region": "US-West"}]
        raise AssertionError(kind)

    result = research_part_sourcing(QUERY, REGISTRY, fake_dispatcher)
    assert calls == ["registry_query", "llm_search"], calls  # <3 registry -> fallback fired
    vendors = [c["vendor"] for c in result["candidates"]]
    assert vendors == ["Hemmings", "ForumSeller99"], vendors  # dupe collapsed
    assert result["unsourceable"] is None
    assert validate_result(result) == [], validate_result(result)
    print(f"2. tiers OK ({calls}); dedup kept {vendors}")
    provs = {c["vendor"]: c["provenance"] for c in result["candidates"]}
    print(f"   provenance: {provs} (trade partner skipped, never queried)")

    # 3. Budget gate — only over-budget options -> exceeds_budget with the cheapest named.
    def pricey_dispatcher(kind, payload, timeout_s):
        return [{"vendor": "GoldPlateParts", "price_usd": 999.0, "condition": "nos",
                 "availability": "special_order"}]

    over = research_part_sourcing(QUERY, REGISTRY, pricey_dispatcher)
    assert over["candidates"] == []
    assert over["unsourceable"]["reason_code"] == "exceeds_budget", over
    print(f"3. budget gate OK: {over['unsourceable']['reason_code']} — "
          f"{over['unsourceable']['alternative_suggestion'][:70]}…")

    # 4. Nothing found anywhere -> no_vendor_response with an alternative suggestion.
    def silent_dispatcher(kind, payload, timeout_s):
        return []

    none = research_part_sourcing(QUERY, REGISTRY, silent_dispatcher)
    assert none["unsourceable"]["reason_code"] == "no_vendor_response"
    print(f"4. empty result OK: {none['unsourceable']['reason_code']}")

    # 5. Schema guard — manual_entry is rejected from the primitive (OBL-22).
    bad = {"part_id": "p", "candidates": [
        {"part_id": "p", "candidate_id": "c1", "vendor": "HandEntry", "price_usd": 10.0,
         "condition": "used", "availability": "in_stock", "provenance": "manual_entry",
         "fetched_at": "2026-08-04T00:00:00Z"}],
        "unsourceable": None, "errors": []}
    violations = validate_result(bad)
    assert any("manual_entry" in v for v in violations), violations
    print(f"5. schema guard OK: {violations[0]}")

    print("\nPRIMITIVE PASS — the FR-012 contract behaves as documented.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
