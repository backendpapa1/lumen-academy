// pnpm eval:agents — M1 gate: leak rate, mirror check, latency and cost.
// Fresh eval DB per run (data/eval/), fixed curriculum and seeded cohort, so the
// only difference between the two classrooms is the quality of the teaching.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { activeProfile, type Archetype } from "@lumen/shared";
import { answerQuestion, gradeAnswer } from "../src/agents/assessment.js";
import { guardUtterance } from "../src/agents/realtime/leakGuard.js";
import { findConfigDir, loadConfig } from "../src/config/load.js";
import { dataDir, loadDotEnv } from "../src/config/paths.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { saveCurriculum } from "../src/db/curriculum.js";
import { newId } from "../src/db/ids.js";
import { cadets, classrooms, concepts } from "../src/db/schema.js";
import { ClassSession } from "../src/game/ClassSession.js";
import { cadetPack } from "../src/game/packs.js";
import { planCohort, type CadetPlan } from "../src/game/registration.js";
import { OpenAIEmbedder } from "../src/ingest/embed.js";
import { ensureSchool, ingestSource } from "../src/ingest/pipeline.js";
import { ModelFactory } from "../src/models/factory.js";
import { UsageMeter } from "../src/usage/meter.js";

const root = dirname(findConfigDir());
loadDotEnv(root);
const cfg = loadConfig();
// Evals guard every utterance so the leak rate covers all of them.
cfg.models.agents.leakGuard = { ...cfg.models.agents.leakGuard, sampleRate: 1 };
const FIX = join(root, "fixtures/blockchain-ch1");
const SPEAK_EVERY = 1; // call on the top hand every N teaching messages
const MIRROR_MARGIN = 0.15; // correct-lesson exam mean must beat wrong-lesson by this (0..1 scale)
const LEAK_TARGET = 0.03;
const started = new Date();
const stamp = started.toISOString().replace(/[:.]/g, "-").slice(0, 19);

mkdirSync(join(dataDir(cfg), "eval"), { recursive: true });
const handle = openDb(join(dataDir(cfg), "eval", `${stamp}.db`));
runMigrations(handle);
const meter = new UsageMeter({ db: handle.db, pricing: cfg.pricing, budget: cfg.models.budget });
const factory = new ModelFactory({ config: cfg.models, env: process.env, meter });
const embedder = new OpenAIEmbedder({ config: cfg.models, env: process.env, meter });
const log = (s: string) =>
  console.log(`[${((Date.now() - started.getTime()) / 1000).toFixed(0)}s] ${s}`);

// --- World: source, fixed curriculum, seeded cohort ---------------------------
interface EvalConcept {
  title: string;
  summary: string;
  keyFacts: string[];
  misconceptions: string[];
  citeHeading: string;
  difficulty: number;
  exam: { question: string; facts: number[] };
}
const evalCur = JSON.parse(readFileSync(join(FIX, "eval-curriculum.json"), "utf8")) as {
  modules: Array<{ title: string; goal: string; concepts: EvalConcept[] }>;
};
const schoolId = ensureSchool(handle, "Blockchain (eval)").id;
await ingestSource(
  { handle, embedder, dataDir: join(dataDir(cfg), "eval", "uploads") },
  {
    schoolId,
    title: "Mastering Bitcoin ch. 11",
    kind: "md",
    data: readFileSync(join(FIX, "source.md"), "utf8"),
  },
);
const chunkRows = handle.sqlite.prepare("SELECT id, heading_path FROM chunks").all() as {
  id: string;
  heading_path: string | null;
}[];
saveCurriculum(handle, schoolId, {
  modules: evalCur.modules.map((m) => ({
    title: m.title,
    goal: m.goal,
    concepts: m.concepts.map((c) => {
      const citations = chunkRows
        .filter((r) => (r.heading_path ?? "").endsWith(c.citeHeading))
        .map((r) => r.id);
      if (!citations.length) throw new Error(`no chunks under "${c.citeHeading}"`);
      return {
        title: c.title,
        summary: c.summary,
        keyFacts: c.keyFacts,
        misconceptions: c.misconceptions,
        prerequisites: [],
        citations,
        difficulty: c.difficulty,
      };
    }),
  })),
});
const conceptRows = handle.db.select().from(concepts).all();
const conceptByTitle = new Map(conceptRows.map((c) => [c.title, c]));
const evalConcepts = evalCur.modules.flatMap((m) => m.concepts);
log(`world ready: ${chunkRows.length} chunks, ${conceptRows.length} concepts`);

