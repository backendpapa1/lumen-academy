// pnpm cli:teach --school "Blockchain" [--class "Class A"] [--minutes 15] [--concept "Merkle"]
// The M1 headless classroom: type to teach, watch reactions, call on hands.
// Also reads a piped script (one message or command per line) for repeatable runs.
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { ARCHETYPE_INFO, REACTION_GLYPHS, type Archetype, type ReactionState } from "@lumen/shared";
import { writeRecap } from "../src/agents/realtime/recap.js";
import { findConfigDir, loadConfig } from "../src/config/load.js";
import { dbPath, loadDotEnv } from "../src/config/paths.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { ClassSession } from "../src/game/ClassSession.js";
import { rewriteNotes } from "../src/game/notes.js";
import { OpenAIEmbedder } from "../src/ingest/embed.js";
import { ModelFactory } from "../src/models/factory.js";
import { BudgetPausedError, UsageMeter } from "../src/usage/meter.js";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const tty = process.stdin.isTTY && process.stdout.isTTY;
const c = (code: number, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => c(2, s);
const bold = (s: string) => c(1, s);
const hex = (color: string, s: string) => {
  if (!tty) return s;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  return `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
};

const schoolName = arg("school");
if (!schoolName) {
  console.error(
    'usage: pnpm cli:teach --school "<name>" [--class "<name>"] [--minutes 15] [--concept "<title>"]',
  );
  process.exit(2);
}
loadDotEnv(dirname(findConfigDir()));
const cfg = loadConfig();
const handle = openDb(dbPath(cfg));
runMigrations(handle);
const meter = new UsageMeter({ db: handle.db, pricing: cfg.pricing, budget: cfg.models.budget });
const factory = new ModelFactory({ config: cfg.models, env: process.env, meter });
const embedder = new OpenAIEmbedder({ config: cfg.models, env: process.env, meter });

const school = handle.sqlite
  .prepare("SELECT id, name FROM schools WHERE lower(name) = lower(?)")
  .get(schoolName) as { id: string; name: string } | undefined;
if (!school) {
  console.error(
    `No School "${schoolName}". Create it with: pnpm cli:ingest --school "${schoolName}" <file>`,
  );
  process.exit(1);
}
const className = arg("class");
const room = (
  className
    ? handle.sqlite
        .prepare(
          "SELECT id, name FROM classrooms WHERE school_id = ? AND lower(name) = lower(?) AND status = 'active'",
        )
        .get(school.id, className)
    : handle.sqlite
        .prepare(
          "SELECT id, name FROM classrooms WHERE school_id = ? AND status = 'active' ORDER BY created_at LIMIT 1",
        )
        .get(school.id)
) as { id: string; name: string } | undefined;
if (!room) {
  console.error(
    `No active classroom${className ? ` "${className}"` : ""} in ${school.name}. Open one with: pnpm cli:register --school "${school.name}"`,
  );
  process.exit(1);
}
const minutes = Number(arg("minutes") ?? cfg.game.period.defaultMinutes);
const conceptQuery = arg("concept");

const roster = new Map(
  (
    handle.sqlite
      .prepare("SELECT id, name, archetype FROM cadets WHERE classroom_id = ?")
      .all(room.id) as { id: string; name: string; archetype: Archetype }[]
  ).map((r) => [r.id, r]),
);
const who = (id: string) => {
  const r = roster.get(id);
  return r ? hex(ARCHETYPE_INFO[r.archetype].accent, r.name.split(" ")[0]!) : id;
};

// --- Recap in ---------------------------------------------------------------------
const prev = handle.sqlite
  .prepare(
    "SELECT id FROM periods WHERE classroom_id = ? AND ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 1",
  )
  .get(room.id) as { id: string } | undefined;
let recapIn: string | undefined;
if (prev) {
  const lines = (
    handle.sqlite
      .prepare(
        "SELECT text FROM messages WHERE period_id = ? AND speaker = 'teacher' ORDER BY created_at",
      )
      .all(prev.id) as { text: string }[]
  ).map((r) => r.text);
  const weak = (
    handle.sqlite
      .prepare(
        "SELECT c.title FROM concepts c JOIN modules m ON m.id = c.module_id WHERE m.school_id = ? AND c.status = 'weak'",
      )
      .all(school.id) as { title: string }[]
  ).map((r) => r.title);
  recapIn = await writeRecap(factory, {
    kind: "in",
    teacherLines: lines,
    weakConcepts: weak,
  }).catch(() => undefined);
}

let session: ClassSession;
const states = new Map<string, ReactionState>();
try {
  const conceptId = conceptQuery
    ? (
        handle.sqlite
          .prepare(
            "SELECT c.id FROM concepts c JOIN modules m ON m.id = c.module_id WHERE m.school_id = ? AND lower(c.title) LIKE lower(?) ORDER BY m.ord, c.ord LIMIT 1",
          )
          .get(school.id, `%${conceptQuery}%`) as { id: string } | undefined
      )?.id
    : undefined;
  session = ClassSession.open(
    { handle, factory, game: cfg.game, embedder },
    { classroomId: room.id, conceptId, plannedMinutes: minutes },
    {
      onReaction: (id, st) => states.set(id, st),
      onConceptChange: (_id, title) => console.log(dim(`  → the class has moved on to: ${title}`)),
      onRewrite: (_m, id, text) =>
        console.log(dim(`  ✎ ${roster.get(id)?.name.split(" ")[0]} rephrases: "${text}"`)),
      onError: (stage, err) => console.log(dim(`  ! ${stage}: ${String(err).slice(0, 140)}`)),
    },
  );
} catch (err) {
  console.error(String((err as Error).message));
  process.exit(1);
}
if (recapIn)
  handle.sqlite
    .prepare("UPDATE periods SET recap_in = ? WHERE id = ?")
    .run(recapIn, session.periodId);

console.log(
  `\n${bold(`🔔 ${school.name} · ${room.name}`)} · ${session.roster.length} cadets · ${minutes} min · concept: ${bold(session.currentConcept.title)}`,
);
if (recapIn) console.log(`\n${bold("Last time…")}\n${recapIn}`);
console.log(
  dim(
    "\nType to teach. Number = call on that hand · /hands · /concept [n|title] · /roster · /cost · /end · /help\n",
  ),
);

const help = () =>
  console.log(
    dim(
      [
        "  <text>          teach (a reply to the cadet who just spoke counts as an answer to them)",
        "  1..5            call on that position in the hand queue",
        "  /call <name>    call on any cadet",
        "  /hands          show the hand queue",
        "  /concept        list concepts; /concept <n|title> to switch",
        "  /roster         reactions and comprehension per cadet",
        "  /cost           this period's cost so far",
        "  /end            ring the bell and finish",
      ].join("\n"),
    ),
  );

const printHands = () => {
  const q = session.handQueue;
  console.log(
    q.length
      ? q
          .map(
            (h, i) =>
              `  ${bold(String(i + 1))} ✋ ${who(h.cadetId)} ${dim(`(${h.intent})`)} "${h.preview}"`,
          )
          .join("\n")
      : dim("  no hands up"),
  );
};

const reactionLine = () => {
  const counts = new Map<ReactionState, string[]>();
  for (const [id, st] of states) counts.set(st, [...(counts.get(st) ?? []), id]);
  const order: ReactionState[] = [
    "confused",
    "skeptical",
    "excited",
    "notetaking",
    "attentive",
    "bored",
  ];
  return order
    .filter((s) => counts.get(s)?.length)
    .map((s) => {
      const ids = counts.get(s)!;
      const label = `${REACTION_GLYPHS[s] || "·"} ${s} ${ids.length}`;
      return s === "confused" || s === "skeptical"
        ? `${label} (${ids.map(who).join(", ")})`
        : label;
    })
    .join("  ");
};

let lastSpeaker: { id: string; turn: number } | null = null;
let turnCount = 0;
let bellRung = false;

async function speak(cadetId: string) {
  process.stdout.write(`  ${who(cadetId)}: `);
  const t0 = performance.now();
  let first = 0;
  const res = await session.speak(cadetId, {
    onDelta: (d) => {
      first ||= performance.now() - t0;
      process.stdout.write(d.replace(/\n+/g, " "));
    },
  });
  process.stdout.write("\n");
  if (!res) return console.log(dim("  (interrupted)"));
  console.log(
    dim(
      `  ${res.utterance.kind} · ${res.utterance.mood}${res.usedTools.length ? ` · used ${res.usedTools.join(", ")}` : ""} · ${Math.round(first)}ms to first word`,
    ),
  );
  lastSpeaker = { id: cadetId, turn: turnCount };
}

async function teach(text: string) {
  states.clear();
  const replyTo = lastSpeaker && lastSpeaker.turn === turnCount ? lastSpeaker.id : undefined;
  const t0 = performance.now();
  const turn = session.teach(text, replyTo ? { replyToCadetId: replyTo } : {});
  turnCount++;
  const reaction = await turn.reaction;
  console.log(
    `  ${reactionLine()} ${dim(`· ${Math.round(reaction?.firstReactionMs ?? performance.now() - t0)}ms`)}`,
  );
  printHands();
  const done = await turn.committed;
  const avg = done.changes.length
    ? done.changes.reduce((a, x) => a + x.comprehension, 0) / done.changes.length
    : null;
  if (avg !== null)
    console.log(
      dim(
        `  class understanding of ${session.currentConcept.title}: ${Math.round(avg * 100)}%${done.lowConfidence ? " (low confidence)" : ""}`,
      ),
    );
  if (!bellRung && session.periodMinute() >= minutes) {
    bellRung = true;
    console.log(
      `\n🔔 ${bold("That's the bell.")} ${dim("Keep going if you're in the flow, or /end to finish.")}\n`,
    );
  }
}

async function handle_(line: string): Promise<boolean> {
  const input = line.trim();
  if (!input) return true;
  if (/^\d$/.test(input)) {
    const h = session.handQueue[Number(input) - 1];
    if (!h) console.log(dim("  no hand at that number"));
    else await speak(h.cadetId);
    return true;
  }
  if (!input.startsWith("/")) {
    await teach(input);
    return true;
  }
  const [cmd, ...rest] = input.slice(1).split(" ");
  const argText = rest.join(" ").trim();
  switch (cmd) {
    case "end":
      return false;
    case "help":
      help();
      return true;
    case "hands":
      printHands();
      return true;
    case "cost": {
      const t = meter.totals(session.periodId);
      console.log(
        dim(
          `  this period $${(t.periodUsd ?? 0).toFixed(4)} · today $${t.dayUsd.toFixed(4)} · month $${t.monthUsd.toFixed(2)} of $${t.capUsd}`,
        ),
      );
      return true;
    }
    case "roster": {
      for (const r of session.roster) {
        const l = handle.sqlite
          .prepare("SELECT comprehension FROM ledger_entries WHERE cadet_id = ? AND concept_id = ?")
          .get(r.id, session.currentConcept.id) as { comprehension: number } | undefined;
        console.log(
          `  ${who(r.id).padEnd(tty ? 30 : 12)} ${dim(ARCHETYPE_INFO[r.archetype].label.padEnd(13))} ${"█".repeat(Math.round((l?.comprehension ?? 0) * 20)).padEnd(20, "·")} ${Math.round((l?.comprehension ?? 0) * 100)}%`,
        );
      }
      return true;
    }
    case "call": {
      const target = [...roster.values()].find((r) =>
        r.name.toLowerCase().startsWith(argText.toLowerCase()),
      );
      if (!target) console.log(dim("  no cadet by that name"));
      else await speak(target.id);
      return true;
    }
    case "concept": {
      const list = session.concepts;
      if (!argText) {
        list.forEach((x, i) =>
          console.log(
            `  ${String(i + 1).padStart(2)}. ${x.id === session.currentConcept.id ? bold(x.title) : x.title}`,
          ),
        );
        return true;
      }
      const pick = /^\d+$/.test(argText)
        ? list[Number(argText) - 1]
        : list.find((x) => x.title.toLowerCase().includes(argText.toLowerCase()));
      if (!pick) console.log(dim("  no such concept"));
      else {
        session.setConcept(pick.id);
        console.log(dim(`  now teaching: ${pick.title}`));
      }
      return true;
    }
    default:
      console.log(dim("  unknown command; /help"));
      return true;
  }
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: tty,
  prompt: tty ? "> " : "",
});
if (tty) rl.prompt();
try {
  for await (const line of rl) {
    if (!tty && line.trim()) console.log(`> ${line}`);
    const keepGoing = await handle_(line).catch((err: unknown) => {
      if (err instanceof BudgetPausedError) {
        console.log(
          `\n${bold("Agents are paused:")} ${err.message}. Raise budget.monthlyUsdCap in config/models.yaml to continue.`,
        );
        return false;
      }
      console.log(dim(`  ! ${String((err as Error).message ?? err).slice(0, 200)}`));
      return true;
    });
    if (!keepGoing) break;
    if (tty) rl.prompt();
  }
} finally {
  rl.close();
}

// --- Bell out ---------------------------------------------------------------------
console.log(`\n🔔 ${bold("Class dismissed.")}`);
await session.close();
const taught = session.lines.filter((l) => l.speaker === "Headmaster").map((l) => l.text);
const idx = session.concepts.findIndex((x) => x.id === session.currentConcept.id);
const weak = (
  handle.sqlite
    .prepare(
      "SELECT c.title FROM concepts c JOIN modules m ON m.id = c.module_id WHERE m.school_id = ? AND c.status = 'weak'",
    )
    .all(school.id) as { title: string }[]
).map((r) => r.title);
const [recapOut, notes] = await Promise.all([
  taught.length
    ? writeRecap(factory, {
        kind: "out",
        teacherLines: taught,
        weakConcepts: weak,
        nextConcept: session.concepts[idx + 1]?.title,
      }).catch(() => undefined)
    : Promise.resolve(undefined),
  rewriteNotes({ handle, factory }, { periodId: session.periodId, classroomId: room.id }),
]);
if (recapOut) {
  handle.sqlite
    .prepare("UPDATE periods SET recap_out = ? WHERE id = ?")
    .run(recapOut, session.periodId);
  console.log(`\n${bold("Next time…")}\n${recapOut}`);
}
const t = meter.totals(session.periodId);
const turns = (
  handle.sqlite
    .prepare("SELECT count(*) n FROM turns WHERE period_id = ?")
    .get(session.periodId) as { n: number }
).n;
console.log(
  dim(
    `\n${turns} turns · ${Math.round(session.periodMinute())} min · notes updated for ${notes.updated} cadets · period cost $${(t.periodUsd ?? 0).toFixed(4)}`,
  ),
);
handle.close();
