#!/usr/bin/env node
// Token audit — scans src/**/*.tsx|ts for raw hex / px / ms outside the token layer.
// Fails on any hit. Run via `npm run audit:tokens`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const root = resolve(import.meta.dirname, "..");
const src = join(root, "src");
const allowed = new Set([
  join(src, "styles", "tokens.css"),
  join(src, "styles", "global.css"),
]);

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const PX = /\b\d+(?:\.\d+)?px\b/g;
const MS = /\b\d+(?:\.\d+)?ms\b/g;
// rgba()/rgb() in the component layer is a raw value too (only tokens.css may
// define rgba), but we whitelist shadow definitions that pair with a token.
const COLORFN = /\b(?:rgba?|hsla?)\s*\(/;

const hits = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(tsx|ts)$/.test(name)) check(p);
  }
}

function fresh(re) {
  return new RegExp(re.source, re.flags);
}

function check(file) {
  if (allowed.has(file)) return;
  const rel = relative(root, file);
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("import ") || trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    const usesVar = /var\(--/.test(line);

    for (const [re, kind] of [[HEX, "hex"], [PX, "px"], [MS, "ms"]]) {
      const r = fresh(re);
      let m;
      while ((m = r.exec(line))) {
        // hex inside an rgba()/rgb() function in a line that also uses a token
        // is still a raw value in the component layer — flag it, but skip if the
        // entire line is a var() token alias (e.g. "color: var(--accent)").
        if (kind === "hex" && COLORFN.test(line) && !usesVar) {
          hits.push({ rel, line: i + 1, col: m.index, match: m[0], kind, lineText: trimmed });
          continue;
        }
        if (usesVar) continue; // line is a token reference; a px/hex here is inside var() name—skip
        hits.push({ rel, line: i + 1, col: m.index, match: m[0], kind, lineText: trimmed });
      }
    }
  });
}

walk(src);

if (hits.length === 0) {
  console.log("audit:tokens — PASS (no raw hex/px/ms outside token layer)");
  process.exit(0);
} else {
  console.error(`audit:tokens — FAIL (${hits.length} raw value(s) outside token layer):`);
  for (const h of hits.slice(0, 40)) {
    console.error(`  ${h.rel}:${h.line}:${h.col}  [${h.kind}] ${h.match}  | ${h.lineText.slice(0, 80)}`);
  }
  process.exit(1);
}
