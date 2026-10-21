import type { CadetCard } from "@lumen/shared";

/** One line per cadet. Pipe-separated keeps the token count low for 15 cadets. */
export function cadetTable(cards: CadetCard[], opts: { withSpoke?: boolean } = {}): string {
  return cards
    .map((c) =>
      [
        c.id,
        c.name,
        c.archetype,
        c.attention.toFixed(2),
        c.skepticism.toFixed(2),
        c.learningStyle,
        c.comprehension.toFixed(2),
        c.misconceptions.length ? c.misconceptions.join("; ") : "-",
        ...(opts.withSpoke === false
          ? []
          : [
              c.lastState,
              c.spokeTurnsAgo ?? "never",
              c.interests?.length ? c.interests.join(", ") : "-",
              c.arc || "-",
            ]),
      ].join(" | "),
    )
    .join("\n");
}

export interface TranscriptLine {
  speaker: string;
  text: string;
}

/** The last N turns, oldest first, as plain dialogue. */
export function recentTranscript(lines: TranscriptLine[], max = 6): string {
  const tail = lines.slice(-max);
  return tail.length ? tail.map((l) => `${l.speaker}: ${l.text}`).join("\n") : "(start of class)";
}

export const keyFactList = (facts: string[]) => facts.map((f, i) => `kf${i + 1}: ${f}`).join("\n");
