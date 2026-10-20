// Live: drive the real server over WebSocket like the browser will.
import { ServerMessageZ, type ServerMessage } from "@lumen/shared";

const base = "http://127.0.0.1:5174";
const schools = (await (await fetch(`${base}/api/schools`)).json()) as Array<{
  name: string;
  classrooms: Array<{ id: string; name: string }>;
}>;
const room = schools
  .find((s) => s.name === "Blockchain")!
  .classrooms.find((c) => c.name === "Class A")!;
const ws = new WebSocket("ws://127.0.0.1:5174/ws", {
  headers: { origin: "http://localhost:5173" },
} as unknown as string[]);
const inbox: Array<{ at: number; m: ServerMessage }> = [];
const t0 = performance.now();
ws.onmessage = (e) =>
  inbox.push({ at: performance.now(), m: ServerMessageZ.parse(JSON.parse(String(e.data))) });
await new Promise((r) => (ws.onopen = r));
const send = (type: string, payload: unknown) => ws.send(JSON.stringify({ type, payload }));
const until = async (type: string, after = 0) => {
  for (let i = 0; i < 3000; i++) {
    const hit = inbox.find((x, idx) => idx >= after && x.m.type === type);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout ${type}`);
};
send("period.start", { classroomId: room.id });
const started = await until("period.started");
console.log(
  `period.started in ${Math.round(started.at - t0)}ms · ${(started.m as Extract<ServerMessage, { type: "period.started" }>).payload.cadets.length} cadets`,
);
const mark = inbox.length;
const sentAt = performance.now();
send("teach.message", {
  text: "If one transaction changes, its hash changes, and every parent hash up to the Merkle root changes too.",
});
const first = await until("crowd.reaction", mark);
const ledger = await until("ledger.update", mark);
console.log(
  `first reaction ${Math.round(first.at - sentAt)}ms · ledger ${Math.round(ledger.at - sentAt)}ms · class avg ${(ledger.m as Extract<ServerMessage, { type: "ledger.update" }>).payload.classAverage.toFixed(2)}`,
);
const hands = [...inbox].reverse().find((x) => x.m.type === "hands.update")!.m as Extract<
  ServerMessage,
  { type: "hands.update" }
>;
const callAt = performance.now();
const m2 = inbox.length;
send("hand.call", { cadetId: hands.payload.queue[0]!.cadetId });
const firstDelta = await until("cadet.stream", m2);
const done = await until("cadet.done", m2);
console.log(
  `cadet first delta ${Math.round(firstDelta.at - callAt)}ms · "${(done.m as Extract<ServerMessage, { type: "cadet.done" }>).payload.text}"`,
);
send("period.end", {});
const ended = await until("period.ended");
console.log(
  `period.ended: ${JSON.stringify((ended.m as Extract<ServerMessage, { type: "period.ended" }>).payload).slice(0, 200)}`,
);
console.log(`message types seen: ${[...new Set(inbox.map((x) => x.m.type))].join(", ")}`);
ws.close();
