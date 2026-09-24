"""AC-046 (research primitive interface contract), AC-009 (reason codes),
AC-008 (tier order + dedup + coverage provenance rules)."""

import pytest

from orchestrator.core.research_primitives import (
    BridgeTimeoutError,
    BridgeUnavailableError,
    ParseError,
    deduplicate,
    interpolate_template,
    research_part_sourcing,
    validate_result,
)
from orchestrator.core.restoration_models import PartSourcingQuery, SourceRegistryEntry


def make_query(**over):
    base = dict(
        part_id="part-1",
        part_name="Front Brake Caliper",
        oem_number="5463628",
        vehicle_make="Chevrolet",
        vehicle_model="Camaro",
        vehicle_year="1969",
        per_part_budget_ceiling_usd=300.0,
        criticality="critical",
    )
    base.update(over)
    return PartSourcingQuery(**base)


class FakeClock:
    def __init__(self):
        self.sleeps = []
        self.t = 0.0

    def monotonic(self):
        self.t += 0.001
        return self.t

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.t += seconds

    def now_iso(self):
        return "2026-08-01T00:00:00+00:00"


class TestInterpolation:
    def test_rfc3986_encoding(self):
        q = make_query(part_name="Brake Caliper & Pads (front)")
        url = interpolate_template("https://x.com/s?q={part_name}&m={vehicle_make}", q)
        assert url == "https://x.com/s?q=Brake%20Caliper%20%26%20Pads%20%28front%29&m=Chevrolet"

    def test_all_placeholders(self):
        q = make_query()
        url = interpolate_template(
            "https://x.com/{vehicle_year}/{vehicle_make}/{vehicle_model}?p={part_name}&o={oem_number}",
            q,
        )
        assert url == "https://x.com/1969/Chevrolet/Camaro?p=Front%20Brake%20Caliper&o=5463628"

    def test_null_oem_sole_param_dropped(self):
        q = make_query(oem_number=None)
        url = interpolate_template("https://x.com/s?q={part_name}&oem={oem_number}&src=a", q)
        assert url == "https://x.com/s?q=Front%20Brake%20Caliper&src=a"

    def test_null_oem_compound_value_collapsed(self):
        q = make_query(oem_number=None)
        url = interpolate_template("https://x.com/s?q={part_name}+{oem_number}", q)
        assert url == "https://x.com/s?q=Front%20Brake%20Caliper"

    def test_null_oem_no_query_string(self):
        q = make_query(oem_number=None)
        url = interpolate_template("https://x.com/parts/{oem_number}/info", q)
        assert url == "https://x.com/parts//info"

    def test_null_oem_middle_of_compound(self):
        q = make_query(oem_number=None)
        url = interpolate_template("https://x.com/s?q={vehicle_make}+{oem_number}+{vehicle_year}", q)
        assert url == "https://x.com/s?q=Chevrolet+1969"


class TestTierOrderAndSkip:
    def test_registry_first_then_llm_and_null_template_skipped(self):
        """AC-008 tier order: registry candidates appear before LLM-search
        candidates; entries without search_template are skipped (OBL-49)."""
        calls = []

        def dispatcher(kind, payload, timeout):
            calls.append(kind)
            if kind == "registry_query":
                return [{"vendor": "RegistryVendor", "price_usd": 100.0}]
            return [{"vendor": "LLMVendor", "price_usd": 120.0}]

        registry = [
            SourceRegistryEntry(
                source_id="trade_joe",
                vendor_name="Joe's Rebuilding",
                url="tel:555",
                search_template=None,
                is_trade_partner=True,
                contact_info="Joe",
            ),
            SourceRegistryEntry(
                source_id="hemmings",
                vendor_name="Hemmings",
                url="https://h",
                search_template="https://h/s?q={part_name}",
            ),
        ]
        clock = FakeClock()
        result = research_part_sourcing(make_query(), registry, dispatcher, clock=clock)
        # null-template entry skipped: only one registry_query call, then llm
        assert calls == ["registry_query", "llm_search"]
        vendors = [c["vendor"] for c in result["candidates"]]
        assert vendors == ["RegistryVendor", "LLMVendor"]  # registry first
        provs = [c["provenance"] for c in result["candidates"]]
        assert provs == ["source_registry", "research_primitive"]
        # rate-limit sleep observed for the registry source
        assert 2 in clock.sleeps or any(s >= 2 for s in clock.sleeps)

    def test_no_llm_when_three_registry_candidates(self):
        def dispatcher(kind, payload, timeout):
            assert kind == "registry_query"
            return [{"vendor": "V", "price_usd": 50.0 + i, "oem_number": f"o{i}"} for i in range(3)]

        registry = [
            SourceRegistryEntry(source_id="a", vendor_name="A", url="https://a",
                                search_template="https://a/{part_name}")
        ]
        result = research_part_sourcing(make_query(), registry, dispatcher, clock=FakeClock())
        assert len(result["candidates"]) == 3
        assert all(c["provenance"] == "source_registry" for c in result["candidates"])


