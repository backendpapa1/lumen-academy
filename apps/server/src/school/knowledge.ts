import type { GameConfig } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { recall } from "../game/memory.js";

// "What I actually know" (V2-07/08, VD6): per concept, the evidence from my
// classes, not an opinion. Mastered = the class got it and kept it and I have
// no open mistakes there; shaky = taught but middling, fading or with an open
// mistake; avoided = in the curriculum but barely taught. My own 1–5 rating
// sits beside it, and the report says where the two disagree.

export type KnowledgeStatus = "mastered" | "shaky" | "avoided";

export interface ConceptKnowledge {
  id: string;
  title: string;
  module: string;
  status: KnowledgeStatus;
  /** Class understanding at its best (as last taught) and recalled today, 0..1. */
  peak: number | null;
  now: number | null;
  /** Mean teaching turns per student. */
  turns: number;
  daysSinceTaught: number | null;
  openMistakes: Array<{ claim: string; correction: string }>;
  selfRating: number | null;
  /** My rating vs the evidence: "over" = I think I know it better than I teach it. */
  mismatch: "over" | "under" | null;
  references: string[];
}

export interface KnowledgeReport {
  school: { id: string; name: string };
  concepts: ConceptKnowledge[];
  counts: Record<KnowledgeStatus, number>;
  /** Share of my self-ratings within one step of the evidence (the V2 gate's number). */
  agreement: { rated: number; within: number } | null;
}

/** My 1–5 on the same 0..1 scale as understanding. */
const ratingScale = (r: number) => (r - 1) / 4;

export function knowledgeReport(
  handle: DbHandle,
  game: GameConfig,
  schoolId: string,
  now = new Date(),
): KnowledgeReport | null {
  const { sqlite } = handle;
  const school = sqlite.prepare("SELECT id, name FROM schools WHERE id = ?").get(schoolId) as
    { id: string; name: string } | undefined;
  if (!school) return null;
  const concepts = sqlite
    .prepare(
      `SELECT c.id, c.title, m.title AS module FROM concepts c JOIN modules m ON m.id = c.module_id
       WHERE m.school_id = ? ORDER BY m.ord, c.ord`,
    )
    .all(schoolId) as Array<{ id: string; title: string; module: string }>;
  const ledger = sqlite
    .prepare(
      `SELECT l.concept_id AS conceptId, l.comprehension AS c, l.exposures AS turns,
         l.last_taught_at AS at, l.stability_days AS st
       FROM ledger_entries l JOIN cadets d ON d.id = l.cadet_id JOIN classrooms r ON r.id = d.classroom_id
       WHERE r.school_id = ? AND d.status IN ('enrolled','transferred_in','alumni')`,
    )
    .all(schoolId) as Array<{
    conceptId: string;
    c: number;
    turns: number;
    at: string | null;
    st: number | null;
  }>;
  const mistakes = sqlite
    .prepare(
      `SELECT e.concept_id AS conceptId, e.claim, e.correction FROM teacher_errors e
       JOIN turns t ON t.id = e.turn_id JOIN periods p ON p.id = t.period_id JOIN classrooms r ON r.id = p.classroom_id
       WHERE r.school_id = ? AND e.resolved = 0`,
    )
    .all(schoolId) as Array<{ conceptId: string | null; claim: string; correction: string }>;
  const ratings = new Map(
    (
      sqlite.prepare("SELECT concept_id AS id, rating FROM self_ratings").all() as Array<{
        id: string;
        rating: number;
      }>
    ).map((r) => [r.id, r.rating]),
  );
  const refs = sqlite
    .prepare(
      `SELECT cc.concept_id AS conceptId, s.title AS source, ch.heading_path AS heading, ch.page_from AS page
       FROM concept_citations cc JOIN chunks ch ON ch.id = cc.chunk_id JOIN sources s ON s.id = ch.source_id
       WHERE s.school_id = ?`,
    )
    .all(schoolId) as Array<{
    conceptId: string;
    source: string;
    heading: string | null;
    page: number | null;
  }>;

  const out: ConceptKnowledge[] = concepts.map((k) => {
    const rows = ledger.filter((l) => l.conceptId === k.id);
    const taught = rows.filter((r) => r.turns > 0);
    const turns = rows.length ? rows.reduce((a, r) => a + r.turns, 0) / rows.length : 0;
    const peak = taught.length ? taught.reduce((a, r) => a + r.c, 0) / taught.length : null;
    const recalled = taught.length
      ? taught.reduce((a, r) => a + recall(r.c, r.at, r.st, now, game.memory), 0) / taught.length
      : null;
    const last = taught.reduce<string | null>(
      (a, r) => (r.at && (!a || r.at > a) ? r.at : a),
      null,
    );
    const open = mistakes
      .filter((m) => m.conceptId === k.id)
      .map((m) => ({ claim: m.claim, correction: m.correction }));
    const status: KnowledgeStatus =
      turns < 1 || peak === null
        ? "avoided"
        : peak >= game.comprehension.understoodAt &&
            recalled !== null &&
            recalled >= peak * game.memory.fadingAt &&
            !open.length
          ? "mastered"
          : "shaky";
    const selfRating = ratings.get(k.id) ?? null;
    const evidence = recalled ?? 0;
    const gap = selfRating === null ? 0 : ratingScale(selfRating) - evidence;
    const where = refs
      .filter((r) => r.conceptId === k.id)
      .map(
        (r) => `${r.source}${r.heading ? ` › ${r.heading}` : ""}${r.page ? ` (p.${r.page})` : ""}`,
      );
    return {
      id: k.id,
      title: k.title,
      module: k.module,
      status,
      peak,
      now: recalled,
      turns,
      daysSinceTaught: last ? Math.floor((now.getTime() - Date.parse(last)) / 86_400_000) : null,
      openMistakes: open,
      selfRating,
      mismatch: selfRating === null ? null : gap > 0.3 ? "over" : gap < -0.3 ? "under" : null,
      references: [...new Set(where)].slice(0, 4),
    };
  });
  const rated = out.filter((c) => c.selfRating !== null);
  return {
    school,
    concepts: out,
    counts: {
      mastered: out.filter((c) => c.status === "mastered").length,
      shaky: out.filter((c) => c.status === "shaky").length,
      avoided: out.filter((c) => c.status === "avoided").length,
    },
    // "Within ±1" on my 1–5 scale = within a quarter on the 0..1 scale.
    agreement: rated.length
      ? {
          rated: rated.length,
          within: rated.filter((c) => Math.abs(ratingScale(c.selfRating!) - (c.now ?? 0)) <= 0.25)
            .length,
        }
      : null,
  };
}

