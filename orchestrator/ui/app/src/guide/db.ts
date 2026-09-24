// IndexedDB wrapper for the Bay Guide (spec §9, OBL-35).
// Two stores: guide_state (step position per token) and flag_queue (offline flags).
// Raw IndexedDB API — no `idb` dependency (not in package.json).
// localStorage is the backup for step position (spec §9.2).

const DB_NAME = "rc-guide";
const DB_VERSION = 1;
const STORE_STATE = "guide_state";
const STORE_FLAGS = "flag_queue";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_STATE)) {
        db.createObjectStore(STORE_STATE, { keyPath: "token_id" });
      }
      if (!db.objectStoreNames.contains(STORE_FLAGS)) {
        db.createObjectStore(STORE_FLAGS, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export interface GuideStateRow {
  token_id: string;
  step_index: number;
  bundle_version: number;
  updated_at: string;
}

export interface FlagQueueRow {
  id?: number;
  token: string;
  body: {
    problem_type: string;
    notes: string;
    step_index: number;
    screenshot_data_url?: string | null;
    photo_data_url?: string | null;
    created_at: string;
  };
  sync_status: "pending" | "synced" | "failed";
}

export async function saveStepIndex(
  tokenId: string,
  stepIndex: number,
  bundleVersion: number,
): Promise<void> {
  const row: GuideStateRow = {
    token_id: tokenId,
    step_index: stepIndex,
    bundle_version: bundleVersion,
    updated_at: new Date().toISOString(),
  };
  // localStorage backup (spec §9.2)
  try {
    localStorage.setItem(`rc-guide:${tokenId}:step`, String(stepIndex));
  } catch {
    // localStorage may be unavailable (private mode, quota) — IndexedDB is primary
  }
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_STATE, "readwrite");
      tx.objectStore(STORE_STATE).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // IndexedDB unavailable — localStorage backup already written
  }
}

export async function loadStepIndex(tokenId: string): Promise<number | null> {
  // Try localStorage first (faster, always available in tests)
  try {
    const ls = localStorage.getItem(`rc-guide:${tokenId}:step`);
    if (ls != null) {
      const n = parseInt(ls, 10);
      if (!isNaN(n) && n >= 0) return n;
    }
  } catch {
    // ignore
  }
  try {
    const db = await openDB();
    return await new Promise<number | null>((resolve, reject) => {
      const tx = db.transaction(STORE_STATE, "readonly");
      const req = tx.objectStore(STORE_STATE).get(tokenId);
      req.onsuccess = () => {
        const row = req.result as GuideStateRow | undefined;
        resolve(row?.step_index ?? null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function queueFlag(
  token: string,
  body: FlagQueueRow["body"],
): Promise<void> {
  const row: Omit<FlagQueueRow, "id"> = {
    token,
    body,
    sync_status: "pending",
  };
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_FLAGS, "readwrite");
    tx.objectStore(STORE_FLAGS).add(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPendingFlags(
  token: string,
): Promise<FlagQueueRow[]> {
  try {
    const db = await openDB();
    return await new Promise<FlagQueueRow[]>((resolve, reject) => {
      const tx = db.transaction(STORE_FLAGS, "readonly");
      const req = tx.objectStore(STORE_FLAGS).getAll();
      req.onsuccess = () => {
        const all = (req.result as FlagQueueRow[]) ?? [];
        resolve(all.filter((r) => r.token === token && r.sync_status === "pending"));
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function markFlagSynced(id: number): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_FLAGS, "readwrite");
      const store = tx.objectStore(STORE_FLAGS);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const row = getReq.result as FlagQueueRow | undefined;
        if (row) {
          row.sync_status = "synced";
          store.put(row);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // non-fatal — flag stays pending, will retry next online event
  }
}

export async function countPendingFlags(token: string): Promise<number> {
  const flags = await getPendingFlags(token);
  return flags.length;
}
