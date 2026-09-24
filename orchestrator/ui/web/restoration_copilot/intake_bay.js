// U2 — Intake Bay: create a job, push photo sets + parts lists, seal intake.
import { api, el } from "./shared.js";

let currentJob = null;

const createForm = document.getElementById("create-job-form");
const uploadForm = document.getElementById("upload-form");

if (createForm) {
  createForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(createForm);
    try {
      const res = await api("/restoration/projects", {
        method: "POST",
        json: {
          vehicle_meta: {
            year: data.get("year") || null,
            make: data.get("make") || null,
            model: data.get("model") || null,
            trim: data.get("trim") || null,
          },
        },
      });
      currentJob = res.project_id;
      if (uploadForm) {
        uploadForm.hidden = false;
        const ref = document.getElementById("upload-job-ref");
        if (ref) ref.textContent = ` — job ${currentJob}`;
      }
      document.dispatchEvent(new CustomEvent("restoration:job-created"));
    } catch (err) {
      window.alert(`Create failed: ${err.message}`);
    }
  });
}

if (uploadForm) {
  uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!currentJob) return;
    const data = new FormData();
    const photos = uploadForm.querySelector('input[name="photos"]').files;
    const parts = uploadForm.querySelector('input[name="parts_list"]').files;
    for (const file of photos) data.append("photos", file);
    if (parts.length) data.append("parts_list", parts[0]);
    const res = await fetch(`/restoration/projects/${currentJob}/intake`, {
      method: "POST",
      headers: { Authorization: `Bearer ${localStorage.getItem("restoration.operatorSession") || ""}` },
      body: data,
    });
    const body = await res.json();
    const list = document.getElementById("upload-receipts");
    if (list) {
      list.replaceChildren();
      for (const r of body.receipts || []) {
        list.append(
          el(
            "li",
            { class: r.accepted ? "ok" : "bad" },
            r.accepted
              ? `${r.filename} ✓ ${r.stored_format} sha256:${(r.content_sha256 || "").slice(0, 12)}…`
              : `${r.filename} ✗ ${r.rejection_reason}`
          )
        );
      }
      for (const gap of body.gap_list || []) list.append(el("li", { class: "gap" }, `gap: ${gap}`));
    }
  });

  const sealBtn = document.getElementById("seal-btn");
  if (sealBtn) {
    sealBtn.addEventListener("click", async () => {
      const status = document.getElementById("seal-status");
      try {
        const res = await api(`/restoration/projects/${currentJob}/intake/seal`, { method: "POST" });
        if (status) status.textContent = `Intake sealed. Identify task: ${res.identify_task_id || "n/a"}`;
        document.dispatchEvent(new CustomEvent("restoration:job-created"));
      } catch (err) {
        if (status) status.textContent = `Seal failed: ${err.message}`;
      }
    });
  }
}
