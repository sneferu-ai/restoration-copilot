"""AC-044 (FR-066 biasing formula with zero-sample guard), vendor ranking,
weighted-median cost estimation, AC-029 (signal write paths)."""

from datetime import datetime, timedelta, timezone

import pytest

from orchestrator.core.restoration_models import FeedbackSignal


def _correction(pipeline, category="brake", make="Chevrolet", model="Camaro", year="1969",
                field="name", old="x", new="x", days_old=0):
    signal = FeedbackSignal(
        project_id="proj-test",
        signal_type="identification_correction",
        part_id="p",
        category=category,
        vehicle_make=make,
        vehicle_model=model,
        vehicle_year=year,
        field_name=field,
        old_value=old,
        new_value=new,
        created_at=datetime.now(timezone.utc) - timedelta(days=days_old),
    )
    pipeline.record_feedback(signal)


class TestConfidenceAdjustment:
    def test_worked_example_ac044(self, pipeline):
        """AC-044: 7 matching + 2 partial + 1 miss → agreement 0.8 →
        adjusted = base + 0.2×(0.8−0.5) = base + 0.06."""
        for _ in range(7):
            _correction(pipeline, field="name", old="caliper", new="caliper")
        for _ in range(2):
            _correction(pipeline, field="condition", old="present", new="deteriorated")
        _correction(pipeline, field="name", old="caliper", new="wheel cylinder")
        adjusted, ctx = pipeline.confidence_adjustment(0.60, "brake", "Chevrolet", "Camaro", "1969")
        assert abs(ctx["agreement_rate"] - 0.8) < 1e-6
        assert ctx["K"] == 0.2
        assert ctx["sample_count"] == 10
        assert abs(adjusted - 0.66) < 1e-6
        assert ctx["adjusted_value"] == round(adjusted, 4)

    def test_zero_sample_guard_no_context(self, pipeline):
        """AC-044/OBL-50: 0 corrections → adjusted == base, no biasing_context,
        no division by zero."""
        adjusted, ctx = pipeline.confidence_adjustment(0.60, "brake", "Chevrolet", "Camaro", "1969")
        assert adjusted == 0.60
        assert ctx is None

    def test_below_minimum_samples_no_adjustment(self, pipeline):
        for _ in range(4):  # minimum is 5
            _correction(pipeline, field="name", old="c", new="c")
        adjusted, ctx = pipeline.confidence_adjustment(0.60, "brake", "Chevrolet", "Camaro", "1969")
        assert adjusted == 0.60
        assert ctx is None

    def test_old_corrections_excluded(self, pipeline):
        for _ in range(9):
            _correction(pipeline, field="name", old="c", new="c", days_old=400)  # >12 months
        adjusted, ctx = pipeline.confidence_adjustment(0.60, "brake", "Chevrolet", "Camaro", "1969")
        assert adjusted == 0.60  # all excluded → guard fires
        assert ctx is None

    def test_low_agreement_lowers_confidence(self, pipeline):
        for _ in range(5):
            _correction(pipeline, field="name", old="a", new="b")  # all misses
        adjusted, ctx = pipeline.confidence_adjustment(0.60, "brake", "Chevrolet", "Camaro", "1969")
        assert adjusted == pytest.approx(0.60 + 0.2 * (0.0 - 0.5))
        assert adjusted == 0.5

    def test_clamped_to_unit_interval(self, pipeline):
        for _ in range(6):
            _correction(pipeline, field="name", old="c", new="c")
        adjusted, _ = pipeline.confidence_adjustment(0.97, "brake", "Chevrolet", "Camaro", "1969")
        assert adjusted <= 1.0

    def test_category_isolation(self, pipeline):
        for _ in range(6):
            _correction(pipeline, category="engine", field="name", old="c", new="c")
        # brake sample is empty → guard
        adjusted, ctx = pipeline.confidence_adjustment(0.60, "brake", "Chevrolet", "Camaro", "1969")
        assert ctx is None


class TestVendorRanking:
    def test_recency_weighted_plus_recent_bonus(self, pipeline):
        for days in (0, 10):
            signal = FeedbackSignal(
                project_id="p",
                signal_type="sourcing_selection",
                vendor="NAPA",
                created_at=datetime.now(timezone.utc) - timedelta(days=days),
            )
            pipeline.record_feedback(signal)
        score = pipeline.vendor_rank_score("NAPA")
        expected = 1.0 + 0.95 ** (10 / 30.4375) + 0.1  # recent bonus applies
        assert score == pytest.approx(expected, abs=0.01)

    def test_no_selections_zero(self, pipeline):
        assert pipeline.vendor_rank_score("Nobody") == 0.0


class TestWeightedMedian:
    def test_median_of_purchases(self, pipeline):
        for price in (80.0, 100.0, 120.0):
            signal = FeedbackSignal(
                project_id="p",
                signal_type="purchase_outcome",
                part_id="part-1",
                vehicle_make="Chevrolet",
                vehicle_model="Camaro",
                vehicle_year="1969",
                final_price_usd=price,
                created_at=datetime.now(timezone.utc),
            )
            pipeline.record_feedback(signal)
        estimate, n = pipeline.weighted_median_estimate("part-1", "Chevrolet", "Camaro", "1969")
        assert n == 3
        assert estimate == pytest.approx(100.0, abs=1.0)

    def test_fewer_than_three_uses_kb_mid(self, pipeline):
        signal = FeedbackSignal(
            project_id="p",
            signal_type="purchase_outcome",
            part_id="part-1",
            vehicle_make="Chevrolet",
            vehicle_model="Camaro",
            vehicle_year="1969",
            final_price_usd=80.0,
            created_at=datetime.now(timezone.utc),
        )
        pipeline.record_feedback(signal)
        estimate, n = pipeline.weighted_median_estimate("part-1", "Chevrolet", "Camaro", "1969", kb_mid=55.0)
        assert estimate == 55.0
        assert n == 1
