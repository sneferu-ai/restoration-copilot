"""Research primitive — ``research_part_sourcing`` (spec B13 §5, FR-012).

[unverified — A-010] for the live bridge-backed search legs. This module pins
the INTERFACE and every deterministic, mechanically testable rule:

  * search_template interpolation with RFC 3986 percent-encoding (FR-012)
  * null ``oem_number`` behavior (token removed; sole-value param dropped;
    compound value collapsed) — FR-012 / OBL-24
  * registry entries without a ``search_template`` are skipped (trade-partner
    manual-contact sources) — FR-012 / OBL-49
  * tier order: source registry first, LLM-mediated search fallback for parts
    with <3 registry candidates, ``unstructured_lead`` for parse failures
  * deduplication key: ``part_id + vendor + oem_number + price ±5%``
  * per-query timeout 30 s; 3 retries with 2/4/8 s exponential backoff;
    retries exhausted → unsourced with reason ``no_vendor_response``
  * per-source rate limit (``rate_limit_seconds`` sleep between queries)
  * output validated against the §5 JSON schema

The bridge dispatch is INJECTED (``bridge_dispatcher`` callable), so the whole
contract is hermetically testable with mocks (AC-008, AC-046).
"""

from __future__ import annotations

import json
import logging
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from .restoration_models import (
    Availability,
    CandidateCondition,
    PartSourcingQuery,
    Provenance,
    SourceRegistryEntry,
    UnsourceableReason,
)

log = logging.getLogger("restoration.research")

#: Error taxonomy (§5 research primitive interface).
class BridgeTimeoutError(Exception):
    """The bridge layer timed out; retryable."""


class BridgeUnavailableError(Exception):
    """The bridge layer is down; non-retryable, surfaces to U7."""


class ParseError(Exception):
    """Structured extraction failed; result flagged unstructured_lead."""


class RateLimitExceeded(Exception):
    """Per-source rate limit hit; wait and retry."""


PER_QUERY_TIMEOUT_S = 30
RETRY_BACKOFF_S = (2.0, 4.0, 8.0)
MIN_REGISTRY_CANDIDATES = 3
DEDUP_PRICE_TOLERANCE_PCT = 5.0

ALLOWED_PROVENANCES = {
    Provenance.SOURCE_REGISTRY.value,
    Provenance.RESEARCH_PRIMITIVE.value,
    Provenance.UNSTRUCTURED_LEAD.value,
    Provenance.UNVERIFIED_URL.value,
    # NOTE: "manual_entry" is deliberately ABSENT — manual entries arrive via
    # POST .../sourcing/manual, never through this primitive (OBL-22).
}

ALLOWED_REASON_CODES = {r.value for r in UnsourceableReason}
ALLOWED_CONDITIONS = {c.value for c in CandidateCondition}
ALLOWED_AVAILABILITY = {a.value for a in Availability}


# ---------------------------------------------------------------------------
# Template interpolation (FR-012)
# ---------------------------------------------------------------------------

_PLACEHOLDERS = ("part_name", "oem_number", "vehicle_make", "vehicle_model", "vehicle_year")


def _enc(value: Optional[str]) -> str:
    """RFC 3986 percent-encoding of a placeholder value."""
    return urllib.parse.quote(str(value), safe="")


def interpolate_template(template: str, query: PartSourcingQuery) -> str:
    """Substitute PartSourcingQuery fields into a search_template.

    Rules (FR-012, OBL-23/OBL-24):
      * every placeholder value is RFC 3986 percent-encoded before substitution
      * null oem_number → the ``{oem_number}`` token is removed entirely;
        if it was the sole value in a query parameter, the whole parameter is
        dropped; if part of a compound value, adjacent ``+`` separators are
        collapsed
    """
    values: Dict[str, Optional[str]] = {
        "part_name": query.part_name,
        "oem_number": query.oem_number,
        "vehicle_make": query.vehicle_make,
        "vehicle_model": query.vehicle_model,
        "vehicle_year": query.vehicle_year,
    }
    out = template
    if values["oem_number"] is None:
        out = _drop_null_oem(out)
    for key in _PLACEHOLDERS:
        token = "{" + key + "}"
        if key == "oem_number" and values[key] is None:
            continue  # already removed above
        value = values.get(key)
        out = out.replace(token, _enc(value) if value is not None else "")
    return out


