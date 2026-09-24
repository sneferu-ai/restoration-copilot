// GuideShell — token-scoped bay guide shell. bundle_meta via SP-2 with Bearer;
// 404 → honest "not yet published" state (§3.3). 429 → persistent pill with
// Retry-After countdown + "what you can do now" guidance (keep working, flags
// queue, preloads resume); when the timer clears, a brief skeleton-pulse
// "Reconnecting" bar signals preloads resuming before it fades (§7 skeleton
// discipline). Speculative fetches (next-3-step preloads) suspend during 429;
// current-step assets never do (OBL-54). Offline: cached steps keep working.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Route, Routes, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "@shared/api-client";
import type { BundleMeta } from "@shared/types";
import { getBootstrap } from "./bootstrap";
import { drainFlags, getPendingFlags, loadProgress, saveProgress } from "./db";
import type { QueuedFlag } from "./db";
import { StepView } from "./StepView";
import { FlagForm } from "./FlagForm";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unpublished" }
  | { kind: "expired" }
  | { kind: "ready"; meta: BundleMeta; expired?: boolean };

export function GuideShell() {
  const bootstrap = useMemo(getBootstrap, []);
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [online, setOnline] = useState(navigator.onLine);
  const [rateLimitedUntil, setRateLimitedUntil] = useState<number | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [preloadsResuming, setPreloadsResuming] = useState(false);
  const [flagNotice, setFlagNotice] = useState<string | null>(null);
  const [superseded, setSuperseded] = useState(bootstrap?.superseded ?? false);
  const [supersededDismissed, setSupersededDismissed] = useState(false);
  const [pendingFlags, setPendingFlags] = useState<QueuedFlag[]>([]);
  const suspendedRef = useRef(false);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  useEffect(() => {
    if (rateLimitedUntil == null) return;
    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((rateLimitedUntil - Date.now()) / 1000));
      setCountdown(left);
      if (left === 0) {
        setRateLimitedUntil(null);
        suspendedRef.current = false;
        setPreloadsResuming(true);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [rateLimitedUntil]);

  // Skeleton-pulse transition: when the rate-limit clears, show a brief
  // "Reconnecting" bar so the operator sees preloads resuming instead of
  // the pill vanishing into nothing (DESIGN.md §7 — skeletons where the
  // layout is known; §8 voice — terse, says what's happening, shuts up).
  useEffect(() => {
    if (!preloadsResuming) return;
    const timer = setTimeout(() => setPreloadsResuming(false), 2000);
    return () => clearTimeout(timer);
  }, [preloadsResuming]);

  const load = useCallback(async () => {
    if (!bootstrap) {
      setState({ kind: "error", message: "This guide link did not carry its bootstrap data. Ask the shop for a fresh link." });
      return;
    }
    try {
      const meta = await api<BundleMeta>(
        `/guide/assets/${bootstrap.assemblyId}/bundle_meta.json`,
        { token: bootstrap.token },
      );
      setState({ kind: "ready", meta });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setState({ kind: "unpublished" });
      } else if (err instanceof ApiError && err.status === 410) {
        // AT-060: expired token — non-dismissible banner, cached content stays readable.
        // If we already have meta from a prior successful load, keep it visible with
        // the expired flag so the mechanic can still read cached steps.
        setState((prev) =>
          prev.kind === "ready"
            ? { ...prev, expired: true }
            : { kind: "expired" },
        );
      } else if (err instanceof ApiError && err.status === 429) {
        suspendedRef.current = true;
        setRateLimitedUntil(Date.now() + (err.retryAfter ?? 60) * 1000);
        setState((prev) =>
          prev.kind === "ready"
            ? prev
            : { kind: "error", message: "The shop's server is limiting requests. Cached steps still work — retry shortly." },
        );
      } else {
        setState({
          kind: "error",
          message:
            err instanceof ApiError
              ? `Guide failed to load: ${err.message}`
              : "Guide failed to load — check the connection.",
        });
      }
    }
  }, [bootstrap]);

  useEffect(() => {
    void load();
  }, [load]);

  // Restore progress
  useEffect(() => {
    if (!bootstrap) return;
    void loadProgress(bootstrap.token).then((progress) => {
      if (progress && state.kind === "ready" && progress.step > 0 && progress.step < state.meta.total_steps) {
        // Only jump when the URL is the bare token root (direct entry)
        if (window.location.pathname === `/guide/${bootstrap.token}`) {
          navigate(`/guide/${bootstrap.token}/step/${progress.step + 1}`, { replace: true });
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrap, state.kind]);

  // Drain the offline flag queue on reconnect
  useEffect(() => {
    if (!online || !bootstrap) return;
    void drainFlags(async (flag) => {
      try {
        await api(`/restoration/projects/${flag.projectId}/flags`, {
          body: flag.body,
          token: bootstrap.token,
        });
        return true;
      } catch {
        return false;
      }
    }).then((n) => {
      if (n > 0) setFlagNotice(`${n} queued flag${n === 1 ? "" : "s"} sent to the shop.`);
    });
  }, [online, bootstrap]);

  // AT-059: supersession HEAD probe — while online, issue a HEAD to the guide
  // URL with cache: 'no-store' to bypass SW + HTTP cache, inspect the
  // X-Guide-Superseded header, and mirror the result to localStorage so the
  // correct banner renders even when the page later loads from cache offline.
  useEffect(() => {
    if (!online || !bootstrap) return;
    const lsKey = `restoration.guide.superseded.${bootstrap.token}`;
    // Restore from localStorage first (covers offline loads).
    try {
      const cached = localStorage.getItem(lsKey);
      if (cached === "true") setSuperseded(true);
    } catch {
      /* private mode */
    }
    let cancelled = false;
    void fetch(window.location.href, { method: "HEAD", cache: "no-store" })
      .then((res) => {
        if (cancelled) return;
        const headerVal = res.headers.get("X-Guide-Superseded");
        const isSuperseded = headerVal === "true" || bootstrap.superseded;
        setSuperseded(isSuperseded);
        try {
          localStorage.setItem(lsKey, String(isSuperseded));
        } catch {
          /* private mode */
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [online, bootstrap]);

  // AT-058: load pending flags count for the "Share pending flags" Plan B button.
  useEffect(() => {
    if (!bootstrap) return;
    void getPendingFlags().then(setPendingFlags);
  }, [bootstrap, flagNotice, online]);

  if (!bootstrap) {
    return (
      <FullScreenNote
        title="Link problem"
        body="This guide link is missing its data block. Ask the shop operator for a fresh link."
      />
    );
  }

  const expired = state.kind === "expired" || (state.kind === "ready" && state.expired === true);

  return (
    <div className="flex min-h-screen flex-col bg-bg">
      {/* Expired banner only when content is still visible (ready+expired).
          When kind==="expired" the FullScreenNote is the sole surface — a
          banner duplicating its message would be redundant. */}
      {state.kind === "ready" && state.expired === true && (
        <div
          role="alert"
          className="border-b border-signal/40 bg-signal/10 px-4 py-3 text-center text-sm text-signal"
          data-testid="expired-banner"
        >
          This guide link has expired. Contact the shop operator to renew.
        </div>
      )}
      {superseded && !expired && !supersededDismissed && (
        <div
          role="status"
          className="flex items-center justify-center gap-3 border-b border-accent/40 bg-accent/10 px-4 py-2 text-sm text-accent"
          data-testid="superseded-banner"
        >
          <span>A newer version of this guide is available. Contact the shop operator for the updated link.</span>
          <button
            type="button"
            className="text-accent/70 hover:text-accent"
            aria-label="Dismiss superseded notice"
            onClick={() => setSupersededDismissed(true)}
          >
            ✕
          </button>
        </div>
      )}
      {!online && (
        <div role="status" className="border-b border-accent/40 bg-accent/10 px-4 py-2 text-center text-sm text-accent">
          Offline — cached steps keep working. Flags queue and send on reconnect.
        </div>
      )}
      {rateLimitedUntil != null && (
        <div
          role="status"
          className="border-b border-accent/40 bg-accent/10 px-4 py-3 text-sm text-accent"
          data-testid="rate-limit-pill"
        >
          <p className="text-center">
            Connection limited — retry in <span className="tnum">{countdown}s</span>. Current step still works.
          </p>
          <p className="mt-1 text-center text-xs text-accent/80">
            Keep working this step. Flags queue and send on reconnect. Preloads resume when the timer clears.
          </p>
        </div>
      )}
      {preloadsResuming && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-3 border-b border-border-subtle px-4 py-2"
          data-testid="preloads-resuming"
        >
          <span className="h-3 w-3 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden="true" />
          <span className="text-xs text-muted">Reconnecting — preloads resuming.</span>
        </div>
      )}
      {flagNotice && (
        <div role="status" className="border-b border-ok/40 bg-ok/10 px-4 py-2 text-center text-sm text-ok">
          {flagNotice}
        </div>
      )}

      <Routes>
        <Route
          path="/:token"
          element={
            <GuideHome
              state={state}
              pendingFlags={pendingFlags}
              onRetry={() => {
                setState({ kind: "loading" });
                void load();
              }}
            />
          }
        />
        <Route
          path="/:token/step/:n"
          element={
            <StepRoute
              state={state}
              token={bootstrap.token}
              speculativeSuspended={rateLimitedUntil != null}
            />
          }
        />
        <Route
          path="/:token/flag"
          element={
            <FlagForm
              projectId={bootstrap.projectId}
              assemblyId={bootstrap.assemblyId}
              token={bootstrap.token}
              online={online}
            />
          }
        />
        <Route
          path="*"
          element={
            <FullScreenNote
              title="Unknown page"
              body="That page is not part of this guide."
              ctaLabel="Back to the guide"
              onCta={() => navigate(`/guide/${bootstrap.token}`)}
            />
          }
        />
      </Routes>
    </div>
  );
}

function GuideHome({
  state,
  pendingFlags,
  onRetry,
}: {
  state: LoadState;
  pendingFlags: QueuedFlag[];
  onRetry: () => void;
}) {
  const params = useParams();
  const navigate = useNavigate();
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  if (state.kind === "loading") {
    return (
      <div className="flex flex-1 flex-col gap-3 p-6" aria-busy="true" aria-label="Loading guide">
        <div className="h-8 w-2/3 animate-pulse rounded-md bg-surface" />
        <div className="h-4 w-1/3 animate-pulse rounded-md bg-surface" />
        <div className="mt-4 h-40 animate-pulse rounded-md bg-surface" />
      </div>
    );
  }
  if (state.kind === "unpublished") {
    return (
      <FullScreenNote
        title="Guide not yet published"
        body="The shop has not published the visual guide for this assembly yet. Check back later, or ask the operator to publish it."
      />
    );
  }
  if (state.kind === "expired") {
    return (
      <FullScreenNote
        title="This guide link has expired"
        body="Contact the shop operator to renew the link. Cached steps from a prior visit may still be readable if the page was loaded before."
      />
    );
  }
  if (state.kind === "error") {
    return (
      <FullScreenNote title="Guide failed to load" body={state.message} ctaLabel="Retry" onCta={onRetry} />
    );
  }
  const meta = state.meta;
  return (
    <div className="page-enter flex flex-1 flex-col gap-4 p-6">
      <div>
        <p className="text-sm text-muted">Bay guide</p>
        <h1 className="mt-1 text-2xl font-semibold">{meta.assembly_name}</h1>
        <p className="mt-1 text-sm text-muted tnum">
          {meta.total_steps} steps
          {meta.total_duration_s != null && ` · about ${Math.round(meta.total_duration_s / 60)} min`}
          {` · bundle v${meta.bundle_version}`}
        </p>
      </div>
      <ol className="flex flex-col">
        {meta.steps.map((s) => (
          <li key={s.step_index}>
            <button
              type="button"
              className="flex w-full items-center gap-3 border-b border-border-subtle py-3 text-left transition-colors duration-150 hover:bg-surface"
              aria-label={`Step ${s.step_index + 1}: ${s.description}${s.safety_warning ? " — has a safety warning" : ""}`}
              onClick={() => navigate(`/guide/${params.token}/step/${s.step_index + 1}`)}
            >
              <span className="tnum w-8 shrink-0 text-center font-mono text-sm text-faint">
                {s.step_index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-base">{s.description}</span>
              {s.safety_warning && (
                <span className="shrink-0 text-signal" aria-label="Safety warning" title={s.safety_warning}>
                  <svg viewBox="0 0 12 12" className="h-3.5 w-3.5" aria-hidden="true">
                    <path d="M6 1.5 11 10H1Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                    <path d="M6 4.6v2.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    <circle cx="6" cy="8.6" r="0.8" fill="currentColor" />
                  </svg>
                </span>
              )}
            </button>
          </li>
        ))}
      </ol>
      {pendingFlags.length > 0 && (
        <div className="rounded-md border border-accent/40 bg-accent/10 p-3" data-testid="pending-flags-share">
          <p className="text-sm font-medium">
            {pendingFlags.length} flag{pendingFlags.length === 1 ? "" : "s"} queued — not yet sent to the shop.
          </p>
          <p className="mt-1 text-xs text-muted">
            If the connection keeps failing, share these manually via SMS or email.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              data-testid="share-pending-flags"
              onClick={() => {
                const lines = pendingFlags.map((f) => {
                  const step = f.body.step_index != null ? `Step ${Number(f.body.step_index) + 1}: ` : "";
                  return `[${new Date(f.queuedAt).toISOString()}] ${step}${f.body.description ?? ""}`;
                });
                const dump = `Restoration Copilot — pending flags (${pendingFlags.length})\n\n${lines.join("\n")}`;
                setShareUrl(`data:text/plain,${encodeURIComponent(dump)}`);
                setShareCopied(false);
              }}
            >
              Generate share text
            </button>
            {shareUrl && (
              <>
                <a
                  href={shareUrl}
                  download="pending-flags.txt"
                  className="btn btn-secondary"
                  data-testid="share-pending-flags-download"
                >
                  Download
                </a>
                <button
                  type="button"
                  className="btn btn-ghost"
                  aria-label={shareCopied ? "Copied" : "Copy text"}
                  onClick={() => {
                    void navigator.clipboard?.writeText(decodeURIComponent(shareUrl.replace(/^data:text\/plain,/, "")));
                    setShareCopied(true);
                  }}
                >
                  {shareCopied ? "Copied" : "Copy text"}
                </button>
              </>
            )}
          </div>
        </div>
      )}
      <div className="mt-auto flex gap-2 pt-4">
        <button
          type="button"
          className="btn btn-primary flex-1"
          onClick={() => navigate(`/guide/${params.token}/step/1`)}
          data-testid="start-guide"
        >
          Start at step 1
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => navigate(`/guide/${params.token}/flag`)}
        >
          Flag a problem
        </button>
      </div>
    </div>
  );
}

function StepRoute({
  state,
  token,
  speculativeSuspended,
}: {
  state: LoadState;
  token: string;
  speculativeSuspended: boolean;
}) {
  const params = useParams();
  const navigate = useNavigate();
  const stepIndex = Math.max(0, (Number(params.n) || 1) - 1);

  useEffect(() => {
    if (state.kind === "ready") {
      if (stepIndex >= state.meta.total_steps) {
        navigate(`/guide/${token}`, { replace: true });
        return;
      }
      void loadProgress(token).then((prev) => {
        const completed = Array.from(new Set([...(prev?.completed ?? []), stepIndex]));
        void saveProgress(token, { step: stepIndex, completed, updatedAt: Date.now() });
      });
    }
  }, [state, stepIndex, token, navigate]);

  if (state.kind === "loading") {
    return (
      <div className="flex flex-1 flex-col gap-3 p-6" aria-busy="true">
        <div className="h-6 w-1/3 animate-pulse rounded-md bg-surface" />
        <div className="h-48 animate-pulse rounded-md bg-surface" />
      </div>
    );
  }
  if (state.kind !== "ready") {
    return (
      <FullScreenNote
        title={
          state.kind === "unpublished"
            ? "Guide not yet published"
            : state.kind === "expired"
              ? "This guide link has expired"
              : "Guide failed to load"
        }
        body={
          state.kind === "unpublished"
            ? "The shop has not published this assembly's guide yet."
            : state.kind === "expired"
              ? "Contact the shop operator to renew the link."
              : state.message
        }
        ctaLabel="Back to the guide"
        onCta={() => navigate(`/guide/${token}`)}
      />
    );
  }
  return (
    <StepView
      key={stepIndex}
      meta={state.meta}
      step={state.meta.steps[stepIndex]}
      token={token}
      speculativeSuspended={speculativeSuspended}
      onNavigate={(next) => navigate(`/guide/${token}/step/${next + 1}`)}
      onFlag={() => navigate(`/guide/${token}/flag`)}
      onHome={() => navigate(`/guide/${token}`)}
    />
  );
}

export function FullScreenNote({
  title,
  body,
  ctaLabel,
  onCta,
}: {
  title: string;
  body: string;
  ctaLabel?: string;
  onCta?: () => void;
}) {
  return (
    <div className="page-enter flex flex-1 flex-col items-start justify-center gap-3 p-8">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-base text-muted">{body}</p>
      {ctaLabel && onCta && (
        <button type="button" className="btn btn-primary" aria-label={ctaLabel} onClick={onCta}>
          {ctaLabel}
        </button>
      )}
    </div>
  );
}
