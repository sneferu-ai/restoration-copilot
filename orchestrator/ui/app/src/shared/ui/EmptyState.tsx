// EmptyState — tells the operator what to do NEXT, not what is missing
// (DESIGN.md §8, SOUL ¶3 anti-default "Welcome back, Mike").

import { ReactNode } from "react";
import { Icon } from "./Icon";

export interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={["flex flex-col items-center justify-center text-center gap-3", className].filter(Boolean).join(" ")}
      style={{ padding: "var(--space-12) var(--space-6)" }}
      role="status"
    >
      {icon && (
        <div
          className="flex items-center justify-center rounded-lg"
          style={{
            width: "var(--space-10)",
            height: "var(--space-10)",
            background: "var(--bg-elevated)",
            border: "0.0625rem solid var(--border-subtle)",
            color: "var(--fg-tertiary)",
          }}
          aria-hidden
        >
          <Icon d={icon} width={24} height={24} />
        </div>
      )}
      <h3 className="text-lg font-semibold text-fg-primary" style={{ margin: 0 }}>
        {title}
      </h3>
      {description && <p className="text-sm text-fg-tertiary" style={{ maxWidth: "32rem", margin: 0 }}>{description}</p>}
      {action && <div style={{ marginTop: "var(--space-2)" }}>{action}</div>}
    </div>
  );
}
