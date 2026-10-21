import { modeInfo, type PeriodKind, type TeachingAnalysis } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";

// Teaching modes (V5, VD11): the small rules each mode adds on top of the
// lecture, and the line or two shown at the bell. Server-side, no LLM.

const ASKING =
  /^(what|why|how|when|where|which|who|whose|could|can|would|will|should|is|are|was|were|do|does|did|have|has|if|suppose|imagine|say|tell me|walk me|explain|talk me)\b/i;

/** V5-02: in a Socratic class I may only ask. A trailing "?" or an asking opener counts. */
export function isQuestion(text: string): boolean {
  const t = text.trim();
  if (t.endsWith("?")) return true;
  // "So, what happens…", "OK — why…": skip a short lead-in before the opener.
  return ASKING.test(t.replace(/^(so|ok|okay|right|now|and|but|then|well)[,.!—-]*\s+/i, ""));
}

export interface ModeResult {
  kind: PeriodKind;
  title: string;
  lines: string[];
  /** 0..1 where a mode has a score. */
  score?: number;
}

/** V5-02: how I questioned, from the Director's question.kind per turn. */
export function socraticResult(
  handle: DbHandle,
  periodId: string,
  hotSeat: { name: string; before: number; after: number } | null,
): ModeResult {
  const rows = handle.sqlite
    .prepare("SELECT analysis_json FROM turns WHERE period_id = ?")
    .all(periodId) as Array<{ analysis_json: string }>;
  const kinds = rows
    .map((r) => (JSON.parse(r.analysis_json) as TeachingAnalysis).question?.kind)
    .filter(Boolean);
  const n = (k: string) => kinds.filter((x) => x === k).length;
  const good = n("diagnostic") + n("leading");
  const lines = [
    kinds.length
      ? `You asked ${kinds.length} question${kinds.length === 1 ? "" : "s"}: ${n("diagnostic")} diagnostic, ${n("leading")} leading, ${n("closed")} closed.`
      : "No questions were scored this time.",
  ];
  if (hotSeat)
    lines.push(
      `${hotSeat.name.split(" ")[0]} went from ${Math.round(hotSeat.before * 100)}% to ${Math.round(hotSeat.after * 100)}% without you telling them a thing.`,
    );
  if (n("closed") > good)
    lines.push("Tip: open questions (why, how, what if) show you more of what they believe.");
  return {
    kind: "socratic",
    title: modeInfo("socratic").label,
    lines,
    ...(kinds.length ? { score: good / kinds.length } : {}),
  };
}
