// Spike M1-S1 (ADR-002): does the Crowd Reactor hit ≤1.5s p50 on the committed
// config, and how long does the Class Director take in parallel?
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { normalizeTeachingAnalysis, TeachingAnalysisZ, type CadetCard } from "@lumen/shared";
import { dirname } from "node:path";
import { callStructured } from "../../src/agents/harness.js";
import { loadPrompt } from "../../src/agents/prompts/load.js";
import {
  cadetTable,
  keyFactList,
  recentTranscript,
  type TranscriptLine,
} from "../../src/agents/realtime/context.js";
import { runCrowdReactor } from "../../src/agents/realtime/crowdReactor.js";
import { findConfigDir, loadConfig } from "../../src/config/load.js";
import { dbPath, loadDotEnv } from "../../src/config/paths.js";
import { openDb, runMigrations } from "../../src/db/client.js";
import { ModelFactory } from "../../src/models/factory.js";
import { UsageMeter } from "../../src/usage/meter.js";

loadDotEnv(dirname(findConfigDir()));
const cfg = loadConfig();
const handle = openDb(dbPath(cfg));
runMigrations(handle);
const meter = new UsageMeter({ db: handle.db, pricing: cfg.pricing, budget: cfg.models.budget });
const factory = new ModelFactory({ config: cfg.models, env: process.env, meter });
const RUNS = Number(process.argv[2] ?? 20);
const CADETS = Number(process.argv[3] ?? 10);
// Optional role override for the Director, e.g. "fast" to compare thinking off.
const DIRECTOR_ROLE = process.argv[4] as "fast" | "standard" | "heavy" | undefined;

const concept = {
  id: "cpt_merkle",
  title: "Merkle Trees",
  keyFacts: [
    "A Merkle tree hashes transactions in pairs, level by level, until one hash remains: the Merkle root.",
    "The Merkle root is stored in the block header, not in each transaction.",
    "Changing any transaction changes the Merkle root.",
    "A Merkle path lets a light client verify a transaction is in a block with about log2(n) hashes.",
    "If a level has an odd number of hashes, the last hash is duplicated.",
  ],
  misconceptions: [
    "The Merkle root is stored in every transaction.",
    "You need all transactions to verify one.",
  ],
};

const names = [
  "Ines Okoro-Vale",
  "Tomas Reyes",
  "Adaeze Bello",
  "Kai Nakamura",
  "Lena Petrov",
  "Femi Adeyemi",
  "Sora Lin",
  "Maya Haddad",
  "Oskar Brandt",
  "Zuri Mwangi",
  "Ravi Iyer",
  "Ana Souza",
  "Theo Laurent",
  "Nia Achebe",
  "Yusuf Kaya",
];
const archetypes: CadetCard["archetype"][] = [
  "skeptic",
  "lost_signal",
  "literalist",
  "overachiever",
  "pragmatist",
  "connector",
  "quiet",
  "lost_signal",
  "skeptic",
  "connector",
  "quiet",
  "pragmatist",
  "literalist",
  "lost_signal",
  "skeptic",
];
const cards: CadetCard[] = names.slice(0, CADETS).map((name, i) => ({
  id: `cdt_${String(i).padStart(2, "0")}`,
  name,
  archetype: archetypes[i]!,
  attention: 0.4 + ((i * 37) % 60) / 100,
  skepticism: 0.2 + ((i * 53) % 70) / 100,
  learningStyle: (["example-first", "analogy", "formal", "visual"] as const)[i % 4]!,
  comprehension: 0.1 + ((i * 29) % 50) / 100,
  misconceptions: i % 4 === 1 ? [concept.misconceptions[0]!] : [],
  lastState: "attentive",
  spokeTurnsAgo: i % 3 === 0 ? null : i % 5,
}));

const lesson = [
  "Today we're looking at Merkle trees. They're how a block summarises all its transactions in one hash.",
  "Picture a tournament bracket. Transactions pair up, each pair gets hashed together, winners move up.",
  "You keep pairing and hashing until only one hash is left. That final hash is the Merkle root.",
  "The root goes in the block header. So the header commits to every single transaction.",
  "If anyone changes even one transaction, its hash changes, and that ripples all the way up to the root.",
  "Quick check: what happens to the root if I swap two transactions? Think about it.",
  "Right, it changes, because the pairs change.",
  "Each transaction actually stores the Merkle root inside it, that's how they're linked.", // wrong on purpose
  "Sorry, correction: the root lives only in the block header. Transactions don't carry it.",
  "Now, why bother? Light clients. A phone can't download every transaction.",
  "With a Merkle path, you only need a handful of hashes, about log base 2 of the number of transactions.",
  "So for a thousand transactions, around ten hashes. That's the magic.",
  "What if there's an odd number at some level? The last one gets paired with itself.",
  "It's like the odd kid out in the bracket playing against a mirror.",
  "Let's recap: pairs, hash, repeat, root in the header, short proofs.",
  "Any questions so far?",
  "Merkle trees also make blocks smaller because they compress the transactions.", // wrong on purpose
  "Hmm, scratch that. They don't compress anything; the transactions are all still there.",
  "Think of the root as a fingerprint of the whole set.",
  "Next time we'll see how this connects to block headers and mining.",
];

