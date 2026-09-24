// Glossary — #/glossary and #/explore views (spec §9.3).
// Glossary: all terms from bundle_meta. Explore: tier-aware placeholder.

import { useMemo, useState } from "react";
import type { BundleMeta } from "./types";
import { Icon, ICONS } from "@/shared/ui/Icon";
import { EmptyState } from "@/shared/ui/EmptyState";

interface GlossaryProps {
  bundle: BundleMeta;
  mode: "glossary" | "explore";
}

export function Glossary({ bundle, mode }: GlossaryProps) {
  const [search, setSearch] = useState("");

  const terms = useMemo(() => {
    const entries = Object.entries(bundle.glossary).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    if (!search) return entries;
    const q = search.toLowerCase();
    return entries.filter(
      ([term, def]) =>
        term.toLowerCase().includes(q) || def.toLowerCase().includes(q),
    );
  }, [bundle.glossary, search]);

  if (mode === "explore") {
    return (
      <div className="guide-explore">
        <h1 className="text-lg font-semibold text-fg-primary" style={{ padding: "var(--space-4) var(--space-4) 0" }}>
          Explore
        </h1>
        {bundle.tier === "T1" || bundle.tier === "T2" ? (
          <div className="guide-explore-placeholder">
            <Icon d={ICONS.layers} width={32} height={32} />
            <p className="text-sm text-fg-tertiary">
              3D model exploration is available on this assembly. The interactive viewer loads on supported devices.
            </p>
          </div>
        ) : bundle.glb_paths.length > 0 ? (
          <div className="guide-explore-placeholder">
            <Icon d={ICONS.layers} width={32} height={32} />
            <p className="text-sm text-fg-tertiary">
              This assembly has 3D models. The interactive viewer loads on supported devices.
            </p>
          </div>
        ) : (
          <div style={{ padding: "var(--space-4)" }}>
            <EmptyState
              icon={ICONS.layers}
              title="No 3D model for this assembly"
              description="This guide is text and 2D diagrams only. Use the Steps tab to navigate the procedure."
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="guide-glossary">
      <h1 className="text-lg font-semibold text-fg-primary" style={{ padding: "var(--space-4) var(--space-4) 0" }}>
        Glossary
      </h1>

      {/* Search */}
      <div className="guide-glossary-search" style={{ padding: "var(--space-3) var(--space-4)" }}>
        <div className="guide-search-row">
          <Icon d={ICONS.search} width={16} height={16} />
          <input
            type="search"
            className="input"
            placeholder="Search terms…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search glossary terms"
          />
        </div>
      </div>

      {/* Terms */}
      {terms.length === 0 ? (
        <div style={{ padding: "var(--space-4)" }}>
          {Object.keys(bundle.glossary).length === 0 ? (
            <EmptyState
              icon={ICONS.book}
              title="No glossary terms"
              description="This assembly doesn't have glossary definitions. Ask your operator to add them."
            />
          ) : (
            <EmptyState
              icon={ICONS.search}
              title="No matches"
              description={`No terms match "${search}". Try a different search.`}
            />
          )}
        </div>
      ) : (
        <dl className="guide-glossary-list">
          {terms.map(([term, def]) => (
            <div key={term} className="guide-glossary-entry">
              <dt className="text-sm font-medium text-fg-primary">{term}</dt>
              <dd className="text-sm text-fg-tertiary">{def}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
