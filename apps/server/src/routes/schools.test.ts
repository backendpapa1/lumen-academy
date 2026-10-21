import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "@lumen/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config/load.js";
import type { DbHandle } from "../db/client.js";
import { EventBus, type Broadcast } from "../events.js";
import { BowEmbedder } from "../test-fixtures/bowEmbedder.js";
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

/** Registrar flavour for whatever cadet indices the prompt lists. */
function reply(body: { messages: Array<{ role: string; content: string }> }) {
  if (agentOf(body) === "artDirector") return "interlocking hexagons forming a chain";
  const prompt = body.messages.map((m) => m.content).join("\n");
  const indices = [...prompt.matchAll(/^(\d+)\. [A-Z]/gm)].map((m) => Number(m[1]));
  return JSON.stringify({
    cadets: indices.map((i) => ({
      index: i,
      name: `Cadet ${i}`,
      quirk: `quirk ${i}`,
      voiceNotes: "v",
      visualQuirk: "pin",
      hair: "short",
    })),
  });
}

async function boot() {
  const w = await smallWorld([{ attention: 0.5, skepticism: 0.5 }]);
  h = w.handle;
  const meter = new UsageMeter({ db: h.db, pricing: cfg.pricing, budget: cfg.models.budget });
  const { factory } = fakeDeepSeekFactory(cfg.models, reply, { meter });
  const bus = new EventBus();
  const events: Broadcast[] = [];
  bus.on((m) => events.push(m));
  app = await buildApp({
    config: cfg,
    dataDir: mkdtempSync(join(tmpdir(), "lumen-routes-")),
    runtime: { handle: h, factory, meter, game: cfg.game, embedder: new BowEmbedder(), bus },
  });
  const until = async <T extends Broadcast["type"]>(
    type: T,
    pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  ) => {
    for (let i = 0; i < 300; i++) {
      const hit = events.find(
        (m) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>),
      );
      if (hit) return hit as Extract<ServerMessage, { type: T }>;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no ${type}; got ${events.map((e) => e.type).join(", ")}`);
  };
  return { w, app, events, until };
}

describe("School setup routes", () => {
  it("creates a School, refuses duplicates and bad names", async () => {
    const { app } = await boot();
    const made = await app.inject({
      method: "POST",
      url: "/api/schools",
      payload: { name: "Cell Biology", description: "Cells" },
    });
    expect(made.statusCode).toBe(201);
    const id = made.json<{ id: string }>().id;
    expect(id).toMatch(/^sch_/);
    expect(
      (await app.inject({ method: "POST", url: "/api/schools", payload: { name: "cell biology" } }))
        .statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ method: "POST", url: "/api/schools", payload: { name: "x" } }))
        .statusCode,
    ).toBe(400);
    const detail = (await app.inject({ method: "GET", url: `/api/schools/${id}` })).json<{
      name: string;
      sources: unknown[];
      classrooms: unknown[];
    }>();
    expect(detail).toMatchObject({ name: "Cell Biology", sources: [], classrooms: [] });
    expect((await app.inject({ method: "GET", url: "/api/schools/sch_nope" })).statusCode).toBe(
      404,
    );
  });

  it("archives a School off the lobby and campus, and restores it", async () => {
    const { app } = await boot();
    const id = (
      await app.inject({ method: "POST", url: "/api/schools", payload: { name: "Geology" } })
    ).json<{ id: string }>().id;
    const listed = async () =>
      (await app.inject({ method: "GET", url: "/api/schools" }))
        .json<{ id: string }[]>()
        .some((s) => s.id === id);
    const onCampus = async () =>
      (await app.inject({ method: "GET", url: "/api/campus" }))
        .json<{ wings: { schoolId: string }[] }>()
        .wings.some((w) => w.schoolId === id);
    expect(await listed()).toBe(true);

    expect(
      (await app.inject({ method: "POST", url: `/api/schools/${id}/archive` })).statusCode,
    ).toBe(200);
    expect(await listed()).toBe(false);
    expect(await onCampus()).toBe(false);
    expect((await app.inject({ method: "GET", url: `/api/schools/${id}` })).statusCode).toBe(404);
    const archived = (await app.inject({ method: "GET", url: "/api/schools/archived" })).json<
      { id: string; name: string }[]
    >();
    expect(archived).toEqual([expect.objectContaining({ id, name: "Geology" })]);
    // The name stays taken, and the error says where it went.
    const dup = await app.inject({
      method: "POST",
      url: "/api/schools",
      payload: { name: "geology" },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json<{ error: string }>().error).toMatch(/archived/i);
    expect(
      (await app.inject({ method: "POST", url: `/api/schools/${id}/archive` })).statusCode,
    ).toBe(404);

    expect(
      (await app.inject({ method: "POST", url: `/api/schools/${id}/restore` })).statusCode,
    ).toBe(200);
    expect(await listed()).toBe(true);
    expect(await onCampus()).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/schools/archived" })).json()).toEqual([]);
  });

  it("indexes a pasted source in the background, reporting status on the bus", async () => {
    const { app, until } = await boot();
    const id = (
      await app.inject({ method: "POST", url: "/api/schools", payload: { name: "Optics" } })
    ).json<{ id: string }>().id;
    const res = await app.inject({
      method: "POST",
      url: `/api/schools/${id}/sources`,
      payload: {
        title: "Lenses",
        text: "# Lenses\nA convex lens bends parallel light rays so they meet at the focal point. ".repeat(
          3,
        ),
      },
    });
    expect(res.statusCode).toBe(202);
    const ready = await until("source.status", (m) => m.payload.status === "ready");
    expect(ready.payload).toMatchObject({ schoolId: id, title: "Lenses" });
    const status = await app.inject({
      method: "GET",
      url: `/api/schools/${id}/sources/${ready.payload.sourceId}/status`,
    });
    expect(status.json()).toMatchObject({ status: "ready" });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/schools/${id}/sources`,
          payload: { title: "x", text: "short" },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("uploads a markdown file (multipart)", async () => {
    const { app, until } = await boot();
    const id = (
      await app.inject({ method: "POST", url: "/api/schools", payload: { name: "Optics" } })
    ).json<{ id: string }>().id;
    const boundary = "----lumen";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="prisms.md"',
      "Content-Type: text/markdown",
      "",
      "# Prisms\nA prism splits white light into a spectrum because each colour bends by a different amount.",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const res = await app.inject({
      method: "POST",
      url: `/api/schools/${id}/sources`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    expect((await until("source.status", (m) => m.payload.status === "ready")).payload.title).toBe(
      "prisms",
    );
  });

  it("serves the curriculum with concept statuses and validates edits", async () => {
    const { app, w } = await boot();
    const sid = h!.sqlite
      .prepare("SELECT school_id AS s FROM classrooms WHERE id = ?")
      .get(w.classroomId) as { s: string };
    const cur = (
      await app.inject({ method: "GET", url: `/api/schools/${sid.s}/curriculum` })
    ).json<{
      modules: Array<{ title: string; concepts: Array<{ id: string; title: string }> }>;
      status: Record<string, { status: string }>;
    }>();
    expect(cur.modules[0]!.concepts.map((c) => c.title)).toEqual(["Merkle Trees", "Block Header"]);
    expect(cur.status[cur.modules[0]!.concepts[0]!.id]!.status).toBe("untaught");

    // Rename a concept: persists.
    const edited = structuredClone(cur) as {
      modules: Array<{ concepts: Array<{ title: string }> }>;
      status?: unknown;
    };
    delete edited.status;
    edited.modules[0]!.concepts[0]!.title = "Merkle Tree Construction";
    const put = await app.inject({
      method: "PUT",
      url: `/api/schools/${sid.s}/curriculum`,
      payload: edited,
    });
    expect(put.statusCode).toBe(200);
    const again = (
      await app.inject({ method: "GET", url: `/api/schools/${sid.s}/curriculum` })
    ).json<typeof cur>();
    expect(again.modules[0]!.concepts[0]!.title).toBe("Merkle Tree Construction");
    // An empty module is refused with problems listed.
    const bad = await app.inject({
      method: "PUT",
      url: `/api/schools/${sid.s}/curriculum`,
      payload: { modules: [{ title: "M", concepts: [] }] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ problems: string[] }>().problems.length).toBeGreaterThan(0);
  });

  it("opens a Classroom: returns at once, then cadets arrive on the bus", async () => {
    const { app, w, until, events } = await boot();
    const sid = (
      h!.sqlite
        .prepare("SELECT school_id AS s FROM classrooms WHERE id = ?")
        .get(w.classroomId) as { s: string }
    ).s;
    const res = await app.inject({
      method: "POST",
      url: `/api/schools/${sid}/classrooms`,
      payload: { difficulty: "gentle" },
    });
    expect(res.statusCode).toBe(202);
    const { classroomId, total, name } = res.json<{
      classroomId: string;
      total: number;
      name: string;
    }>();
    expect(name).toBe("Class B");
    expect(total).toBeGreaterThanOrEqual(cfg.game.cohort.min);
    await until("registration.done", (m) => m.payload.classroomId === classroomId);
    const arrivals = events.filter((e) => e.type === "registration.arrival");
    expect(arrivals).toHaveLength(total);
    expect(arrivals.map((a) => a.type === "registration.arrival" && a.payload.index)).toEqual(
      Array.from({ length: total }, (_, i) => i + 1),
    );
    const room = h!.sqlite.prepare("SELECT status FROM classrooms WHERE id = ?").get(classroomId);
    expect(room).toEqual({ status: "active" });
  });

  it("flags sources added after the curriculum, to offer an update (S-5)", async () => {
    const { app, w, until } = await boot();
    const sid = (
      h!.sqlite
        .prepare("SELECT school_id AS s FROM classrooms WHERE id = ?")
        .get(w.classroomId) as { s: string }
    ).s;
    const before = (
      await app.inject({ method: "GET", url: `/api/schools/${sid}/curriculum` })
    ).json<{ newSources: unknown[] }>();
    expect(before.newSources).toEqual([]); // the world's one source is cited by its concepts
    await app.inject({
      method: "POST",
      url: `/api/schools/${sid}/sources`,
      payload: {
        title: "Chapter 12",
        text: "# Mining\nMiners race to find a hash below the target, which secures the chain. ".repeat(
          3,
        ),
      },
    });
    await until("source.status", (m) => m.payload.status === "ready");
    const after = (
      await app.inject({ method: "GET", url: `/api/schools/${sid}/curriculum` })
    ).json<{ newSources: Array<{ title: string }> }>();
    expect(after.newSources.map((x) => x.title)).toEqual(["Chapter 12"]);
  });

  it("won't open a Classroom before there is a curriculum", async () => {
    const { app } = await boot();
    const id = (
      await app.inject({ method: "POST", url: "/api/schools", payload: { name: "Empty" } })
    ).json<{ id: string }>().id;
    expect(
      (await app.inject({ method: "POST", url: `/api/schools/${id}/classrooms`, payload: {} }))
        .statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ method: "POST", url: `/api/schools/${id}/curriculum/generate` }))
        .statusCode,
    ).toBe(409);
  });
});
