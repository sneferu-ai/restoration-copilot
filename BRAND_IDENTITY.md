# str — Brand Identity

This file is a launch-frozen product contract. Read `BRAND_DIRECTION.md` first. Use the exact selected brand-mark bytes; do not redraw, replace, recolor, or generate another logo during the UI pass.

- Identity ID: `80a4c4d1e7b0be7034a6324ae9ecd25c498333e9e7a4d50534c568bfa76e54ed`
- Direction asset: `BRAND_ASSETS/brand-direction.svg`
- Selected mark: `BRAND_ASSETS/brand-mark.svg`
- Mark source: `deterministic_fallback`
- Board-to-mark lineage: `fallback/debt`

## Required semantic color tokens

- `--brand-background`: `#15111B`
- `--brand-surface`: `#241B2D`
- `--brand-foreground`: `#FFF5E8`
- `--brand-muted`: `#B8A9C1`
- `--brand-primary`: `#FF6B5F`
- `--brand-secondary`: `#E6B655`

Copy the exact selected mark into the framework's public/static asset directory and reference that copy in the primary visible product surface. Apply every semantic color through the product's token layer. The direction board remains a design reference and must not be mistaken for the shipped mark. The orchestrator verifies the copied mark bytes, source reference, complete palette, and direction acknowledgement before B16 may pass.
