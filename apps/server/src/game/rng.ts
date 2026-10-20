// Seeded RNG so game outcomes are reproducible per classroom/turn (docs/03 §4.3).

/** mulberry32: small, fast, good enough for gameplay randomness. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of strings, to derive per-turn/per-cadet seeds. */
export function seedFrom(...parts: Array<string | number>): number {
  let h = 2166136261;
  for (const ch of parts.join("|")) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