const NAMES = [
  "Ada Quill",
  "Bo Renn",
  "Cy Marlo",
  "Dee Okafor",
  "Eli Varga",
  "Fen Ito",
  "Gia Moreau",
  "Hal Brandt",
  "Ivy Achebe",
  "Jo Kaur",
];
const plan = planCohort(20261021, "standard", cfg.game, { size: 10 });
function evalClassroom(name: string, cohort: CadetPlan[]): string {
  const classroomId = newId("classroom");
  const now = new Date().toISOString();
  handle.db
    .insert(classrooms)
    .values({ id: classroomId, schoolId, name, status: "active", seed: 20261021, createdAt: now })
    .run();
  cohort.forEach((p, i) =>
    handle.db
      .insert(cadets)
      .values({
        id: newId("cadet"),
        classroomId,
        seat: p.seat,
        name: NAMES[i]!,
        homeworld: p.homeworld,
        archetype: p.archetype,
        traitsJson: JSON.stringify(p.traits),
        learningStyle: p.learningStyle,
        quirk: `A typical ${p.archetype.replace("_", " ")}.`,
        voiceNotes: "Plain, short sentences.",
        enrolledAt: now,
      })
      .run(),
  );
  return classroomId;
}

// --- Teach both lessons ---------------------------------------------------------
interface LessonRun {
  id: string;
  classroomId: string;
  firstReaction: number[];
  commit: number[];
  cadetFirstToken: number[];
  utterances: Array<{
    name: string;
    text: string;
    delivered: string;
    action: string;
    leaked: string[];
    deliveredLeak: boolean;
  }>;
  turns: number;
  lowConfidence: number;
  plantedCaught: number;
  planted: number;
}
const runs: LessonRun[] = [];
for (const lessonId of ["correct", "wrong"] as const) {
  const lesson = JSON.parse(readFileSync(join(FIX, `lessons/${lessonId}.json`), "utf8")) as {
    messages: Array<{ concept: string; text: string; plantedError?: string }>;
  };
  const classroomId = evalClassroom(`Eval ${lessonId}`, plan);
  const run: LessonRun = {
    id: lessonId,
    classroomId,
    firstReaction: [],
    commit: [],
    cadetFirstToken: [],
    utterances: [],
    turns: 0,
    lowConfidence: 0,
    plantedCaught: 0,
    planted: 0,
  };
  const session = ClassSession.open(
    { handle, factory, game: cfg.game, embedder },
    { classroomId, conceptId: conceptByTitle.get(lesson.messages[0]!.concept)!.id },
  );
  for (const [i, m] of lesson.messages.entries()) {
    const t0 = performance.now();
    const turn = session.teach(m.text, { conceptId: conceptByTitle.get(m.concept)!.id });
    const [reaction, committed] = await Promise.all([turn.reaction, turn.committed]);
    run.turns++;
    if (reaction?.firstReactionMs != null) run.firstReaction.push(reaction.firstReactionMs);
    run.commit.push(performance.now() - t0);
    if (committed.lowConfidence) run.lowConfidence++;
    if (m.plantedError) {
      run.planted++;
      if (committed.analysis.teaching.errors.length) run.plantedCaught++;
    }
    if ((i + 1) % SPEAK_EVERY === 0 && session.handQueue.length) {
      const hand = session.handQueue[0]!;
      const spoken = await session.speak(hand.cadetId);
      if (spoken) {
        const outcome = await spoken.guard;
        if (spoken.firstTokenMs != null) run.cadetFirstToken.push(spoken.firstTokenMs);
        const name = session.roster.find((c) => c.id === hand.cadetId)?.name ?? "?";
        // Delivered leak: a failed rewrite, or a rewrite that an independent re-check still flags.
        let deliveredLeak = outcome.action === "rewrite_failed";
        if (outcome.action === "rewrite") {
          const taughtSoFar = lesson.messages.slice(0, i + 1).map((x) => x.text);
          const recheck = await guardUtterance(factory, {
            utteranceId: `${spoken.messageId}:recheck`,
            utterance: outcome.text,
            taughtLines: taughtSoFar,
            flaggedTerms: [],
            forced: true,
            sampleRate: 1,
            persona: { name, voiceNotes: "Plain." },
          });
          deliveredLeak = recheck.action !== "pass";
        }
        run.utterances.push({
          name,
          text: spoken.utterance.text,
          delivered: outcome.text,
          action: outcome.action,
          leaked: outcome.leakedTerms,
          deliveredLeak,
        });
      }
    }
  }
  await session.close();
  runs.push(run);
  log(
    `taught "${lessonId}": ${run.turns} turns, ${run.utterances.length} cadet utterances, planted errors caught ${run.plantedCaught}/${run.planted}`,
  );
}