/** Study notes to keep (V2-07): what I know, what to review, what the source says, where to read. */
export function knowledgeMarkdown(r: KnowledgeReport): string {
  const pct = (n: number | null) => (n === null ? "–" : `${Math.round(n * 100)}%`);
  const section = (status: KnowledgeStatus, title: string, blurb: string) => {
    const cs = r.concepts.filter((c) => c.status === status);
    if (!cs.length) return "";
    return [
      `## ${title} (${cs.length})`,
      `_${blurb}_`,
      "",
      ...cs.map((c) =>
        [
          `### ${c.title}`,
          `${c.module} · class understanding ${pct(c.peak)} → ${pct(c.now)} today` +
            (c.daysSinceTaught !== null ? ` · last taught ${c.daysSinceTaught} days ago` : "") +
            (c.selfRating !== null ? ` · my rating ${c.selfRating}/5` : ""),
          ...c.openMistakes.map(
            (m) => `- **I said:** ${m.claim}\n  **The source:** ${m.correction}`,
          ),
          ...(c.references.length ? [`- Read: ${c.references.join("; ")}`] : []),
          "",
        ].join("\n"),
      ),
    ].join("\n");
  };
  return [
    `# What I actually know: ${r.school.name}`,
    `_${new Date().toISOString().slice(0, 10)} · ${r.counts.mastered} mastered · ${r.counts.shaky} shaky · ${r.counts.avoided} not taught yet_`,
    "",
    section(
      "shaky",
      "Shaky: review these",
      "Taught, but the class is middling, it's fading, or I got something wrong.",
    ),
    section("avoided", "Not taught yet", "In the curriculum, but I've barely taught it."),
    section("mastered", "Mastered", "The class got it and kept it."),
  ]
    .filter(Boolean)
    .join("\n");
}