class TestRetriesAndTimeout:
    def test_three_retries_248_backoff_then_no_vendor_response(self):
        calls = []

        def dispatcher(kind, payload, timeout):
            calls.append(kind)
            raise BridgeTimeoutError("timed out")

        registry = [
            SourceRegistryEntry(source_id="a", vendor_name="A", url="https://a",
                                search_template="https://a/{part_name}", rate_limit_seconds=0)
        ]
        clock = FakeClock()
        result = research_part_sourcing(make_query(), registry, dispatcher, clock=clock)
        # registry: 1 + 3 retries = 4 calls; llm: another 4
        assert calls == ["registry_query"] * 4 + ["llm_search"] * 4
        backoffs = [s for s in clock.sleeps if s in (2.0, 4.0, 8.0)]
        assert backoffs[:3] == [2.0, 4.0, 8.0]
        assert result["unsourceable"]["reason_code"] == "no_vendor_response"
        assert any(e["retryable"] for e in result["errors"])

    def test_bridge_unavailable_non_retryable(self):
        def dispatcher(kind, payload, timeout):
            raise BridgeUnavailableError("down")

        registry = [
            SourceRegistryEntry(source_id="a", vendor_name="A", url="https://a",
                                search_template="https://a/{part_name}", rate_limit_seconds=0)
        ]
        result = research_part_sourcing(make_query(), registry, dispatcher, clock=FakeClock())
        assert any(not e["retryable"] for e in result["errors"])

    def test_parse_failure_flagged_unstructured_lead(self):
        def dispatcher(kind, payload, timeout):
            return {"unexpected": "shape"}

        result = research_part_sourcing(make_query(), [], dispatcher, clock=FakeClock())
        assert result["candidates"]
        assert result["candidates"][0]["provenance"] == "unstructured_lead"


class TestReasonCodes:
    def test_exceeds_budget(self):
        """AC-009 part B: only over-budget options → exceeds_budget."""

        def dispatcher(kind, payload, timeout):
            return [{"vendor": "Pricey", "price_usd": 900.0}]

        result = research_part_sourcing(
            make_query(per_part_budget_ceiling_usd=300.0), [], dispatcher, clock=FakeClock()
        )
        assert result["candidates"] == []
        assert result["unsourceable"]["reason_code"] == "exceeds_budget"
        assert "Pricey" in result["unsourceable"]["alternative_suggestion"]

    def test_discontinued_from_dispatcher(self):
        """AC-009 part C: dispatcher-reported outcome, not part-name lookup."""

        def dispatcher(kind, payload, timeout):
            return {
                "candidates": [],
                "unsourceable": {
                    "reason_code": "discontinued",
                    "alternative_suggestion": "NOS marketplace or rebuilder",
                },
            }

        result = research_part_sourcing(make_query(), [], dispatcher, clock=FakeClock())
        assert result["unsourceable"]["reason_code"] == "discontinued"
        assert result["unsourceable"]["alternative_suggestion"]

    def test_no_results_no_vendor_response(self):
        """AC-009 part A."""

        def dispatcher(kind, payload, timeout):
            return []

        result = research_part_sourcing(make_query(), [], dispatcher, clock=FakeClock())
        assert result["unsourceable"]["reason_code"] == "no_vendor_response"


class TestDedupAndSchema:
    def test_dedup_key_includes_oem_and_price_band(self):
        cands = [
            {"part_id": "p", "vendor": "V", "oem_number": "o1", "price_usd": 100.0},
            {"part_id": "p", "vendor": "V", "oem_number": "o1", "price_usd": 103.0},  # ±5% dupe
            {"part_id": "p", "vendor": "V", "oem_number": "o2", "price_usd": 100.0},  # different oem
            {"part_id": "p", "vendor": "V", "oem_number": "o1", "price_usd": 200.0},  # different price
        ]
        out = deduplicate(cands)
        assert len(out) == 3

    def test_schema_validation_accepts_valid(self):
        def dispatcher(kind, payload, timeout):
            return [{"vendor": "V", "price_usd": 10.0}]

        result = research_part_sourcing(make_query(), [], dispatcher, clock=FakeClock())
        assert validate_result(result) == []

    def test_schema_rejects_manual_entry_provenance(self):
        result = {
            "part_id": "p",
            "candidates": [
                {
                    "part_id": "p",
                    "candidate_id": "c",
                    "vendor": "V",
                    "price_usd": 10.0,
                    "condition": "used",
                    "availability": "in_stock",
                    "provenance": "manual_entry",
                    "fetched_at": "2026-01-01",
                }
            ],
            "unsourceable": None,
            "errors": [],
        }
        violations = validate_result(result)
        assert violations, "manual_entry must be rejected from primitive output"

    def test_schema_rejects_bad_reason_code(self):
        result = {
            "part_id": "p",
            "candidates": [],
            "unsourceable": {"part_id": "p", "reason_code": "made_up"},
            "errors": [],
        }
        assert validate_result(result)

    def test_invalid_price_becomes_null(self):
        def dispatcher(kind, payload, timeout):
            return [{"vendor": "V", "price_usd": -5}]

        result = research_part_sourcing(make_query(), [], dispatcher, clock=FakeClock())
        assert result["candidates"][0]["price_usd"] is None
