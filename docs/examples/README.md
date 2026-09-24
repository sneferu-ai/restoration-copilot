# Runnable examples

Four scripts that exercise the product for real. None of them mocks the product itself; example 4 injects a fake bridge dispatcher because that is the primitive's designed test seam.

| Example | Needs | What it proves |
|---|---|---|
| [01_quickstart_smoke.sh](01_quickstart_smoke.sh) | a running server | Install smoke: health, login, create a project. |
| [02_full_journey.py](02_full_journey.py) | nothing (self-contained) | The whole job journey end to end: create → intake → seal → identify → manifest → lock → budget → override → hunt → manual candidate → partial seal → negotiation → purchase → token → guide page. |
| [03_kb_and_sources.py](03_kb_and_sources.py) | nothing (self-contained) | KB listing/add/approve and source-registry CRUD. |
| [04_research_primitive.py](04_research_primitive.py) | nothing (offline) | The FR-012 sourcing contract: tier order, template interpolation, dedup, budget gate, unsourceable reasons. |

Examples 2–4 boot the WSGI app **in-process** on a throwaway port with `RUNS_ROOT` pointed at a temp directory — no server to start, no state left behind, no API keys.

Run them from the repository root:

```bash
# 1 — with your own server running (python3 -m orchestrator.api.server)
bash docs/examples/01_quickstart_smoke.sh

# 2, 3, 4 — fully self-contained
python3 docs/examples/02_full_journey.py
python3 docs/examples/03_kb_and_sources.py
python3 docs/examples/04_research_primitive.py
```

Expected exit code is 0 for all four; each prints a step-by-step transcript and fails loudly (non-zero) on the first unexpected response.
