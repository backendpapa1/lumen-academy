// Spike M1-S2 (ADR-003): do answers built only from the knowledge pack score
// worse as comprehension drops? 0.0 is the leak detector: it should score ~0.
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { dirname } from "node:path";
import { z } from "zod";
import { callStructured } from "../../src/agents/harness.js";
import { loadPrompt } from "../../src/agents/prompts/load.js";
import { findConfigDir, loadConfig } from "../../src/config/load.js";
import { dbPath, loadDotEnv } from "../../src/config/paths.js";
import { openDb, runMigrations } from "../../src/db/client.js";
import { formatPack, knowledgePack } from "../../src/game/knowledgePack.js";
import { ModelFactory } from "../../src/models/factory.js";
import { UsageMeter } from "../../src/usage/meter.js";

loadDotEnv(dirname(findConfigDir()));
const cfg = loadConfig();
const handle = openDb(dbPath(cfg));
runMigrations(handle);
const meter = new UsageMeter({ db: handle.db, pricing: cfg.pricing, budget: cfg.models.budget });
const factory = new ModelFactory({ config: cfg.models, env: process.env, meter });

const facts = [
  "A Merkle tree hashes transactions in pairs, level by level, until one hash remains: the Merkle root.",
  "The Merkle root is stored in the block header, not in each transaction.",
  "Changing any transaction changes the Merkle root.",
  "A Merkle path lets a light client verify a transaction is in a block with about log2(n) hashes.",
  "If a level has an odd number of hashes, the last hash is duplicated.",
];
const questions = [
  { q: "What is a Merkle root, how is it built, and where is it stored?", needs: [1, 2] },
  { q: "Why does changing a single transaction matter for the Merkle root?", needs: [3] },
  {
    q: "How can a light client check that a transaction is in a block without downloading every transaction?",
    needs: [4],
  },
];
const LEVELS = (process.argv[2] ?? "0,0.2,0.5,0.9").split(",").map(Number);
const SEEDS = ["cdt_a", "cdt_b", "cdt_c"];

const AnswerZ = z.object({ answer: z.string(), confidence: z.number() });
const GradeZ = z.object({
  score: z.number(),
  present: z.array(z.string()),
  missing: z.array(z.string()),
  contradictions: z.array(z.string()),
  rationale: z.string(),
});

interface Job {
  level: number;
  seed: string;
  qi: number;
  misconception?: string;
}
const jobs: Job[] = [];
for (const level of LEVELS)
  for (const seed of SEEDS)
    for (let qi = 0; qi < questions.length; qi++) jobs.push({ level, seed, qi });
// Misconception case: half understanding plus a confident wrong belief about Q1.
for (const seed of SEEDS)
  jobs.push({
    level: 0.5,
    seed,
    qi: 0,
    misconception: "The Merkle root is stored inside every transaction.",
  });

async function run(job: Job) {
  const { q, needs } = questions[job.qi]!;
  const pack = knowledgePack({
    conceptTitle: "Merkle Trees",
    taught: facts.map((fact) => ({ fact, timesCovered: 2 })),
    comprehension: job.level,
    misconceptions: job.misconception ? [job.misconception] : [],
    seed: { cadetId: job.seed, conceptId: "cpt_merkle", purpose: `q${job.qi}` },
  });
  const system = loadPrompt("cadetAnswer", {
    name: "Tomas Reyes",
    homeworld: "Ceres Exchange",
    archetype: "pragmatist",
    voiceNotes: "Plain, practical.",
    purpose: "homework",
    pack: formatPack([pack]),
    confidenceWord: "fairly confident",
    maxWords: 80,
  });
  const ans = await callStructured(factory, "cadetHomework", {
    schema: AnswerZ,
    name: "answer",
    messages: [new SystemMessage(system), new HumanMessage(q)],
  });
  const relevant = needs.map((n) => `kf${n}: ${facts[n - 1]}`).join("\n");
  const grade = await callStructured(factory, "grader", {
    schema: GradeZ,
    name: "grade",
    messages: [
      new SystemMessage(loadPrompt("grader", { question: q, facts: relevant })),
      new HumanMessage(`Student answer: ${ans.data.answer}`),
    ],
  });
  const neededRetained = needs.filter((n) => pack.retained.includes(facts[n - 1]!)).length;
  return {
    ...job,
    score: Math.max(0, Math.min(5, grade.data.score)),
    neededRetained,
    needed: needs.length,
    answer: ans.data.answer,
    contradictions: grade.data.contradictions.length,
  };
}

const startUsd = meter.totals().monthUsd;
const results: Awaited<ReturnType<typeof run>>[] = [];
const queue = [...jobs];
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try {
        results.push(await run(job));
      } catch (e) {
        console.log(`FAILED ${JSON.stringify(job)}: ${String(e).slice(0, 160)}`);
      }
    }
  }),
);

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
console.log("comprehension  mean score (0–5)  per question                needed facts retained");
for (const level of LEVELS) {
  const rows = results.filter((r) => r.level === level && !r.misconception);
  const perQ = questions
    .map((_, qi) => mean(rows.filter((r) => r.qi === qi).map((r) => r.score)).toFixed(1))
    .join(" / ");
  const retained = mean(rows.map((r) => r.neededRetained / r.needed));
  console.log(
    `${level.toFixed(1).padEnd(14)} ${mean(rows.map((r) => r.score))
      .toFixed(2)
      .padEnd(17)} ${perQ.padEnd(27)} ${(retained * 100).toFixed(0)}%`,
  );
}
const plain = results.filter((r) => !r.misconception);
const noneRetained = plain.filter((r) => r.neededRetained === 0);
const allRetained = plain.filter((r) => r.neededRetained === r.needed);
console.log(
  `\nby pack content: needed facts NOT retained → mean ${mean(noneRetained.map((r) => r.score)).toFixed(2)} (n=${noneRetained.length}, max ${Math.max(...noneRetained.map((r) => r.score))}) · ALL retained → mean ${mean(allRetained.map((r) => r.score)).toFixed(2)} (n=${allRetained.length})`,
);
for (const r of noneRetained.filter((x) => x.score >= 3))
  console.log(
    `  possible leak (q${r.qi + 1}, level ${r.level}, score ${r.score}): "${r.answer.slice(0, 160)}"`,
  );
const mis = results.filter((r) => r.misconception);
const plainQ1 = results.filter((r) => r.level === 0.5 && r.qi === 0 && !r.misconception);
console.log(
  `\nQ1 at 0.5 without misconception: ${mean(plainQ1.map((r) => r.score)).toFixed(2)} · with "root in every tx": ${mean(mis.map((r) => r.score)).toFixed(2)} (contradictions flagged ${mis.filter((r) => r.contradictions > 0).length}/${mis.length})`,
);
const zero = results.filter((r) => r.level === 0);
console.log(
  `leak check, comprehension 0.0: max score ${Math.max(...zero.map((r) => r.score))} · sample answer: "${zero[0]?.answer.slice(0, 140)}"`,
);
const top = results.filter((r) => r.level === 0.9 && r.qi === 0);
console.log(`sample 0.9 answer: "${top[0]?.answer.slice(0, 200)}"`);
console.log(
  `\ncost: $${(meter.totals().monthUsd - startUsd).toFixed(4)} for ${results.length} answer+grade pairs`,
);
handle.close();
