**Goal**

Build a showcase vehicle-restoration assistant for a small auto restoration shop, running on the shop's Sneferu back-end. The system ingests photos and parts lists of vintage vehicles, determines all parts needed for a full restoration, sources them worldwide within an allocated budget or identifies unsourceable parts for fabrication, and delivers vehicle-specific 3D assembly instructions with real-time audio guidance — so a mechanic with no AI or advanced technical training can complete restorations with expert guidance and parts ready to go. This is a Sneferu showcase: it must wow, and it must be effective and easy to use.

**Deliverables**

- Photo and parts-list intake producing a structured, tagged inventory of the vehicle's current state and an itemized parts manifest for full restoration. Automated identification handles the majority of parts; human input is reserved for genuinely ambiguous cases.
- Budget-constrained global parts sourcing that first checks budget feasibility against known part costs, then locates purchasable and tradeable options worldwide within the allocated budget. Unsourceable parts are flagged with specific reasons and alternative suggestions; where the 3D pipeline can produce a model, that model serves as a fabrication reference. The operator handles all haggling, trade negotiation, and purchase execution manually.
- Vehicle-specific 3D part models and complete assembly animations using the game-pipeline approach (see `docs-local/BUGS/2026-07-23-game-pipeline-end-to-end-hostile-audit.md` and `docs-local/current-runtime-truth.md`). Models faithfully represent the vehicle's make, model, year, and visible modifications affecting part fitment; a full photogrammetric digital twin of the specific car is not required.
- Step-by-step installation instructions delivered on a smartphone via webcam or mobile app: the mechanic advances audio walk-throughs manually (tap to proceed), each step synchronized to its corresponding 3D animation. Audio covers the entire demonstrated procedure.
- Integration with the shop's Sneferu back-end for authentication, storage, and model orchestration.

**Constraints**

- Runs entirely on the shop's Sneferu back-end; no external infrastructure beyond what Sneferu provides may be required.
- All instructional content is vehicle-specific to the exact car in the intake photos — no generic assembly assets.
- Budget is a hard boundary: the system checks budget feasibility before sourcing begins and warns the operator if the allocated budget is insufficient for critical parts. Overspend triggers failure unless the operator explicitly overrides.
- Operable by a mechanic with no AI or advanced technical training.
- 3D mesh generation uses exclusively the documented game-pipeline approach; no alternative 3D method is in scope unless the referenced pipeline is proven infeasible during spec validation.

**Out of scope**

- Building the system as a resalable platform or multi-tenant SaaS. The operator's hedge on future reselling is noted; the build targets the shop's own use and market position, not exposing tools to third parties.
- Autonomous transaction execution for parts purchasing, haggling, or trade negotiation — the system surfaces options; the operator buys.
- Generic assembly instructions not tied to a specific photographed vehicle.
- Physical restoration labor and mechanic training/certification.

**Acceptance**

- A representative vintage vehicle can be ingested and a complete, correct parts manifest produced within one working day. Automated identification handles at least 80% of parts without manual intervention; human-in-the-loop assistance is permitted only for genuinely ambiguous cases such as rare aftermarket items.
- 3D assembly instructions are produced for all major assemblies required to restore the vehicle to running condition. At minimum, a mechanic can follow step-by-step animations to correctly install a critical sub-assembly on the exact vehicle photographed.
- Real-time guidance runs on a standard smartphone: the mechanic advances audio instructions manually, each step is synchronized to its 3D animation, and audio is understandable without reading the screen. Audio covers the entire demonstrated sub-assembly procedure.
- Global sourcing first confirms budget feasibility, then locates purchasable or tradeable options for ≥90% of required parts within budget. Unsourced parts are flagged with specific reasons and alternative suggestions, not blanket "not found" messages. Unsourceable parts receive fabrication references where the 3D pipeline can produce them.
- A mechanic with basic smartphone skills completes the full workflow — vehicle photo ingestion through parts review to successfully installing a critical sub-assembly using the system's manifest, 3D instructions, and audio guidance — without external assistance.
- The entire system operates on the Sneferu back-end without additional server setup.

**Falsification**

- If the 3D pipeline flagged unverified in `docs-local/current-runtime-truth.md` cannot produce dimensionally sufficient part models matching real vehicle geometry within assembly tolerances, the 3D instruction feature is undeliverable on current infrastructure.
- If Sneferu does not expose stable, callable services for asset storage and model orchestration, the "runs on Sneferu" premise fails.
- If photo-based parts determination cannot enumerate missing parts with usable accuracy on deteriorated vintage vehicles, the manifest feature requires a declared human-in-loop workflow rather than autonomous vision inference.
- If a mechanic with basic smartphone skills cannot complete the full workflow (capture → parts review → guided assembly) without external help, the usability constraint is violated.
- If the system flags ≥10% of parts as unsourced without making genuine sourcing attempts, the sourcing deliverable is falsified.
- If a second, previously unseen vintage vehicle type cannot be ingested and produce a correct parts manifest using the same process, the generalization claim is falsified.