// ConsoleShell — fixed top bar (brand mark + title, primary nav, session
// pill), OfflineBanner (OBL-1), ToastContainer (OBL-7), skip link, ProtectedRoute
// session gate, cross-panel wallet-override navigation (OBL-8).

import { useEffect } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { getSessionToken } from "@shared/api-client";
import {
  ReadOnlyProvider,
  useOfflineState,
  useReadOnly,
} from "@shared/hooks";
import { GlobalErrorHandler, ToastContainer } from "@shared/toast";
import { ErrorBoundary } from "@shared/error-boundary";

function OfflineBanner() {
  const isOffline = useOfflineState();
  const readOnly = useReadOnly();
  if (!isOffline && !readOnly) return null;
  return (
    <div
      role="status"
      className="border-b border-accent/40 bg-accent/10 px-4 py-1.5 text-center text-sm text-accent"
      data-testid="offline-banner"
    >
      {isOffline
        ? "Offline – viewing data only. Actions require a network connection."
        : "Read-only — this platform is not fully supported. Mutations are disabled."}
    </div>
  );
}

function SessionPill() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="inline-flex h-8 items-center gap-2 rounded-pill border border-border-default bg-surface px-3 text-xs text-muted transition-colors duration-150 hover:border-border-strong hover:text-ink"
      onClick={() => navigate("/login")}
      title="Signed in as operator. Manage session."
    >
      <span className="h-1.5 w-1.5 rounded-pill bg-ok" aria-hidden="true" />
      operator
    </button>
  );
}

export function ConsoleShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const authed = Boolean(getSessionToken());

  useEffect(() => {
    if (!authed) {
      try {
        sessionStorage.setItem(
          "restoration.intendedRoute",
          location.pathname + location.search,
        );
      } catch {
        /* ignore */
      }
      navigate("/login", { replace: true });
    }
  }, [authed, location.pathname, location.search, navigate]);

  // OBL-8: any panel can ask to jump to the wallet override form.
  useEffect(() => {
    function onWalletOverride(e: Event) {
      const detail = (e as CustomEvent<{ projectId?: string }>).detail;
      if (detail?.projectId) {
        window.location.hash = `#/jobs/${detail.projectId}/budget#override`;
      }
    }
    window.addEventListener("rc:navigate-to-wallet-override", onWalletOverride);
    return () => window.removeEventListener("rc:navigate-to-wallet-override", onWalletOverride);
  }, []);

  if (!authed) return null;

  return (
    <ReadOnlyProvider>
      <div className="flex min-h-screen flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:z-sticky focus:bg-elevated focus:px-4 focus:py-2"
        >
          Skip to content
        </a>
        <header className="sticky top-0 z-sticky border-b border-border-subtle bg-surface">
          <div className="mx-auto flex h-14 max-w-layout-max items-center gap-4 px-4">
            <NavLink to="/jobs" className="flex items-center gap-2.5" aria-label="Restoration Copilot home">
              <img
                src="/static/restoration/app/brand-mark.svg"
                alt=""
                className="h-6 w-6"
                data-testid="brand-mark"
              />
              <span className="text-base font-semibold tracking-tight">Restoration Copilot</span>
            </NavLink>
            <nav className="flex items-center gap-1" aria-label="Primary">
              {[
                { to: "/jobs", label: "Jobs" },
                { to: "/insights", label: "Insights" },
              ].map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-150 ${
                      isActive ? "bg-elevated text-ink" : "text-muted hover:text-ink"
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-3">
              <SessionPill />
            </div>
          </div>
          <OfflineBanner />
        </header>
        <main id="main" className="mx-auto w-full max-w-layout-max flex-1 px-4 py-4">
          <ErrorBoundary panelName="Console">
            <Outlet />
          </ErrorBoundary>
        </main>
        <GlobalErrorHandler />
        <ToastContainer />
      </div>
    </ReadOnlyProvider>
  );
}
