// DegradationPanel (spec §8.9 + §11.2). The standardized surface every 404 on a
// Phase 4/5 endpoint renders — never a silent route-around, never a bare
// "not available". Per-endpoint content lives in DEGRADATION_PRESETS, keyed by
// the endpoint name, transcribed verbatim from the §11.2 table. The panel
// replaces the screen section that would normally host the feature (§8.9).

import type React from "react";

export interface DegradationAction {
  label: string;
  onClick?: () => void;
  href?: string;
}

export interface DegradationPreset {
  /** Full headline, e.g. "3D Generation Not Available" (§11.2). */
  title: string;
  /** One sentence: what the feature does. */
  description: string;
  /** "What you can do now" fallback actions (§8.9 bullet list). */
  fallbacks: string[];
  /** Primary action button (optional). */
  primary?: DegradationAction;
  /** Secondary link (optional). */
  secondary?: DegradationAction;
}

/**
 * Per-endpoint degradation content (spec §11.2, transcribed verbatim).
 * projectId is interpolated into CLI fallback strings at the call site.
 */
export const DEGRADATION_PRESETS = {
  generate_3d: (projectId: string): DegradationPreset => ({
    title: "3D Generation Not Available",
    description: "3D meshes are generated from locked-manifest parts by the backend pipeline.",
    fallbacks: [
      `Run generation from the CLI: python -m orchestrator.cli restoration generate-3d ${projectId}`,
      "Continue with 2D diagrams and text-only guidance in the bay guide.",
    ],
  }),
  assembly_data: (): DegradationPreset => ({
    title: "Assembly Data Not Available",
    description: "No guides have been published yet — the assemblies endpoint serves published bundles.",
    fallbacks: [
      "Assemblies derived from the manifest are reviewable below.",
      "The bay guide shows text-only mode from cached steps, or 'contact the shop operator'.",
    ],
  }),
  assembly_graph: (): DegradationPreset => ({
    title: "Graph Save Not Available",
    description: "Saving the assembly relationship graph to the backend is not enabled in this build.",
    fallbacks: [
      "Review assemblies visually below.",
      "Export the graph as JSON for manual backend entry.",
    ],
    primary: { label: "Export graph JSON" },
  }),
  publish: (projectId: string): DegradationPreset => ({
    title: "Guide Publish Not Available",
    description: "Publishing a guide bundle for the bay guide is not enabled in this build.",
    fallbacks: [
      `Run publish from the CLI: python -m orchestrator.cli restoration publish ${projectId}`,
      "Assemblies remain reviewable — token links work once the bundle is published.",
    ],
  }),
  dimensions: (): DegradationPreset => ({
    title: "Dimension Input Not Available",
    description: "Recording operator-verified part dimensions for QA is not enabled in this build.",
    fallbacks: [
      "Record dimensions externally and update the KB entry manually.",
      "Skip QA with unverified dimensions — the part ships flagged as unverified.",
    ],
  }),
  export_artifact: (): DegradationPreset => ({
    title: "PDF Export Not Available",
    description: "Exporting a job artifact as a server-rendered PDF is not enabled in this build.",
    fallbacks: ["Use the browser's Print to PDF as a workaround."],
    primary: { label: "Print this page", onClick: () => window.print() },
  }),
  insights: (): DegradationPreset => ({
    title: "Shop Insights Not Available",
    description: "Aggregate analytics across all jobs are served by a backend endpoint not yet enabled.",
    fallbacks: [
      "Analytics appear here after the endpoint is enabled and at least one job completes.",
    ],
  }),
  guide_content: (): DegradationPreset => ({
    title: "Guide Content Not Available",
    description: "Step assets for the bay guide are not served by this build.",
    fallbacks: [
      "Contact the shop operator.",
      "If cached text scripts exist, the guide shows text-only mode (T4).",
    ],
  }),
  kb_approve: (): DegradationPreset => ({
    title: "KB Proposal Approval Not Available",
    description:
      "KB proposal approval is not available in this build. You can still browse existing entries and add them manually via 'Add KB entry'.",
    fallbacks: [
      "Add proposed entries manually via 'Add KB entry'.",
      "Approved proposals from completed jobs will appear here when the endpoint is activated.",
    ],
  }),
} as const;

export type DegradationKey = keyof typeof DEGRADATION_PRESETS;

/** Detect a 404 from an ApiError (the only status that triggers a panel). */
export function isPhaseGap(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: number }).status;
  return status === 404;
}

export function DegradationPanel({
  preset,
  testId,
}: {
  preset: DegradationPreset;
  testId?: string;
}): React.ReactElement {
  return (
    <div
      className="card flex flex-col gap-3 border-l-2 border-accent/50 p-4"
      role="status"
      aria-live="polite"
      data-testid={testId ?? "degradation-panel"}
    >
      <div className="flex items-start gap-3">
        {/* Dashed-box icon — "planned but not in this build". Not an emoji
            (anti-default #10). 20px, 1.5 stroke, currentColor. */}
        <svg
          viewBox="0 0 20 20"
          fill="none"
          aria-hidden="true"
          className="mt-0.5 h-5 w-5 shrink-0 text-muted"
        >
          <rect
            x="2.75"
            y="2.75"
            width="14.5"
            height="14.5"
            rx="2"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="3 2.5"
          />
          <path
            d="M5.5 14.5 L14.5 5.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        <div className="flex flex-col gap-0.5">
          <h3 className="text-base font-semibold leading-tight">{preset.title}</h3>
          <p className="text-xs text-muted">Not available in this build</p>
        </div>
      </div>

      <p className="text-sm text-muted">{preset.description}</p>

      {preset.fallbacks.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium uppercase tracking-wide text-faint">What you can do now</p>
          <ul className="flex flex-col gap-1">
            {preset.fallbacks.map((f, i) => (
              <li key={i} className="flex gap-2 text-sm text-muted">
                <span aria-hidden="true" className="mt-px text-faint">•</span>
                <span className="flex-1">{f}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(preset.primary || preset.secondary) && (
        <div className="flex flex-wrap gap-2 pt-1">
          {preset.primary && (preset.primary.onClick || preset.primary.href) && (
            preset.primary.href ? (
              <a
                className="btn btn-primary"
                href={preset.primary.href}
                aria-label={preset.primary.label}
                data-testid={`${testId ?? "degradation-panel"}-primary`}
              >
                {preset.primary.label}
              </a>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                onClick={preset.primary.onClick}
                aria-label={preset.primary.label}
                data-testid={`${testId ?? "degradation-panel"}-primary`}
              >
                {preset.primary.label}
              </button>
            )
          )}
          {preset.secondary && (preset.secondary.onClick || preset.secondary.href) && (
            preset.secondary.href ? (
              <a
                className="btn btn-ghost"
                href={preset.secondary.href}
                aria-label={preset.secondary.label}
                data-testid={`${testId ?? "degradation-panel"}-secondary`}
              >
                {preset.secondary.label}
              </a>
            ) : (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={preset.secondary.onClick}
                aria-label={preset.secondary.label}
                data-testid={`${testId ?? "degradation-panel"}-secondary`}
              >
                {preset.secondary.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
