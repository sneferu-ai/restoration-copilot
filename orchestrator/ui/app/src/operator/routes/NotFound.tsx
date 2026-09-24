// 404 — honest not-found with a path back home.

import { Link } from "react-router-dom";
import { Button } from "@/shared/ui/Button";
import { Icon, ICONS } from "@/shared/ui/Icon";

export function NotFound() {
  return (
    <div
      className="flex flex-col items-center justify-center text-center gap-4"
      style={{ padding: "var(--space-20) var(--space-6)", minHeight: "60vh" }}
    >
      <div
        className="flex items-center justify-center rounded-lg"
        style={{
          width: "var(--space-12)",
          height: "var(--space-12)",
          background: "var(--bg-elevated)",
          border: "0.0625rem solid var(--border-subtle)",
          color: "var(--fg-tertiary)",
        }}
        aria-hidden
      >
        <Icon d={ICONS.search} width={28} height={28} />
      </div>
      <div>
        <h1 className="text-xl font-semibold text-fg-primary">Page not found</h1>
        <p className="text-sm text-fg-tertiary" style={{ marginTop: "0.25rem" }}>
          The page you're looking for doesn't exist or may have moved.
        </p>
      </div>
      <Link to="/">
        <Button variant="primary" iconRight={ICONS.chevronRight}>
          Back to jobs
        </Button>
      </Link>
    </div>
  );
}
