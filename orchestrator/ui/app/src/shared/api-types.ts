// TypeScript types for the Restoration Copilot API surface.
// Derived from orchestrator/core/restoration_models.py (the backend data model).
// These mirror the Python enums/str fields exactly so the UI never invents a
// status the backend does not carry.

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
  status: ProjectStatus;
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

export interface CreateProjectInput {
  vehicle_meta: VehicleMeta;
  budget_ceiling_usd?: number | null;
  api_cost_ceiling_usd?: number | null;
}

export interface ComponentRecord {
  part_id: string;
  name: string;
  category: string;
  condition: string;
  confidence: number;
  photo_refs: string[];
  location_on_vehicle?: string | null;
  source: string;
  kb_match?: string | null;
}

export interface ManifestEntry {
  part_id: string;
  name: string;
  oem_number?: string | null;
  aftermarket_alternatives: string[];
  quantity: number;
  criticality: string;
  estimated_cost_usd?: number | null;
  sourcing_status: string;
  confidence: number;
  requires_review: boolean;
}

export interface SourcingCandidate {
  candidate_id: string;
  part_id: string;
  supplier: string;
  availability: string;
  price_usd?: number | null;
  condition: string;
  negotiation_status: string;
  url?: string | null;
  notes?: string | null;
}

export interface SourcingSummary {
  project_id: string;
  status: string;
  candidates: SourcingCandidate[];
  flags?: Flag[];
  total_coverage?: number | null;
  system_coverage?: number | null;
  critical_coverage?: number | null;
  total_parts?: number | null;
}

export interface Flag {
  flag_id: string;
  project_id: string;
  part_id?: string | null;
  step_id?: string | null;
  problem_type: string;
  status: string;
  description: string;
  resolution_notes?: string | null;
  created_at: string;
  resolved_at?: string | null;
}

export interface GuideToken {
  token_id: string;
  project_id: string;
  assembly_id?: string | null;
  tier: string;
  created_at: string;
  expires_at?: string | null;
  superseded: boolean;
  revoked: boolean;
  qr_path?: string | null;
}

export interface ApiCostSummary {
  project_id: string;
  to_date_usd: number;
  ceiling_usd: number;
  override_reason?: string | null;
  by_provider?: Array<{ provider: string; calls: number; cost_usd: number; status: string }>;
}

export interface BridgeHealth {
  status: string;
  providers?: Array<{
    provider: string;
    status: string;
    healthy: boolean;
    last_check?: string | null;
    model?: string | null;
    detail?: string | null;
  }>;
  capabilities?: Record<string, "available" | "gated" | "unknown">;
}

export interface RestorationHealth {
  status: string;
  pipeline_running?: boolean;
  active_project_id?: string | null;
  providers_paused?: string[];
  capabilities?: Record<string, "available" | "gated" | "unknown">;
}

export interface SessionInfo {
  authenticated: boolean;
  operator?: string | null;
  expires_at?: string | null;
}

export interface KbEntry {
  part_id: string;
  name: string;
  category: string;
  oem_number?: string | null;
  notes?: string | null;
  approved: boolean;
}

export interface Source {
  source_id: string;
  name: string;
  url?: string | null;
  kind: string;
  trusted: boolean;
  notes?: string | null;
}

// ── U5 Model Shop: manual assembly + bundle types (spec §8.5, §18) ──

export type StepPositionLabel = "exploded" | "install" | "torque" | "finishing";
export type QAStatus = "text_only" | "has_2d_diagrams" | "passed" | "quarantined";
export type GuideTier = "T1" | "T2" | "T3" | "T4";

export interface ManualAssemblyStep {
  caption: string;
  part_name?: string | null;
  required_tool?: string | null;
  safety_warning?: string | null;
  step_position_label: StepPositionLabel;
}

export interface ManualAssemblyResponse {
  task_id: string;
  assembly_id: string;
}

export interface AssemblySummary {
  assembly_id: string;
  project_id: string;
  bundle_version: number;
  qa_status: QAStatus;
  tier: GuideTier;
  step_count: number;
  total_duration_s: number;
  audio_available: boolean;
  created_at?: string | null;
}

export interface Hotspot {
  id: string;
  label: string;
  part_name: string | null;
  target_step_index: number | null;
  position: { x: number; y: number; z: number };
}

export interface BundleStep {
  step_index: number;
  step_position_label: StepPositionLabel;
  caption: string;
  part_name: string | null;
  required_tool: string | null;
  safety_warning: string | null;
  duration_s: number;
  has_glb: boolean;
  glb_path: string | null;
  has_diagram: boolean;
  diagram_path: string | null;
  has_audio: boolean;
  audio_path: string | null;
  hotspots: Hotspot[];
}

export interface CrossReference {
  part_id: string;
  part_name: string;
  compatible_vehicles: { make: string; model: string; year: number }[];
}

export interface BundleMeta {
  bundle_version: number;
  assembly_id: string;
  project_id: string;
  vehicle_meta: VehicleMeta;
  qa_status: QAStatus;
  tier: GuideTier;
  step_count: number;
  total_duration_s: number;
  audio_available: boolean;
  audio_lufs_target: number | null;
  glb_paths: string[];
  steps: BundleStep[];
  glossary: Record<string, string>;
  cross_references?: CrossReference[];
}

// S-6 minimal bootstrap embedded in the guide HTML shell (spec §9.1).
export interface GuideBootstrap {
  token_id: string;
  assembly_id: string;
  bundle_version: number;
  project_id: string;
  qa_status: QAStatus;
  tier: GuideTier;
  vehicle_meta: VehicleMeta;
}

// Capability manifest keys (spec §5.2) — features that may be gated.
export type CapabilityState = "available" | "gated" | "unknown" | "uncertain";

export type CapabilityKey =
  | "insights"
  | "assemblies_list"
  | "generate_3d"
  | "publish"
  | "assembly_graph"
  | "dimensions"
  | "tts"
  | "audio_normalize";

// Guide flag submission (S-11, spec §9.4).
export interface GuideFlagSubmission {
  problem_type: string;
  notes: string;
  step_index: number;
  screenshot_data_url?: string | null;
  photo_data_url?: string | null;
  created_at: string;
}
