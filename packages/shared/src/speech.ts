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

/**
 * A student's voice register, fixed by their id. The server picks their voice
 * from it and the drawing uses it too (only lower voices grow beards), so a
 * student looks and sounds like one person.
 */
export function voiceRegister(id: string): "female" | "male" {
  let h = 2166136261;
  for (const ch of `voice:${id}`) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return (h >>> 0) % 100 < 55 ? "female" : "male";
}
