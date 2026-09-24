// INTERIM hand-authored types mirroring orchestrator/core/restoration_models.py.
// Next round replaces this file with scripts/generate_types.py output (spec §4.3);
// field shapes below were transcribed from the Pydantic models 1:1, including
// nullable fields (Optional[T] → `| null`).

export interface VehicleMeta {
  year?: string | null;
  make?: string | null;
  model?: string | null;
  trim?: string | null;
  engine_code?: string | null;
  notes?: string | null;
}

export type ProjectStatus =
  | "draft"
  | "intake_open"
  | "intake_sealed"
  | "identifying"
  | "review_open"
  | "manifest_locked"
  | "budget_ruled"
  | "hunting"
  | "sourcing_insufficient"
  | "hunt_sealed"
  | "meshing"
  | "graph_review"
  | "published"
  | "in_service"
  | "closed"
  | "abandoned";

export interface RestorationProject {
  project_id: string;
  run_id: string;
  vehicle_meta: VehicleMeta;
  status: string; // plain str per backend model (AC-012 custom statuses load)
  parked: boolean;
  parked_reason?: string | null;
  abandoned_reason?: string | null;
  cloned_from?: string | null;
  in_service_checklist?: string[] | null;
  created_at: string;
  updated_at: string;
  budget_ceiling_usd?: number | null;
  budget_override_reason?: string | null;
  api_cost_ceiling_usd: number;
  api_cost_override_reason?: string | null;
  automation_coverage_pct?: number | null;
  system_sourcing_coverage_pct?: number | null;
  total_sourcing_coverage_pct?: number | null;
  critical_path_coverage_pct?: number | null;
  mesh_qa_pass_rate?: number | null;
  actual_spend_usd?: number | null;
  api_cost_to_date_usd: number;
  reopened_from?: string | null;
  needs_attention?: string | null;
}

export interface IntakeReceipt {
  filename: string;
  size_bytes: number;
  accepted: boolean;
  rejection_reason?: string | null;
  content_sha256?: string | null;
  stored_format?: string | null;
  stored_path?: string | null;
  thumbnail_path?: string | null;
  thumbnail_status?: string | null;
}

export interface IntakeUploadResult {
  receipts: IntakeReceipt[];
  gap_list: string[];
}

export interface SealResult {
  status: string;
  identify_task_id?: string | null;
}

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

