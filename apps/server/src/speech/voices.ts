import { voiceRegister, type SpeechConfig } from "@lumen/shared";

// A student's voice (V1-04): a Kokoro voice from their register, spread so
// classmates differ, and a speaking rate from their archetype.

export interface StudentVoice {
  voice: string;
  speed: number;
}

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return h >>> 0;
}

/** Deterministic per student; `taken` (classmates' voices) is avoided while there are free ones. */
export function pickVoice(
  cfg: SpeechConfig["tts"],
  student: { id: string; archetype: string },
  taken: string[] = [],
): StudentVoice {
  const pool = cfg.voices[voiceRegister(student.id)];
  const start = hash(student.id) % pool.length;
  let voice = pool[start]!;
  for (let k = 0; k < pool.length; k++) {
    const v = pool[(start + k) % pool.length]!;
    if (!taken.includes(v)) {
      voice = v;
      break;
    }
  }
  // Two students on the same voice still differ a little in pace.
  const base = cfg.speed[student.archetype] ?? 1;
  const nudge = taken.includes(voice) ? ((hash(`${student.id}:pace`) % 9) - 4) / 100 : 0;
  return { voice, speed: Math.round((base + nudge) * 100) / 100 };
}