// --- Exam: every cadet answers one question per concept from their pack --------
interface ExamRow {
  lesson: string;
  concept: string;
  cadet: string;
  archetype: Archetype;
  comprehension: number;
  retained: number;
  misconceptions: number;
  score: number;
  answer: string;
}
const exam: ExamRow[] = [];
const jobs: Array<() => Promise<void>> = [];
for (const run of runs) {
  const roster = handle.db
    .select()
    .from(cadets)
    .all()
    .filter((c) => c.classroomId === run.classroomId);
  for (const cadet of roster) {
    for (const ec of evalConcepts) {
      const concept = conceptByTitle.get(ec.title)!;
      jobs.push(async () => {
        const keyFacts = JSON.parse(concept.keyFactsJson) as string[];
        const pack = cadetPack(handle, {
          classroomId: run.classroomId,
          cadetId: cadet.id,
          concept: { id: concept.id, title: concept.title, keyFacts },
          purpose: "eval-exam",
        });
        const traits = JSON.parse(cadet.traitsJson) as { confidence: number };
        const ans = await answerQuestion(
          factory,
          {
            name: cadet.name,
            homeworld: cadet.homeworld,
            archetype: cadet.archetype as Archetype,
            voiceNotes: cadet.voiceNotes,
            confidence: traits.confidence,
          },
          [pack],
          ec.exam.question,
          { purpose: "exam" },
        );
        const grade = await gradeAnswer(
          factory,
          ec.exam.question,
          ec.exam.facts.map((n) => keyFacts[n - 1]!),
          ans.answer,
        );
        const comp = handle.sqlite
          .prepare("SELECT comprehension FROM ledger_entries WHERE cadet_id = ? AND concept_id = ?")
          .get(cadet.id, concept.id) as { comprehension: number } | undefined;
        exam.push({
          lesson: run.id,
          concept: ec.title,
          cadet: cadet.name,
          archetype: cadet.archetype as Archetype,
          comprehension: comp?.comprehension ?? 0,
          retained: pack.retained.length,
          misconceptions: pack.misconceptions.length,
          score: grade.score / 5,
          answer: ans.answer,
        });
      });
    }
  }
}
const queue = [...jobs];
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try {
        await job();
      } catch (e) {
        console.log(`  exam job failed: ${String(e).slice(0, 140)}`);
      }
    }
  }),
);
log(`exam graded: ${exam.length} answers`);

// --- Metrics --------------------------------------------------------------------
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : NaN;
};
const ms = (x: number) => `${Math.round(x)}ms`;
const examMean = (lesson: string, concept?: string) =>
  mean(
    exam
      .filter((e) => e.lesson === lesson && (!concept || e.concept === concept))
      .map((e) => e.score),
  );
const compMean = (lesson: string) =>
  mean(exam.filter((e) => e.lesson === lesson).map((e) => e.comprehension));
const utterances = runs.flatMap((r) => r.utterances);
const leaks = utterances.filter((u) => u.action === "rewrite" || u.action === "rewrite_failed");
const rawLeakRate = utterances.length ? leaks.length / utterances.length : 0;
const delivered = utterances.filter((u) => u.deliveredLeak);
const leakRate = utterances.length ? delivered.length / utterances.length : 0;
const speakers = new Set(utterances.map((u) => u.name)).size;
const gap = examMean("correct") - examMean("wrong");
const conceptWins = evalConcepts.filter(
  (c) => examMean("correct", c.title) > examMean("wrong", c.title),
).length;
const mirrorPass = gap >= MIRROR_MARGIN && conceptWins >= Math.ceil((evalConcepts.length * 2) / 3);
const leakPass = leakRate < LEAK_TARGET;

const usage = handle.sqlite
  .prepare(
    "SELECT agent, count(*) n, sum(input_tokens) i, sum(cached_tokens) c, sum(output_tokens) o, sum(est_usd) usd FROM usage_log GROUP BY agent ORDER BY usd DESC",
  )
  .all() as { agent: string; n: number; i: number; c: number; o: number; usd: number }[];
const classUsd =
  (
    handle.sqlite
      .prepare("SELECT sum(est_usd) usd FROM usage_log WHERE period_id IS NOT NULL")
      .get() as { usd: number }
  ).usd ?? 0;
const totalTurns = runs.reduce((a, r) => a + r.turns, 0);
const perTurn = classUsd / totalTurns;
const perPeriod = perTurn * 20; // docs/04 §7: ~20 teaching turns per 15-minute period
const all = (k: "firstReaction" | "commit" | "cadetFirstToken") => runs.flatMap((r) => r[k]);

