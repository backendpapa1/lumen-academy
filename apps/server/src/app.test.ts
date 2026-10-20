import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/load.js";

let app: FastifyInstance;
let wsUrl: string;

beforeAll(async () => {
  app = await buildApp({ config: loadConfig({ env: {} }) });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});
afterAll(() => app.close());

function connect(headers?: Record<string, string>): Promise<WebSocket> {
  // Node's WebSocket accepts headers via a non-standard init object.
  const ws = new WebSocket(wsUrl, headers ? ({ headers } as unknown as string[]) : undefined);
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("ws error"));
  });
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.onmessage = (e) => resolve(JSON.parse(String(e.data)));
  });
}

describe("http", () => {
  it("GET /api/health → 200", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, profile: "flash" });
  });

  it("allows CORS only for the Vite origin", async () => {
    const allowed = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "http://localhost:5173" },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    const denied = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "https://evil.example" },
    });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("binds to loopback", () => {
    expect((app.server.address() as AddressInfo).address).toBe("127.0.0.1");
  });
});

describe("websocket", () => {
  it("round-trips a validated ping", async () => {
    const ws = await connect();
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ type: "ping", sessionId: "s1", payload: { nonce: "abc" } }));
    expect(await reply).toMatchObject({ type: "pong", sessionId: "s1", payload: { nonce: "abc" } });
    ws.close();
  });

  it.each([
    ["not json", "bad_json"],
    [JSON.stringify({ hello: 1 }), "bad_envelope"],
    [JSON.stringify({ type: "teleport", payload: {} }), "unknown_type"],
    [JSON.stringify({ type: "ping", payload: { nonce: 5 } }), "bad_payload"],
  ])("answers %s with error %s", async (frame, code) => {
    const ws = await connect();
    const reply = nextMessage(ws);
    ws.send(frame);
    expect(await reply).toMatchObject({ type: "error", payload: { code } });
    ws.close();
  });

  it("closes sockets from foreign origins", async () => {
    const ws = await connect({ origin: "https://evil.example" });
    const code = await new Promise<number>((resolve) => (ws.onclose = (e) => resolve(e.code)));
    expect(code).toBe(1008);
  });
});
