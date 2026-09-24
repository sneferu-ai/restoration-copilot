// ErrorBanner — names what failed, where, and how to recover (DESIGN.md §8).
// role="alert" for screen readers. Retry is optional but always offered when
// the error is a network/server class.

import { ReactNode } from "react";
import { Icon, ICONS } from "./Icon";
import { Button } from "./Button";

export interface ErrorBannerProps {
  title?: string;
  message: ReactNode;
  retry?: () => void;
  retryLabel?: string;
  retryLoading?: boolean;
  /** When true, the error is shown as an inline notice, not a full banner. */
  inline?: boolean;
}

export function ErrorBanner({ title = "Something went wrong", message, retry, retryLabel = "Retry", retryLoading, inline }: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className={["flex items-start gap-3", inline ? "" : "card"].filter(Boolean).join(" ")}
      style={{
        padding: inline ? undefined : "var(--space-4)",
        borderColor: "var(--status-failed)",
        background: inline ? "var(--status-failed-soft)" : undefined,
      }}
    >
      <span style={{ color: "var(--status-failed)", flexShrink: 0, marginTop: "0.125rem" }} aria-hidden>
        <Icon d={ICONS.alert} width={18} height={18} />
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-fg-primary">{title}</p>
        <p className="text-sm text-fg-secondary" style={{ marginTop: "0.25rem" }}>{message}</p>
      </div>
      {retry && (
        <Button variant="ghost" size="sm" icon={ICONS.refresh} onClick={retry} loading={retryLoading} loadingLabel="Retrying…">
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
