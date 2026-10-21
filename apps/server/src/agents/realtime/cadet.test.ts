import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../config/load.js";
import type { DbHandle } from "../../db/client.js";
import { cadets, messages } from "../../db/schema.js";
import { ClassSession } from "../../game/ClassSession.js";
import {
  agentOf,
  fakeDeepSeekFactory,
  type FakeReply,
  type FakeRequest,
} from "../../test-fixtures/fakeDeepSeek.js";
import { smallWorld } from "../../test-fixtures/world.js";
import { parseCadetOutput } from "./cadet.js";

const cfg = loadConfig({ env: {} });
let h: DbHandle | undefined;
afterEach(() => h?.close());

describe("parseCadetOutput", () => {
  it("splits words from the meta block and validates it", () => {
    expect(
      parseCadetOutput(
        '"Wait — is the root in the header?"\n###\nkind: question\nmood: confused\nconfidence: 0.3',
        "cpt_1",
      ),
    ).toEqual({
      text: "Wait — is the root in the header?",
      kind: "question",
      mood: "confused",
      confidence: 0.3,
      conceptId: "cpt_1",
    });
  });
  it("defaults gracefully when the meta block is missing or odd", () => {
    expect(parseCadetOutput("I think I get it.", "c")).toMatchObject({
      kind: "question",
      mood: "curious",
      confidence: 0.5,
    });
    expect(parseCadetOutput("x\n###\nkind: shout\nconfidence: 7", "c")).toMatchObject({
      kind: "question",
      confidence: 1,
    });
  });
});

const CADET_SAYS =
  "Headmaster, if the root is in the header, what's in each transaction?\n###\nkind: question\nmood: curious\nconfidence: 0.4";
const DIRECTOR = (conceptId: string) =>
  JSON.stringify({
    conceptIds: [conceptId],
    teaching: { accuracy: 1, clarity: 0.8, coverage: [], errors: [] },
    ledgerDeltas: [],
  });

async function setup(
  cadetReply: (body: FakeRequest, n: number) => FakeReply,
  archetype = "skeptic",
) {
  const w = await smallWorld([
    { attention: 0.8, skepticism: 0.5 },
    { attention: 0.6, skepticism: 0.5 },
  ]);
  h = w.handle;
  h.db
    .update(cadets)
    .set({ archetype, notesMd: "Root = summary hash." })
    .where(eq(cadets.id, w.cadets[0]!.id))
    .run();
  let cadetCalls = 0;
  const { factory, calls } = fakeDeepSeekFactory(cfg.models, (body) => {
    const who = agentOf(body);
    if (who === "crowdReactor")
      return "1 confused\n2 attentive\nH 1 clarify 0.9 Where does the root live?\n";
    if (who === "classDirector") return DIRECTOR(w.conceptIds[0]!);
    if (who === "cadet") return cadetReply(body, ++cadetCalls);
    throw new Error(`unexpected agent ${who}`);
  });
  const session = ClassSession.open(
    { handle: w.handle, factory, game: cfg.game },
    { classroomId: w.classroomId },
  );
  return { w, session, calls };
}

describe("cadet turn", () => {
  it("streams the words but never the meta block, then records the utterance", async () => {
    const { w, session, calls } = await setup(() => CADET_SAYS);
    const turn = session.teach("The Merkle root lives in the block header.");
    await Promise.all([turn.reaction, turn.committed]); // hands come from the reactor
    let streamed = "";
    const r = await session.speak(w.cadets[0]!.id, { onDelta: (d) => (streamed += d) });
    expect(r!.utterance).toMatchObject({ kind: "question", mood: "curious", confidence: 0.4 });
    expect(streamed).toContain("what's in each transaction?");
    expect(streamed).not.toContain("###");
    expect(streamed).not.toContain("kind:");
    const said = h!.db
      .select()
      .from(messages)
      .all()
      .find((m) => m.speaker === w.cadets[0]!.id)!;
    expect(said).toMatchObject({ kind: "question", text: r!.utterance.text });

    const prompt = calls
      .find((b) => agentOf(b) === "cadet")!
      .messages.map((m) => m.content)
      .join("\n");
    expect(prompt).toContain("Root = summary hash."); // notes injected (ADR-001)
    expect(prompt).toContain('to clarify: "Where does the root live?"');
    expect(prompt).toContain("Teacher: The Merkle root lives in the block header.");
    await session.close();
  });

  it("gives every cadet recall_lesson but never source search; peek only to Overachievers", async () => {
    const skeptic = await setup(() => CADET_SAYS, "skeptic");
    await skeptic.session.speak(skeptic.w.cadets[0]!.id);
    const tools = (b: FakeRequest) =>
      (b.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(tools(skeptic.calls.find((b) => agentOf(b) === "cadet")!)).toEqual(["recall_lesson"]);
    await skeptic.session.close();
    h!.close();

    const over = await setup(() => CADET_SAYS, "overachiever");
    await over.session.speak(over.w.cadets[0]!.id);
    expect(tools(over.calls.find((b) => agentOf(b) === "cadet")!)).toEqual([
      "recall_lesson",
      "peek_ahead",
    ]);
    await over.session.close();
  });

  it("lets an Overachiever peek once per period, at most 2 short passages", async () => {
    const { w, session, calls } = await setup(
      (body, n) =>
        n % 2 === 1
          ? { toolCalls: [{ name: "peek_ahead", args: { query: "merkle" } }] }
          : "I read ahead… the root is in the header?\n###\nkind: claim\nmood: proud\nconfidence: 0.7",
      "overachiever",
    );
    const first = await session.speak(w.cadets[0]!.id);
    expect(first!.usedTools).toEqual(["peek_ahead"]);
    expect(first!.peeked).toBe(true);
    const toolResult = calls
      .filter((b) => agentOf(b) === "cadet")[1]!
      .messages.find((m) => m.role === "tool")!.content;
    expect(toolResult.split("---").length).toBeLessThanOrEqual(2);
    expect(toolResult.length).toBeLessThanOrEqual(2 * 600 + 10);

    // Second time this period: the tool isn't offered at all.
    await session.speak(w.cadets[0]!.id);
    const later = calls.filter((b) => agentOf(b) === "cadet").at(-2)!;
    expect(
      (later.tools as Array<{ function: { name: string } }>).map((t) => t.function.name),
    ).toEqual(["recall_lesson"]);
    await session.close();
  });

  it("recall_lesson only returns the Headmaster's words from this classroom", async () => {
    const { w, session, calls } = await setup((_b, n) =>
      n === 1 ? { toolCalls: [{ name: "recall_lesson", args: { query: "root" } }] } : CADET_SAYS,
    );
    await session.teach("The root goes in the header.").committed;
    session.recordCadetUtterance(w.cadets[1]!.id, "I think the root is in every transaction.");
    await session.speak(w.cadets[0]!.id);
    const toolResult = calls
      .filter((b) => agentOf(b) === "cadet")[1]!
      .messages.find((m) => m.role === "tool")!.content;
    expect(toolResult).toContain("Teacher: The root goes in the header.");
    expect(toolResult).not.toContain("every transaction");
    await session.close();
  });

  it("returns null and records nothing when the Headmaster interrupts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { w, session } = await setup(() => gate.then(() => CADET_SAYS) as never);
    const speaking = session.speak(w.cadets[0]!.id);
    session.teach("Actually, hold that thought.");
    release();
    expect(await speaking).toBeNull();
    expect(
      h!.db
        .select()
        .from(messages)
        .all()
        .some((m) => m.speaker === w.cadets[0]!.id),
    ).toBe(false);
    await session.close();
  });
});