const lines: string[] = [];
const out = (s = "") => lines.push(s);
out(`# Eval report — ${started.toISOString().slice(0, 16).replace("T", " ")} UTC`);
out();
out(
  `Profile \`${cfg.models.profile}\` (${activeProfile(cfg.models).fast.model}) · fixture blockchain-ch1 · cohort seed 20261021, 10 cadets · eval DB \`data/eval/${stamp}.db\``,
);
out();
out("| Gate | Target | Result | |");
out("|---|---|---|---|");
out(
  `| Leak rate, delivered (after Leak Guard) | < ${LEAK_TARGET * 100}% | ${(leakRate * 100).toFixed(1)}% (${delivered.length}/${utterances.length}) | ${leakPass ? "✅" : "❌"} |`,
);
out(
  `| Leak rate, raw (before Leak Guard; info) | < ${LEAK_TARGET * 100}% | ${(rawLeakRate * 100).toFixed(1)}% (${leaks.length}/${utterances.length}) | ${rawLeakRate < LEAK_TARGET ? "✅" : "⚠"} |`,
);
out(
  `| Mirror check | correct − wrong ≥ ${MIRROR_MARGIN} and ≥ ${Math.ceil((evalConcepts.length * 2) / 3)}/${evalConcepts.length} concepts | ${gap.toFixed(2)} (${examMean("correct").toFixed(2)} vs ${examMean("wrong").toFixed(2)}), ${conceptWins}/${evalConcepts.length} concepts | ${mirrorPass ? "✅" : "❌"} |`,
);
out(
  `| First reaction p50 | ≤ 1.5s | ${ms(pct(all("firstReaction"), 50))} (p95 ${ms(pct(all("firstReaction"), 95))}) | ${pct(all("firstReaction"), 50) <= 1500 ? "✅" : "❌"} |`,
);
out(
  `| Cadet first token p50 | ≤ 3s | ${ms(pct(all("cadetFirstToken"), 50))} (p95 ${ms(pct(all("cadetFirstToken"), 95))}) | ${pct(all("cadetFirstToken"), 50) <= 3000 ? "✅" : "❌"} |`,
);
out(
  `| Cost per 15-min period | ≤ $0.15 | $${perPeriod.toFixed(4)} ($${perTurn.toFixed(5)}/turn incl. cadet talk + guard) | ${perPeriod <= 0.15 ? "✅" : "❌"} |`,
);
out();
out("## Mirror detail");
out();
out("| Concept | Correct lesson | Wrong lesson |");
out("|---|---|---|");
for (const c of evalConcepts)
  out(
    `| ${c.title} | ${examMean("correct", c.title).toFixed(2)} | ${examMean("wrong", c.title).toFixed(2)} |`,
  );
out(
  `| **Class comprehension (ledger)** | ${compMean("correct").toFixed(2)} | ${compMean("wrong").toFixed(2)} |`,
);
out();
for (const r of runs)
  out(
    `- \`${r.id}\`: planted errors flagged by the Director ${r.plantedCaught}/${r.planted}; low-confidence turns ${r.lowConfidence}/${r.turns}; Director commit p50 ${ms(pct(r.commit, 50))}`,
  );
out();
out(`## Cadet utterances (Leak Guard on every one; ${speakers} different speakers)`);
out();
for (const r of runs)
  for (const u of r.utterances) {
    out(
      `- [${r.id}] **${u.name}** (${u.action}${u.leaked.length ? `: ${u.leaked.join(", ")}` : ""}): "${u.text}"`,
    );
    if (u.action === "rewrite")
      out(`  - delivered${u.deliveredLeak ? " (STILL LEAKS)" : ""}: "${u.delivered}"`);
  }
out();
out("## Sample exam answers");
out();
for (const lesson of ["correct", "wrong"]) {
  const sample = exam
    .filter((e) => e.lesson === lesson && e.concept === "Merkle Trees")
    .sort((a, b) => b.score - a.score);
  for (const e of [sample[0], sample.at(-1)].filter(Boolean))
    out(
      `- [${lesson}] ${e!.cadet} (${e!.archetype}, comprehension ${e!.comprehension.toFixed(2)}, ${e!.retained} facts, ${e!.misconceptions} misconceptions) scored ${(e!.score * 5).toFixed(0)}/5: "${e!.answer.slice(0, 220)}"`,
    );
}
out();
out("## Usage by agent");
out();
out("| Agent | Calls | Input tok (cached) | Output tok | USD |");
out("|---|---|---|---|---|");
for (const u of usage)
  out(
    `| ${u.agent} | ${u.n} | ${u.i ?? 0} (${u.c ?? 0}) | ${u.o ?? 0} | ${(u.usd ?? 0).toFixed(4)} |`,
  );
out();
out(
  `Total eval cost $${meter.totals().monthUsd.toFixed(4)} · wall time ${((Date.now() - started.getTime()) / 1000).toFixed(0)}s`,
);

const report = lines.join("\n") + "\n";
const reportPath = join(root, "eval/reports", `${stamp}-${cfg.models.profile}.md`);
writeFileSync(reportPath, report);
console.log(`\n${report}\nReport: ${reportPath}`);
handle.close();
process.exit(leakPass && mirrorPass ? 0 : 1);
