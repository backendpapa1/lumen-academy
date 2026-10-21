// Time-of-day lighting from the user's real clock in Lagos (docs/08 §1).

export type DayPhase = "dawn" | "day" | "dusk" | "night";

export const PHASES: Record<
  DayPhase,
  { key: number; keyIntensity: number; ambient: number; ambientIntensity: number }
> = {
  dawn: { key: 0xffc9a3, keyIntensity: 1.6, ambient: 0x8a7aa8, ambientIntensity: 0.35 },
  day: { key: 0xeaf2ff, keyIntensity: 2.0, ambient: 0x9fb6d8, ambientIntensity: 0.45 },
  dusk: { key: 0xff9e7a, keyIntensity: 1.5, ambient: 0x7a6ab8, ambientIntensity: 0.35 },
  night: { key: 0x7fa8ff, keyIntensity: 1.1, ambient: 0x3a4a78, ambientIntensity: 0.3 },
};

export function lagosHour(at = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h + m / 60;
}

export function dayPhase(hour = lagosHour()): DayPhase {
  if (hour >= 5 && hour < 8) return "dawn";
  if (hour >= 8 && hour < 17) return "day";
  if (hour >= 17 && hour < 20) return "dusk";
  return "night";
}
