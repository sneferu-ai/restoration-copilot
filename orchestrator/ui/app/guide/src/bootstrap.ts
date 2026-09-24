// Guide bootstrap (SP-1) — the server injects window.__RC_GUIDE__ per request.

import type { GuideBootstrap } from "@shared/types";

declare global {
  interface Window {
    __RC_GUIDE__?: GuideBootstrap;
  }
}

export function getBootstrap(): GuideBootstrap | null {
  const b = window.__RC_GUIDE__;
  if (!b || !b.token || !b.projectId || !b.assemblyId) return null;
  return b;
}