export interface AsyncTask {
  task_id: string;
  task_type: string;
  status: TaskStatus;
  progress_pct?: number | null;
  message?: string | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ManifestEntry {
  part_id: string;
  name: string;
  oem_number?: string | null;
  aftermarket_alternatives: string[];
  quantity: number;
  criticality: "critical" | "standard" | "cosmetic";
  estimated_cost_usd?: number | null;
  sourcing_status: "pending" | "sourced" | "unsourceable" | "fabrication_ref" | "previously_sourced";
  confidence: number;
  requires_review: boolean;
}

export interface Manifest {
  project_id: string;
  locked: boolean;
  entries: ManifestEntry[];
}

export interface ReviewCase {
  part_id: string;
  name: string;
  category?: string | null;
  confidence: number;
  suggested_oem?: string | null;
  identified_oem?: string | null;
  kb_match?: string | null;
  biasing_context?: BiasingContext | null;
  source?: string | null;
}

export interface BiasingContext {
  agreement_rate?: number | null;
  sample_size?: number | null;
  category?: string | null;
  prior_corrections?: number | null;
  [key: string]: unknown;
}

export interface BudgetRuling {
  ruling: "within_budget" | "shortfall_critical" | "insufficient_data" | string;
  budget_ceiling_usd: number;
  estimated_total_usd?: number | null;
  allocation?: Record<string, number> | null;
  overridden?: boolean;
  override_reason?: string | null;
  message?: string | null;
}

export type CandidateCondition = "new" | "used" | "rebuilt" | "nos";
export type Availability = "in_stock" | "backorder" | "special_order";

export interface SourcingCandidate {
  part_id: string;
  candidate_id: string;
  vendor: string;
  oem_number?: string | null;
  price_usd?: number | null;
  condition: CandidateCondition;
  availability: Availability;
  region: string;
  url_or_contact: string;
  tradeable: boolean;
  provenance: string;
  fetched_at: string;
  trade_partner_id?: string | null;
}

export interface UnsourceableFlag {
  part_id: string;
  reason_code: string;
  alternative_suggestion?: string | null;
  fabrication_reference_glb?: string | null;
}

export interface SourcingSummary {
  candidates: SourcingCandidate[];
  flags: UnsourceableFlag[];
  system_coverage?: number | null;
  total_coverage?: number | null;
  critical_coverage?: number | null;
  total_parts?: number | null;
}

export interface GuideToken {
  token_id: string;
  assembly_id: string;
  bundle_version: number;
  expires_at?: string | null;
  created_at?: string | null;
  superseded?: boolean;
  revoked?: boolean;
}

export interface ApiCostSummary {
  total: number;
  ceiling: number;
  pct_of_ceiling?: number | null;
  per_provider?: Record<string, number> | null;
}

export interface KBEntry {
  part_id: string;
  name: string;
  category: string;
  oem_number?: string | null;
  aftermarket_alternatives?: string[];
  // Backend sends {min, max, mid} (restoration_pipeline.py load_kb)
  indicative_price_range_usd?: { min?: number; max?: number; mid?: number } | null;
  // Backend sends string[] (restoration_models.py ReferenceKBEntry.interchange)
  interchange?: string[] | string | null;
  // Backend sends make/model/year (load_kb flattens the YAML hierarchy)
  make?: string | null;
  model?: string | null;
  year?: string | null;
  // Legacy aliases (never populated by the current backend — kept for compat)
  vehicle_make?: string | null;
  vehicle_model?: string | null;
  vehicle_year?: string | null;
  updated_at?: string | null;
  provenance?: string | null;
  // §8.4 KB Curation: editable fields from ReferenceKBEntry (restoration_models.py)
  criticality?: "critical" | "standard" | "optional" | null;
  reference_dimensions_mm?: Record<string, number> | null;
}

// Source registry — mirrors the backend SourceRegistryEntry (restoration_models.py).
export interface SourceRegistryEntry {
  source_id: string;
  vendor_name: string;
  url?: string | null;
  search_template?: string | null;
  specialty?: string | null;
  is_trade_partner: boolean;
  contact_info?: string | null;
  rate_limit_seconds: number;
}

// IndexedDB session ledger entry (U4 wallet desk, §16 item 8). The server's
// actual_spend_usd is always authoritative; this is the browser-local mirror
// that survives F5 until REP-4 GET endpoints land (AC-UI-011, OBL-19).
export interface LedgerEntry {
  id: string;
  project_id: string;
  part_id: string;
  vendor: string;
  price_usd: number;
  condition: string;
  notes?: string | null;
  recorded_at: number;
}

export interface MechanicFlag {
  flag_id: string;
  step_index?: number | null;
  description: string;
  screenshot?: string | null;
  resolved: boolean;
  resolution_notes?: string | null;
  created_at?: string | null;
}

export interface HealthResponse {
  module_loaded: boolean;
  active_projects: number;
  pipeline_route: string;
  os_supported: boolean;
  version?: string | null;
}

export interface BridgeHealth {
  bridges: Record<string, { configured: boolean; healthy: boolean; unverified?: boolean }>;
}

// ---- Bay Guide (bundle_meta.json, spec §7.2) ----

export interface GuideBootstrap {
  token: string;
  projectId: string;
  assemblyId: string;
  bundleVersion: number;
  superseded: boolean;
}

export interface GuideHotspot {
  id: string;
  label: string;
  order?: number;
  position: [number, number, number];
  _position_space?: string;
}

export interface GuideStep {
  step_index: number;
  description: string;
  step_position_label?: string | null;
  audio_path?: string | null;
  audio_available: boolean;
  duration_s?: number | null;
  glb_file?: string | null;
  has_2d_diagram: boolean;
  diagram_path?: string | null;
  tool_callout?: string | null;
  part_callout?: string | null;
  safety_warning?: string | null;
  text_fallback?: string | null;
  still_image_path?: string | null;
  glossary_terms?: string[];
  hotspots?: GuideHotspot[];
}

export interface BundleMeta {
  bundle_version: number;
  assembly_id: string;
  assembly_name: string;
  visual_tier: "T1" | "T2" | "T3" | "T4";
  total_steps: number;
  total_duration_s?: number | null;
  estimated_total_size_mb?: number | null;
  locale?: string;
  asset_base_url: string;
  steps: GuideStep[];
  glossary?: { term: string; definition: string }[];
}

// ---- Error envelope (spec §3.4) ----

export interface ApiErrorBody {
  error: string;
  message: string;
  field_errors?: { field: string; message: string }[];
  missing_items?: string[];
}
