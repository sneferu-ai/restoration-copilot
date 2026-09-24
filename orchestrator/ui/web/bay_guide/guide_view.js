// U6 — Bay Guide main logic (Round 1: token shell + step persistence +
// superseded/expired banners + offline indicator wiring). Bundle rendering,
// Service Worker preload, free-explore, glossary, and flag-a-problem land in
// their phases (spec §11 Phase 5).

const root = document.getElementById("guide-root");
const TOKEN = root ? root.dataset.token : "";
const DB_NAME = "restoration_guide";
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("guide_progress")) {
        db.createObjectStore("guide_progress", { keyPath: "token_id" });
      }
      if (!db.objectStoreNames.contains("flag_queue")) {
        db.createObjectStore("flag_queue", { keyPath: "flag_id" });
      }
      if (!db.objectStoreNames.contains("text_scripts")) {
        db.createObjectStore("text_scripts", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadProgress() {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const tx = db.transaction("guide_progress", "readonly");
      const req = tx.objectStore("guide_progress").get(TOKEN);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function saveProgress(stepIndex) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("guide_progress", "readwrite");
      tx.objectStore("guide_progress").put({
        token_id: TOKEN,
        step_index: stepIndex,
        timestamp: new Date().toISOString(),
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* IndexedDB unavailable — progress simply won't persist */
  }
}

// Superseded banner: dismissible but reappears on next load (FR-040).
if (document.documentElement.dataset || true) {
  const banner = document.getElementById("superseded-banner");
  // The server sets X-Guide-Superseded on the HTML response; the module
  // also re-checks via fetch headers so mixed cached/online content works.
  fetch(window.location.href, { method: "HEAD" })
    .then((res) => {
      if (res.headers.get("X-Guide-Superseded") === "true" && banner) banner.hidden = false;
    })
    .catch(() => {});
  const dismiss = document.getElementById("superseded-dismiss");
  if (dismiss && banner) dismiss.addEventListener("click", () => (banner.hidden = true));
}

// Offline indicator (FR-046).
function updateOnline() {
  const el = document.getElementById("offline-indicator");
  if (el) el.hidden = navigator.onLine;
}
window.addEventListener("online", updateOnline);
window.addEventListener("offline", updateOnline);
updateOnline();

// Step navigation (persisted per token — FR-032).
let stepIndex = 0;
const stepCurrent = document.getElementById("step-current");
async function setStep(i) {
  stepIndex = Math.max(0, i);
  if (stepCurrent) stepCurrent.textContent = String(stepIndex);
  await saveProgress(stepIndex);
}
const next = document.getElementById("btn-next");
const back = document.getElementById("btn-back");
if (next) next.addEventListener("click", () => setStep(stepIndex + 1));
if (back) back.addEventListener("click", () => setStep(stepIndex - 1));

loadProgress().then((saved) => {
  if (saved && Number.isInteger(saved.step_index)) setStep(saved.step_index);
});

export { openDb, loadProgress, saveProgress };
