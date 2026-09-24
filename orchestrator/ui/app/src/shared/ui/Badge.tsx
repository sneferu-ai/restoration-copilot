// Badge + StatusPip — hue + icon + label, never hue alone (DESIGN.md §6, §9).
// StatusPip is the 3px absolute-positioned marker (Linear pattern #1).

import { HTMLAttributes, ReactNode } from "react";
import { Icon } from "./Icon";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  hue?: string;       // CSS var for the pip/text color
  soft?: string;      // CSS var for the soft background
  icon?: string;      // svg path
  label: ReactNode;
}

export function Badge({ hue = "var(--fg-tertiary)", soft, icon, label, className, style, ...rest }: BadgeProps) {
  return (
    <span
      {...rest}
      className={["badge", className].filter(Boolean).join(" ")}
      style={{
        color: hue,
        background: soft ?? "transparent",
        borderColor: soft ? hue : "var(--border-subtle)",
        ...style,
      }}
    >
      {icon && <Icon d={icon} width={11} height={11} />}
      {label}
    </span>
  );
}

export function StatusPip({ color, label }: { color: string; label?: string }) {
  return (
    <span
      className="pip"
      style={{ background: color }}
      aria-hidden
      data-status-label={label}
    />
  );
}
