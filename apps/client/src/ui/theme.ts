import type { Archetype } from "@lumen/shared";
import { ARCHETYPE_INFO } from "@lumen/shared";

// The few design values TypeScript needs (ADR-009). Colours, type and shadows
// live in CSS: style/tokens.css.

export const accentCss = (a: Archetype) => ARCHETYPE_INFO[a].accent;

export const motion = {
  /** Student speech types in at this rate unless the stream is faster. */
  typeCharsPerSec: 45,
} as const;

export const reducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
