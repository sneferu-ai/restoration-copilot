// Shared primitive components (spec §4.8 inventory). All styling via tokens.

import type React from "react";
import { statusMeta } from "./constants";
import type { BiasingContext, KBEntry } from "./types";
import { useStaleKbWarning } from "./hooks";

type Tone = "accent" | "ok" | "signal" | "muted" | "faint";

const toneClasses: Record<Tone, string> = {
  accent: "text-accent",
  ok: "text-ok",
  signal: "text-signal",
  muted: "text-muted",
  faint: "text-faint",
};

const toneBg: Record<Tone, string> = {
  accent: "bg-accent/15",
  ok: "bg-ok/15",
  signal: "bg-signal/15",
  muted: "bg-muted/15",
  faint: "bg-faint/15",
};

/** Status glyph + label — hue is never the only carrier (DESIGN §3). */
export function StatusBadge({ status, className = "" }: { status: string; className?: string }) {
  const meta = statusMeta(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-xs font-medium ${toneBg[meta.tone]} ${className}`}
      title={meta.hint}
      data-testid="status-badge"
    >
      <StatusGlyph tone={meta.tone} status={status} />
      <span className="text-ink">{meta.label}</span>
    </span>
  );
}

function StatusGlyph({ tone, status }: { tone: Tone; status: string }) {
  const cls = `h-3 w-3 ${toneClasses[tone]}`;
  if (status === "closed" || status === "in_service" || status === "manifest_locked" || status === "hunt_sealed" || status === "published" || status === "budget_ruled") {
    return (
      <svg viewBox="0 0 12 12" className={cls} aria-hidden="true">
        <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M3.5 6.2 5.2 7.9 8.6 4.3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "abandoned" || status === "sourcing_insufficient") {
    return (
      <svg viewBox="0 0 12 12" className={cls} aria-hidden="true">
        <path d="M6 1.5 11 10H1Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M6 4.6v2.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="6" cy="8.6" r="0.8" fill="currentColor" />
      </svg>
    );
  }
  // in-progress arc
  return (
    <svg viewBox="0 0 12 12" className={cls} aria-hidden="true">
      <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.35" />
      <path d="M6 1a5 5 0 0 1 5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function Chip({
  label,
  value,
  title,
  tone = "muted",
  mono = false,
}: {
  label: string;
  value: string;
  title?: string;
  tone?: Tone;
  mono?: boolean;
}) {
  return (
    <span
      className="inline-flex items-baseline gap-1.5 rounded-sm bg-elevated px-2 py-0.5"
      title={title}
    >
      <span className="text-xs text-faint">{label}</span>
      <span className={`tnum text-sm font-medium ${toneClasses[tone]} ${mono ? "font-mono" : ""}`}>
        {value}
      </span>
    </span>
  );
}

export function ProgressBar({
  value,
  max,
  tone = "accent",
  label,
}: {
  value: number;
  max: number;
  tone?: Tone;
  label?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className="h-1.5 w-full overflow-hidden rounded-pill bg-elevated"
    >
      <div
        className={`h-full rounded-pill transition-[width] duration-200 ${tone === "signal" ? "bg-signal" : tone === "ok" ? "bg-ok" : "bg-accent"}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function InlineError({
  message,
  fieldErrors,
  id,
}: {
  message?: string | null;
  fieldErrors?: { field: string; message: string }[];
  id?: string;
}) {
  if (!message && !(fieldErrors && fieldErrors.length)) return null;
  return (
    <div
      id={id}
      role="alert"
      className="rounded-sm border border-signal/40 bg-signal/10 px-3 py-2 text-sm text-ink"
      data-testid="inline-error"
    >
      {message && <p>{message}</p>}
      {fieldErrors?.map((fe) => (
        <p key={fe.field} className="text-muted">
          <span className="font-mono text-xs">{fe.field}</span> — {fe.message}
        </p>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  ctaLabel,
  ctaTo,
  onCta,
}: {
  title: string;
  body: string;
  ctaLabel?: string;
  ctaTo?: string;
  onCta?: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border-default px-6 py-8">
      <p className="text-lg font-semibold">{title}</p>
      <p className="max-w-prose text-sm text-muted">{body}</p>
      {ctaLabel && (ctaTo || onCta) && (
        <a
          href={ctaTo ?? "#"}
          onClick={(e) => {
            if (onCta) {
              e.preventDefault();
              onCta();
            }
          }}
          className="mt-2 inline-flex h-touch items-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors duration-150 hover:bg-accent-hover active:bg-accent-pressed"
        >
          {ctaLabel}
        </a>
      )}
    </div>
  );
}

export function SkeletonRows({ rows = 3, height = "h-8" }: { rows?: number; height?: string }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={`${height} animate-pulse rounded-md bg-surface`} />
      ))}
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="animate-pulse rounded-md border border-border-subtle bg-surface p-4" aria-busy="true">
      <div className="h-4 w-2/3 rounded-sm bg-elevated" />
      <div className="mt-3 h-3 w-1/3 rounded-sm bg-elevated" />
      <div className="mt-4 flex gap-2">
        <div className="h-6 w-16 rounded-sm bg-elevated" />
        <div className="h-6 w-16 rounded-sm bg-elevated" />
        <div className="h-6 w-16 rounded-sm bg-elevated" />
      </div>
    </div>
  );
}

export type AlertSeverity = "info" | "warn" | "critical";

export function CopilotAlert({
  severity,
  title,
  body,
  action,
}: {
  severity: AlertSeverity;
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  const tone: Tone = severity === "critical" ? "signal" : severity === "warn" ? "accent" : "muted";
  return (
    <div
      role={severity === "critical" ? "alert" : "status"}
      className={`flex items-start gap-3 rounded-md border-l-2 bg-surface px-4 py-3 ${
        severity === "critical" ? "border-signal" : severity === "warn" ? "border-accent" : "border-muted"
      }`}
      data-testid="copilot-alert"
    >
      <span className={`mt-0.5 text-sm font-semibold ${toneClasses[tone]}`}>
        {severity === "critical" ? "!" : severity === "warn" ? "▲" : "i"}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        {body && <p className="mt-0.5 text-sm text-muted">{body}</p>}
      </div>
      {action}
    </div>
  );
}

const SAFE_SCHEMES = new Set(["http:", "https:"]);

/** URL scheme sanitizer (D19 / OBL-45/59) for every user-provided href. */
export function SafeLink({
  href,
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const isSafe =
    !href ||
    (() => {
      try {
        const url = new URL(href, window.location.origin);
        return SAFE_SCHEMES.has(url.protocol);
      } catch {
        return false;
      }
    })();
  return (
    <a
      href={isSafe ? href : undefined}
      className="text-accent underline-offset-2 hover:underline"
      {...props}
    >
      {children}
    </a>
  );
}

/**
 * §6.0 Layer 3 — Stale-KB warning (soul-brief core feature). Fires when the
 * operator resolves an identification review case (U3) or selects a sourcing
 * candidate (U4). Three checks, all deterministic (OBL-66):
 *   1. OEM mismatch — KB oem_number ≠ VLM-identified OEM → amber banner
 *   2. Low historical agreement — biasing_context.agreement_rate < 0.5 → escalated
 *   3. KB entry age — older than 365 days (or no timestamp) → secondary note
 * The biasing_context object is rendered as a transparency surface wherever
 * identification confidence is shown (§6.0).
 */
export function StaleKbWarning({
  kbEntry,
  identifiedOem,
  biasingContext,
}: {
  kbEntry: KBEntry | null | undefined;
  identifiedOem: string | null | undefined;
  biasingContext: BiasingContext | null | undefined;
}) {
  const state = useStaleKbWarning(kbEntry, identifiedOem, biasingContext);
  if (!state.hasWarnings) return null;

  return (
    <div
      role="alert"
      className="flex flex-col gap-1.5 rounded-sm border-l-2 border-signal bg-signal/10 px-3 py-2"
      data-testid="stale-kb-warning"
    >
      {state.oemMismatch && (
        <p className="text-sm font-medium text-signal">
          OEM mismatch — KB says {state.kbOem}, identification says {state.identifiedOem}. Verify
          before accepting.
        </p>
      )}
      {state.lowAgreement && (
        <p className="text-sm font-medium text-signal">
          Historical agreement for this category is low ({Math.round((state.agreementRate ?? 0) * 100)}%).
          Extra care — past identifications in this category were frequently corrected.
        </p>
      )}
      {state.staleEntry && (
        <p className="text-xs text-muted">
          {state.kbEntryAgeDays == null
            ? "KB entry has no update timestamp — freshness unknown."
            : `KB entry last updated ${state.kbEntryAgeDays} days ago — may be stale.`}
        </p>
      )}
      {biasingContext && (biasingContext.sample_size != null || biasingContext.prior_corrections != null) && (
        <p className="text-xs text-faint" data-testid="biasing-context">
          Biasing context: {biasingContext.sample_size != null ? `${biasingContext.sample_size} samples` : ""}
          {biasingContext.sample_size != null && biasingContext.prior_corrections != null ? " · " : ""}
          {biasingContext.prior_corrections != null ? `${biasingContext.prior_corrections} prior corrections` : ""}
          {biasingContext.category ? ` · category: ${biasingContext.category}` : ""}
        </p>
      )}
    </div>
  );
}
