import { expect, test } from "@playwright/test";

// A fake server socket, so this never touches the real database or models.
// The server half of resume is covered by classroomConnection.test.ts.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const sent: Array<{ type: string }> = [];
    (window as unknown as { __sent: typeof sent }).__sent = sent;
    const seen = localStorage.getItem("__fake_seen") === "1";
    if (!localStorage.getItem("__fake_init")) {
      localStorage.setItem("__fake_init", "1");
      localStorage.setItem("lumen.liveClassroom", "cls_fake");
    }
    const cadet = {
      id: "cdt_1",
      name: "Ines Okoro-Vale",
      archetype: "skeptic",
      seat: 4,
      homeworld: "Titan",
      quirk: "",
      comprehension: 0.3,
      state: "attentive",
    };
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        setTimeout(() => this.onopen?.(), 10);
      }
      private reply(type: string, payload: unknown) {
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type, payload }) }), 20);
      }
      send(data: string) {
        const m = JSON.parse(data) as { type: string };
        sent.push(m);
        if (m.type === "period.start") {
          localStorage.setItem("__fake_seen", "1");
          this.reply("period.started", {
            periodId: "per_fake",
            school: { id: "sch_fake", name: "Blockchain" },
            classroom: { id: "cls_fake", name: "Class A" },
            concept: { id: "cpt_1", title: "Merkle trees" },
            concepts: [{ id: "cpt_1", title: "Merkle trees" }],
            cadets: [cadet],
            plannedMinutes: 15,
            xp: {
              total: 340,
              rank: "Cadet Instructor",
              next: { name: "Lecturer", minXp: 500 },
              progress: 0.68,
            },
            elapsedMs: seen ? 240_000 : 0,
            resumed: seen,
            paused: seen,
            transcript: seen
              ? [
                  { speaker: "Headmaster", messageId: "m1", text: "Hashes pair up to a root." },
                  {
                    speaker: "Ines Okoro-Vale",
                    cadetId: "cdt_1",
                    messageId: "m2",
                    text: "Why pairs?",
                  },
                ]
              : [],
          });
        } else if (m.type === "period.pause" || m.type === "period.resume") {
          this.reply("period.paused", { paused: m.type === "period.pause", elapsedMs: 240_000 });
        } else if (m.type === "period.end") {
          this.reply("period.ended", {
            periodId: "per_fake",
            turns: 6,
            minutes: 12,
            costUsd: 0.0123,
            recapOut: "We'll build a Merkle path and prove one transaction is in the block.",
            xp: {
              earned: 165,
              breakdown: [
                { kind: "teachingMinute", amount: 120 },
                { kind: "questionAnswered", amount: 45 },
              ],
              standing: {
                total: 505,
                rank: "Lecturer",
                next: { name: "Professor", minXp: 2000 },
                progress: 0,
              },
              rankedUp: true,
            },
          });
        }
      }
      close() {}
    }
    (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
});

test("Esc pauses and resumes; a reload continues the period, paused, with its transcript", async ({
  page,
}) => {
  const state = () => page.evaluate(() => window.__lumen!.store.getState());
  await page.goto("/");
  await page.waitForFunction(() => window.__lumen?.store.getState().classroom.status === "live");
  expect((await state()).route.name).toBe("classroom");

  await page.keyboard.press("Escape");
  await expect.poll(async () => (await state()).classroom.clock.paused).toBe(true);
  await expect(page.locator("#lectern")).toBeDisabled();
  await page.screenshot({ path: "docs/screens/m2-paused.png" });
  await page.keyboard.press("Space");
  await expect.poll(async () => (await state()).classroom.clock.paused).toBe(false);

  await page.reload();
  await page.waitForFunction(() => window.__lumen?.store.getState().classroom.status === "live");
  const s = await state();
  expect(s.classroom.resumed).toBe(true);
  expect(s.classroom.clock.paused).toBe(true);
  expect(s.classroom.transcript.map((t) => t.text)).toEqual([
    "Hashes pair up to a root.",
    "Why pairs?",
  ]);
  await page.waitForTimeout(400);
  await page.screenshot({ path: "docs/screens/m2-welcome-back.png" });
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await state()).classroom.clock.paused).toBe(false);

  // End class (top-right button on the Phaser canvas) forgets the live class.
  await page.mouse.click(1671, 50);
  await expect.poll(async () => (await state()).classroom.status).toBe("ended");
  expect(await page.evaluate(() => localStorage.getItem("lumen.liveClassroom"))).toBeNull();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "docs/screens/m2-bell-out.png" });
});
