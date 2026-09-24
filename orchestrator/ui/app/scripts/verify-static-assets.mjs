#!/usr/bin/env node
// Post-build static-asset gate (round-5, reviewer P0: brand mark 404).
// Runs automatically after `npm run build` via the package.json "postbuild"
// hook. Fails the build loudly if any contract below is broken:
//
//   1. The launch-frozen brand mark exists in the served asset tree.
//   2. Its bytes are EXACTLY the launch-frozen bytes (BRAND_ASSETS/brand-mark.svg,
//      SHA-256 44a8f432…). Not redrawn, not recolored, not stale.
//   3. The guide service worker exists at its stable un-hashed path
//      (guide/index.html registers /static/restoration/app/guide-sw.js).
//   4. Both entry HTML pages exist (operator console + bay guide).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not import.meta.dirname — README promises Node ≥ 18 and
// import.meta.dirname only exists on ≥ 20.11.
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(appRoot, "../web/static/restoration/app");

const FROZEN_MARK_SHA256 =
  "44a8f4328feaa650064fca55438c31ea17309447d745920fb775032fd0e25e98";

const failures = [];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function mustExist(rel) {
  const p = join(outDir, rel);
  if (!existsSync(p)) {
    failures.push(`missing ${rel} (expected at ${p})`);
    return null;
  }
  return p;
}

// 1 + 2: the mark, present and byte-frozen.
const mark = mustExist("brand-mark.svg");
if (mark) {
  const actual = sha256(mark);
  if (actual !== FROZEN_MARK_SHA256) {
    failures.push(
      `brand-mark.svg SHA-256 ${actual} != launch-frozen ${FROZEN_MARK_SHA256} ` +
        `(copy the exact bytes from BRAND_ASSETS/brand-mark.svg into public/)`,
    );
  }
}

// 3: the service worker at its stable registration path.
mustExist("guide-sw.js");

// 4: both entry pages.
mustExist("operator/index.html");
mustExist("guide/index.html");

if (failures.length > 0) {
  console.error("verify-static-assets: FAILED");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  `verify-static-assets: OK — brand-mark.svg frozen (${FROZEN_MARK_SHA256.slice(0, 8)}…), guide-sw.js, operator/guide entries present in ${outDir}`,
);
