// Spike M1-S4 (ADR-001): one cadet turn as createDeepAgent vs lean createAgent,
// same model, prompt and tools. Gate: deepagents everywhere only if it adds
// < 300ms p50 and < 20% tokens.
import { tool } from "@langchain/core/tools";
import { createDeepAgent } from "deepagents";
import { createAgent } from "langchain";
import { dirname } from "node:path";
import { z } from "zod";
import { findConfigDir, loadConfig } from "../../src/config/load.js";
import { loadDotEnv } from "../../src/config/paths.js";
import { buildModel } from "../../src/models/factory.js";
import { resolveSpec } from "../../src/models/spec.js";
import type { UsageEvent } from "../../src/usage/meter.js";

loadDotEnv(dirname(findConfigDir()));
const cfg = loadConfig();
const RUNS = Number(process.argv[2] ?? 10);

let tally = { calls: 0, input: 0, output: 0 };
const sink = {
  record: (e: UsageEvent) => {
    tally.calls++;
    tally.input += e.inputTokens ?? 0;
    tally.output += e.outputTokens ?? 0;
  },
  budgetState: () => "ok",
  assertCanCall: () => {},
};
const model = buildModel(resolveSpec(cfg.models, "cadetTalk"), {
  config: cfg.models,
  env: process.env,
  meter: sink,
});

const transcript = [
  "Headmaster: A Merkle tree hashes transactions in pairs until one hash is left, the Merkle root.",
  "Headmaster: The root goes in the block header.",
  "Headmaster: Change one transaction and the root changes.",
];
const tools = [
  tool(
    async ({ query }: { query: string }) =>
      transcript
        .filter((l) => l.toLowerCase().includes(query.toLowerCase().split(" ")[0] ?? ""))
        .join("\n") || transcript.join("\n"),
    {
      name: "recall_lesson",
      description: "Search what the Headmaster said in this class.",
      schema: z.object({ query: z.string() }),
    },
  ),
  tool(async () => "Merkle root = summary hash. Stored in... every transaction? (not sure)", {
    name: "read_my_notes",
    description: "Read your own notes from class.",
    schema: z.object({}),
  }),
  tool(
    async () =>
      JSON.stringify({
        concept: "Merkle Trees",
        comprehension: 0.35,
        misconceptions: ["The root is stored in every transaction."],
      }),
    {
      name: "check_ledger",
      description: "Check how well you understand the current concept.",
      schema: z.object({}),
    },
  ),
];
const systemPrompt = `You are Tomas Reyes, a Lost Signal cadet at Lumen Academy. You only know what the Headmaster taught (use your tools to check). Never introduce facts the Headmaster hasn't said. Under 60 words. One question at a time.
You raised your hand to clarify: "Wait, where does the root actually live?"`;
const userTurn = {
  messages: [{ role: "user", content: "Headmaster: Go ahead, Tomas, what's your question?" }],
};

const lean = createAgent({ model, tools, systemPrompt });
const deep = createDeepAgent({ model, tools, systemPrompt });

type Row = { ms: number; calls: number; input: number; output: number; text: string };
async function once(agent: {
  invoke: (x: typeof userTurn) => Promise<{ messages: Array<{ content: unknown }> }>;
}): Promise<Row> {
  tally = { calls: 0, input: 0, output: 0 };
  const t0 = performance.now();
  const out = await agent.invoke(userTurn);
  const last = out.messages.at(-1);
  return { ms: performance.now() - t0, ...tally, text: String(last?.content ?? "").slice(0, 120) };
}

const rows: Record<"lean" | "deep", Row[]> = { lean: [], deep: [] };
await once(lean);
await once(deep); // warm-up, not counted
for (let i = 0; i < RUNS; i++) {
  for (const [name, agent] of [
    ["lean", lean],
    ["deep", deep],
  ] as const) {
    try {
      rows[name].push(await once(agent as never));
    } catch (e) {
      console.log(`${name} run ${i} FAILED: ${String(e).slice(0, 160)}`);
    }
  }
}
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN;
};
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
for (const name of ["lean", "deep"] as const) {
  const r = rows[name];
  console.log(
    `${name.padEnd(5)} n=${r.length} p50 ${Math.round(
      pct(
        r.map((x) => x.ms),
        50,
      ),
    )}ms p95 ${Math.round(
      pct(
        r.map((x) => x.ms),
        95,
      ),
    )}ms · LLM calls/turn ${avg(r.map((x) => x.calls)).toFixed(1)} · input tok ${Math.round(avg(r.map((x) => x.input)))} · output tok ${Math.round(avg(r.map((x) => x.output)))}`,
  );
  console.log(`      sample: "${r[0]?.text}"`);
}
const dl =
  pct(
    rows.deep.map((x) => x.ms),
    50,
  ) -
  pct(
    rows.lean.map((x) => x.ms),
    50,
  );
const tl =
  avg(rows.deep.map((x) => x.input + x.output)) / avg(rows.lean.map((x) => x.input + x.output)) - 1;
console.log(
  `\ndeep − lean: +${Math.round(dl)}ms p50, ${(tl * 100).toFixed(0)}% tokens → gate (<300ms and <20%): ${dl < 300 && tl < 0.2 ? "PASS (use deepagents everywhere)" : "FAIL (keep the lean path for realtime)"}`,
);
