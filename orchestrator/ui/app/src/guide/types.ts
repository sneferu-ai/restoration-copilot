// Zod schemas for the Bay Guide boot + bundle (spec §7.10, §18).
// Every API response validated at the client boundary (spec §4 Runtime safety).

import { z } from "zod";

export const VehicleMetaSchema = z.object({
  year: z.number().int().min(1900).max(2100),
  make: z.string().min(1),
  model: z.string().min(1),
});

export const GuideBootstrapSchema = z.object({
  token_id: z.string().min(1),
  assembly_id: z.string().min(1),
  bundle_version: z.number().int().min(1),
  project_id: z.string().min(1),
  qa_status: z.enum([
    "pending",
    "passed",
    "quarantined",
    "unverified_dimensions",
    "text_only",
    "has_2d_diagrams",
  ]),
  tier: z.enum(["T1", "T2", "T3", "T4"]),
  vehicle_meta: VehicleMetaSchema,
});

export const HotspotSchema = z.object({
  id: z.string(),
  label: z.string(),
  part_name: z.string().nullable(),
  target_step_index: z.number().int().nullable(),
  position: z.object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
  }),
});

export const BundleStepSchema = z.object({
  step_index: z.number().int(),
  step_position_label: z.enum(["exploded", "install", "torque", "finishing"]),
  caption: z.string().min(1),
  part_name: z.string().nullable(),
  required_tool: z.string().nullable(),
  safety_warning: z.string().nullable(),
  duration_s: z.number(),
  has_glb: z.boolean(),
  glb_path: z.string().nullable(),
  has_diagram: z.boolean(),
  diagram_path: z.string().nullable(),
  has_audio: z.boolean(),
  audio_path: z.string().nullable(),
  hotspots: z.array(HotspotSchema),
});

export const CrossReferenceSchema = z.object({
  part_id: z.string(),
  part_name: z.string(),
  compatible_vehicles: z.array(
    z.object({
      make: z.string(),
      model: z.string(),
      year: z.number().int(),
    }),
  ),
});

export const BundleMetaSchema = z.object({
  bundle_version: z.number().int().min(1),
  assembly_id: z.string().min(1),
  project_id: z.string().min(1),
  vehicle_meta: VehicleMetaSchema,
  qa_status: z.enum([
    "pending",
    "passed",
    "quarantined",
    "unverified_dimensions",
    "text_only",
    "has_2d_diagrams",
  ]),
  tier: z.enum(["T1", "T2", "T3", "T4"]),
  step_count: z.number().int().min(1),
  total_duration_s: z.number(),
  audio_available: z.boolean(),
  audio_lufs_target: z.number().nullable(),
  glb_paths: z.array(z.string()),
  steps: z.array(BundleStepSchema).min(1),
  glossary: z.record(z.string(), z.string()),
  cross_references: z.array(CrossReferenceSchema).optional(),
});

export type GuideBootstrap = z.infer<typeof GuideBootstrapSchema>;
export type BundleMeta = z.infer<typeof BundleMetaSchema>;
export type BundleStep = z.infer<typeof BundleStepSchema>;
