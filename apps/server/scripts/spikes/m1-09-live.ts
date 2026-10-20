// Live smoke test of ClassSession: real models, real DB, a few fixture messages.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findConfigDir, loadConfig } from "../../src/config/load.js";
import { dbPath, loadDotEnv } from "../../src/config/paths.js";
import { openDb, runMigrations } from "../../src/db/client.js";
import { ClassSession } from "../../src/game/ClassSession.js";
import { OpenAIEmbedder } from "../../src/ingest/embed.js";
import { ModelFactory } from "../../src/models/factory.js";
import { UsageMeter } from "../../src/usage/meter.js";

const root = dirname(findConfigDir());
loadDotEnv(root);
const cfg = loadConfig();
const handle = openDb(dbPath(cfg));
runMigrations(handle);
const meter = new UsageMeter({ db: handle.db, pricing: cfg.pricing, budget: cfg.models.budget });
const factory = new ModelFactory({ config: cfg.models, env: process.env, meter });
const embedder = new OpenAIEmbedder({ config: cfg.models, env: process.env, meter });
const room = handle.sqlite
  .prepare(
    "SELECT c.id FROM classrooms c JOIN schools s ON s.id = c.school_id WHERE s.name = 'Blockchain' ORDER BY c.created_at LIMIT 1",
  )
  .get() as { id: string };
const merkle = handle.sqlite
  .prepare("SELECT id, title FROM concepts WHERE title LIKE '%Merkle%' ORDER BY rowid LIMIT 1")
  .get() as { id: string; title: string };
const lesson = JSON.parse(
  readFileSync(join(root, "fixtures/blockchain-ch1/lessons/correct.json"), "utf8"),
) as { messages: Array<{ text: string }> };
const names = new Map(
  (
    handle.sqlite.prepare("SELECT id, name FROM cadets WHERE classroom_id = ?").all(room.id) as {
      id: string;
      name: string;
    }[]
  ).map((c) => [c.id, c.name.split(" ")[0]]),
);

const s = ClassSession.open(
  { handle, factory, game: cfg.game, embedder },
  { classroomId: room.id, conceptId: merkle.id },
  {
    onError: (stage, e) => console.log(`  ! ${stage}: ${String(e).slice(0, 120)}`),
    onConceptChange: (_id, t) => console.log(`  → concept now: ${t}`),
  },
);
console.log(`Teaching "${merkle.title}" to ${s.roster.length} cadets\n`);
const before = meter.totals().monthUsd;
for (const m of lesson.messages.slice(5, 11)) {
  const t0 = performance.now();
  const t = s.teach(m.text);
  const r = await t.reaction;
  const c = await t.committed;
  const mix = Object.entries(
    (r?.reaction.reactions ?? []).reduce<Record<string, number>>(
      (a, x) => ((a[x.state] = (a[x.state] ?? 0) + 1), a),
      {},
    ),
  )
    .map(([k, v]) => `${k}×${v}`)
    .join(" ");
  const avg = c.changes.length
    ? c.changes.reduce((a, x) => a + x.comprehension, 0) / c.changes.length
    : 0;
  console.log(`> ${m.text.slice(0, 70)}…`);
  console.log(
    `  first reaction ${Math.round(r?.firstReactionMs ?? -1)}ms · committed ${Math.round(performance.now() - t0)}ms · ${mix}`,
  );
  console.log(
    `  hands: ${s.handQueue.map((h) => `${names.get(h.cadetId)} (${h.intent}) "${h.preview}"`).join(" | ") || "none"}`,
  );
  console.log(
    `  acc ${c.analysis.teaching.accuracy.toFixed(2)} clarity ${c.analysis.teaching.clarity.toFixed(2)} · coverage ${c.analysis.teaching.coverage.length} · errors ${c.analysis.teaching.errors.length} · class comprehension ${avg.toFixed(2)}${c.lowConfidence ? " · LOW CONFIDENCE" : ""}\n`,
  );
}
await s.close();
const vec = handle.sqlite.prepare("SELECT count(*) n FROM message_vec").get() as { n: number };
console.log(
  `period ${s.periodId} closed · ${vec.n} teacher messages embedded · cost $${(meter.totals().monthUsd - before).toFixed(4)}`,
);
handle.close();
