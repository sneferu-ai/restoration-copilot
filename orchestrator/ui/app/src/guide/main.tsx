// Bay Guide entry point — token-gated PWA for shop-floor access (spec §9).
// Boot: read window.__GUIDE_BOOTSTRAP__, validate with Zod, render guide or
// degraded state. The server embeds the bootstrap JSON via a script tag.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GuideApp } from "./GuideApp";
import "@/styles/global.css";

// The server injects the bootstrap JSON via <script id="guide-bootstrap" type="application/json">.
// We read it here, validate, and pass to GuideApp. On parse/validation failure,
// GuideApp renders a branded degraded state.
function readBootstrap(): unknown {
  const el = document.getElementById("guide-bootstrap");
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent);
  } catch {
    return null;
  }
}

const bootstrap = readBootstrap();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GuideApp bootstrap={bootstrap} />
  </StrictMode>,
);
