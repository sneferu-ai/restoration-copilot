// ToastContainer (OBL-7) — async error notifications, bottom-right stack,
// auto-dismiss 8s, max 5 visible, manual dismiss. GlobalErrorHandler pushes
// window.onerror / unhandledrejection here (D14).

import { useEffect, useState } from "react";

export interface Toast {
  id: number;
  severity: "error" | "warn" | "info";
  message: string;
}

let pushToast: ((t: Omit<Toast, "id">) => void) | null = null;
let nextId = 1;

export function toast(severity: Toast["severity"], message: string): void {
  pushToast?.({ severity, message: message.slice(0, 100) });
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    pushToast = (t) => {
      setToasts((prev) => [...prev.slice(-4), { ...t, id: nextId++ }]);
    };
    return () => {
      pushToast = null;
    };
  }, []);

  useEffect(() => {
    if (!toasts.length) return;
    const timer = setTimeout(() => setToasts((prev) => prev.slice(1)), 8000);
    return () => clearTimeout(timer);
  }, [toasts]);

  return (
    <div className="fixed bottom-4 right-4 z-toast flex w-80 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-start gap-2 rounded-md border-l-2 bg-elevated px-3 py-2 shadow-3 ${
            t.severity === "error" ? "border-signal" : t.severity === "warn" ? "border-accent" : "border-muted"
          }`}
        >
          <p className="min-w-0 flex-1 text-sm">{t.message}</p>
          <button
            type="button"
            aria-label="Dismiss notification"
            className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted hover:bg-surface hover:text-ink"
            onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
          >
            <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}

export function GlobalErrorHandler() {
  useEffect(() => {
    function onError(event: ErrorEvent) {
      toast("error", event.message || "Unexpected error");
    }
    function onRejection(event: PromiseRejectionEvent) {
      const reason = event.reason as { message?: string } | undefined;
      toast("error", reason?.message || "Unexpected async error");
    }
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
