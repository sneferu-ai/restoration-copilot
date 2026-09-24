// Error boundary — shared contract (spec §4.7). Sync render errors land here;
// async errors ride window.onerror / unhandledrejection via GlobalErrorHandler.
// Telemetry POST (REP-9) is attempted; console.error + localStorage fallback.

import React from "react";

interface Props {
  children: React.ReactNode;
  panelName: string;
  fallback?: React.ReactNode;
  onError?: (error: Error) => void;
  resetKeys?: unknown[];
}

interface State {
  error: Error | null;
}

export function reportTelemetry(payload: Record<string, unknown>): void {
  try {
    void fetch("/restoration/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => undefined); // REP-9 pending — silent until it lands
  } catch {
    /* never throw from telemetry */
  }
  try {
    const log = JSON.parse(localStorage.getItem("restoration.errorLog") ?? "[]") as unknown[];
    log.push({ ...payload, at: new Date().toISOString() });
    localStorage.setItem("restoration.errorLog", JSON.stringify(log.slice(-50)));
  } catch {
    /* private mode */
  }
  // eslint-disable-next-line no-console
  console.error("[restoration]", payload);
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    reportTelemetry({
      kind: "sync",
      panel: this.props.panelName,
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
    this.props.onError?.(error);
  }

  componentDidUpdate(prev: Props): void {
    if (
      this.state.error &&
      this.props.resetKeys &&
      prev.resetKeys &&
      this.props.resetKeys.some((k, i) => k !== prev.resetKeys?.[i])
    ) {
      this.setState({ error: null });
    }
  }

  render(): React.ReactNode {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          role="alert"
          className="rounded-md border border-signal/40 bg-signal/10 px-4 py-3 text-sm"
        >
          <p className="font-semibold">{this.props.panelName} failed to render.</p>
          <p className="mt-1 text-muted">{this.state.error.message}</p>
          <button
            type="button"
            className="mt-2 inline-flex h-touch items-center rounded-md bg-elevated px-3 text-sm font-medium hover:bg-surface"
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
