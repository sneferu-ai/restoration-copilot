// Session context — reads the operator token from localStorage, exposes
// login()/logout()/isAuthenticated/expiresAt (spec §7.6).
// Login calls POST /admin/operator/session. 401 anywhere clears the session.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from "react";
import { ApiError } from "./http";

const SESSION_KEY = "restoration.operatorSession";

interface StoredSession {
  token: string;
  expires_at: string | null;
  operator: string | null;
}

export interface SessionContextValue {
  token: string;
  isAuthenticated: boolean;
  expiresAt: string | null;
  operator: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function readStored(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed.token) return null;
    if (parsed.expires_at && new Date(parsed.expires_at).getTime() < Date.now()) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<StoredSession | null>(() => readStored());

  const logout = useCallback(() => {
    localStorage.removeItem(SESSION_KEY);
    setStored(null);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await fetch("/admin/operator/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body?.message) message = String(body.message);
      } catch {
        /* ignore */
      }
      throw new ApiError(message, res.status, null);
    }
    // The backend contract (docs/API.md, tests/restoration/conftest.py) answers
    // {"session_token", "username"}. Reading `token` left every login
    // unauthenticated; `token`/`operator` stay accepted for older hosts.
    const body = (await res.json()) as {
      session_token?: string;
      token?: string;
      username?: string | null;
      expires_at?: string | null;
      operator?: string | null;
    };
    const token = body.session_token ?? body.token ?? "";
    if (!token) throw new ApiError("Sign-in response carried no session token", res.status, null);
    const next: StoredSession = {
      token,
      expires_at: body.expires_at ?? null,
      operator: body.operator ?? body.username ?? username,
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    setStored(next);
  }, []);

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === SESSION_KEY) setStored(readStored());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      token: stored?.token ?? "",
      isAuthenticated: Boolean(stored?.token),
      expiresAt: stored?.expires_at ?? null,
      operator: stored?.operator ?? null,
      login,
      logout,
    }),
    [stored, login, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}
