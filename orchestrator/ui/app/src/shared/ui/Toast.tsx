// Toast system — slides up, role="status" for non-critical / role="alert" for
// errors. Auto-dismiss after 4s (errors stay until dismissed). One queue.

import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { Icon, ICONS } from "./Icon";

type ToastKind = "info" | "success" | "error";
interface Toast {
  id: number;
  kind: ToastKind;
  message: ReactNode;
}

const ToastContext = createContext<{ push: (kind: ToastKind, message: ReactNode) => void } | null>(null);

const KIND_CONFIG: Record<ToastKind, { color: string; icon: string }> = {
  info: { color: "var(--fg-secondary)", icon: ICONS.alert },
  success: { color: "var(--status-complete)", icon: ICONS.check },
  error: { color: "var(--status-failed)", icon: ICONS.alert },
};

let counter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((kind: ToastKind, message: ReactNode) => {
    const id = ++counter;
    setToasts((prev) => [...prev, { id, kind, message }]);
    if (kind !== "error") {
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4000);
    }
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="fixed flex flex-col gap-2"
        style={{ zIndex: "var(--z-toast)", right: "var(--space-4)", bottom: "var(--space-4)", maxWidth: "calc(100vw - 2rem)" }}
      >
        {toasts.map((t) => {
          const cfg = KIND_CONFIG[t.kind];
          return (
            <div
              key={t.id}
              role={t.kind === "error" ? "alert" : "status"}
              className="card flex items-start gap-3 animate-enter"
              style={{ padding: "var(--space-3) var(--space-4)", borderColor: "var(--border-default)", boxShadow: "var(--shadow-3)", minWidth: "20rem" }}
            >
              <span style={{ color: cfg.color, flexShrink: 0, marginTop: "0.0625rem" }} aria-hidden>
                <Icon d={cfg.icon} width={16} height={16} />
              </span>
              <p className="text-sm text-fg-primary flex-1">{t.message}</p>
              <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="btn btn-ghost btn-icon" style={{ flexShrink: 0 }}>
                <Icon d={ICONS.close} width={14} height={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
