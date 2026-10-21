// Where to cut a streaming line into spoken chunks (V1-05, spike V1-S2). The
// first chunk is short (to the first comma, or a few words) so a student starts
// speaking in about half a second; later chunks are whole sentences.

const CLAUSE = /[,;:—–]/;
const SENTENCE = /[.?!…]/;

/**
 * The end (exclusive) of the next chunk of `text` starting at `from`, or null
 * if more text is needed. `done` means the stream has ended: the rest goes.
 */
export function nextChunkEnd(
  text: string,
  from: number,
  done: boolean,
  opts: { firstChunkWords: number; maxWords?: number } = { firstChunkWords: 6 },
): number | null {
  const rest = text.slice(from);
  if (!rest.trim()) return null;
  const maxWords = opts.maxWords ?? 22;
  const first = from === 0;
  let words = 0;
  let inWord = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!;
    const space = /\s/.test(ch);
    if (!space && !inWord) {
      inWord = true;
    } else if (space && inWord) {
      inWord = false;
      words++;
      if (first && words >= opts.firstChunkWords) return from + i;
      if (words >= maxWords) return from + i;
    }
    // Punctuation counts once the next character shows it's really a boundary.
    const next = rest[i + 1];
    const settled = next === undefined ? done : /\s/.test(next);
    if (!settled) continue;
    if (SENTENCE.test(ch)) return from + i + 1;
    if (first && CLAUSE.test(ch) && words + (inWord ? 1 : 0) >= 1) return from + i + 1;
  }
  return done ? text.length : null;
}

/** All chunks of a finished line, for tests and for speaking a whole line at once. */
export function chunkLine(text: string, firstChunkWords = 6): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const end = nextChunkEnd(text, from, true, { firstChunkWords });
    if (end === null) break;
    const piece = text.slice(from, end).trim();
    if (piece) out.push(piece);
    from = end;
  }
  return out;
}

export type VoiceRegister = "female" | "male";

/**
 * A student's voice register, fixed by their id: only the fallback when the
 * Registrar left no note (see registerFor).
 */
export function voiceRegister(id: string): VoiceRegister {
  let h = 2166136261;
  for (const ch of `voice:${id}`) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return (h >>> 0) % 100 < 55 ? "female" : "male";
}

/**
 * Word swaps between what the recogniser gave me and what I actually sent
 * ("ash" → "hash"), for learning my mishearings. Only short swaps (1–3 words a
 * side) count; if I rewrote much of the line it's a change of mind, not a fix.
 */
export function wordSwaps(
  suggested: string,
  sent: string,
): Array<{ heard: string; meant: string }> {
  const tok = (s: string) =>
    s
      .split(/\s+/)
      .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
      .filter(Boolean);
  const a = tok(suggested);
  const b = tok(sent);
  if (!a.length || !b.length) return [];
  const key = (w: string) => w.toLowerCase();
  // Longest common subsequence on words, then read off the gaps.
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i]![j] =
        key(a[i]!) === key(b[j]!)
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const kept = dp[0]![0]!;
  if (kept < Math.max(a.length, b.length) * 0.6) return [];
  const out: Array<{ heard: string; meant: string }> = [];
  let i = 0;
  let j = 0;
  let ga: string[] = [];
  let gb: string[] = [];
  const flush = () => {
    if (ga.length && gb.length && ga.length <= 3 && gb.length <= 3)
      out.push({ heard: ga.join(" ").toLowerCase(), meant: gb.join(" ") });
    ga = [];
    gb = [];
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && key(a[i]!) === key(b[j]!)) {
      flush();
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || dp[i]![j + 1]! >= dp[i + 1]![j]!))
      gb.push(b[j++]!);
    else ga.push(a[i++]!);
  }
  flush();
  return out;
}

/**
 * A student's voice register, so name, voice and drawing agree: the
 * Registrar's "higher"/"lower" note (written to fit the name), else a
 * feminine or masculine presentation, else the id. The server picks their
 * voice from it and the drawing follows it (only lower voices grow beards).
 */
export function registerFor(
  id: string,
  appearance?: { voice?: unknown; genderPresentation?: unknown } | null,
): VoiceRegister {
  if (appearance?.voice === "higher") return "female";
  if (appearance?.voice === "lower") return "male";
  if (appearance?.genderPresentation === "feminine") return "female";
  if (appearance?.genderPresentation === "masculine") return "male";
  return voiceRegister(id);
}
