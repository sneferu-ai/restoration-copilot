// API client — Bearer session, §3.4 error envelope, 401 intended-route
// preservation (OBL-28), non-JSON error bodies truncated to 500 chars.

import { INTENDED_ROUTE_KEY, SESSION_KEY } from "./constants";
import type { ApiErrorBody } from "./types";

export class ApiError extends Error {
  status: number;
  code: string;
  fieldErrors?: { field: string; message: string }[];
  missingItems?: string[];
  rawBody?: string;
  retryAfter?: number;

  constructor(status: number, code: string, message: string, extras?: Partial<ApiError>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    Object.assign(this, extras);
  }
}

export function getSessionToken(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode — session is per-tab memory only */
  }
}

function handleUnauthorized(): void {
  // Console-only behavior: preserve the route, drop the session, go to login.
  if (window.location.pathname.startsWith("/guide/")) return;
  try {
    const current = window.location.hash.replace(/^#/, "") || "/jobs";
    if (!current.startsWith("/login")) sessionStorage.setItem(INTENDED_ROUTE_KEY, current);
  } catch {
    /* ignore */
  }
  setSessionToken(null);
  if (!window.location.hash.startsWith("#/login")) window.location.hash = "#/login";
}

async function parseError(res: Response): Promise<ApiError> {
  const retryAfterHeader = res.headers.get("Retry-After");
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;
  const text = await res.text();
  try {
    const body = JSON.parse(text) as ApiErrorBody;
    return new ApiError(res.status, body.error || "error", body.message || res.statusText, {
      fieldErrors: body.field_errors,
      missingItems: body.missing_items,
      rawBody: text.length > 500 ? text.slice(0, 500) : text,
      retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
    });
  } catch {
    return new ApiError(res.status, "error", text.slice(0, 500) || res.statusText, {
      rawBody: text.slice(0, 500),
      retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
    });
  }
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  formData?: FormData;
  token?: string | null; // override (guide uses its own token)
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = options.token !== undefined ? options.token : getSessionToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (options.formData) {
    body = options.formData; // browser sets multipart boundary
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method: options.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      signal: options.signal,
    });
  } catch (err) {
    throw new ApiError(0, "network_error", "Network request failed — check the connection.", {
      rawBody: String(err),
    });
  }
  if (res.status === 401) {
    handleUnauthorized();
    throw await parseError(res);
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

// Guide asset fetch — Bearer header + blob URL (D11: media elements cannot
// set headers, so all guide assets arrive via fetch and render as blob URLs).
export async function fetchAssetBlob(path: string, token: string): Promise<string> {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw await parseError(res);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
