# Restoration Copilot — documentation map

> **New here? Start with the project README at the repository root: [../README.md](../README.md).** It carries the full quickstart (install → KB seed → run → curl proofs). The fast path, condensed:
>
> ```bash
> pip install -e ".[dev]"
> python3 scripts/seed_restoration_kb.py && python3 scripts/validate_kb_seed.py
> python3 -m orchestrator.api.server     # → http://localhost:8000/restoration-ui
> ```

This directory holds the operator and maintainer documentation set.

| Document | Read it when you need to… |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Understand how the system fits together: components, persistence, state machine, data flow, deployment shape. |
| [API.md](API.md) | Call the REST API, integrate a client, or check an error code. Every route the server registers is documented. |
| [UI.md](UI.md) | Work on the operator console or the Bay Guide: screens, flows, design system, frontend tooling. |
| [OPERATIONS.md](OPERATIONS.md) | Install, configure, run, test, monitor, back up, and troubleshoot the system. |
| [examples/](examples/README.md) | Run scripted end-to-end walkthroughs against a live server (or fully offline). |

Reference documents at the repository root:

| Document | What it pins |
|---|---|
| [../spec.md](../spec.md) | The frozen product contract (B13): FR/AC requirements, data model, REST table, pinned formulas. |
| [../IMPLEMENTATION_NOTES.md](../IMPLEMENTATION_NOTES.md) | Round-by-round build log: what each build round delivered, deliberate deviations, open questions. |
| [../DESIGN.md](../DESIGN.md) | The UI design system: tokens, components, motion, voice, anti-defaults, audit gates. |
| [../SOUL.md](../SOUL.md) | The product-feeling brief the design system implements. |
| [../BRAND_IDENTITY.md](../BRAND_IDENTITY.md) | The launch-frozen brand (palette, mark) the UI must not drift from. |

## Reading paths by role

- **New operator (shop owner):** root [README](../README.md) → [OPERATIONS.md](OPERATIONS.md) (install + run) → [examples/](examples/README.md) (watch a full job journey) → [UI.md](UI.md) (what each screen does).
- **Mechanic (guide user):** no documentation required — open the guide link on a phone. The operator-facing explanation of that surface is in [UI.md — Bay Guide](UI.md#bay-guide-u6).
- **Integration developer:** [API.md](API.md) → [ARCHITECTURE.md — data and persistence](ARCHITECTURE.md#data-and-persistence) → [examples/04_research_primitive.py](examples/04_research_primitive.py).
- **Maintainer:** [ARCHITECTURE.md](ARCHITECTURE.md) → [../IMPLEMENTATION_NOTES.md](../IMPLEMENTATION_NOTES.md) → [../spec.md](../spec.md) → [OPERATIONS.md — troubleshooting](OPERATIONS.md#troubleshooting).

## Conventions used in these docs

- Commands and response bodies were verified by executing them against this repository (macOS, Python 3.12.13, Node 26.5.0): the backend suite (152 green), the frontend suite (5 green + typecheck + build), both KB scripts, every example in [examples/](examples/README.md), and a full live-API journey. Two paths are documented but marked where they live: the full `pip install -e ".[dev]"` (its heavyweight STT extras are for the AC-040 audio test; the core install was verified with `--no-deps` plus the runtime deps present here) and the production host's `launch.sh`/`launch-dev.sh` (part of the claudopus checkout, not this repository).
- FR-/AC- numbers cite the frozen spec ([../spec.md](../spec.md)); file paths cite the source of truth directly.
- "Spec-future" marks behavior that exists in the spec (and sometimes in the React UI) but is **not** served by this backend yet. The exact list is in [API.md — spec routes not yet implemented](API.md#spec-routes-not-yet-implemented).
