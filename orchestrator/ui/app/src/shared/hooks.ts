// React-Query hooks bound to the session token. 401 clears the session (spec §7.6).
// All queries/mutations resolve to routes in App._register_routes (server.py).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { ApiError, createApi, withAuth } from "./http";
import { useSession } from "./session";
import type {
  RestorationProject,
  CreateProjectInput,
  BridgeHealth,
  RestorationHealth,
  ManifestEntry,
  SourcingSummary,
  Flag,
  GuideToken,
  ApiCostSummary,
  KbEntry,
  Source,
  SessionInfo,
  AssemblySummary,
  ManualAssemblyResponse,
  ManualAssemblyStep,
  BundleMeta,
  CapabilityState,
  CapabilityKey,
} from "./api-types";

type Authed = <T>(path: string, opts?: { method?: string; json?: unknown; signal?: AbortSignal }) => Promise<T>;

function useAuthed(): Authed {
  const session = useSession();
  const api = useMemo(() => createApi(() => session.token), [session.token]);
  return useMemo<Authed>(() => withAuth(api, session) as Authed, [api, session]);
}

export function useProjects(filters: { state?: string; search?: string } = {}) {
  const authed = useAuthed();
  const params = new URLSearchParams();
  if (filters.state) params.set("state", filters.state);
  if (filters.search) params.set("search", filters.search);
  const qs = params.toString();
  return useQuery<RestorationProject[]>({
    queryKey: ["projects", filters],
    queryFn: ({ signal }) => authed(`/restoration/projects${qs ? `?${qs}` : ""}`, { signal }),
  });
}

export function useProject(projectId: string | undefined) {
  const authed = useAuthed();
  return useQuery<RestorationProject>({
    queryKey: ["project", projectId],
    queryFn: ({ signal }) => authed(`/restoration/projects/${projectId}`, { signal }),
    enabled: Boolean(projectId),
  });
}

