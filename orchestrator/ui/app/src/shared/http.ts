// Shared HTTP client for the Restoration Copilot operator console.
// All network calls resolve to routes registered in App._register_routes
// today (BACKEND_MANIFEST.md / server.py route table). No invented endpoints.

import { SessionContextValue } from "./session";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export interface ApiOptions {
  method?: string;
  json?: unknown;
  signal?: AbortSignal;
  token?: string;
}

export function createApi(getToken: () => string) {
  async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
    const headers: Record<string, string> = {};
    const token = options.token ?? getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const isFormData = typeof FormData !== "undefined" && options.json instanceof FormData;
    if (options.json !== undefined && !isFormData) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(path, {
      method: options.method ?? "GET",
      headers,
      body: options.json !== undefined ? (isFormData ? (options.json as FormData) : JSON.stringify(options.json)) : undefined,
      signal: options.signal,
    });
    let body: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      if (body && typeof body === "object" && "message" in body) {
        message = String((body as { message: unknown }).message);
      } else if (typeof body === "string" && body) {
        message = body;
      }
      throw new ApiError(message, res.status, body);
    }
    return body as T;
  }
  return api;
}

export type Api = ReturnType<typeof createApi>;

// React-Query-friendly helper that re-throws ApiError with status for 401 handling.
export function withAuth(api: Api, session: Pick<SessionContextValue, "token" | "logout">) {
  return async <T,>(path: string, options?: ApiOptions): Promise<T> => {
    try {
      return await api<T>(path, { ...options, token: session.token });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        session.logout();
      }
      throw err;
    }
  };
}
