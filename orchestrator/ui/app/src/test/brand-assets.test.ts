// Brand-asset contract tests (round-5, reviewer P0: brand mark 404'd at runtime).
//
// The launch-frozen brand mark must reach the served asset tree byte-exact.
// These tests pin the SOURCE side of that contract without needing a build;
// scripts/verify-static-assets.mjs (npm postbuild) pins the BUILT side.
/// <reference types="node" />
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// fileURLToPath, not import.meta.dirname — README promises Node ≥ 18.
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const worktreeRoot = resolve(appRoot, "../../..");

const FROZEN_MARK_SHA256 =
  "44a8f4328feaa650064fca55438c31ea17309447d745920fb775032fd0e25e98";
const SERVED_MARK_URL = "/static/restoration/app/brand-mark.svg";
const SERVED_SW_URL = "/static/restoration/app/guide-sw.js";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("brand mark — launch-frozen identity", () => {
  it("public/brand-mark.svg is byte-identical to BRAND_ASSETS/brand-mark.svg", () => {
    const source = resolve(appRoot, "public/brand-mark.svg");
    const frozen = resolve(worktreeRoot, "BRAND_ASSETS/brand-mark.svg");
    expect(existsSync(source), "public/brand-mark.svg must exist").toBe(true);
    expect(existsSync(frozen), "BRAND_ASSETS/brand-mark.svg must exist").toBe(true);
    expect(sha256(source)).toBe(sha256(frozen));
  });

  it("public/brand-mark.svg matches the launch-frozen SHA-256 exactly", () => {
    // BRAND_IDENTITY froze the selected mark at 44a8f432… — not redrawn,
    // not recolored, not swapped. A deliberate re-brand updates this digest
    // and BRAND_ASSETS together.
    const source = resolve(appRoot, "public/brand-mark.svg");
    expect(sha256(source)).toBe(FROZEN_MARK_SHA256);
  });

  it("every consumer references the exact served URL", () => {
    const consumers = [
      "src/operator/index.html", // favicon
      "src/operator/AppShell.tsx", // console top bar, 24×24
      "src/operator/LoginScreen.tsx", // login screen, 48×48
    ];
    for (const rel of consumers) {
      const text = readFileSync(resolve(appRoot, rel), "utf-8");
      expect(text, `${rel} must reference ${SERVED_MARK_URL}`).toContain(
        SERVED_MARK_URL,
      );
    }
  });

  it("no shadow src/public dir exists (the round-4 root cause)", () => {
    // vite root is src/; a src/public dir would be Vite's DEFAULT publicDir and
    // silently replace the real one if the explicit publicDir pin were lost.
    expect(existsSync(resolve(appRoot, "src/public"))).toBe(false);
  });
});

describe("guide service worker — stable un-hashed path", () => {
  it("public/guide-sw.js exists and the guide registers its served URL", () => {
    expect(existsSync(resolve(appRoot, "public/guide-sw.js"))).toBe(true);
    const guideHtml = readFileSync(
      resolve(appRoot, "src/guide/index.html"),
      "utf-8",
    );
    expect(guideHtml).toContain(SERVED_SW_URL);
  });
});
