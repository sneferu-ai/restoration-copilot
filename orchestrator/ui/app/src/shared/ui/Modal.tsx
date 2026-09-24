// Modal — role="dialog" + aria-labelledby + focus trap + focus restore + Esc
// + click-outside (DESIGN.md §6, a11y floor). 480px wide, backdrop blur.

import { ReactNode, useCallback, useEffect, useRef, CSSProperties } from "react";
import { Icon, ICONS } from "./Icon";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** When true, Esc/click-outside are disabled (e.g. during a submit). */
  blocking?: boolean;
  /** Override the panel width / max-width. */
  style?: CSSProperties;
}

export function Modal({ open, onClose, title, description, children, footer, blocking, style }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const trap = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && !blocking) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose, blocking],
  );

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement;
    document.addEventListener("keydown", trap);
    document.body.style.overflow = "hidden";
    // Focus first focusable in the panel after paint.
    const t = window.setTimeout(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      first?.focus();
    }, 0);
    return () => {
      document.removeEventListener("keydown", trap);
      document.body.style.overflow = "";
      window.clearTimeout(t);
      restoreRef.current?.focus();
    };
  }, [open, trap]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: "var(--z-modal-bg)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !blocking) onClose();
      }}
    >
      <div
        className="absolute inset-0"
        style={{ background: "var(--overlay-scrim)", backdropFilter: "blur(var(--blur-modal)) saturate(180%)" }}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        aria-describedby={description ? "modal-desc" : undefined}
        className="card relative animate-enter"
        style={{
          zIndex: "var(--z-modal)",
          width: "min(30rem, calc(100vw - 2rem))",
          maxHeight: "calc(100vh - 4rem)",
          overflow: "auto",
          borderColor: "var(--border-default)",
          boxShadow: "var(--shadow-3)",
          borderRadius: "var(--radius-xl)",
          ...style,
        }}
      >
        <div className="flex items-start justify-between gap-4" style={{ padding: "var(--space-5) var(--space-5) var(--space-3)" }}>
          <div className="min-w-0">
            <h2 id="modal-title" className="text-lg font-semibold text-fg-primary" style={{ margin: 0 }}>
              {title}
            </h2>
            {description && (
              <p id="modal-desc" className="text-sm text-fg-tertiary" style={{ marginTop: "0.25rem" }}>
                {description}
              </p>
            )}
          </div>
          {!blocking && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="btn btn-ghost btn-icon"
              style={{ flexShrink: 0 }}
            >
              <Icon d={ICONS.close} />
            </button>
          )}
        </div>
        <div style={{ padding: "0 var(--space-5) var(--space-5)" }}>{children}</div>
        {footer && (
          <div
            className="flex items-center justify-end gap-2"
            style={{ padding: "var(--space-3) var(--space-5) var(--space-5)", borderTop: "0.0625rem solid var(--border-subtle)" }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
