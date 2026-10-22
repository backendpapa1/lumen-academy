import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "./test";

// M2 gate, latency side: a real class against the real server and DeepSeek.
// Costs a few cents, so it only runs with LUMEN_LIVE=1, ideally against a
// copy of the database (LUMEN_DATA_DIR) so it doesn't touch your classes.
test.skip(!process.env.LUMEN_LIVE, "set LUMEN_LIVE=1 to run a live class");
test.setTimeout(240_000);

const LINES = [
  "Today: Merkle trees. Every transaction in a block gets hashed on its own first.",
  "Then we pair those hashes up, and hash each pair together into one new hash.",
  "We keep pairing and hashing, level by level, until only one hash is left: the Merkle root.",
  "If a level has an odd number of hashes, the last one is paired with a copy of itself.",
  "The root goes in the block header, so changing any transaction changes the root.",
  "That lets a light wallet check one transaction with just a short path of hashes.",
];

test("live class: send → first reaction p50 under 1.5s, measured in the browser", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // The server's own first-reaction time, to separate it from transport + render.
  const serverMs: number[] = [];
  page.on("websocket", (ws) =>
    ws.on("framereceived", (f) => {
      const m = JSON.parse(String(f.payload)) as {
        type: string;
        payload: { firstReactionMs?: number | null };
      };
      if (m.type === "crowd.done" && typeof m.payload.firstReactionMs === "number")
        serverMs.push(Math.round(m.payload.firstReactionMs));
    }),
  );
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/?stats=1");
  await page.waitForFunction(() => window.__lumen?.store.getState().route.name === "boot");
  await page.waitForTimeout(1500); // the class list has loaded
  const classroomId = process.env.LUMEN_LIVE_CLASSROOM;
  await page.evaluate((id) => window.__lumen!.app.startClass(id!), classroomId);
  await page.waitForFunction(
    () => window.__lumen!.store.getState().classroom.status === "live",
    null,
    {
      timeout: 30_000,
    },
  );
  const st = () => page.evaluate(() => window.__lumen!.store.getState().classroom);
  if ((await st()).clock.paused) await page.keyboard.press("Escape"); // a resumed period

  const latencies: number[] = [];
  for (const line of LINES) {
    const before = (await st()).transcript.length;
    await page.locator("#lectern").fill(line);
    await page.locator("#lectern").press("Enter");
    await page.waitForFunction(
      (n) => {
        const c = window.__lumen!.store.getState().classroom;
        return c.transcript.length > n && !c.thinking;
      },
      before,
      { timeout: 30_000 },
    );
    latencies.push((await st()).lastReactionMs ?? Number.NaN);
    await page.waitForTimeout(2500); // the Director commits before the next turn
  }
  // Call on the first hand and watch the speech stream.
  const hands = (await st()).hands;
  let speechMs: number | null = null;
  if (hands.length) {
    const t0 = Date.now();
    // Focus is still in the (empty) lectern: Tab picks the first hand, Space calls it.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Space");
    await page.waitForFunction(() => !!window.__lumen!.store.getState().classroom.speech, null, {
      timeout: 30_000,
    });
    speechMs = Date.now() - t0;
    await page.waitForFunction(
      () => window.__lumen!.store.getState().classroom.speech?.done,
      null,
      {
        timeout: 60_000,
      },
    );
  }
  await page.screenshot({ path: "docs/screens/m2-live-class.png" });
  await page.mouse.click(1671, 50); // End class
  await page.waitForFunction(
    () => window.__lumen!.store.getState().classroom.status === "ended",
    null,
    {
      timeout: 90_000,
    },
  );
  await page.waitForTimeout(600);
  await page.screenshot({ path: "docs/screens/m2-live-bell.png" });
  const ended = (await st()).ended!;
  const sorted = latencies.filter(Number.isFinite).sort((a, b) => a - b);
  const report = {
    turns: LINES.length,
    firstReactionMs: latencies,
    serverFirstReactionMs: serverMs,
    p50: sorted[Math.floor(sorted.length / 2)],
    max: sorted.at(-1),
    firstSpeechTokenMs: speechMs,
    costUsd: ended.costUsd,
    xpEarned: ended.xp.earned,
    at: new Date().toISOString(),
  };
  console.log(JSON.stringify(report));
  mkdirSync("eval/reports", { recursive: true });
  writeFileSync("eval/reports/m2-latency.json", JSON.stringify(report, null, 2) + "\n");
  expect(report.p50).toBeLessThan(1500);
  expect(errors).toEqual([]);
});
