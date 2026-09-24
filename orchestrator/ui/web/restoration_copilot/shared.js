// Shared helpers for the Restoration Copilot operator console.
export const SESSION_KEY = "restoration.operatorSession";

export function sessionToken() {
  return localStorage.getItem(SESSION_KEY) || "";
}

export async function api(path, options = {}) {
  const headers = options.headers || {};
  if (sessionToken()) headers["Authorization"] = `Bearer ${sessionToken()}`;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.json);
    delete options.json;
  }
  const res = await fetch(path, { ...options, headers });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const err = new Error((body && body.message) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export function el(tag, attrs = {}, text = "") {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text) node.textContent = text;
  return node;
}

export function updateSessionBar() {
  const bar = document.getElementById("session-state");
  if (bar) bar.textContent = sessionToken() ? "operator signed in" : "not signed in";
}

export function wireLogin() {
  const btn = document.getElementById("login-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const username = window.prompt("Operator username", "operator");
    if (username === null) return;
    const password = window.prompt("Operator password", "");
    if (password === null) return;
    try {
      const res = await fetch("/admin/operator/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || "login failed");
      localStorage.setItem(SESSION_KEY, body.session_token);
      updateSessionBar();
      document.dispatchEvent(new CustomEvent("restoration:login"));
    } catch (err) {
      window.alert(`Sign-in failed: ${err.message}`);
    }
  });
  updateSessionBar();
}

export function wirePanels() {
  const nav = document.getElementById("panel-nav");
  if (!nav) return;
  nav.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-panel]");
    if (!btn) return;
    for (const b of nav.querySelectorAll("button")) b.classList.toggle("active", b === btn);
    for (const panel of document.querySelectorAll(".panel")) {
      panel.classList.toggle("active", panel.id === `panel-${btn.dataset.panel}`);
    }
  });
}

wireLogin();
wirePanels();
