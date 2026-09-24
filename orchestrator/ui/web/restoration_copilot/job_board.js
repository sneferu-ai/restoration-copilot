// U1 — Job Board: list every vehicle job with state badges and attention markers.
import { api, el } from "./shared.js";

async function loadJobs() {
  const list = document.getElementById("job-list");
  const empty = document.getElementById("job-empty");
  if (!list) return;
  let jobs;
  try {
    jobs = await api("/restoration/projects");
  } catch (err) {
    if (empty) empty.textContent = `Sign in to view jobs (${err.message}).`;
    return;
  }
  for (const card of list.querySelectorAll(".job-card")) card.remove();
  if (empty) empty.hidden = jobs.length > 0;
  for (const job of jobs) {
    const meta = job.vehicle_meta || {};
    const title = [meta.year, meta.make, meta.model].filter(Boolean).join(" ") || job.project_id;
    const card = el("article", { class: "job-card", "data-project-id": job.project_id });
    card.append(el("h3", {}, title));
    card.append(el("span", { class: `badge state-${job.status}` }, job.status));
    if (job.needs_attention) {
      card.append(el("span", { class: "badge attention" }, `needs attention: ${job.needs_attention}`));
    }
    if (job.automation_coverage_pct !== null && job.automation_coverage_pct !== undefined) {
      card.append(el("span", { class: "chip" }, `auto-ID ${job.automation_coverage_pct}%`));
    }
    if (job.total_sourcing_coverage_pct !== null && job.total_sourcing_coverage_pct !== undefined) {
      card.append(el("span", { class: "chip" }, `sourcing ${job.total_sourcing_coverage_pct}%`));
    }
    card.append(el("span", { class: "chip" }, `API $${(job.api_cost_to_date_usd || 0).toFixed(2)} / $${(job.api_cost_ceiling_usd || 0).toFixed(2)}`));
    list.append(card);
  }
}

document.addEventListener("restoration:login", loadJobs);
document.addEventListener("restoration:job-created", loadJobs);
if (document.readyState !== "loading") loadJobs();
else document.addEventListener("DOMContentLoaded", loadJobs);
