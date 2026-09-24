// U8 — Knowledge & Sources. KB entries (known parts, OEM numbers, notes) and
// source registry (suppliers, trusted/untrusted). The operator's reference library.

import { useState } from "react";
import { useKbEntries, useSources } from "@/shared/hooks";
import { Card } from "@/shared/ui/Card";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { ErrorBanner } from "@/shared/ui/ErrorBanner";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Skeleton } from "@/shared/ui/Skeleton";
import { ICONS } from "@/shared/ui/Icon";

type Tab = "kb" | "sources";

export function KnowledgeBase() {
  const [tab, setTab] = useState<Tab>("kb");
  const kb = useKbEntries();
  const sources = useSources();

  return (
    <div className="flex flex-col gap-6" style={{ padding: "var(--space-6)" }}>
      <header className="flex items-end justify-between gap-4 flex-wrap animate-enter">
        <div>
          <h1 className="lead-rule text-2xl font-semibold tracking-tight">Knowledge & sources</h1>
          <p className="text-sm text-fg-tertiary" style={{ marginTop: "0.25rem" }}>
            The parts knowledge base and source registry used by the sourcing hunt.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant={tab === "kb" ? "primary" : "ghost"} size="sm" icon={ICONS.book} onClick={() => setTab("kb")} aria-pressed={tab === "kb"}>
            Knowledge base
          </Button>
          <Button variant={tab === "sources" ? "primary" : "ghost"} size="sm" icon={ICONS.search} onClick={() => setTab("sources")} aria-pressed={tab === "sources"}>
            Sources
          </Button>
        </div>
      </header>

      {tab === "kb" && (
        <section className="flex flex-col gap-3 animate-enter stagger-1">
          {kb.isLoading && (
            <div className="flex flex-col gap-2" aria-live="polite" aria-busy="true">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} style={{ height: "3.5rem" }} />)}
            </div>
          )}
          {kb.isError && (
            <ErrorBanner message="Couldn't load the knowledge base." retry={() => kb.refetch()} retryLoading={kb.isFetching} />
          )}
          {kb.data && kb.data.length === 0 && (
            <EmptyState icon={ICONS.book} title="No KB entries" description="The knowledge base is empty. KB entries are created when parts are identified and approved." />
          )}
          {kb.data && kb.data.length > 0 && (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <table className="w-full" style={{ borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "0.0625rem solid var(--border-subtle)" }}>
                    <th className="text-xs font-semibold uppercase tracking-wider text-fg-tertiary" style={{ textAlign: "left", padding: "var(--space-3) var(--space-4)", letterSpacing: "0.06em" }}>Part</th>
                    <th className="text-xs font-semibold uppercase tracking-wider text-fg-tertiary" style={{ textAlign: "left", padding: "var(--space-3) var(--space-4)", letterSpacing: "0.06em" }}>Category</th>
                    <th className="text-xs font-semibold uppercase tracking-wider text-fg-tertiary" style={{ textAlign: "left", padding: "var(--space-3) var(--space-4)", letterSpacing: "0.06em" }}>OEM #</th>
                    <th className="text-xs font-semibold uppercase tracking-wider text-fg-tertiary" style={{ textAlign: "right", padding: "var(--space-3) var(--space-4)", letterSpacing: "0.06em" }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {kb.data.map((entry) => (
                    <tr key={entry.part_id} style={{ borderBottom: "0.0625rem solid var(--border-subtle)" }} className="hover:bg-surface-hover transition-colors">
                      <td style={{ padding: "var(--space-3) var(--space-4)" }}>
                        <span className="text-sm font-medium text-fg-primary">{entry.name}</span>
                        <span className="text-xs text-fg-tertiary tnum block">{entry.part_id.slice(0, 8)}</span>
                      </td>
                      <td className="text-sm text-fg-secondary" style={{ padding: "var(--space-3) var(--space-4)" }}>{entry.category}</td>
                      <td className="text-sm text-fg-secondary tnum" style={{ padding: "var(--space-3) var(--space-4)" }}>{entry.oem_number ?? "—"}</td>
                      <td style={{ padding: "var(--space-3) var(--space-4)", textAlign: "right" }}>
                        <Badge
                          hue={entry.approved ? "var(--status-complete)" : "var(--signal-amber)"}
                          soft={entry.approved ? "var(--status-complete-soft)" : "var(--signal-amber-soft)"}
                          label={entry.approved ? "Approved" : "Pending"}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </section>
      )}

      {tab === "sources" && (
        <section className="flex flex-col gap-3 animate-enter stagger-1">
          {sources.isLoading && (
            <div className="flex flex-col gap-2" aria-live="polite" aria-busy="true">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} style={{ height: "3.5rem" }} />)}
            </div>
          )}
          {sources.isError && (
            <ErrorBanner message="Couldn't load the source registry." retry={() => sources.refetch()} retryLoading={sources.isFetching} />
          )}
          {sources.data && sources.data.length === 0 && (
            <EmptyState icon={ICONS.search} title="No sources registered" description="The source registry is empty. Sources are where the sourcing hunt looks for parts." />
          )}
          {sources.data && sources.data.length > 0 && (
            <ul className="flex flex-col gap-2">
              {sources.data.map((source) => (
                <li key={source.source_id}>
                  <Card className="flex items-center gap-3" style={{ padding: "var(--space-3) var(--space-4)" }}>
                    <span className="pip" style={{ background: source.trusted ? "var(--status-complete)" : "var(--signal-amber)", width: "0.5rem", height: "0.5rem", borderRadius: "50%" }} aria-hidden />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-fg-primary truncate">{source.name}</span>
                        <Badge hue="var(--fg-tertiary)" label={source.kind} />
                      </div>
                      {source.notes && <p className="text-xs text-fg-tertiary truncate">{source.notes}</p>}
                    </div>
                    {source.url && (
                      <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:underline">
                        Visit
                      </a>
                    )}
                    <Badge
                      hue={source.trusted ? "var(--status-complete)" : "var(--signal-amber)"}
                      soft={source.trusted ? "var(--status-complete-soft)" : "var(--signal-amber-soft)"}
                      label={source.trusted ? "Trusted" : "Unverified"}
                    />
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
