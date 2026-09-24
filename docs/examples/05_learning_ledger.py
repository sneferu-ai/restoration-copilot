#!/usr/bin/env python3
"""The learning ledger (FR-066): confidence adjustment, vendor ranking, and
weighted-median cost estimation over recorded feedback signals.

The ledger is deterministic SQL + arithmetic over the shared
``restoration_feedback.db`` — not an ML model. Formulas:

  adjusted = base + K * (agreement_rate - 0.5), clamped [0, 1]
  agreement_rate = (matching + 0.5 * partial) / total   (recency-weighted)
  vendor score = Σ 0.95^months_old (+0.1 if selected in the last 30 days)
  cost estimate = weighted median of ≥3 purchase outcomes, else KB midpoint

    python3 docs/examples/05_learning_ledger.py
"""

import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from orchestrator.core.restoration_models import FeedbackSignal  # noqa: E402
from orchestrator.core.restoration_pipeline import RestorationPipeline  # noqa: E402


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        pipeline = RestorationPipeline(runs_root=Path(tmp) / "runs")

        # Below the 5-sample minimum: no adjustment, no biasing context.
        adjusted, ctx = pipeline.confidence_adjustment(
            0.80, category="brake", make="Chevrolet", model="Camaro", year="1969")
        print(f"0 samples: adjusted={adjusted} (base unchanged), context={ctx}")

        # Record 6 corrections for brake parts on 1969 Camaros:
        # 4 'matching' (name unchanged → the system was right),
        # 1 partial (condition changed only → half credit),
        # 1 miss (name changed → the identification was wrong).
        corrections = [
            ("wheel cylinder", "wheel cylinder", "name"),
            ("wheel cylinder", "wheel cylinder", "name"),
            ("brake hose", "brake hose", "name"),
            ("master cylinder", "master cylinder", "name"),
            ("brake drum", "brake drum (worn)", "condition"),  # condition-only change → half credit
            ("brake caliper", "brake caliper bracket", "name"),  # a miss
        ]
        for old, new, field in corrections:
            pipeline.record_feedback(FeedbackSignal(
                project_id="demo",
                signal_type="identification_correction",
                category="brake",
                vehicle_make="Chevrolet", vehicle_model="Camaro", vehicle_year="1969",
                field_name=field, old_value=old, new_value=new,
            ))

        adjusted, ctx = pipeline.confidence_adjustment(
            0.80, category="brake", make="Chevrolet", model="Camaro", year="1969")
        print(f"6 samples: adjusted={adjusted:.4f} (base 0.80)")
        print(f"           biasing_context={ctx}")
        # agreement = (4 matching + 0.5 partial) / 6 = 0.75
        # adjusted  = 0.80 + 0.2 * (0.75 - 0.5) = 0.85

        # Vendor ranking: selections decay at 0.95^months_old.
        for vendor in ("Classic Industries", "Classic Industries", "RockAuto"):
            pipeline.record_feedback(FeedbackSignal(
                project_id="demo", signal_type="sourcing_selection", vendor=vendor))
        print(f"\nvendor_rank('Classic Industries') = "
              f"{pipeline.vendor_rank_score('Classic Industries')}  (2 fresh selections + 0.1 recency bonus)")
        print(f"vendor_rank('RockAuto')           = {pipeline.vendor_rank_score('RockAuto')}")
        print(f"vendor_rank('Never Used')         = {pipeline.vendor_rank_score('Never Used')}")

        # Cost estimation: ≥3 purchase outcomes → weighted median; else KB mid.
        for price in (210.0, 225.0, 240.0):
            pipeline.record_feedback(FeedbackSignal(
                project_id="demo", signal_type="purchase_outcome",
                part_id="part-brake-cal", vehicle_make="Chevrolet",
                vehicle_model="Camaro", vehicle_year="1969", final_price_usd=price))
        est, n = pipeline.weighted_median_estimate("part-brake-cal", "Chevrolet", "Camaro", "1969")
        print(f"\nweighted median of [210, 225, 240] = {est} (n={n})")
        est, n = pipeline.weighted_median_estimate(
            "part-unknown", "Chevrolet", "Camaro", "1969", kb_mid=185.0)
        print(f"unknown part falls back to KB midpoint = {est} (n={n})")


if __name__ == "__main__":
    main()
