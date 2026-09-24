"""Brand identity pins (BRAND_IDENTITY.md — launch-frozen).

Mechanically verifies, without a browser:
- the six --brand-* semantic palette values exist VERBATIM in the token layer
- the copied mark in the framework's public dir is byte-identical to the
  selected mark in BRAND_ASSETS/
- the copied mark is referenced from the primary visible product surface
  (ConsoleShell.tsx) and from the built console shell
- DESIGN.md carries the direction-board acknowledgement citing the exact board
  filename (the translation obligation in BRAND_DIRECTION.md)
"""
import hashlib
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
APP = REPO_ROOT / "orchestrator" / "ui" / "app"
TOKENS = APP / "shared" / "base-tokens.css"
MARK_SRC = REPO_ROOT / "BRAND_ASSETS" / "brand-mark.svg"
MARK_COPY = APP / "console" / "public" / "brand-mark.svg"
SHELL = APP / "console" / "src" / "shell" / "ConsoleShell.tsx"
DESIGN = REPO_ROOT / "DESIGN.md"

BRAND_VALUES = {
    "--brand-background": "#15111B",
    "--brand-surface": "#241B2D",
    "--brand-foreground": "#FFF5E8",
    "--brand-muted": "#B8A9C1",
    "--brand-primary": "#FF6B5F",
    "--brand-secondary": "#E6B655",
}


class TestBrandIdentityUI(unittest.TestCase):
    def test_six_brand_values_verbatim_in_token_layer(self):
        css = TOKENS.read_text(encoding="utf-8")
        for name, value in BRAND_VALUES.items():
            with self.subTest(token=name):
                self.assertIn(f"{name}: {value};", css)

    def test_copied_mark_is_byte_identical(self):
        self.assertTrue(MARK_COPY.is_file(), "brand-mark.svg not copied to console/public/")
        self.assertEqual(
            hashlib.sha256(MARK_SRC.read_bytes()).hexdigest(),
            hashlib.sha256(MARK_COPY.read_bytes()).hexdigest(),
        )

    def test_mark_referenced_from_primary_surface(self):
        shell = SHELL.read_text(encoding="utf-8")
        self.assertIn("brand-mark.svg", shell)

    def test_direction_acknowledgement_in_design(self):
        design = DESIGN.read_text(encoding="utf-8")
        self.assertIn("## Brand direction implementation", design)
        self.assertIn("BRAND_ASSETS/brand-direction.svg", design)

    def test_mark_served_path_present_in_built_shell(self):
        built = REPO_ROOT / "orchestrator" / "ui" / "web" / "static" / "restoration" / "app" / "brand-mark.svg"
        if not built.exists():
            self.skipTest("console build has not run (npm run build:console)")
        self.assertEqual(
            hashlib.sha256(MARK_SRC.read_bytes()).hexdigest(),
            hashlib.sha256(built.read_bytes()).hexdigest(),
        )


if __name__ == "__main__":
    unittest.main()