const directorSystem = new SystemMessage(
  loadPrompt("classDirector", {
    conceptId: concept.id,
    conceptTitle: concept.title,
    keyFacts: keyFactList(concept.keyFacts),
    knownMisconceptions: concept.misconceptions.map((m) => `- ${m}`).join("\n"),
    cadetTable: cadetTable(cards, { withSpoke: false }),
  }),
);

interface Row {
  turn: number;
  firstMs: number;
  reactorMs: number;
  directorMs: number;
  filled: number;
  skipped: number;
  hands: number;
  reasked: boolean;
  errors: number;
  accuracy: number;
}
const rows: Row[] = [];
const failures: string[] = [];
const transcript: TranscriptLine[] = [];
const startUsd = meter.totals().monthUsd;

for (let t = 0; t < RUNS; t++) {
  const said = lesson[t % lesson.length]!;
  const user = new HumanMessage(
    `Recent class:\n${recentTranscript(transcript)}\n\nThe Headmaster just said:\n"${said}"`,
  );
  const started = performance.now();
  const reactor = runCrowdReactor(factory, {
    cards,
    conceptTitle: concept.title,
    transcript,
    teacherMessage: said,
    maxHands: cfg.game.hands.maxPerTurn,
  });
  const director = callStructured(factory, "classDirector", {
    schema: TeachingAnalysisZ,
    name: "teaching_analysis",
    messages: [directorSystem, user],
    ...(DIRECTOR_ROLE ? { resolve: { role: DIRECTOR_ROLE } } : {}),
  }).then((r) => ({ r, ms: performance.now() - started }));
  const [rx, dx] = await Promise.allSettled([reactor, director]);
  if (rx.status === "rejected" || dx.status === "rejected") {
    const why = [rx, dx]
      .filter((x) => x.status === "rejected")
      .map((x) => String((x as PromiseRejectedResult).reason).slice(0, 160));
    failures.push(`turn ${t + 1}: ${why.join(" | ")}`);
    console.log(`turn ${String(t + 1).padStart(2)} FAILED ${why.join(" | ")}`);
    transcript.push({ speaker: "Headmaster", text: said });
    continue;
  }
  const analysis = normalizeTeachingAnalysis(dx.value.r.data);
  rows.push({
    turn: t + 1,
    firstMs: Math.round(rx.value.firstReactionMs ?? rx.value.totalMs),
    reactorMs: Math.round(rx.value.totalMs),
    directorMs: Math.round(dx.value.ms),
    filled: rx.value.filled,
    skipped: rx.value.skippedLines,
    hands: rx.value.reaction.handRaises.length,
    reasked: dx.value.r.reasked,
    errors: analysis.teaching.errors.length,
    accuracy: analysis.teaching.accuracy,
  });
  transcript.push({ speaker: "Headmaster", text: said });
  const last = rows.at(-1)!;
  console.log(
    `turn ${String(last.turn).padStart(2)} first reaction ${last.firstMs}ms · all ${last.reactorMs}ms · director ${last.directorMs}ms · filled ${last.filled} · bad lines ${last.skipped} · hands ${last.hands} · acc ${last.accuracy.toFixed(2)} · errors ${last.errors}${last.reasked ? ` · REASKED: ${dx.value.r.reaskReason?.slice(0, 200)}` : ""}`,
  );
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const warm = rows.filter((x) => x.turn > 1);
const f = warm.map((x) => x.firstMs);
const r = warm.map((x) => x.reactorMs);
const d = warm.map((x) => x.directorMs);
const usd = meter.totals().monthUsd - startUsd;
console.log(
  `\n${CADETS} cadets, ${RUNS} turns (turn 1 excluded as warm-up), failures ${failures.length}`,
);
console.log(`first reaction p50 ${pct(f, 50)}ms  p95 ${pct(f, 95)}ms`);
console.log(`all reactions  p50 ${pct(r, 50)}ms  p95 ${pct(r, 95)}ms`);
console.log(`classDirector  p50 ${pct(d, 50)}ms  p95 ${pct(d, 95)}ms  max ${Math.max(...d)}ms`);
console.log(
  `cadets filled (skipped by model) total ${rows.reduce((a, x) => a + x.filled, 0)} · malformed lines ${rows.reduce((a, x) => a + x.skipped, 0)} · director re-asks ${rows.filter((x) => x.reasked).length}`,
);
console.log(
  `wrong-on-purpose turns 8 & 17 flagged: ${[8, 17].map((n) => (rows.find((x) => x.turn === n)?.errors ?? 0) > 0).join(", ")} · false errors on other turns: ${
    rows
      .filter((x) => ![8, 17].includes(x.turn) && x.errors > 0)
      .map((x) => x.turn)
      .join(",") || "none"
  }`,
);
console.log(
  `cost for ${RUNS} turns: $${usd.toFixed(4)} → per 20-turn period ≈ $${((usd / RUNS) * 20).toFixed(4)} (reactor + director only)`,
);
handle.close();
