// AppShell — the operator console frame: skip link, top bar (brand mark +
// title + session bar), left nav spine (desktop) / bottom bar (narrow),
// main outlet. One primary nav per screen, keyboard path matches visual order.

import { NavLink, Outlet, useNavigate, useSearchParams } from "react-router-dom";
import { useEffect, useState, FormEvent } from "react";
import { useSession } from "@/shared/session";
import { useProjects } from "@/shared/hooks";
import { Icon, ICONS } from "@/shared/ui/Icon";
import { datetime } from "@/shared/format";

interface NavItem {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: "/", label: "Jobs", icon: ICONS.clipboard, end: true },
  { to: "/insights", label: "Insights", icon: ICONS.bolt },
  { to: "/engine-room", label: "Engine room", icon: ICONS.cog },
  { to: "/knowledge", label: "Knowledge & sources", icon: ICONS.book },
];

const SESSION_WARN_MS = 5 * 60 * 1000;
const OFFLINE_POLL_MS = 30 * 1000;

export function AppShell() {
  const { operator, expiresAt, logout, isAuthenticated } = useSession();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [globalSearch, setGlobalSearch] = useState(searchParams.get("q") ?? "");

  // Pending-changes indicator: count of jobs needing operator attention.
  const projectsQuery = useProjects();
  const pendingCount = (projectsQuery.data ?? []).filter((j) => j.needs_attention).length;

  function onGlobalSearch(e: FormEvent) {
    e.preventDefault();
    navigate(globalSearch.trim() ? `/?q=${encodeURIComponent(globalSearch.trim())}` : "/");
  }

  function onLogout() {
    logout();
    navigate("/");
  }

  // C-17: amber banner five minutes before expires_at; expired → clear session.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  const expiryMs = expiresAt ? Date.parse(expiresAt) : NaN;
  const expiringSoon = Number.isFinite(expiryMs) && expiryMs - now <= SESSION_WARN_MS && expiryMs - now > 0;
  const expired = Number.isFinite(expiryMs) && expiryMs - now <= 0;

  // Offline indicator (spec §8.0 top bar: "offline status").
  const [online, setOnline] = useState(() => (typeof navigator !== "undefined" ? navigator.onLine : true));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const id = setInterval(() => setOnline(navigator.onLine), OFFLINE_POLL_MS);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); clearInterval(id); };
  }, []);

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only"
        style={{
          position: "fixed",
          top: "var(--space-2)",
          left: "var(--space-2)",
          zIndex: "var(--z-cmd)",
          padding: "var(--space-2) var(--space-3)",
          background: "var(--bg-elevated)",
          border: "0.0625rem solid var(--border-default)",
          borderRadius: "var(--radius-md)",
        }}
      >
        Skip to content
      </a>

      <header
        className="sticky top-0 flex items-center gap-4"
        style={{
          zIndex: "var(--z-sticky)",
          height: "var(--space-12)",
          padding: "0 var(--space-4) 0 var(--space-5)",
          background: "var(--bg-elevated)",
          borderBottom: "0.0625rem solid var(--border-subtle)",
        }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <img
            src="/static/restoration/app/brand-mark.svg"
            alt=""
            width={24}
            height={24}
            aria-hidden
            style={{ filter: "var(--drop-shadow-mark)" }}
          />
          <span className="text-base font-semibold tracking-tight truncate">Restoration Copilot</span>
        </div>

        <nav aria-label="Primary" className="hidden md:flex items-center gap-1" style={{ marginLeft: "var(--space-4)" }}>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                [
                  "btn btn-ghost btn-sm",
                  isActive && "!text-fg-primary",
                ].filter(Boolean).join(" ")
              }
              style={({ isActive }) =>
                isActive
                  ? { background: "var(--accent-soft)", color: "var(--accent)", boxShadow: "inset 0 -0.125rem 0 var(--accent)" }
                  : undefined
              }
            >
              <Icon d={item.icon} width={15} height={15} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* Global search (spec §8.0 top bar: "global search") — desktop only */}
        <form onSubmit={onGlobalSearch} className="hidden md:flex items-center gap-2" style={{ marginLeft: "var(--space-3)" }} role="search">
          <div className="relative flex items-center">
            <span className="absolute" style={{ left: "var(--space-2)", color: "var(--fg-tertiary)", pointerEvents: "none" }} aria-hidden>
              <Icon d={ICONS.search} width={14} height={14} />
            </span>
            <input
              type="search"
              className="input"
              style={{ paddingLeft: "var(--space-8)", width: "14rem", height: "2.25rem" }}
              placeholder="Search jobs…"
              aria-label="Search all jobs by vehicle or project ID"
              value={globalSearch}
              onChange={(e) => setGlobalSearch(e.target.value)}
            />
          </div>
        </form>

        <div className="flex-1" />

        <div className="flex items-center gap-3">
          {!online && (
            <span
              className="flex items-center gap-1 text-xs text-fg-tertiary"
              role="status"
              title="You're offline. Polling is paused; in-flight tasks continue on the backend."
            >
              <Icon d={ICONS.bolt} width={12} height={12} />
              <span className="hidden sm:inline">Offline</span>
            </span>
          )}
          {isAuthenticated && pendingCount > 0 && (
            <button
              type="button"
              onClick={() => navigate("/")}
              className="flex items-center gap-1 text-xs"
              style={{ color: "var(--signal-amber)", background: "var(--signal-amber-soft)", border: "0.0625rem solid var(--signal-amber)", borderRadius: "var(--radius-sm)", padding: "0.125rem var(--space-2)" }}
              title={`${pendingCount} job${pendingCount > 1 ? "s" : ""} need attention`}
              aria-label={`${pendingCount} jobs need attention. Go to job board.`}
            >
              <Icon d={ICONS.alert} width={12} height={12} />
              <span className="tnum">{pendingCount}</span>
            </button>
          )}
          {isAuthenticated && operator && (
            <span className="hidden sm:flex items-center gap-2 text-xs text-fg-tertiary tnum" title={expiresAt ? `Session expires ${datetime(expiresAt)}` : undefined}>
              <Icon d={ICONS.key} width={12} height={12} />
              {operator}
            </span>
          )}
          <button
            type="button"
            onClick={onLogout}
            className="btn btn-ghost btn-sm"
            aria-label="Sign out"
            title="Sign out"
          >
            <Icon d={ICONS.logout} width={15} height={15} />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </header>

      {/* C-17 session-expiry banner */}
      {(expiringSoon || expired) && (
        <div
          role="alert"
          aria-live="assertive"
          className="flex items-center gap-3"
          style={{
            padding: "var(--space-2) var(--space-5)",
            background: "var(--signal-amber-soft)",
            borderBottom: "0.0625rem solid var(--signal-amber)",
            color: "var(--signal-amber)",
          }}
        >
          <Icon d={ICONS.alert} width={16} height={16} />
          <span className="text-sm font-medium">
            {expired
              ? "Your session expired. Re-authenticate to re-attach to running tasks."
              : `Session expires in ${Math.max(1, Math.round((expiryMs - now) / 60000))} min — save your work and re-authenticate soon.`}
          </span>
          {expired && (
            <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }} onClick={onLogout}>
              Re-authenticate
            </button>
          )}
        </div>
      )}

      <main id="main-content" className="flex-1 min-w-0" tabIndex={-1}>
        <Outlet />
      </main>

      {/* Bottom bar — narrow screens (tablet portrait / phone) */}
      <nav
        aria-label="Primary"
        className="md:hidden sticky bottom-0 flex items-stretch"
        style={{ zIndex: "var(--z-sticky)", background: "var(--bg-elevated)", borderTop: "0.0625rem solid var(--border-subtle)" }}
      >
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className="flex flex-1 flex-col items-center gap-1"
            style={({ isActive }) => ({
              padding: "var(--space-2) 0",
              color: isActive ? "var(--accent)" : "var(--fg-tertiary)",
              borderTop: isActive ? "0.125rem solid var(--accent)" : "0.125rem solid transparent",
            })}
          >
            <Icon d={item.icon} width={18} height={18} />
            <span className="text-xs">{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
