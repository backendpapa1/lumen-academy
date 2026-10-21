// pnpm eval:assessment — M4 gate: Grader agreement (≥85% within ±1 of the
// hand labels) and Examiner citation validity (100% delivered), on the fixed
// fixture. Fresh eval DB per run (data/eval/). Costs a few cents.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gradeAnswer } from "../src/agents/assessment.js";
import { draftQuestions, loadExamConcepts, questionProblems } from "../src/agents/examiner.js";
import { findConfigDir, loadConfig } from "../src/config/load.js";
import { dataDir, loadDotEnv } from "../src/config/paths.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { saveCurriculum } from "../src/db/curriculum.js";
import { pool } from "../src/game/pool.js";
import { OpenAIEmbedder } from "../src/ingest/embed.js";
import { ensureSchool, ingestSource } from "../src/ingest/pipeline.js";
import { ModelFactory } from "../src/models/factory.js";
import { UsageMeter } from "../src/usage/meter.js";

const root = dirname(findConfigDir());
loadDotEnv(root);
const cfg = loadConfig();
const FIX = join(root, "fixtures/blockchain-ch1");
const AGREEMENT_TARGET = 0.85;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
mkdirSync(join(dataDir(cfg), "eval"), { recursive: true });
const handle = openDb(join(dataDir(cfg), "eval", `assessment-${stamp}.db`));
runMigrations(handle);
const meter = new UsageMeter({ db: handle.db, pricing: cfg.pricing, budget: cfg.models.budget });
const factory = new ModelFactory({ config: cfg.models, env: process.env, meter });
const embedder = new OpenAIEmbedder({ config: cfg.models, env: process.env, meter });
const log = (s: string) => console.log(s);

// --- 1. Grader agreement on the labelled set -----------------------------------
interface Labels {
  questions: Array<{ id: string; question: string; facts: string[] }>;
  answers: Array<{ questionId: string; score: number; answer: string }>;
}
const labels = JSON.parse(readFileSync(join(FIX, "grader-labels.json"), "utf8")) as Labels;
log(`Grading ${labels.answers.length} labelled answers…`);
const graded = await pool(labels.answers, 6, async (a) => {
  const q = labels.questions.find((x) => x.id === a.questionId)!;
  const g = await gradeAnswer(factory, q.question, q.facts, a.answer);
  return { ...a, grader: g.score, rationale: g.rationale };
});
const within = graded.filter((g) => Math.abs(g.grader - g.score) <= 1).length;
const exact = graded.filter((g) => g.grader === g.score).length;
const agreement = within / graded.length;
log(`  within ±1: ${within}/${graded.length} (${(agreement * 100).toFixed(0)}%), exact ${exact}`);

