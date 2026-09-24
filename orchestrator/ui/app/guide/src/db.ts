// Guide IndexedDB — per-token step progress + offline flag queue (§7.3).

import { openDB, type IDBPDatabase } from "idb";

interface GuideDB extends IDBPDatabase {}

let dbPromise: Promise<GuideDB> | null = null;

function db(): Promise<GuideDB> {
  if (!dbPromise) {
    dbPromise = openDB("rc-guide", 1, {
      upgrade(d) {
        d.createObjectStore("progress"); // key: token → { step, completed[], updatedAt }
        d.createObjectStore("flagQueue", { keyPath: "id", autoIncrement: true });
      },
    }) as Promise<GuideDB>;
  }
  return dbPromise;
}

export interface GuideProgress {
  step: number;
  completed: number[];
  updatedAt: number;
  textMode?: boolean; // OBL-6: text-only mode toggle, persisted per-token
}

export async function loadProgress(token: string): Promise<GuideProgress | null> {
  try {
    return ((await (await db()).get("progress", token)) as GuideProgress | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function saveProgress(token: string, progress: GuideProgress): Promise<void> {
  try {
    await (await db()).put("progress", progress, token);
  } catch {
    /* quota or private mode — progress is best-effort */
  }
}

export interface QueuedFlag {
  id?: number;
  projectId: string;
  token: string;
  body: Record<string, unknown>;
  queuedAt: number;
}

export async function queueFlag(flag: Omit<QueuedFlag, "id" | "queuedAt">): Promise<void> {
  await (await db()).add("flagQueue", { ...flag, queuedAt: Date.now() });
}

export async function getPendingFlags(): Promise<QueuedFlag[]> {
  try {
    return ((await (await db()).getAll("flagQueue")) as QueuedFlag[]) ?? [];
  } catch {
    return [];
  }
}

export async function drainFlags(
  poster: (flag: QueuedFlag) => Promise<boolean>,
): Promise<number> {
  const store = (await db()).transaction("flagQueue", "readwrite").store;
  const all = (await store.getAll()) as QueuedFlag[];
  let drained = 0;
  for (const flag of all) {
    try {
      if (await poster(flag)) {
        if (flag.id != null) await store.delete(flag.id);
        drained += 1;
      }
    } catch {
      /* stays queued */
    }
  }
  return drained;
}
