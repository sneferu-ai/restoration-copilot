"""Restoration Copilot — Pydantic data model (spec B13 §5).

Python 3.9 compatible (Optional/Union from typing, no ``X | None`` syntax).
The field set here is the implementation target of spec §5 "Data model".
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _uuid() -> str:
    return uuid.uuid4().hex


# ---------------------------------------------------------------------------
# Enums (§3 status enum, FR-005, FR-013, FR-014, FR-018, FR-042, FR-044,
# FR-054, FR-056, FR-066)
# ---------------------------------------------------------------------------


class ProjectStatus(str, enum.Enum):
    DRAFT = "draft"
    INTAKE_OPEN = "intake_open"
    INTAKE_SEALED = "intake_sealed"
    IDENTIFYING = "identifying"
    REVIEW_OPEN = "review_open"
    MANIFEST_LOCKED = "manifest_locked"
    BUDGET_RULED = "budget_ruled"
    HUNTING = "hunting"
    SOURCING_INSUFFICIENT = "sourcing_insufficient"
    HUNT_SEALED = "hunt_sealed"
    MESHING = "meshing"
    GRAPH_REVIEW = "graph_review"
    PUBLISHED = "published"
    IN_SERVICE = "in_service"
    CLOSED = "closed"
    ABANDONED = "abandoned"


class BudgetRuling(str, enum.Enum):
    AFFORDABLE = "AFFORDABLE"
    TIGHT = "TIGHT"
    SHORTFALL_CRITICAL = "SHORTFALL_CRITICAL"
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA"


class PartCondition(str, enum.Enum):
    PRESENT = "present"
    DETERIORATED = "deteriorated"
    MISSING = "missing"


class Criticality(str, enum.Enum):
    CRITICAL = "critical"
    STANDARD = "standard"
    OPTIONAL = "optional"


class SourcingStatus(str, enum.Enum):
    """FR-005: single enum field — no separate booleans."""

    PENDING = "pending"
    SOURCED = "sourced"
    UNSOURCEABLE = "unsourceable"
    FABRICATION_REF = "fabrication_ref"
    PREVIOUSLY_SOURCED = "previously_sourced"


class Provenance(str, enum.Enum):
    SOURCE_REGISTRY = "source_registry"
    RESEARCH_PRIMITIVE = "research_primitive"
    MANUAL_ENTRY = "manual_entry"
    UNSTRUCTURED_LEAD = "unstructured_lead"
    UNVERIFIED_URL = "unverified_url"


#: Provenances that count as system-discovered coverage (FR-013).
SYSTEM_DISCOVERED_PROVENANCES = frozenset(
    {Provenance.SOURCE_REGISTRY.value, Provenance.RESEARCH_PRIMITIVE.value}
)
#: Provenances that count toward total coverage (FR-013).
TOTAL_COVERAGE_PROVENANCES = frozenset(
    {
        Provenance.SOURCE_REGISTRY.value,
        Provenance.RESEARCH_PRIMITIVE.value,
        Provenance.MANUAL_ENTRY.value,
    }
)


class UnsourceableReason(str, enum.Enum):
    DISCONTINUED = "discontinued"
    NO_AFTERMARKET_REPRODUCTION = "no_aftermarket_reproduction"
    REGIONAL_UNAVAILABILITY = "regional_unavailability"
    EXCEEDS_BUDGET = "exceeds_budget"
    NO_VENDOR_RESPONSE = "no_vendor_response"


class CandidateCondition(str, enum.Enum):
    NEW = "new"
    USED = "used"
    REBUILT = "rebuilt"
    NOS = "nos"


class Availability(str, enum.Enum):
    IN_STOCK = "in_stock"
    BACKORDER = "backorder"
    SPECIAL_ORDER = "special_order"


class NegotiationStatus(str, enum.Enum):
    PENDING = "pending"
    NEGOTIATING = "negotiating"
    ORDERED = "ordered"
    RECEIVED = "received"
    PASSED = "passed"
    RETURNED = "returned"
    DISPUTED = "disputed"


#: FR-042 pinned state machine. Values are (valid next statuses, required fields).
NEGOTIATION_TRANSITIONS: Dict[str, Dict[str, Any]] = {
    "pending": {"negotiating": []},
    "negotiating": {"ordered": ["final_price_usd"], "passed": ["notes"]},
    "ordered": {"received": [], "passed": []},
    "received": {"returned": [], "disputed": []},
    "disputed": {"returned": [], "received": []},
    "passed": {},
    "returned": {},
}


class QAStatus(str, enum.Enum):
    PENDING = "pending"
    PASSED = "passed"
    QUARANTINED = "quarantined"
    UNVERIFIED_DIMENSIONS = "unverified_dimensions"
    TEXT_ONLY = "text_only"
    HAS_2D_DIAGRAMS = "has_2d_diagrams"


class StepPositionLabel(str, enum.Enum):
    EXPLODED = "exploded"
    POSITIONING = "positioning"
    INSTALL = "install"
    TORQUE = "torque"
    FINISHING = "finishing"


class SignalType(str, enum.Enum):
    IDENTIFICATION_CORRECTION = "identification_correction"
    SOURCING_SELECTION = "sourcing_selection"
    PURCHASE_OUTCOME = "purchase_outcome"


class TaskType(str, enum.Enum):
    IDENTIFY = "identify"
    SOURCE = "source"
    GENERATE_3D = "generate_3d"
    TTS = "tts"
    AUDIO_NORMALIZE = "audio_normalize"


class TaskStatus(str, enum.Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    INTERRUPTED = "interrupted"
    CANCELLED = "cancelled"


class ProblemType(str, enum.Enum):
    WRONG_PART = "wrong_part"
    STEP_UNCLEAR = "step_unclear"
    TOOL_MISSING = "tool_missing"
    SAFETY_CONCERN = "safety_concern"
    OTHER = "other"


class FlagStatus(str, enum.Enum):
    OPEN = "open"
    RESOLVED = "resolved"


class FlagSyncStatus(str, enum.Enum):
    PENDING = "pending"
    SYNCED = "synced"
    FAILED = "failed"


class ComponentSource(str, enum.Enum):
    AUTO = "auto"
    MANUAL = "manual"


#: The built-in category taxonomy (§2 U3 hallucination defense; §5 KB minimums).
PART_CATEGORIES: List[str] = [
    "brake",
    "suspension",
    "engine",
    "body",
    "interior",
    "electrical",
    "exhaust",
    "fuel",
    "cooling",
    "transmission",
]


# ---------------------------------------------------------------------------
# Core models
# ---------------------------------------------------------------------------


class VehicleMeta(BaseModel):
    year: Optional[str] = None
    make: Optional[str] = None
    model: Optional[str] = None
    trim: Optional[str] = None
    engine_code: Optional[str] = None
    notes: Optional[str] = None


class RestorationProject(BaseModel):
    """§5 data model. ``status`` is a plain str (per spec) so a status value
    injected outside the enum (AC-012's custom-status persistence test) still
    loads and displays; transition VALIDATION against the §3 spine happens in
    the pipeline, never by rejecting the stored value at the model layer."""

    project_id: str
    run_id: str
    vehicle_meta: VehicleMeta = Field(default_factory=VehicleMeta)
    status: str = "draft"
    parked: bool = False
    parked_reason: Optional[str] = None
    abandoned_reason: Optional[str] = None
    cloned_from: Optional[str] = None
    in_service_checklist: Optional[List[str]] = None
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)
    budget_ceiling_usd: Optional[float] = None
    budget_override_reason: Optional[str] = None
    api_cost_ceiling_usd: float = 100.0
    api_cost_override_reason: Optional[str] = None
    automation_coverage_pct: Optional[float] = None
    system_sourcing_coverage_pct: Optional[float] = None
    total_sourcing_coverage_pct: Optional[float] = None
    critical_path_coverage_pct: Optional[float] = None
    mesh_qa_pass_rate: Optional[float] = None
    actual_spend_usd: Optional[float] = None
    api_cost_to_date_usd: float = 0.0
    reopened_from: Optional[datetime] = None
    needs_attention: Optional[str] = None

    @field_validator("budget_ceiling_usd")
    @classmethod
    def _budget_positive(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and v <= 0:
            raise ValueError("budget_ceiling_usd must be a positive number (USD)")
        return v


class ComponentRecord(BaseModel):
    part_id: str
    name: str
    category: str
    condition: PartCondition = PartCondition.PRESENT
    confidence: float = 0.0
    photo_refs: List[str] = Field(default_factory=list)
    location_on_vehicle: Optional[str] = None
    source: ComponentSource = ComponentSource.AUTO
    kb_match: Optional[str] = None
    biasing_context: Optional[Dict[str, Any]] = None


class ManifestEntry(BaseModel):
    part_id: str
    name: str
    oem_number: Optional[str] = None
    aftermarket_alternatives: List[str] = Field(default_factory=list)
    quantity: int = 1
    criticality: Criticality = Criticality.STANDARD
    estimated_cost_usd: Optional[float] = None
    sourcing_status: SourcingStatus = SourcingStatus.PENDING
    confidence: float = 0.0
    requires_review: bool = False

    @field_validator("quantity")
    @classmethod
    def _qty_positive(cls, v: int) -> int:
        if v < 1:
            raise ValueError("quantity must be >= 1")
        return v


class PartSourcingQuery(BaseModel):
    part_id: str
    part_name: str
    oem_number: Optional[str] = None
    vehicle_make: str
    vehicle_model: str
    vehicle_year: str
    per_part_budget_ceiling_usd: float
    criticality: Criticality = Criticality.STANDARD


class SourcingCandidate(BaseModel):
    part_id: str
    candidate_id: str = Field(default_factory=_uuid)
    vendor: str
    oem_number: Optional[str] = None
    price_usd: Optional[float] = None
    condition: CandidateCondition = CandidateCondition.USED
    availability: Availability = Availability.IN_STOCK
    region: str = ""
    url_or_contact: str = ""
    tradeable: bool = False
    provenance: Provenance = Provenance.MANUAL_ENTRY
    fetched_at: datetime = Field(default_factory=_utcnow)
    trade_partner_id: Optional[str] = None

    @field_validator("price_usd")
    @classmethod
    def _price_positive(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and v <= 0:
            # FR-012 hallucination defense: prices validated as positive numbers;
            # invalid prices become null rather than crashing ingestion.
            return None
        return v


#: Typed alias used by the research primitive (§5).
PartSourcingResult = SourcingCandidate


class UnsourceableFlag(BaseModel):
    part_id: str
    reason_code: UnsourceableReason
    alternative_suggestion: Optional[str] = None
    fabrication_reference_glb: Optional[str] = None


class NegotiationRecord(BaseModel):
    part_id: str
    candidate_id: str
    status: NegotiationStatus = NegotiationStatus.PENDING
    notes: str = ""
    final_price_usd: Optional[float] = None
    updated_at: datetime = Field(default_factory=_utcnow)


class PurchaseRecord(BaseModel):
    part_id: str
    vendor: str
    price_usd: float
    condition: CandidateCondition = CandidateCondition.USED
    ordered_at: datetime = Field(default_factory=_utcnow)
    received_at: Optional[datetime] = None
    notes: Optional[str] = None
    batch_id: Optional[str] = None

    @field_validator("price_usd")
    @classmethod
    def _purchase_price_positive(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("price_usd must be a positive number (USD)")
        return v


class AssemblyGraphStep(BaseModel):
    step_index: int
    part_ids: List[str] = Field(default_factory=list)
    description: str = ""
    tool_callout: Optional[str] = None
    safety_warning: Optional[str] = None
    estimated_duration_s: float = 0.0


class AssemblyGraph(BaseModel):
    assembly_id: str
    steps: List[AssemblyGraphStep] = Field(default_factory=list)
    tool_list: List[str] = Field(default_factory=list)


class WalkthroughAssembly(BaseModel):
    """FR-018/FR-044. ``text_only``/``has_2d_diagrams`` are DERIVED from
    ``qa_status`` (computed properties, never independently settable) per the
    §5 consistency invariant."""

    model_config = ConfigDict(validate_assignment=False)

    assembly_id: str
    name: str = ""
    glb_paths: List[str] = Field(default_factory=list)
    qa_status: QAStatus = QAStatus.PENDING
    qa_reason: Optional[str] = None
    step_count: int = 0
    audio_format: str = "mp3"
    audio_lufs_target: float = -16.0
    total_duration_s: float = 0.0
    bundle_version: int = 1
    superseded: bool = False

    @computed_field  # type: ignore[misc]
    @property
    def text_only(self) -> bool:
        return self.qa_status == QAStatus.TEXT_ONLY

    @computed_field  # type: ignore[misc]
    @property
    def has_2d_diagrams(self) -> bool:
        return self.qa_status == QAStatus.HAS_2D_DIAGRAMS


class WalkthroughStep(BaseModel):
    assembly_id: str
    step_index: int
    description: str = ""
    step_position_label: StepPositionLabel = StepPositionLabel.EXPLODED
    audio_path: str = ""
    audio_available: bool = False
    duration_s: float = 0.0
    glb_file: str = ""
    has_2d_diagram: bool = False
    diagram_path: Optional[str] = None
    tool_callout: Optional[str] = None
    part_callout: Optional[str] = None
    safety_warning: Optional[str] = None
    text_fallback: str = ""
    still_image_path: Optional[str] = None
    glossary_terms: List[str] = Field(default_factory=list)


class GuideToken(BaseModel):
    token_id: str
    project_id: str
    assembly_id: str
    bundle_version: int = 1
    minted_at: datetime = Field(default_factory=_utcnow)
    expires_at: datetime
    revoked_at: Optional[datetime] = None
    revoked_by: Optional[str] = None
    superseded_at: Optional[datetime] = None
    superseded_by: Optional[str] = None
    last_accessed_at: Optional[datetime] = None
    access_count: int = 0


class ReferenceKBEntry(BaseModel):
    part_id: str
    name: str
    oem_number: Optional[str] = None
    aftermarket_alternatives: List[str] = Field(default_factory=list)
    category: str
    criticality: Criticality = Criticality.STANDARD
    reference_dimensions_mm: Optional[Dict[str, float]] = None
    indicative_price_range_usd: Optional[Dict[str, float]] = None
    interchange: List[str] = Field(default_factory=list)

    @field_validator("category")
    @classmethod
    def _category_known(cls, v: str) -> str:
        if v not in PART_CATEGORIES:
            raise ValueError(
                f"unknown category {v!r}; must be one of {PART_CATEGORIES}"
            )
        return v


class FeedbackSignal(BaseModel):
    """Learning ledger (FR-066). ``category`` is DENORMALIZED from the manifest
    at signal-creation time to prevent misattribution when manifest categories
    change after the signal was recorded."""

    signal_id: str = Field(default_factory=_uuid)
    project_id: str
    signal_type: SignalType
    part_id: Optional[str] = None
    category: Optional[str] = None
    vehicle_make: Optional[str] = None
    vehicle_model: Optional[str] = None
    vehicle_year: Optional[str] = None
    field_name: Optional[str] = None
    old_value: Optional[str] = None
    new_value: Optional[str] = None
    vendor: Optional[str] = None
    final_price_usd: Optional[float] = None
    created_at: datetime = Field(default_factory=_utcnow)


class AsyncTask(BaseModel):
    task_id: str = Field(default_factory=_uuid)
    project_id: str
    task_type: TaskType
    status: TaskStatus = TaskStatus.PENDING
    progress_pct: float = 0.0
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)
    resumed_from: Optional[datetime] = None


class APICostRecord(BaseModel):
    project_id: str
    provider: str
    operation: str
    cost_usd: float
    timestamp: datetime = Field(default_factory=_utcnow)
    description: str = ""


class ReviewLogEntry(BaseModel):
    review_id: str = Field(default_factory=_uuid)
    project_id: str
    part_id: str
    field_name: str
    old_value: str
    new_value: str
    actor: str = "operator"
    timestamp: datetime = Field(default_factory=_utcnow)
    notes: Optional[str] = None


class SourceRegistryEntry(BaseModel):
    source_id: str
    vendor_name: str
    url: str = ""
    search_template: Optional[str] = None
    specialty: Optional[str] = None
    is_trade_partner: bool = False
    contact_info: Optional[str] = None
    rate_limit_seconds: int = 2


class MechanicFlag(BaseModel):
    flag_id: str = Field(default_factory=_uuid)
    project_id: str
    assembly_id: str
    step_index: int = 0
    problem_type: ProblemType = ProblemType.OTHER
    description: str = ""
    screenshot_path: Optional[str] = None
    photo_path: Optional[str] = None
    status: FlagStatus = FlagStatus.OPEN
    created_at: datetime = Field(default_factory=_utcnow)
    resolved_at: Optional[datetime] = None
    resolution_notes: Optional[str] = None


# ---------------------------------------------------------------------------
# Intake receipts (FR-002)
# ---------------------------------------------------------------------------


class IntakeReceipt(BaseModel):
    filename: str
    stored_path: Optional[str] = None
    content_sha256: Optional[str] = None
    stored_format: Optional[str] = None  # jpeg, png, heic, webp
    thumbnail_path: Optional[str] = None
    thumbnail_status: str = "pending"  # generated | skipped_no_pillow | rejected
    size_bytes: int = 0
    accepted: bool = False
    rejection_reason: Optional[str] = None
