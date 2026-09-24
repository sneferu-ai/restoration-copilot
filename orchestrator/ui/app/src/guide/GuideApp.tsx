// GuideApp — the Bay Guide root component (spec §9).
// Validates the S-6 bootstrap, fetches the bundle (S-10), handles token states
// (404/410/429/superseded), and routes between #/now, #/explore, #/glossary.
// Mobile-first, offline-capable, accessible.

import { useCallback, useEffect, useState } from "react";
import { HashRouter, Routes, Route, Navigate, NavLink } from "react-router-dom";
import { GuideBootstrapSchema, BundleMetaSchema } from "./types";
import type { GuideBootstrap, BundleMeta } from "./types";
import { StepPlayer } from "./StepPlayer";
import { Glossary } from "./Glossary";
import { FlagModal } from "./FlagModal";
import { Icon, ICONS } from "@/shared/ui/Icon";
import { submitGuideFlag } from "@/shared/hooks";
import { countPendingFlags, getPendingFlags, markFlagSynced } from "./db";

interface GuideAppProps {
  bootstrap: unknown;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; bundle: BundleMeta; superseded: boolean }
  | { kind: "error"; status: number | null; message: string }
  | { kind: "degraded"; message: string };

// ── Bootstrap validation gate ──

function parseBootstrap(raw: unknown): GuideBootstrap | null {
  const result = GuideBootstrapSchema.safeParse(raw);
  if (!result.success) return null;
  return result.data;
}

// ── Token extraction ──

function extractToken(): string | null {
  // /guide/{token} — pathname segments
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts.length >= 2 && parts[0] === "guide") return parts[1]!;
  return null;
}

// ── Vehicle title ──

function vehicleTitle(v: { year: number; make: string; model: string }): string {
  return `${v.year} ${v.make} ${v.model}`;
}

