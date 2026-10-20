import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ServerMessageZ, type ServerMessage } from "@lumen/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { agentOf, fakeDeepSeekFactory } from "../test-fixtures/fakeDeepSeek.js";
import { smallWorld } from "../test-fixtures/world.js";
import { UsageMeter } from "../usage/meter.js";

const cfg = loadConfig({ env: {} });
let app: FastifyInstance | undefined;
let h: DbHandle | undefined;
afterEach(async () => {
  await app?.close();
  h?.close();
});

const SECRET_ERROR = "The Merkle root is stored in every transaction.";

async function boot() {
  const w = await smallWorld([
    { attention: 0.8, skepticism: 0.2 },
    { attention: 0.6, skepticism: 0.5 },
    { attention: 0.5, skepticism: 0.9 },
  ]);
  h = w.handle;
  const meter = new UsageMeter({ db: h.db, pricing: cfg.pricing, budget: cfg.models.budget });
  const { factory } = fakeDeepSeekFactory(
    cfg.models,
    (body) => {
      const who = agentOf(body);
      if (who === "crowdReactor")
        return "1 confused\n2 attentive\n3 skeptical\nH 1 clarify 0.9 Where is the root kept?\n";
      if (who === "classDirector") {
        const wrong = body.messages.at(-1)!.content.toLowerCase().includes("every transaction");
        return JSON.stringify({
          conceptIds: [w.conceptIds[0]],
          teaching: {
            accuracy: wrong ? 0.2 : 1,
            clarity: 0.8,
            coverage: [],
            errors: wrong
              ? [{ claim: SECRET_ERROR, correction: "In the header.", citation: "kf1" }]
              : [],
          },
          ledgerDeltas: [],
        });
      }
      if (who === "cadet")
        return "Headmaster, where is the root kept?\n###\nkind: question\nmood: confused\nconfidence: 0.3";
      return JSON.stringify({ verdict: "pass", leakedTerms: [], reason: "" });
    },
    { meter },
  );
  app = await buildApp({
    config: cfg,
    runtime: { handle: h, factory, meter, game: cfg.game, extras: { recaps: false, notes: false } },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((r) => (ws.onopen = r));
  const frames: string[] = [];
  const inbox: ServerMessage[] = [];
  ws.onmessage = (e) => {
    frames.push(String(e.data));
    inbox.push(ServerMessageZ.parse(JSON.parse(String(e.data)))); // the client can validate everything
  };
  const send = (type: string, payload: unknown) => ws.send(JSON.stringify({ type, payload }));
  const until = async <T extends ServerMessage["type"]>(type: T, n = 1) => {
    for (let i = 0; i < 400; i++) {
      const got = inbox.filter((m) => m.type === type);
      if (got.length >= n) return got.at(n - 1) as Extract<ServerMessage, { type: T }>;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${type}; got ${inbox.map((m) => m.type).join(", ")}`);
  };
  return { w, ws, send, until, inbox, frames };
}

describe("classroom over WebSocket", () => {
  it("runs a period: start → teach → reactions/hands/ledger → call → speech → end", async () => {
    const { w, send, until, inbox, ws } = await boot();
    send("period.start", { classroomId: w.classroomId });
    const started = await until("period.started");
    expect(started.payload.cadets).toHaveLength(3);
    expect(started.payload.concept.id).toBe(w.conceptIds[0]);
    expect(started.payload.concepts).toHaveLength(2);

    send("teach.message", { text: "Pairs of hashes are hashed again up to the root." });
    const turn = await until("turn.started");
    await until("crowd.done");
    const reactions = inbox.filter((m) => m.type === "crowd.reaction");
    expect(reactions.map((r) => r.type === "crowd.reaction" && r.payload.state)).toEqual([
      "confused",
      "attentive",
      "skeptical",
    ]);
    expect(
      reactions.every(
        (r) => r.type === "crowd.reaction" && r.payload.turnId === turn.payload.turnId,
      ),
    ).toBe(true);
    const hands = await until("hands.update");
    expect(hands.payload.queue[0]).toMatchObject({ cadetId: w.cadets[0]!.id, intent: "clarify" });
    const ledger = await until("ledger.update");
    expect(ledger.payload.cadets).toHaveLength(3);
    expect(ledger.payload.classAverage).toBeGreaterThan(0);
    expect((await until("cost.update", 2)).payload.capUsd).toBe(cfg.models.budget.monthlyUsdCap);

    send("hand.call", { cadetId: w.cadets[0]!.id });
    const done = await until("cadet.done");
    const streamed = inbox
      .filter((m) => m.type === "cadet.stream")
      .map((m) => (m.type === "cadet.stream" ? m.payload.delta : ""))
      .join("");
    expect(done.payload).toMatchObject({
      cadetId: w.cadets[0]!.id,
      kind: "question",
      mood: "confused",
      text: "Headmaster, where is the root kept?",
    });
    expect(streamed).toContain("where is the root kept?");
    expect(streamed).not.toContain("###");

    send("period.end", {});
    const ended = await until("period.ended");
    expect(ended.payload.turns).toBe(1);
    ws.close();
  });

  it("never sends the Director's analysis or the teacher's errors to the client", async () => {
    const { w, send, until, frames, ws } = await boot();
    send("period.start", { classroomId: w.classroomId });
    await until("period.started");
    send("teach.message", { text: "Every transaction stores a copy of the root." });
    await until("ledger.update");
    const all = frames.join("\n");
    expect(all).not.toContain(SECRET_ERROR);
    expect(all).not.toMatch(/"accuracy"|"errors"|"correction"/);
    expect(h!.sqlite.prepare("SELECT count(*) n FROM teacher_errors").get()).toEqual({ n: 1 }); // stored for the Debrief
    ws.close();
  });

  it("answers teach before start, unknown classrooms and bad frames with errors", async () => {
    const { send, until, ws, inbox } = await boot();
    send("teach.message", { text: "hello" });
    expect((await until("error")).payload.message).toMatch(/period\.start first/);
    send("period.start", { classroomId: "cls_nope" });
    expect((await until("error", 2)).payload.message).toMatch(/no classroom/);
    ws.send("{bad");
    expect((await until("error", 3)).payload.code).toBe("bad_json");
    expect(inbox.some((m) => m.type === "period.started")).toBe(false);
    ws.close();
  });

  it("ends the period when the socket closes", async () => {
    const { w, send, until, ws } = await boot();
    send("period.start", { classroomId: w.classroomId });
    await until("period.started");
    ws.close();
    for (let i = 0; i < 100; i++) {
      const row = h!.sqlite.prepare("SELECT ended_at FROM periods").get() as {
        ended_at: string | null;
      };
      if (row.ended_at) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("period was not closed");
  });

  it("serves schools and a classroom roster over REST", async () => {
    const { w, ws } = await boot();
    const schools = (await app!.inject({ method: "GET", url: "/api/schools" })).json() as Array<{
      classrooms: Array<{ id: string; cadets: number }>;
    }>;
    expect(schools[0]!.classrooms[0]).toMatchObject({ id: w.classroomId, cadets: 3 });
    const room = (
      await app!.inject({ method: "GET", url: `/api/classrooms/${w.classroomId}` })
    ).json() as { cadets: unknown[] };
    expect(room.cadets).toHaveLength(3);
    expect((await app!.inject({ method: "GET", url: "/api/classrooms/cls_x" })).statusCode).toBe(
      404,
    );
    ws.close();
  });
});
