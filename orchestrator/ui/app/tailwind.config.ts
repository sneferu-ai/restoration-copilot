import type { Config } from "tailwindcss";

// Tailwind is wired to the closed token layer. Theme values reference CSS
// custom properties so the token layer stays the single source of truth — no
// raw hex/px ever lives here except the token *names* that map to tokens.css.
export default {
  content: ["./src/**/*.{ts,tsx,html}"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        base: "var(--bg-base)",
        elevated: "var(--bg-elevated)",
        surface: {
          DEFAULT: "var(--bg-elevated)",
          hover: "var(--bg-hover)",
        },
        overlay: "var(--bg-overlay)",
        input: "var(--bg-input)",
        fg: {
          primary: "var(--fg-primary)",
          secondary: "var(--fg-secondary)",
          tertiary: "var(--fg-tertiary)",
          disabled: "var(--fg-disabled)",
          "on-accent": "var(--fg-on-accent)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-hover)",
          pressed: "var(--accent-pressed)",
          soft: "var(--accent-soft)",
        },
        amber: {
          DEFAULT: "var(--signal-amber)",
          soft: "var(--signal-amber-soft)",
        },
        blue: {
          DEFAULT: "var(--signal-blue)",
          soft: "var(--signal-blue-soft)",
        },
        border: {
          subtle: "var(--border-subtle)",
          DEFAULT: "var(--border-default)",
          strong: "var(--border-strong)",
          focus: "var(--border-focus)",
        },
        status: {
          running: "var(--status-running)",
          paused: "var(--status-paused)",
          halted: "var(--status-halted)",
          complete: "var(--status-complete)",
          failed: "var(--status-failed)",
          orphan: "var(--status-orphan)",
        },
      },
      fontFamily: {
        display: ["var(--font-display)"],
        body: ["var(--font-body)"],
        mono: ["var(--font-mono)"],
        numeric: ["var(--font-numeric)"],
      },
      fontSize: {
        xs: ["var(--text-xs)", "var(--line-snug)"],
        sm: ["var(--text-sm)", "var(--line-snug)"],
        base: ["var(--text-base)", "var(--line-normal)"],
        md: ["var(--text-md)", "var(--line-normal)"],
        lg: ["var(--text-lg)", "var(--line-snug)"],
        xl: ["var(--text-xl)", "var(--line-tight)"],
        "2xl": ["var(--text-2xl)", "var(--line-tight)"],
        "3xl": ["var(--text-3xl)", "var(--line-tight)"],
      },
      fontWeight: {
        regular: "var(--weight-regular)",
        medium: "var(--weight-medium)",
        semibold: "var(--weight-semibold)",
        bold: "var(--weight-bold)",
      },
      spacing: {
        1: "var(--space-1)",
        2: "var(--space-2)",
        3: "var(--space-3)",
        4: "var(--space-4)",
        5: "var(--space-5)",
        6: "var(--space-6)",
        8: "var(--space-8)",
        10: "var(--space-10)",
        12: "var(--space-12)",
        16: "var(--space-16)",
        20: "var(--space-20)",
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
        full: "var(--radius-full)",
      },
      boxShadow: {
        0: "var(--shadow-0)",
        1: "var(--shadow-1)",
        2: "var(--shadow-2)",
        3: "var(--shadow-3)",
        4: "var(--shadow-4)",
      },
      transitionDuration: {
        instant: "var(--dur-instant)",
        fast: "var(--dur-fast)",
        base: "var(--dur-base)",
        slow: "var(--dur-slow)",
      },
      transitionTimingFunction: {
        default: "var(--ease-default)",
        emphasized: "var(--ease-emphasized)",
      },
      zIndex: {
        base: "var(--z-base)",
        sticky: "var(--z-sticky)",
        dropdown: "var(--z-dropdown)",
        toast: "var(--z-toast)",
        "modal-bg": "var(--z-modal-bg)",
        modal: "var(--z-modal)",
        cmd: "var(--z-cmd)",
      },
      letterSpacing: {
        tight: "var(--tracking-tight)",
        mono: "var(--tracking-mono)",
      },
      lineHeight: {
        tight: "var(--line-tight)",
        snug: "var(--line-snug)",
        normal: "var(--line-normal)",
        relaxed: "var(--line-relaxed)",
      },
    },
  },
  plugins: [],
} satisfies Config;