def _drop_null_oem(template: str) -> str:
    token = "{oem_number}"
    if token not in template:
        return template
    if "?" not in template:
        return template.replace(token, "")
    base, _, query = template.partition("?")
    params = query.split("&")
    kept: List[str] = []
    for param in params:
        if token not in param:
            kept.append(param)
            continue
        name, eq, value = param.partition("=")
        if value == token:
            continue  # sole value in this parameter → drop the whole parameter
        # compound value: remove token and collapse adjacent '+' separators
        new_value = value.replace(token, "")
        while "++" in new_value:
            new_value = new_value.replace("++", "+")
        new_value = new_value.strip("+")
        if new_value:
            kept.append(f"{name}{eq}{new_value}")
        # if the compound value became empty, drop the parameter entirely
    return base + ("?" + "&".join(kept) if kept else "")


# ---------------------------------------------------------------------------
# Deduplication (FR-012): part_id + vendor + oem_number + price ±5%
# ---------------------------------------------------------------------------


def _same_identity(a: Dict[str, Any], b: Dict[str, Any]) -> bool:
    return (
        a.get("part_id") == b.get("part_id")
        and (a.get("vendor") or "").strip().lower() == (b.get("vendor") or "").strip().lower()
        and a.get("oem_number") == b.get("oem_number")
    )


