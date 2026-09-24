// Session login contract test (docs-round-4, reviewer blocker: the console
// read `body.token` while the standalone backend returns `session_token` —
// server.py::_login). The login mapper must accept the standalone field,
// keep the legacy host field working, and refuse a token-less 200 loudly.
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionProvider,
  useSession,
  type SessionContextValue,
} from "../shared/session";
import { ApiError } from "../shared/http";

let captured: SessionContextValue | null = null;

function Probe() {
  captured = useSession();
  return null;
}

function mount(): SessionContextValue {
  captured = null;
  render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
  const session = captured as SessionContextValue | null;
  if (!session) throw new Error("session context did not mount");
  return session;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("operator login — backend field contract", () => {
  it("stores the standalone backend's `session_token` field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { session_token: "tok-standalone-123", username: "operator" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const session = mount();

    await act(async () => {
      await session.login("operator", "restoration-dev");
    });

    expect(captured!.token).toBe("tok-standalone-123");
    expect(captured!.isAuthenticated).toBe(true);
    expect(captured!.operator).toBe("operator");
    const stored = JSON.parse(localStorage.getItem("restoration.operatorSession")!);
    expect(stored.token).toBe("tok-standalone-123");
    expect(fetchMock).toHaveBeenCalledWith(
      "/admin/operator/session",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("still accepts the legacy `token` field (Sneferu host surface)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { token: "tok-legacy-456" })),
    );
    const session = mount();

    await act(async () => {
      await session.login("operator", "restoration-dev");
    });

    expect(captured!.token).toBe("tok-legacy-456");
  });

  it("rejects a 200 response carrying neither token field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { username: "operator" })),
    );
    const session = mount();

    await expect(
      act(async () => {
        return session.login("operator", "restoration-dev");
      }),
    ).rejects.toThrow(ApiError);
    // Nothing stored — a token-less login must not persist a session.
    expect(localStorage.getItem("restoration.operatorSession")).toBeNull();
    expect(captured!.isAuthenticated).toBe(false);
  });

  it("surfaces the server message on 401 and stores nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(401, { error: "invalid_credentials", message: "Invalid credentials." }),
      ),
    );
    const session = mount();

    await expect(
      act(async () => {
        return session.login("operator", "wrong");
      }),
    ).rejects.toThrow("Invalid credentials.");
    expect(localStorage.getItem("restoration.operatorSession")).toBeNull();
  });
});