export function useCreateProject() {
  const authed = useAuthed();
  const qc = useQueryClient();
  return useMutation<RestorationProject, ApiError, CreateProjectInput>({
    mutationFn: (input) => authed(`/restoration/projects`, { method: "POST", json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

export function useManifest(projectId: string | undefined) {
  const authed = useAuthed();
  return useQuery<{ entries: ManifestEntry[] }>({
    queryKey: ["manifest", projectId],
    queryFn: ({ signal }) => authed(`/restoration/projects/${projectId}/manifest`, { signal }),
    enabled: Boolean(projectId),
  });
}

export function useSourcing(projectId: string | undefined) {
  const authed = useAuthed();
  return useQuery<SourcingSummary>({
    queryKey: ["sourcing", projectId],
    queryFn: ({ signal }) => authed(`/restoration/projects/${projectId}/sourcing`, { signal }),
    enabled: Boolean(projectId),
  });
}

export function useFlags(projectId: string | undefined) {
  const authed = useAuthed();
  return useQuery<Flag[]>({
    queryKey: ["flags", projectId],
    queryFn: ({ signal }) => authed(`/restoration/projects/${projectId}/flags`, { signal }),
    enabled: Boolean(projectId),
  });
}

export function useTokens(projectId: string | undefined) {
  const authed = useAuthed();
  return useQuery<GuideToken[]>({
    queryKey: ["tokens", projectId],
    queryFn: ({ signal }) => authed(`/restoration/projects/${projectId}/tokens`, { signal }),
    enabled: Boolean(projectId),
  });
}

export function useApiCosts(projectId: string | undefined) {
  const authed = useAuthed();
  return useQuery<ApiCostSummary>({
    queryKey: ["api-costs", projectId],
    queryFn: ({ signal }) => authed(`/restoration/projects/${projectId}/api-costs`, { signal }),
    enabled: Boolean(projectId),
  });
}

export function useBridgeHealth() {
  const authed = useAuthed();
  return useQuery<BridgeHealth>({
    queryKey: ["bridge-health"],
    queryFn: ({ signal }) => authed(`/bridge/health`, { signal }),
    refetchInterval: 30_000,
  });
}

export function useRestorationHealth() {
  const authed = useAuthed();
  return useQuery<RestorationHealth>({
    queryKey: ["restoration-health"],
    queryFn: ({ signal }) => authed(`/restoration/health`, { signal }),
    refetchInterval: 30_000,
  });
}

export function useKbEntries() {
  const authed = useAuthed();
  return useQuery<KbEntry[]>({ queryKey: ["kb-entries"], queryFn: ({ signal }) => authed(`/restoration/kb/entries`, { signal }) });
}

export function useSources() {
  const authed = useAuthed();
  return useQuery<Source[]>({ queryKey: ["sources"], queryFn: ({ signal }) => authed(`/restoration/sources`, { signal }) });
}

export function useSessionInfo() {
  const session = useSession();
  const api = useMemo(() => createApi(() => session.token), [session.token]);
  return useQuery<SessionInfo>({
    queryKey: ["session-info"],
    queryFn: ({ signal }) => api<SessionInfo>(`/admin/operator/session`, { signal }),
  });
}

// ── U5 Model Shop ──

export function useAssemblies(projectId: string | undefined) {
  const authed = useAuthed();
  return useQuery<AssemblySummary[]>({
    queryKey: ["assemblies", projectId],
    queryFn: ({ signal }) => authed(`/restoration/projects/${projectId}/assemblies`, { signal }),
    enabled: Boolean(projectId),
  });
}

export function useCreateManualAssembly(projectId: string | undefined) {
  const authed = useAuthed();
  const qc = useQueryClient();
  return useMutation<ManualAssemblyResponse, ApiError, { name: string; steps: ManualAssemblyStep[] }>({
    mutationFn: ({ name, steps }) => {
      // Multipart/form-data with a `steps` JSON field (spec §8.5 OBL-24).
      const fd = new FormData();
      fd.append("name", name);
      fd.append("steps", new Blob([JSON.stringify(steps)], { type: "application/json" }), "steps.json");
      return authed(`/restoration/projects/${projectId}/assemblies/manual`, { method: "POST", json: fd });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["assemblies", projectId] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });
}

export function useMintToken(projectId: string | undefined) {
  const authed = useAuthed();
  const qc = useQueryClient();
  return useMutation<GuideToken, ApiError, { assembly_id: string; expires_in_days?: number }>({
    mutationFn: (input) => authed(`/restoration/projects/${projectId}/tokens`, { method: "POST", json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tokens", projectId] }),
  });
}

export function useRevokeToken(projectId: string | undefined) {
  const authed = useAuthed();
  const qc = useQueryClient();
  return useMutation<{ ok: true }, ApiError, string>({
    mutationFn: (tokenId) => authed(`/restoration/projects/${projectId}/tokens/${tokenId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tokens", projectId] }),
  });
}

export function useBulkRevokeTokens(projectId: string | undefined) {
  const authed = useAuthed();
  const qc = useQueryClient();
  return useMutation<{ ok: true }, ApiError, void>({
    mutationFn: () => authed(`/restoration/projects/${projectId}/tokens`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tokens", projectId] }),
  });
}

export function useExtendToken(projectId: string | undefined) {
  const authed = useAuthed();
  const qc = useQueryClient();
  return useMutation<GuideToken, ApiError, { tokenId: string; days: number }>({
    mutationFn: ({ tokenId, days }) =>
      authed(`/restoration/projects/${projectId}/tokens/${tokenId}/extend`, { method: "POST", json: { days } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tokens", projectId] }),
  });
}

// ── U3 Parts Manifest: review queue + lock ──

export function useReviews(projectId: string | undefined) {
  const authed = useAuthed();
  return useQuery<ManifestEntry[]>({
    queryKey: ["reviews", projectId],
    queryFn: ({ signal }) => authed(`/restoration/projects/${projectId}/reviews`, { signal }),
    enabled: Boolean(projectId),
  });
}

export function useResolveManifestEntry(projectId: string | undefined) {
  const authed = useAuthed();
  const qc = useQueryClient();
  return useMutation<
    ManifestEntry,
    ApiError,
    { partId: string; fields: Partial<Pick<ManifestEntry, "name" | "oem_number" | "quantity" | "criticality" | "estimated_cost_usd">> }
  >({
    mutationFn: ({ partId, fields }) =>
      authed(`/restoration/projects/${projectId}/manifest/resolve`, { method: "POST", json: { part_id: partId, ...fields } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["manifest", projectId] });
      qc.invalidateQueries({ queryKey: ["reviews", projectId] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });
}

export function useLockManifest(projectId: string | undefined) {
  const authed = useAuthed();
  const qc = useQueryClient();
  return useMutation<{ ok: true }, ApiError, void>({
    mutationFn: () => authed(`/restoration/projects/${projectId}/manifest/lock`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["manifest", projectId] });
      qc.invalidateQueries({ queryKey: ["reviews", projectId] });
    },
  });
}

// ── Flags (operator-scoped resolve, used by U5 flag review) ──

export function useResolveFlag(projectId: string | undefined) {
  const authed = useAuthed();
  const qc = useQueryClient();
  return useMutation<{ ok: true }, ApiError, { flagId: string; resolutionNotes: string }>({
    mutationFn: ({ flagId, resolutionNotes }) =>
      authed(`/restoration/projects/${projectId}/flags/${flagId}/resolve`, {
        method: "POST",
        json: { resolution_notes: resolutionNotes },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["flags", projectId] }),
  });
}

// ── Capability manifest (spec §5.2) ──
// The server-supplied manifest (in /restoration/health `capabilities`) is
// authoritative when present. This hook returns a normalized map; a missing
// key resolves to "unknown" so gated UI degrades safely.

export function useCapabilities(): Record<CapabilityKey, CapabilityState> {
  const health = useRestorationHealth();
  const caps = health.data?.capabilities ?? {};
  return caps as Record<CapabilityKey, CapabilityState>;
}

// ── Guide bundle (S-10) — unauthenticated, token-scoped ──

export async function fetchGuideBundle(token: string, signal?: AbortSignal): Promise<BundleMeta> {
  const res = await fetch(`/guide/${token}/bundle`, { signal });
  if (!res.ok) {
    const err = new Error(`Bundle fetch failed (HTTP ${res.status})`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<BundleMeta>;
}

export async function submitGuideFlag(token: string, body: unknown, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`/guide/${token}/flags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const err = new Error(`Flag submission failed (HTTP ${res.status})`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
}
