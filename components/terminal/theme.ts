/**
 * xterm.js theme — built ONLY from WHARF design tokens
 * (design §4.2 Terminal): terminal-bg screen, neutral-100 foreground,
 * cobalt-300 cursor, coral selection (mirrors the brand ::selection).
 */
import type { ITheme } from "@xterm/xterm";

export const TERMINAL_FONT_FAMILY =
  "var(--font-jetbrains), ui-monospace, SFMono-Regular, monospace";

export const TERMINAL_FONT_SIZE = 13;

export const TERMINAL_THEME: ITheme = {
  background: "#0d1117", // --color-terminal-bg
  foreground: "#eef0f4", // neutral-100
  cursor: "#8ca3ef", // cobalt-300
  cursorAccent: "#0d1117",
  selectionBackground: "#ec6b45", // coral-500
  selectionForeground: "#ffffff",

  // Sane 16-color ANSI set tuned for the near-black screen.
  black: "#1f2530", // neutral-800
  red: "#e0655a",
  green: "#4ade80",
  yellow: "#e7a63c", // warning
  blue: "#8ca3ef", // cobalt-300
  magenta: "#c792ea",
  cyan: "#56b6c2",
  white: "#d6dae2", // neutral-200
  brightBlack: "#6a7385", // neutral-400
  brightRed: "#f28b82",
  brightGreen: "#86efac",
  brightYellow: "#f4c877",
  brightBlue: "#b9c8f5", // cobalt-200-ish
  brightMagenta: "#e2b8f5",
  brightCyan: "#7fd6e0",
  brightWhite: "#ffffff",
};
