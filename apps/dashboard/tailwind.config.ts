import type { Config } from "tailwindcss";

/**
 * Tailwind config for the suverse-pay customer dashboard.
 *
 * Aesthetic direction (per the user prompt's "frontend-design" skill
 * + the Kobaru benchmark): refined dark-mode-default with a single
 * sharp amber accent. Avoid the purple-gradient AI cliché. Display
 * font is JetBrains Mono for tabular numeric/identifier feel; body
 * is Inter Tight (more constrained than vanilla Inter and less of an
 * "AI tool" tell). Fonts are loaded via `next/font/google` in
 * `app/layout.tsx`; this config exposes them as `font-display` and
 * `font-sans` utilities.
 */
const config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "2rem", screens: { "2xl": "1400px" } },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // Brand-specific. The amber accent is the only saturated
        // colour in the palette — used sparingly: chart strokes,
        // active states, highlight badges.
        amber: {
          50: "#FFF8EB",
          100: "#FEEAC2",
          200: "#FCD37E",
          300: "#FABA45",
          400: "#F59E0B",  // base accent
          500: "#DC8508",
          600: "#A66306",
          700: "#704204",
          800: "#3A2102",
          900: "#1F1101",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter-tight)", "system-ui", "sans-serif"],
        display: ["var(--font-jetbrains-mono)", "ui-monospace", "monospace"],
        mono: ["var(--font-jetbrains-mono)", "ui-monospace", "monospace"],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "shimmer": {
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "shimmer": "shimmer 2s linear infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;

export default config;
