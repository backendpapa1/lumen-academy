import type { Archetype } from "@lumen/shared";
import { ARCHETYPE_INFO } from "@lumen/shared";

// Art-direction tokens (docs/08 §1–3). Every HUD colour, size and duration
// comes from here; components never hard-code them.

const hex = (s: string) => Number.parseInt(s.slice(1), 16);

export const color = {
  void: hex("#05070D"),
  hull900: hex("#0B1020"),
  hull700: hex("#141B2E"),
  hull500: hex("#22304D"),
  glass: hex("#8CB4FF"), // used at 8% alpha
  ink: hex("#E6EDF7"),
  inkDim: hex("#8A96AD"),
  lumen: hex("#5BE7FF"),
  lumenDeep: hex("#1BA8D6"),
  aurum: hex("#F5C66B"),
  success: hex("#4ADE80"),
  danger: hex("#FF5C7A"),
} as const;

export const css = {
  ink: "#E6EDF7",
  inkDim: "#8A96AD",
  lumen: "#5BE7FF",
  aurum: "#F5C66B",
  danger: "#FF5C7A",
  success: "#4ADE80",
  void: "#05070D",
} as const;

export const alpha = {
  glass: 0.08,
  /** Dark base under the glass so text stays legible over a bright 3D scene. */
  panelBase: 0.72,
  modalBase: 0.95,
  focusGlow: 0.35,
  primaryFill: 0.14,
} as const;

export const accentOf = (a: Archetype) => hex(ARCHETYPE_INFO[a].accent);
export const accentCss = (a: Archetype) => ARCHETYPE_INFO[a].accent;

export const font = {
  display: '"Space Grotesk", system-ui, sans-serif',
  body: '"Inter", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, monospace',
} as const;

/** Sizes at the 1080p baseline (docs/08 §2); scaled by `ui()`. */
export const size = { display: 40, h1: 28, h2: 20, body: 16, caption: 13, micro: 11 } as const;

export const shape = { radius: 12, chamfer: 10, chipHeight: 24, meterHeight: 4, gap: 8 } as const;

export const motion = {
  hover: 180,
  panel: 280,
  scene: 1000,
  /** Cadet speech types in at this rate unless the stream is faster. */
  typeCharsPerSec: 45,
  easeIn: "Cubic.easeOut",
  easeOut: "Cubic.easeIn",
} as const;

/** HUD scale for the current viewport, relative to 1920×1080, clamped. */
export function uiScale(width: number, height: number): number {
  return Math.min(1.25, Math.max(0.75, Math.min(width / 1920, height / 1080)));
}

export const reducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export const fontFamilies = ["Space Grotesk", "Inter", "JetBrains Mono"] as const;
