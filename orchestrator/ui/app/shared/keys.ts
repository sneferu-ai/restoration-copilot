// Query key factory — tenant ID is always the first element (§16 item 2
// forward path: multi-tenant scoping lands by changing TENANT_ID).

import { TENANT_ID } from "./constants";

export const keys = {
  all: [TENANT_ID] as const,
  health: () => [TENANT_ID, "health"] as const,
  bridgeHealth: () => [TENANT_ID, "bridge-health"] as const,
  projects: (filter?: { state?: string; search?: string }) =>
    [TENANT_ID, "projects", filter ?? {}] as const,
  project: (id: string) => [TENANT_ID, "projects", id] as const,
  manifest: (id: string) => [TENANT_ID, "projects", id, "manifest"] as const,
  reviews: (id: string) => [TENANT_ID, "projects", id, "reviews"] as const,
  sourcing: (id: string) => [TENANT_ID, "projects", id, "sourcing"] as const,
  apiCosts: (id: string) => [TENANT_ID, "projects", id, "api-costs"] as const,
  flags: (id: string) => [TENANT_ID, "projects", id, "flags"] as const,
  task: (taskId: string) => [TENANT_ID, "tasks", taskId] as const,
  sources: () => [TENANT_ID, "sources"] as const,
  ledger: (id: string) => [TENANT_ID, "projects", id, "ledger"] as const,
  kbEntries: (filter?: { make?: string; model?: string; year?: string }) =>
    [TENANT_ID, "kb", filter ?? {}] as const,
};
