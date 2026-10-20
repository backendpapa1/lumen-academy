import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../config/load.js";
import type { DbHandle } from "../../db/client.js";
import { cadets, leakEvents, messages } from "../../db/schema.js";
import { ClassSession } from "../../game/ClassSession.js";
import {
  agentOf,
  fakeDeepSeekFactory,
  type FakeRequest,
} from "../../test-fixtures/fakeDeepSeek.js";
import { smallWorld } from "../../test-fixtures/world.js";
import { eq } from "drizzle-orm";
import { sampled } from "./leakGuard.js";

const cfg = loadConfig({ env: {} });
let h: DbHandle | undefined;
afterEach(() => h?.close());

const meta = "\n###\nkind: claim\nmood: proud\nconfidence: 0.9";
const DIRECTOR = (id: string) =>
  JSON.stringify({
    conceptIds: [id],
    teaching: { accuracy: 1, clarity: 0.8, coverage: [], errors: [] },
    ledgerDeltas: [],
  });

async function run(opts: {
  cadetSays: string;
  verdict?: "pass" | "leak";
  rewrite?: string;
  rewriteFails?: boolean;
  archetype?: string;
  peek?: boolean;
}) {
  const w = await smallWorld([{ attention: 0.7, skepticism: 0.5 }]);
  h = w.handle;
  if (opts.archetype)
    h.db
      .update(cadets)
      .set({ archetype: opts.archetype })
      .where(eq(cadets.id, w.cadets[0]!.id))
      .run();
  const guardCalls: FakeRequest[] = [];
  let cadetCalls = 0;
  const { factory } = fakeDeepSeekFactory(cfg.models, (body) => {
    const who = agentOf(body);
    const sys = body.messages.map((m) => m.content).join("\n");
    if (who === "crowdReactor") return "1 attentive\n";
    if (who === "classDirector") return DIRECTOR(w.conceptIds[0]!);
    if (sys.includes("You check whether an AI cadet said something")) {
      guardCalls.push(body);
      return JSON.stringify({
        verdict: opts.verdict ?? "pass",
        leakedTerms: opts.verdict === "leak" ? ["SHA256"] : [],
        reason: "states the hash function",
      });
    }
    if (sys.includes("Rewrite what you said")) {
      if (opts.rewriteFails) throw Object.assign(new Error("boom"), { status: 400 });
      return opts.rewrite ?? "";
    }
    if (who === "cadet") {
      cadetCalls++;
      if (opts.peek && cadetCalls === 1)
        return { toolCalls: [{ name: "peek_ahead", args: { query: "hash" } }] };
      return opts.cadetSays + meta;
    }
    throw new Error(`unexpected ${who}`);
  });
  const rewrites: string[] = [];
  const s = ClassSession.open(
    { handle: h, factory, game: cfg.game },
    { classroomId: w.classroomId },
    { onRewrite: (_id, _c, t) => rewrites.push(t) },
  );
  await s.teach(
    "Each transaction is hashed, and pairs of hashes are hashed again into a Merkle root.",
  ).committed;
  const spoken = await s.speak(w.cadets[0]!.id);
  const outcome = await spoken!.guard;
  await s.close();
  return {
    outcome,
    guardCalls,
    rewrites,
    spoken: spoken!,
    events: h.db.select().from(leakEvents).all(),
    stored: h.db
      .select()
      .from(messages)
      .all()
      .find((m) => m.id === spoken!.messageId)!,
  };
}

describe("Leak Guard in a session", () => {
  it("forces the guard when the heuristic finds untaught technical terms, and rewrites a leak", async () => {
    const r = await run({
      cadetSays: "Of course, Merkle trees use SHA256 twice, and SPV clients check log2(N) proofs!",
      verdict: "leak",
      rewrite: "Wait, which hash do we use, Headmaster? You didn't say.",
    });
    expect(r.outcome).toMatchObject({ action: "rewrite", forced: true });
    expect(r.outcome.flaggedTerms).toEqual(expect.arrayContaining(["sha256", "log2"]));
    expect(r.stored.text).toBe("Wait, which hash do we use, Headmaster? You didn't say.");
    expect(r.rewrites).toEqual([r.stored.text]);
    expect(r.events).toMatchObject([{ action: "rewrite", utteranceId: r.spoken.messageId }]);
    // The guard was shown what was taught.
    expect(r.guardCalls[0]!.messages.map((m) => m.content).join("\n")).toContain(
      "pairs of hashes are hashed again",
    );
  });

  it("passes clean words and logs the pass", async () => {
    const r = await run({
      cadetSays: "So the hashes get paired and hashed again, all the way up to the root?",
      verdict: "pass",
    });
    if (r.outcome.action === "skipped") {
      expect(r.events).toEqual([]); // not sampled and not forced: no LLM call, no event
      expect(r.guardCalls).toHaveLength(0);
    } else {
      expect(r.outcome.action).toBe("pass");
      expect(r.events).toMatchObject([{ action: "pass" }]);
    }
    expect(r.stored.text).toContain("paired and hashed again");
  });

  it("keeps the original words if the rewrite fails, and says so", async () => {
    const r = await run({
      cadetSays: "It's SHA256 twice, then SPV clients check log2(N) proofs.",
      verdict: "leak",
      rewriteFails: true,
    });
    expect(r.outcome.action).toBe("rewrite_failed");
    expect(r.events).toMatchObject([{ action: "rewrite_failed" }]);
    expect(r.stored.text).toContain("SHA256");
  });

  it("doesn't police an Overachiever's sanctioned peek", async () => {
    const r = await run({
      cadetSays: "I read ahead… it's SHA256 twice and log2(N) proofs!",
      verdict: "leak",
      archetype: "overachiever",
      peek: true,
    });
    expect(r.spoken.peeked).toBe(true);
    expect(r.outcome.action).toBe("skipped");
    expect(r.guardCalls).toHaveLength(0);
  });
});

describe("sampled", () => {
  it("is deterministic and close to the rate", () => {
    expect(sampled("msg_a", 0.5)).toBe(sampled("msg_a", 0.5));
    const n = Array.from({ length: 4000 }, (_, i) => sampled(`msg_${i}`, 0.5)).filter(
      Boolean,
    ).length;
    expect(n / 4000).toBeGreaterThan(0.45);
    expect(n / 4000).toBeLessThan(0.55);
    expect(sampled("x", 0)).toBe(false);
    expect(sampled("x", 1)).toBe(true);
  });
});
