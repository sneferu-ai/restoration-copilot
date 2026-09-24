// Button primitive — four variants (primary/secondary/ghost/danger), six states.
// Uses the .btn component classes from global.css. Visual size ≠ hit zone:
// btn-sm is 32px visual but the btn class gives 44px hit zone via padding.

import { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon } from "./Icon";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "default" | "sm";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  loadingLabel?: string;
  icon?: string;
  iconRight?: string;
  /** Disabled reason — rendered as title + inline aria-describedby helper. */
  disabledReason?: string;
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "default",
  loading = false,
  loadingLabel = "Submitting…",
  icon,
  iconRight,
  disabledReason,
  disabled,
  children,
  className,
  ...rest
}: ButtonProps) {
  const variantClass = `btn-${variant}`;
  const sizeClass = size === "sm" ? "btn-sm" : "";
  const isDisabled = disabled || loading;
  const helperId = disabledReason ? `${rest.id ?? "btn"}-helper` : undefined;

  return (
    <>
      <button
        {...rest}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        aria-describedby={isDisabled && disabledReason ? helperId : undefined}
        className={["btn", variantClass, sizeClass, className].filter(Boolean).join(" ")}
        title={disabledReason || rest.title}
      >
        {loading ? (
          <>
            <span
              className="inline-block animate-spin"
              style={{ width: "var(--space-3)", height: "var(--space-3)" }}
              aria-hidden
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} width="100%" height="100%">
                <path d="M21 12a9 9 0 1 1-6.2-8.6" strokeLinecap="round" />
              </svg>
            </span>
            <span>{loadingLabel}</span>
          </>
        ) : (
          <>
            {icon && <Icon d={icon} />}
            {children && <span>{children}</span>}
            {iconRight && <Icon d={iconRight} />}
          </>
        )}
      </button>
      {disabledReason && isDisabled && (
        <span id={helperId} className="sr-only">
          {disabledReason}
        </span>
      )}
    </>
  );
}
