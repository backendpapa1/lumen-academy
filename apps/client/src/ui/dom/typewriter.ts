import { motion } from "../theme";

// How many characters of a streaming reply to show (docs/08 §3): type at
// ~45 chars/s, but never fall more than ~1.5s behind the stream, and once the
// stream is done finish the rest quickly rather than make the teacher wait.

const MAX_LAG_S = 1.5;
const FINISH_CPS = 200; // a 120-char reply finishes within ~0.6s

export function revealStep(shown: number, available: number, dt: number, done: boolean): number {
  const backlog = available - shown;
  if (backlog <= 0) return available;
  const rate = Math.max(done ? FINISH_CPS : motion.typeCharsPerSec, backlog / MAX_LAG_S);
  return Math.min(available, shown + rate * dt);
}

/** How long a finished reply stays up before fading: reading time, bounded. */
export const lingerMs = (text: string) => Math.min(14_000, Math.max(5_000, text.length * 70));