export function GuideApp({ bootstrap }: GuideAppProps) {
  const bs = parseBootstrap(bootstrap);
  const token = extractToken();

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [online, setOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const [flagModalOpen, setFlagModalOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);

  // ── Bundle fetch ──
  const fetchBundle = useCallback(
    async (signal?: AbortSignal) => {
      if (!bs || !token) return;
      try {
        const res = await fetch(`/guide/${token}/bundle`, { signal });
        if (res.status === 404) {
          setState({ kind: "error", status: 404, message: "Token not found or revoked." });
          return;
        }
        if (res.status === 410) {
          // Expired — cached bundle may still be readable
          setState({ kind: "error", status: 410, message: "This guide link has expired. The content is locked but still readable." });
          return;
        }
        if (res.status === 429) {
          setState({ kind: "error", status: 429, message: "Too many requests. Please wait a moment and try again." });
          return;
        }
        if (!res.ok) {
          setState({ kind: "error", status: res.status, message: `Loading error (HTTP ${res.status}). Contact your shop operator.` });
          return;
        }
        const raw = await res.json();
        const parsed = BundleMetaSchema.safeParse(raw);
        if (!parsed.success) {
          setState({ kind: "degraded", message: "The guide data is malformed. Contact your shop operator." });
          return;
        }
        const superseded = res.headers.get("X-Guide-Superseded") === "true";
        setState({ kind: "ready", bundle: parsed.data, superseded });
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        const isOffline = !navigator.onLine;
        if (isOffline) {
          setState({
            kind: "error",
            status: null,
            message: "You're offline. Cached content may be available — try reloading.",
          });
        } else {
          setState({
            kind: "error",
            status: null,
            message: "Couldn't reach the server. Check your connection or contact your shop operator.",
          });
        }
      }
    },
    [bs, token],
  );

  useEffect(() => {
    if (!bs || !token) return;
    const controller = new AbortController();
    fetchBundle(controller.signal);
    return () => controller.abort();
  }, [bs, token, fetchBundle, refreshKey]);

  // ── Online/offline tracking ──
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // ── Pending flag count ──
  useEffect(() => {
    if (!token) return;
    countPendingFlags(token).then(setPendingCount);
  }, [token, flagModalOpen, online]);

  // ── Replay queued flags on reconnect (OBL-35) ──
  useEffect(() => {
    if (!online || !token) return;
    let cancelled = false;
    (async () => {
      const pending = await getPendingFlags(token);
      if (cancelled || pending.length === 0) return;
      for (const row of pending) {
        if (cancelled || row.id == null) continue;
        try {
          await submitGuideFlag(token, row.body);
          await markFlagSynced(row.id);
        } catch {
          // stays pending — will retry next online event
          break;
        }
      }
      if (!cancelled) {
        countPendingFlags(token).then(setPendingCount);
      }
    })();
    return () => { cancelled = true; };
  }, [online, token]);

  // ── Bootstrap invalid ──
  if (!bs || !token) {
    return (
      <div className="guide-shell">
        <div className="guide-degraded">
          <div className="guide-degraded-mark" aria-hidden>
            <Icon d={ICONS.alert} width={32} height={32} />
          </div>
          <h1 className="text-lg font-semibold text-fg-primary">Guide unavailable</h1>
          <p className="text-sm text-fg-tertiary">
            This guide link is missing its boot data. Scan a new QR code from your shop operator.
          </p>
        </div>
      </div>
    );
  }

  const title = vehicleTitle(bs.vehicle_meta);

  // ── Loading ──
  if (state.kind === "loading") {
    return (
      <div className="guide-shell">
        <header className="guide-header">
          <p className="text-sm text-fg-tertiary">{title}</p>
          <div className="guide-skeleton-line" style={{ width: "60%" }} />
          <div className="guide-skeleton-line" style={{ width: "40%" }} />
        </header>
        <div className="guide-loading-body" aria-live="polite" aria-busy="true">
          <div className="guide-skeleton-block" />
          <div className="guide-skeleton-line" style={{ width: "80%" }} />
          <div className="guide-skeleton-line" style={{ width: "65%" }} />
        </div>
      </div>
    );
  }

  // ── Error (non-revoked) ──
  if (state.kind === "error") {
    const isRevoked = state.status === 404;
    const isExpired = state.status === 410;
    const isRateLimit = state.status === 429;
    return (
      <div className="guide-shell">
        <header className="guide-header">
          <p className="text-sm text-fg-tertiary">{title}</p>
        </header>
        <div className="guide-degraded">
          <div className="guide-degraded-mark" aria-hidden>
            <Icon
              d={isRevoked ? ICONS.alert : isRateLimit ? ICONS.clock : ICONS.alert}
              width={32}
              height={32}
            />
          </div>
          <h1 className="text-lg font-semibold text-fg-primary">
            {isRevoked ? "Token not found" : isExpired ? "Guide expired" : isRateLimit ? "Slow down" : "Loading error"}
          </h1>
          <p className="text-sm text-fg-tertiary">{state.message}</p>
          {!isRevoked && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setState({ kind: "loading" });
                setRefreshKey((k) => k + 1);
              }}
              style={{ marginTop: "var(--space-4)" }}
            >
              Try again
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Degraded (malformed data) ──
  if (state.kind === "degraded") {
    return (
      <div className="guide-shell">
        <header className="guide-header">
          <p className="text-sm text-fg-tertiary">{title}</p>
        </header>
        <div className="guide-degraded">
          <div className="guide-degraded-mark" aria-hidden>
            <Icon d={ICONS.alert} width={32} height={32} />
          </div>
          <h1 className="text-lg font-semibold text-fg-primary">Guide data error</h1>
          <p className="text-sm text-fg-tertiary">{state.message}</p>
        </div>
      </div>
    );
  }

  // ── Ready ──
  const { bundle, superseded } = state;

  return (
    <GuideRouter
      bundle={bundle}
      token={token}
      title={title}
      online={online}
      superseded={superseded}
      pendingCount={pendingCount}
      flagModalOpen={flagModalOpen}
      onOpenFlag={() => setFlagModalOpen(true)}
      onCloseFlag={() => setFlagModalOpen(false)}
      onFlagQueued={() => countPendingFlags(token).then(setPendingCount)}
    />
  );
}

// ── Router shell ──

interface GuideRouterProps {
  bundle: BundleMeta;
  token: string;
  title: string;
  online: boolean;
  superseded: boolean;
  pendingCount: number;
  flagModalOpen: boolean;
  onOpenFlag: () => void;
  onCloseFlag: () => void;
  onFlagQueued: () => void;
}

function GuideRouter(props: GuideRouterProps) {
  const { bundle, token, title, online, superseded, pendingCount, flagModalOpen, onOpenFlag, onCloseFlag, onFlagQueued } = props;
  const [supersededDismissed, setSupersededDismissed] = useState(false);

  return (
    <HashRouter>
      <div className="guide-shell">
        {/* Header */}
        <header className="guide-header" role="banner">
          <div className="guide-header-row">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-fg-tertiary uppercase tracking-wider" style={{ letterSpacing: "0.04em" }}>
                {title}
              </p>
              <p className="text-sm font-medium text-fg-primary">
                {bundle.step_count} {bundle.step_count === 1 ? "step" : "steps"}
              </p>
            </div>
            {/* Offline indicator */}
            <span
              className={`guide-offline-badge ${online ? "" : "is-offline"}`}
              role="status"
              aria-label={online ? "Online" : "Offline — cached content"}
            >
              <span className="guide-offline-dot" aria-hidden />
              {online ? "Online" : "Offline"}
            </span>
          </div>
          {/* Superseded banner */}
          {superseded && !supersededDismissed && (
            <div className="guide-superseded-banner" role="alert">
              <span className="text-xs text-fg-secondary">
                A newer version of this guide is available.
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setSupersededDismissed(true)}
                aria-label="Dismiss superseded banner"
              >
                <Icon d={ICONS.close} width={14} height={14} />
              </button>
            </div>
          )}
        </header>

        {/* Routes */}
        <main className="guide-main" role="main">
          <Routes>
            <Route path="/" element={<Navigate to="/now" replace />} />
            <Route
              path="/now"
              element={
                <StepPlayer
                  bundle={bundle}
                  token={token}
                  onOpenFlag={onOpenFlag}
                />
              }
            />
            <Route
              path="/explore"
              element={<Glossary bundle={bundle} mode="explore" />}
            />
            <Route
              path="/glossary"
              element={<Glossary bundle={bundle} mode="glossary" />}
            />
            <Route path="*" element={<Navigate to="/now" replace />} />
          </Routes>
        </main>

        {/* Bottom navigation */}
        <nav className="guide-bottom-nav" role="navigation" aria-label="Guide sections">
          <NavLink to="/now" className="guide-nav-link" aria-label="Steps">
            <Icon d={ICONS.play} width={20} height={20} />
            <span>Steps</span>
          </NavLink>
          <NavLink to="/explore" className="guide-nav-link" aria-label="Explore">
            <Icon d={ICONS.layers} width={20} height={20} />
            <span>Explore</span>
          </NavLink>
          <NavLink to="/glossary" className="guide-nav-link" aria-label="Glossary">
            <Icon d={ICONS.book} width={20} height={20} />
            <span>Glossary</span>
          </NavLink>
          <button
            type="button"
            className="guide-nav-link guide-flag-btn"
            onClick={onOpenFlag}
            aria-label={`Flag a problem${pendingCount > 0 ? `, ${pendingCount} pending` : ""}`}
          >
            <Icon d={ICONS.alert} width={20} height={20} />
            <span>Flag{pendingCount > 0 ? ` (${pendingCount})` : ""}</span>
          </button>
        </nav>

        {/* Flag modal */}
        {flagModalOpen && (
          <FlagModal
            bundle={bundle}
            token={token}
            onClose={onCloseFlag}
            onQueued={onFlagQueued}
          />
        )}
      </div>
    </HashRouter>
  );
}
