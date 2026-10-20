// Live check of the Leak Guard's judgement on hand-written utterances.
import { dirname } from "node:path";
import { guardUtterance } from "../../src/agents/realtime/leakGuard.js";
import { findConfigDir, loadConfig } from "../../src/config/load.js";
import { loadDotEnv } from "../../src/config/paths.js";
import { ModelFactory } from "../../src/models/factory.js";

loadDotEnv(dirname(findConfigDir()));
const cfg = loadConfig();
const factory = new ModelFactory({ config: cfg.models, env: process.env });
const taught = [
  "Today: Merkle trees. Each transaction is hashed, then neighbouring hashes are paired, joined and hashed again.",
  "You keep pairing level by level until one hash is left: the Merkle root. It goes in the block header.",
];
const cases: Array<[string, "clean" | "leak"]> = [
  [
    "Headmaster, if a level has an odd number of hashes, what happens to the one without a partner?",
    "clean",
  ],
  [
    "So if I change one transaction, its hash changes and that ripples all the way up to the root, right?",
    "clean",
  ],
  ["Is the root a bit like a fingerprint of the whole block?", "clean"],
  ["Right, and that's SHA256 applied twice, double-SHA256, isn't it?", "leak"],
  [
    "And a light client only needs about log2 of N hashes to prove a transaction is in the block.",
    "leak",
  ],
  ["Did Satoshi invent this in 2008?", "leak"],
];
let agree = 0;
for (const [i, [text, expected]] of cases.entries()) {
  const t0 = performance.now();
  const r = await guardUtterance(factory, {
    utteranceId: `case${i}`,
    utterance: text,
    taughtLines: taught,
    flaggedTerms: [],
    forced: true,
    sampleRate: 1,
    persona: { name: "Bereket", voiceNotes: "Eager, fast, finishes your sentences." },
  });
  const got = r.action === "pass" ? "clean" : "leak";
  if (got === expected) agree++;
  console.log(
    `${got === expected ? "✓" : "✗"} [${expected}→${r.action}] ${Math.round(performance.now() - t0)}ms  "${text}"${r.action === "rewrite" ? `\n     rewrite: "${r.text}"` : ""}${r.reason ? `\n     reason: ${r.reason}` : ""}`,
  );
}
console.log(`\n${agree}/${cases.length} as expected`);
