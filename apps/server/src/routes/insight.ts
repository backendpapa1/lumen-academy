import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { StyleProfileZ } from "@lumen/shared";
import { callStructured } from "../agents/harness.js";
import { loadPrompt } from "../agents/prompts/load.js";
import type { ModelFactory } from "../models/factory.js";
import { progress } from "../game/progress.js";
import { fallbackProfile, numbersAreOurs, statLines, styleStats } from "../game/styleProfile.js";
import type { FastifyInstance } from "fastify";
import type { CrowdReaction, GameConfig, TeachingAnalysis } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { recentMisses, startHere } from "../game/detective.js";

// After-class insight (V5-06, V5-07), all from data already stored: where a
// miss really starts (the prerequisite detective) and which of my
// explanations confused or cleared the class (the confusion map).

const CONFUSED = new Set(["confused", "skeptical"]);
const CLEAR = new Set(["attentive", "excited", "notetaking"]);

export interface ConfusionTurn {
  ord: number;
  text: string;
  confused: string[];
  cleared: string[];
  /** Mix-ups the Director saw me fix on this turn. */
  fixed: number;
}

export function confusionMap(handle: DbHandle, periodId: string): ConfusionTurn[] {
  const { sqlite } = handle;
  const names = new Map(
    (
      sqlite
        .prepare(
          `SELECT d.id, d.name FROM cadets d JOIN periods p ON p.classroom_id = d.classroom_id WHERE p.id = ?`,
        )
        .all(periodId) as Array<{ id: string; name: string }>
    ).map((r) => [r.id, r.name.split(" ")[0]!]),
  );
  const rows = sqlite
    .prepare(
      `SELECT t.ord, m.text, t.reactions_json r, t.analysis_json a FROM turns t
       JOIN messages m ON m.id = t.teacher_message_id WHERE t.period_id = ? ORDER BY t.ord`,
    )
    .all(periodId) as Array<{ ord: number; text: string; r: string; a: string }>;
  let before = new Map<string, string>();
  return rows.map((row) => {
    const reaction = JSON.parse(row.r) as Partial<CrowdReaction>;
    const analysis = JSON.parse(row.a) as Partial<TeachingAnalysis>;
    const now = new Map((reaction.reactions ?? []).map((x) => [x.cadetId, x.state as string]));
    const confused = [...now]
      .filter(([, s]) => CONFUSED.has(s))
      .map(([id]) => names.get(id) ?? "?");
    const cleared = [...now]
      .filter(([id, s]) => CLEAR.has(s) && CONFUSED.has(before.get(id) ?? ""))
      .map(([id]) => names.get(id) ?? "?");
    before = now;
    return {
      ord: row.ord,
      text: row.text,
      confused,
      cleared,
      fixed: (analysis.ledgerDeltas ?? []).filter((d) => d.resolvedMisconception).length,
    };
  });
}

/** V7-07: refreshed weekly (or on request), cached in settings. */
const STYLE_KEY = "styleProfile";
const WEEK = 7 * 86_400_000;
/** Fewer turns than this and the profile would be guessing. */
const MIN_TURNS = 20;

export function registerInsightRoutes(
  app: FastifyInstance,
  deps: { handle: DbHandle; game: GameConfig; factory: ModelFactory },
) {
  const { sqlite } = deps.handle;

  /** V7-06: weekly minutes, sessions, mastered, clarity/accuracy, voice share, energy days. */
  app.get("/api/progress", async () => progress(deps.handle, deps.game));

  /** V7-07: how I teach, in three sentences and a suggestion, from my own numbers. */
  app.get<{ Querystring: { refresh?: string } }>("/api/style", async (req) => {
    const cached = sqlite
      .prepare("SELECT value_json v FROM settings WHERE key = ?")
      .get(STYLE_KEY) as { v: string } | undefined;
    const old = cached ? (JSON.parse(cached.v) as { computedAt: string }) : null;
    if (old && !req.query.refresh && Date.now() - Date.parse(old.computedAt) < WEEK) return old;
    const stats = styleStats(deps.handle);
    if (stats.turns < MIN_TURNS)
      return { computedAt: null, stats, enough: false, needed: MIN_TURNS };
    const lines = statLines(stats);
    let text = fallbackProfile(stats);
    let written = false;
    try {
      const res = await callStructured(deps.factory, "styleCoach", {
        schema: StyleProfileZ,
        name: "style_profile",
        messages: [
          new SystemMessage(
            loadPrompt("styleCoach", { facts: lines.map((l) => `- ${l}`).join("\n") }),
          ),
          new HumanMessage("Write the profile."),
        ],
      });
      // The coach may only use our numbers; otherwise the plain version stands.
      if (numbersAreOurs([...res.data.sentences, res.data.suggestion].join(" "), lines)) {
        text = res.data;
        written = true;
      }
    } catch {
      /* the plain sentences still describe the numbers */
    }
    const profile = { computedAt: new Date().toISOString(), stats, enough: true, written, ...text };
    sqlite
      .prepare(
        "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
      )
      .run(STYLE_KEY, JSON.stringify(profile));
    return profile;
  });

  /** V5-06: "start here" pins for a School's curriculum map, from recent misses in its classes. */
  app.get<{ Params: { id: string } }>("/api/schools/:id/start-here", async (req, reply) => {
    const rooms = sqlite
      .prepare("SELECT id FROM classrooms WHERE school_id = ? AND status IN ('active','graduated')")
      .all(req.params.id) as Array<{ id: string }>;
    if (!rooms.length && !sqlite.prepare("SELECT 1 FROM schools WHERE id = ?").get(req.params.id))
      return reply.code(404).send({ error: "no such School" });
    const merged = new Map<string, ReturnType<typeof startHere>[number]>();
    for (const r of rooms)
      for (const s of startHere(deps.handle, deps.game, {
        classroomId: r.id,
        misses: recentMisses(deps.handle, r.id),
      })) {
        const had = merged.get(s.conceptId);
        if (had) had.because.push(...s.because);
        else merged.set(s.conceptId, s);
      }
    return [...merged.values()].sort((a, b) => b.because.length - a.because.length);
  });

  /** V5-07: my explanations in one period, with who each confused or cleared. */
  app.get<{ Params: { id: string } }>("/api/periods/:id/confusion", async (req, reply) => {
    if (!sqlite.prepare("SELECT 1 FROM periods WHERE id = ?").get(req.params.id))
      return reply.code(404).send({ error: "no such period" });
    return confusionMap(deps.handle, req.params.id);
  });
}
