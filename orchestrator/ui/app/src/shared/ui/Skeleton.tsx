// Skeleton — the loading state when the layout is known (DESIGN.md §7).
// Uses the .skeleton shimmer from global.css. Each variant matches a real
// layout shape so the page doesn't jump when data arrives.

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={["skeleton", className].filter(Boolean).join(" ")} style={style} aria-hidden />;
}

export function JobCardSkeleton() {
  return (
    <div
      className="card relative overflow-hidden"
      style={{ height: "3.5rem", padding: "var(--space-3) var(--space-4)" }}
      aria-hidden
    >
      <Skeleton style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "0.1875rem", borderRadius: 0 }} />
      <div className="flex items-center gap-4 h-full">
        <Skeleton style={{ width: "12rem", height: "0.875rem" }} />
        <Skeleton style={{ width: "4rem", height: "0.75rem" }} />
        <div className="flex-1" />
        <Skeleton style={{ width: "5rem", height: "0.75rem" }} />
        <Skeleton style={{ width: "6rem", height: "0.75rem" }} />
      </div>
    </div>
  );
}

export function RowSkeleton({ columns }: { columns: number }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3" style={{ height: "3.5rem" }} aria-hidden>
      {Array.from({ length: columns }).map((_, i) => (
        <Skeleton key={i} style={{ flex: i === 0 ? "1 1 40%" : "1 1 0", height: "0.875rem" }} />
      ))}
    </div>
  );
}
