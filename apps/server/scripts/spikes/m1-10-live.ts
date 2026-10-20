// Live check of cadet speech: first-token latency, tool use, peek_ahead, leaks by eye.
import { dirname } from "node:path";
import { findConfigDir, loadConfig } from "../../src/config/load.js";
import { dbPath, loadDotEnv } from "../../src/config/paths.js";
import { openDb, runMigrations } from "../../src/db/client.js";
import { ClassSession } from "../../src/game/ClassSession.js";
import { OpenAIEmbedder } from "../../src/ingest/embed.js";
import { ModelFactory } from "../../src/models/factory.js";
import { UsageMeter } from "../../src/usage/meter.js";

loadDotEnv(dirname(findConfigDir()));
const cfg = loadConfig();
const handle = openDb(dbPath(cfg));
runMigrations(handle);
const meter = new UsageMeter({ db: handle.db, pricing: cfg.pricing, budget: cfg.models.budget });
const factory = new ModelFactory({ config: cfg.models, env: process.env, meter });
const embedder = new OpenAIEmbedder({ config: cfg.models, env: process.env, meter });
const room = handle.sqlite
  .prepare(
    "SELECT c.id FROM classrooms c JOIN schools s ON s.id = c.school_id WHERE s.name = 'Blockchain' ORDER BY c.created_at DESC LIMIT 1",
  )
  .get() as { id: string };
const merkle = handle.sqlite
  .prepare("SELECT id FROM concepts WHERE title LIKE '%Merkle%' ORDER BY rowid LIMIT 1")
  .get() as { id: string };
const roster = handle.sqlite
  .prepare("SELECT id, name, archetype FROM cadets WHERE classroom_id = ? ORDER BY seat")
  .all(room.id) as { id: string; name: string; archetype: string }[];
const before = meter.totals().monthUsd;
const s = ClassSession.open(
  { handle, factory, game: cfg.game, embedder },
  { classroomId: room.id, conceptId: merkle.id },
);

for (const text of [
  "Today: Merkle trees. Each transaction is hashed, then neighbouring hashes are paired, joined and hashed again.",
  "You keep pairing level by level until one hash is left: the Merkle root. It goes in the block header.",
]) {
  const t = s.teach(text);
  await Promise.all([t.reaction, t.committed]);
  console.log(`> ${text}`);
}
const speakers = [
  s.handQueue[0]?.cadetId,
  roster.find((c) => c.archetype === "overachiever")?.id,
].filter((x): x is string => !!x);
for (const id of speakers) {
  const c = roster.find((r) => r.id === id)!;
  let streamed = "";
  const r = await s.speak(id, { onDelta: (d) => (streamed += d) });
  console.log(
    `\n${c.name} (${c.archetype}) · first token ${Math.round(r?.firstTokenMs ?? -1)}ms · total ${Math.round(r?.totalMs ?? -1)}ms · tools [${r?.usedTools.join(", ")}] · ${r?.utterance.kind}/${r?.utterance.mood}`,
  );
  console.log(`  "${r?.utterance.text}"`);
  console.log(`  streamed matches: ${streamed.trim().replace(/^"|"$/g, "") === r?.utterance.text}`);
}
await s.close();
console.log(`\ncost $${(meter.totals().monthUsd - before).toFixed(4)}`);
handle.close();