def _price_similar(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if not (isinstance(a, (int, float)) and isinstance(b, (int, float))):
        return False
    if a <= 0 or b <= 0:
        return False
    return abs(a - b) / max(a, b) * 100.0 <= DEDUP_PRICE_TOLERANCE_PCT


def dedup_key(candidate: Dict[str, Any]) -> tuple:
    """Identity portion of the dedup key (price is compared pairwise ±5%)."""
    return (
        candidate.get("part_id"),
        (candidate.get("vendor") or "").strip().lower(),
        candidate.get("oem_number"),
    )


def deduplicate(candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """part_id + vendor + oem_number + similar price (±5%), pairwise — a
    bucketed hash would split neighbors across bucket boundaries."""
    kept: List[Dict[str, Any]] = []
    for cand in candidates:
        dupe = any(
            _same_identity(existing, cand)
            and _price_similar(existing.get("price_usd"), cand.get("price_usd"))
            for existing in kept
        )
        if not dupe:
            kept.append(cand)
    return kept


# ---------------------------------------------------------------------------
# Output schema validation (§5 JSON schema)
# ---------------------------------------------------------------------------

_CANDIDATE_REQUIRED = (
    "part_id",
    "candidate_id",
    "vendor",
    "price_usd",
    "condition",
    "availability",
    "provenance",
    "fetched_at",
)


def validate_result(result: Dict[str, Any]) -> List[str]:
    """Validate a primitive result dict against the §5 schema. Returns a list
    of violations (empty = valid)."""
    violations: List[str] = []
    if not isinstance(result, dict):
        return ["result is not an object"]
    if "part_id" not in result:
        violations.append("missing part_id")
    candidates = result.get("candidates")
    if not isinstance(candidates, list):
        violations.append("candidates must be an array")
        candidates = []
    for i, cand in enumerate(candidates):
        if not isinstance(cand, dict):
            violations.append(f"candidates[{i}] is not an object")
            continue
        for field in _CANDIDATE_REQUIRED:
            if field not in cand:
                violations.append(f"candidates[{i}] missing {field}")
        prov = cand.get("provenance")
        if prov is not None and prov not in ALLOWED_PROVENANCES:
            violations.append(f"candidates[{i}] invalid provenance {prov!r}")
        if prov == "manual_entry":
            violations.append(f"candidates[{i}] manual_entry must not come from the primitive")
        cond = cand.get("condition")
        if cond is not None and cond not in ALLOWED_CONDITIONS:
            violations.append(f"candidates[{i}] invalid condition {cond!r}")
        avail = cand.get("availability")
        if avail is not None and avail not in ALLOWED_AVAILABILITY:
            violations.append(f"candidates[{i}] invalid availability {avail!r}")
        price = cand.get("price_usd")
        if price is not None and (not isinstance(price, (int, float)) or price <= 0):
            violations.append(f"candidates[{i}] price_usd must be a positive number")
    uns = result.get("unsourceable")
    if uns is not None:
        if not isinstance(uns, dict):
            violations.append("unsourceable must be an object or null")
        else:
            if uns.get("reason_code") not in ALLOWED_REASON_CODES:
                violations.append(f"unsourceable invalid reason_code {uns.get('reason_code')!r}")
    errors = result.get("errors")
    if not isinstance(errors, list):
        violations.append("errors must be an array")
    else:
        for i, err in enumerate(errors):
            if not isinstance(err, dict) or "error" not in err or "retryable" not in err:
                violations.append(f"errors[{i}] must carry error and retryable")
    return violations


# ---------------------------------------------------------------------------
# Clock / sleeper injection for deterministic tests
# ---------------------------------------------------------------------------


class _Clock:
    def monotonic(self) -> float:
        return time.monotonic()

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)

    def now_iso(self) -> str:
        return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# The primitive
# ---------------------------------------------------------------------------


def _normalize_candidate(raw: Dict[str, Any], query: PartSourcingQuery, provenance: str, clock: _Clock) -> Dict[str, Any]:
    price = raw.get("price_usd")
    if not isinstance(price, (int, float)) or price <= 0:
        price = None  # FR-012 hallucination defense: invalid prices become null
    return {
        "part_id": query.part_id,
        "candidate_id": raw.get("candidate_id") or f"cand-{clock.monotonic():.6f}-{abs(hash(json.dumps(raw, sort_keys=True, default=str))) % 10**8}",
        "vendor": str(raw.get("vendor") or "unknown"),
        "oem_number": raw.get("oem_number"),
        "price_usd": price,
        "condition": raw.get("condition") if raw.get("condition") in ALLOWED_CONDITIONS else "used",
        "availability": raw.get("availability") if raw.get("availability") in ALLOWED_AVAILABILITY else "in_stock",
        "region": str(raw.get("region") or ""),
        "url_or_contact": str(raw.get("url_or_contact") or ""),
        "tradeable": bool(raw.get("tradeable", False)),
        "provenance": provenance,
        "fetched_at": raw.get("fetched_at") or clock.now_iso(),
        "trade_partner_id": raw.get("trade_partner_id"),
    }


def research_part_sourcing(
    query: PartSourcingQuery,
    source_registry: List[SourceRegistryEntry],
    bridge_dispatcher: Callable[..., Any],
    clock: Optional[_Clock] = None,
    per_query_timeout_s: float = PER_QUERY_TIMEOUT_S,
    min_registry_candidates: int = MIN_REGISTRY_CANDIDATES,
) -> Dict[str, Any]:
    """Tiered sourcing (pinned order — serial, not parallel). See FR-012.

    ``bridge_dispatcher`` is a callable with signature::

        bridge_dispatcher(kind, payload, timeout_s) -> dict | list

    where ``kind`` is ``"registry_query"`` (payload carries the interpolated
    ``url`` and the ``source_id``) or ``"llm_search"`` (payload carries the
    structured query). It must return either a list of raw candidate dicts or
    a dict with a ``candidates`` list; anything else raises ParseError so the
    part is flagged ``unstructured_lead``.
    """
    clock = clock or _Clock()
    result: Dict[str, Any] = {
        "part_id": query.part_id,
        "candidates": [],
        "unsourceable": None,
        "errors": [],
    }

    # --- Tier 1: source registry (skip entries without search_template) -----
    for entry in source_registry:
        if not entry.search_template:
            continue  # trade-partner manual-contact source (OBL-49)
        url = interpolate_template(entry.search_template, query)
        raw = _with_retries(
            clock,
            lambda: bridge_dispatcher(
                "registry_query",
                {"url": url, "source_id": entry.source_id, "query": query.model_dump(mode="json")},
                per_query_timeout_s,
            ),
            result,
            part_id=query.part_id,
        )
        clock.sleep(max(0, entry.rate_limit_seconds))  # per-source rate limit
        if raw is None:
            continue
        for cand in _extract_candidates(raw, query, Provenance.SOURCE_REGISTRY.value, clock, result):
            result["candidates"].append(cand)

    # --- Tier 2: LLM-mediated web search fallback (<3 registry candidates) --
    registry_count = len(result["candidates"])
    if registry_count < min_registry_candidates:
        raw = _with_retries(
            clock,
            lambda: bridge_dispatcher(
                "llm_search",
                {
                    "part_name": query.part_name,
                    "oem_number": query.oem_number,
                    "vehicle_make": query.vehicle_make,
                    "vehicle_model": query.vehicle_model,
                    "vehicle_year": query.vehicle_year,
                    "budget_ceiling_usd": query.per_part_budget_ceiling_usd,
                },
                per_query_timeout_s,
            ),
            result,
            part_id=query.part_id,
        )
        if raw is not None:
            for cand in _extract_candidates(raw, query, Provenance.RESEARCH_PRIMITIVE.value, clock, result):
                result["candidates"].append(cand)

    # --- Dedup + unsourced determination ------------------------------------
    # FR-012 scope is candidates *inside budget*: over-budget candidates are
    # dropped from the candidate list, and when they were the ONLY options the
    # part is unsourceable with reason ``exceeds_budget`` (AC-009). An explicit
    # dispatcher-provided unsourceable dict (e.g. ``discontinued``) is adopted
    # verbatim after validation.
    result["candidates"] = deduplicate(result["candidates"])
    ceiling = query.per_part_budget_ceiling_usd
    viable: List[Dict[str, Any]] = []
    over_budget: List[Dict[str, Any]] = []
    for cand in result["candidates"]:
        price = cand.get("price_usd")
        is_lead = cand.get("provenance") in (
            Provenance.UNSTRUCTURED_LEAD.value,
        )
        if is_lead:
            viable.append(cand)  # leads are surfaced, never priced
        elif isinstance(price, (int, float)) and price > ceiling:
            over_budget.append(cand)
        else:
            viable.append(cand)
    if result["unsourceable"] is None:
        if viable:
            result["candidates"] = viable
        elif over_budget:
            cheapest = min(over_budget, key=lambda c: c.get("price_usd") or float("inf"))
            result["candidates"] = []
            result["unsourceable"] = {
                "part_id": query.part_id,
                "reason_code": UnsourceableReason.EXCEEDS_BUDGET.value,
                "alternative_suggestion": (
                    f"Cheapest found: {cheapest.get('vendor')} at "
                    f"${cheapest.get('price_usd'):.2f} (ceiling ${ceiling:.2f}). "
                    "Consider raising the budget or contacting a rebuilder."
                ),
                "fabrication_reference_glb": None,
            }
        else:
            result["candidates"] = []
            result["unsourceable"] = {
                "part_id": query.part_id,
                "reason_code": UnsourceableReason.NO_VENDOR_RESPONSE.value,
                "alternative_suggestion": "Try a specialty rebuilder or custom fabricator for this part.",
                "fabrication_reference_glb": None,
            }
    else:
        result["candidates"] = viable
    violations = validate_result(result)
    if violations:
        raise ValueError(f"primitive produced invalid result: {violations}")
    return result


def _extract_candidates(
    raw: Any,
    query: PartSourcingQuery,
    provenance: str,
    clock: _Clock,
    result: Dict[str, Any],
) -> List[Dict[str, Any]]:
    if isinstance(raw, dict) and raw.get("unsourceable"):
        uns = raw["unsourceable"]
        if isinstance(uns, dict) and uns.get("reason_code") in ALLOWED_REASON_CODES:
            result["unsourceable"] = {
                "part_id": query.part_id,
                "reason_code": uns["reason_code"],
                "alternative_suggestion": uns.get("alternative_suggestion"),
                "fabrication_reference_glb": uns.get("fabrication_reference_glb"),
            }
    if isinstance(raw, dict) and isinstance(raw.get("candidates"), list):
        items = raw["candidates"]
    elif isinstance(raw, list):
        items = raw
    else:
        # Tier 3: unparseable structured extraction → unstructured_lead
        result["candidates"].append(
            _normalize_candidate(
                {
                    "vendor": "unstructured lead",
                    "url_or_contact": json.dumps(raw, default=str)[:500],
                },
                query,
                Provenance.UNSTRUCTURED_LEAD.value,
                clock,
            )
        )
        return []
    out: List[Dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        out.append(_normalize_candidate(item, query, provenance, clock))
    return out


def _with_retries(
    clock: _Clock,
    fn: Callable[[], Any],
    result: Dict[str, Any],
    part_id: str,
) -> Optional[Any]:
    """3 retries with exponential backoff (2s, 4s, 8s); retries exhausted →
    error recorded (retryable) and None returned (part ends unsourced with
    ``no_vendor_response`` unless another tier covers it)."""
    attempts = 1 + len(RETRY_BACKOFF_S)
    last_exc: Optional[Exception] = None
    for attempt in range(attempts):
        try:
            return fn()
        except RateLimitExceeded as exc:
            last_exc = exc
            if attempt < attempts - 1:
                clock.sleep(RETRY_BACKOFF_S[attempt])
        except BridgeTimeoutError as exc:
            last_exc = exc
            if attempt < attempts - 1:
                clock.sleep(RETRY_BACKOFF_S[attempt])
        except BridgeUnavailableError as exc:
            result["errors"].append({"part_id": part_id, "error": str(exc), "retryable": False})
            return None
        except ParseError as exc:
            result["errors"].append({"part_id": part_id, "error": str(exc), "retryable": False})
            return {"unstructured": str(exc)}
    result["errors"].append(
        {
            "part_id": part_id,
            "error": f"no_vendor_response after {attempts} attempts: {last_exc}",
            "retryable": True,
        }
    )
    return None