// --- 2. Examiner citation validity on the fixture curriculum -----------------------
const evalCur = JSON.parse(readFileSync(join(FIX, "eval-curriculum.json"), "utf8")) as {
  modules: Array<{
    title: string;
    goal: string;
    concepts: Array<{
      title: string;
      summary: string;
      keyFacts: string[];
      misconceptions: string[];
      citeHeading: string;
      difficulty: number;
    }>;
  }>;
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
const chunkRows = handle.sqlite.prepare("SELECT id, heading_path FROM chunks").all() as Array<{
  id: string;
  heading_path: string | null;
}>;
saveCurriculum(handle, schoolId, {
  modules: evalCur.modules.map((m) => ({
    title: m.title,
    goal: m.goal,
    concepts: m.concepts.map((c) => ({
      title: c.title,
      summary: c.summary,
      keyFacts: c.keyFacts,
      misconceptions: c.misconceptions,
      prerequisites: [],
      citations: chunkRows
        .filter((r) => (r.heading_path ?? "").endsWith(c.citeHeading))
        .map((r) => r.id),
      difficulty: c.difficulty,
    })),
  })),
});
const conceptIds = (
  handle.sqlite.prepare("SELECT id FROM concepts ORDER BY ord").all() as Array<{ id: string }>
).map((r) => r.id);
const concepts = loadExamConcepts(handle, conceptIds);
const runs: Array<{ kind: "exam" | "assignment"; count: number }> = [
  { kind: "exam", count: Math.min(12, Math.max(5, concepts.length * 2)) },
  { kind: "assignment", count: 4 },
  { kind: "exam", count: 8 },
];
const examiner: Array<{
  kind: string;
  asked: number;
  firstValid: number;
  firstTotal: number;
  delivered: number;
  deliveredValid: number;
  attempts: number;
  kinds: Record<string, number>;
}> = [];
for (const r of runs) {
  log(`Examiner: ${r.kind} × ${r.count}…`);
  const res = await draftQuestions(factory, { kind: r.kind, count: r.count, concepts });
  const deliveredValid = res.questions.filter(
    (q) => !questionProblems(q, concepts, r.kind).length,
  ).length;
  const kinds: Record<string, number> = {};
  for (const q of res.questions) kinds[q.kind] = (kinds[q.kind] ?? 0) + 1;
  examiner.push({
    kind: r.kind,
    asked: r.count,
    firstValid: res.firstAttempt.valid,
    firstTotal: res.firstAttempt.total,
    delivered: res.questions.length,
    deliveredValid,
    attempts: res.attempts,
    kinds,
  });
  log(
    `  first attempt ${res.firstAttempt.valid}/${res.firstAttempt.total} valid · delivered ${deliveredValid}/${res.questions.length} · ${res.attempts} attempt(s)`,
  );
}
const delivered = examiner.reduce((s, e) => s + e.delivered, 0);
const deliveredValid = examiner.reduce((s, e) => s + e.deliveredValid, 0);
const firstTotal = examiner.reduce((s, e) => s + e.firstTotal, 0);
const firstValid = examiner.reduce((s, e) => s + e.firstValid, 0);
const cost = meter.totals().dayUsd;

// --- report ----------------------------------------------------------------------------
const pass = agreement >= AGREEMENT_TARGET && deliveredValid === delivered;
const lines = [
  `# Assessment eval · ${stamp} · ${cfg.models.profile}`,
  "",
  `| Gate | Target | Result | |`,
  `|---|---|---|---|`,
  `| Grader agreement | ≥ ${AGREEMENT_TARGET * 100}% within ±1 | ${(agreement * 100).toFixed(0)}% (${within}/${graded.length}; exact ${exact}) | ${agreement >= AGREEMENT_TARGET ? "✅" : "❌"} |`,
  `| Examiner citations (delivered) | 100% | ${((deliveredValid / delivered) * 100).toFixed(0)}% (${deliveredValid}/${delivered}) | ${deliveredValid === delivered ? "✅" : "❌"} |`,
  `| Examiner citations (first attempt, before fix-ups) | — | ${((firstValid / firstTotal) * 100).toFixed(0)}% (${firstValid}/${firstTotal}) | ℹ |`,
  `| Cost of this eval | — | $${cost.toFixed(4)} | ℹ |`,
  "",
  "Labels are Claude drafts pending Paul's review (fixtures/blockchain-ch1/grader-labels.json).",
  "",
  "## Grader disagreements (> ±1)",
  ...graded
    .filter((g) => Math.abs(g.grader - g.score) > 1)
    .map(
      (g) =>
        `- ${g.questionId}: label ${g.score}, grader ${g.grader}: "${g.answer.slice(0, 120)}" · ${g.rationale.slice(0, 160)}`,
    ),
  "",
  "## Examiner runs",
  ...examiner.map(
    (e) =>
      `- ${e.kind} × ${e.asked}: first ${e.firstValid}/${e.firstTotal}, delivered ${e.deliveredValid}/${e.delivered}, kinds ${JSON.stringify(e.kinds)}, attempts ${e.attempts}`,
  ),
];
const out = join(root, "eval/reports", `assessment-${stamp}.md`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join("\n") + "\n");
log(`\n${lines.slice(2, 8).join("\n")}\nReport: ${out}`);
handle.close();
process.exitCode = pass ? 0 : 1;
