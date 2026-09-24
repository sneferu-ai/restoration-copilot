// Console IndexedDB — U4 wallet-desk session ledger (§6.4, §16 item 8).
// Mirrors purchase records the operator posts so they survive F5 refresh
// before REP-4 GET endpoints exist. The server's actual_spend_usd is ALWAYS
// authoritative (AC-UI-011, OBL-19); this store is the honest "Local records"
// half of the side-by-side display. Best-effort: private mode / quota failure
// degrades to an empty ledger, never throws.

import { openDB, type IDBPDatabase } from "idb";
import type { LedgerEntry } from "./types";

interface ConsoleDB extends IDBPDatabase {}

let dbPromise: Promise<ConsoleDB> | null = null;

function db(): Promise<ConsoleDB> {
  if (!dbPromise) {
    dbPromise = openDB("rc-console", 1, {
      upgrade(d) {
        // keyPath id so puts are idempotent across re-mirrors.
        d.createObjectStore("purchases", { keyPath: "id" });
      },
    }) as Promise<ConsoleDB>;
  }
  return dbPromise;
}

export async function savePurchase(entry: LedgerEntry): Promise<void> {
  try {
    await (await db()).put("purchases", entry);
  } catch {
    /* quota / private mode — ledger is best-effort */
  }
}

export async function loadPurchases(projectId: string): Promise<LedgerEntry[]> {
  try {
    const all = (await (await db()).getAll("purchases")) as LedgerEntry[];
    return all
      .filter((e) => e.project_id === projectId)
      .sort((a, b) => a.recorded_at - b.recorded_at);
  } catch {
    return [];
  }
}

export async function clearPurchases(projectId: string): Promise<void> {
  try {
    const store = (await db()).transaction("purchases", "readwrite").store;
    const all = (await store.getAll()) as LedgerEntry[];
    for (const e of all) {
      if (e.project_id === projectId) await store.delete(e.id);
    }
  } catch {
    /* best-effort */
  }
}
