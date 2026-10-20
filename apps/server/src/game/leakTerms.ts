// Cheap pre-LLM leak signal (docs/03 §6.5): technical-looking or source-only
// tokens in a cadet's words that the Headmaster never said.

const COMMON = new Set(
  `about above after again against because before being below between both could does doing down during each
  every from further having here itself just like more most myself only other ought over same should some
  such than that their them then there these they this those through under until very what when where which
  while with would your yours headmaster professor teacher doctor class lesson question confused sorry maybe
  actually exactly really thing things something anything everything nothing think thought mean means
  understand explain example right wrong idea point because whole part first second next last level levels
  again around always never still already another people someone`.split(/\s+/),
);

const norm = (w: string) =>
  w
    .toLowerCase()
    .replace(/[’']s$/, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
/** Crude stem so "hashes"/"hashing"/"hashed" match "hash". */
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "");

export function vocabulary(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    for (const raw of t.match(/[\p{L}\p{N}][\p{L}\p{N}’'-]*/gu) ?? []) {
      for (const part of raw.split("-")) {
        const w = norm(part);
        if (w) {
          out.add(w);
          out.add(stem(w));
        }
      }
    }
  }
  return out;
}

export interface TermCheck {
  /** Technical or source-only terms not in what was taught. */
  untaught: string[];
  forceGuard: boolean;
}

/**
 * @param taught    vocabulary of everything the Headmaster said + concept titles + the cadet's own identity
 * @param sourceOnly vocabulary of the School's sources (terms a cadet could only know by leaking)
 */
export function untaughtTerms(
  utterance: string,
  taught: Set<string>,
  sourceOnly: Set<string>,
  threshold: number,
): TermCheck {
  const found = new Set<string>();
  const tokens = utterance.match(/[\p{L}\p{N}][\p{L}\p{N}’'-]*/gu) ?? [];
  tokens.forEach((raw, i) => {
    const w = norm(raw);
    if (!w || w.length < 3 || COMMON.has(w)) return;
    if (taught.has(w) || taught.has(stem(w))) return;
    const prev = i > 0 ? utterance.slice(0, utterance.indexOf(raw)).trimEnd().slice(-1) : ".";
    const midSentenceCapital = /^\p{Lu}/u.test(raw) && !/[.!?:"“(]/.test(prev);
    const technicalShape = /\d/.test(raw) || /^\p{Lu}{2,}/u.test(raw) || /\p{Ll}\p{Lu}/u.test(raw);
    const sourceTerm = w.length >= 6 && (sourceOnly.has(w) || sourceOnly.has(stem(w)));
    if (technicalShape || midSentenceCapital || sourceTerm) found.add(w);
  });
  const untaught = [...found];
  return { untaught, forceGuard: untaught.length > threshold };
}
