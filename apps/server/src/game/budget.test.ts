import type { PricingConfig } from "@lumen/shared";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { messages, usageLog } from "../db/schema.js";
import { resolveSpec } from "../models/spec.js";
import { agentOf, fakeDeepSeekFactory, type FakeRequest } from "../test-fixtures/fakeDeepSeek.js";
import { smallWorld } from "../test-fixtures/world.js";
import { BudgetPausedError, UsageMeter, type BudgetState } from "../usage/meter.js";
import { ClassSession, DEGRADED_CROWD } from "./ClassSession.js";

const cfg = loadConfig({ env: {} });
let h: DbHandle | undefined;
afterEach(() => h?.close());

// Inflated prices so a few fake calls (10 in + 10 out tokens each) move the
// budget: $1000/1M tokens → $0.02 per call.
const pricing: PricingConfig = {
  openai: { models: {} },
  deepseek: { models: { "deepseek-flash": { input: 1000, cachedInput: 1000, output: 1000 } } },
};
const budget = {
  monthlyUsdCap: 1,
  softWarnAt: 0.5,
  degradeAt: 0.7,
  onCap: "degrade_then_pause" as const,
  imagesUsdCap: 1,
};

describe("budget guard end to end (M1-14)", () => {
  it("warns, degrades to the fastest role with a 6-cadet crowd, then pauses teaching cleanly", async () => {
    const w = await smallWorld(
      Array.from({ length: 10 }, () => ({ attention: 0.6, skepticism: 0.5 })),
    );
    h = w.handle;
    const meter = new UsageMeter({ db: h.db, pricing, budget });
    const states: BudgetState[] = [];
    meter.onStateChange((st) => states.push(st));
    const reactorPrompts: FakeRequest[] = [];
    const { factory } = fakeDeepSeekFactory(
      cfg.models,
      (body) => {
        if (agentOf(body) === "crowdReactor") {
          reactorPrompts.push(body);
          return Array.from({ length: 10 }, (_, i) => `${i + 1} attentive`).join("\n");
        }
        return JSON.stringify({
          conceptIds: [w.conceptIds[0]],
          teaching: { accuracy: 1, clarity: 0.8, coverage: [], errors: [] },
          ledgerDeltas: [],
        });
      },
      { meter },
    );
    const session = ClassSession.open(
      { handle: h, factory, game: cfg.game, budget: meter },
      { classroomId: w.classroomId },
    );
    // $0.10 per step, capped so a wrong threshold fails instead of hanging.
    const spendUntil = (state: BudgetState) => {
      for (let i = 0; i < 50 && meter.budgetState() !== state; i++) {
        meter.record({
          agent: "examiner",
          provider: "deepseek",
          model: "deepseek-flash",
          inputTokens: 100,
        });
      }
      expect(meter.budgetState()).toBe(state);
    };
    const seatsIn = (b: FakeRequest) =>
      (
        b.messages.find((m) => m.content.includes("Students (seat"))!.content.match(/^\d+ \|/gm) ??
        []
      ).length;

    // Normal: the whole class reacts.
    await session.teach("Turn one.").committed;
    expect(seatsIn(reactorPrompts[0]!)).toBe(10);
    expect(meter.budgetState()).toBe("ok");

    // Spend up to the degrade threshold.
    spendUntil("degrade");
    expect(states).toEqual(["warn", "degrade"]);
    expect(factory.getModel("curriculumArchitect").spec.role).toBe("fastest"); // every role degraded
    expect(resolveSpec(cfg.models, "curriculumArchitect").role).toBe("heavy"); // config untouched

    const t2 = session.teach("Turn two.");
    const r2 = await t2.reaction;
    await t2.committed;
    expect(seatsIn(reactorPrompts[1]!)).toBe(DEGRADED_CROWD);
    expect(r2!.reaction.reactions).toHaveLength(DEGRADED_CROWD);
    // The window rotates, so the next turn reaches different cadets.
    const t3 = session.teach("Turn three.");
    const r3 = await t3.reaction;
    await t3.committed;
    expect(r3!.reaction.reactions.map((x) => x.cadetId)).not.toEqual(
      r2!.reaction.reactions.map((x) => x.cadetId),
    );

    // Hit the cap: teaching is refused before anything is saved.
    spendUntil("pause");
    const before = h.db.select().from(messages).all().length;
    expect(() => session.teach("Turn four.")).toThrow(BudgetPausedError);
    expect(h.db.select().from(messages).all()).toHaveLength(before);
    expect(states.at(-1)).toBe("pause");
    expect(
      h.db
        .select()
        .from(usageLog)
        .all()
        .some((u) => u.agent === "crowdReactor"),
    ).toBe(true); // real calls were metered
    await session.close();
  });
});
