import { expect, test } from "@playwright/test";

// T-7: the bell rings at the planned time and asks; "5 more minutes" extends.
// Fake socket: the period starts 1.5 s before its planned 5 minutes.
test("the bell asks to end or extend; extending carries on", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen.liveClassroom", "cls_bell");
    const sent: Array<{ type: string; payload: unknown }> = [];
    (window as unknown as { __sent: typeof sent }).__sent = sent;
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        setTimeout(() => this.onopen?.(), 5);
      }
      private reply(type: string, payload: unknown) {
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type, payload }) }), 10);
      }
      send(data: string) {
        const m = JSON.parse(data) as { type: string; payload: { minutes?: number } };
        sent.push(m);
        if (m.type === "period.start")
          this.reply("period.started", {
            periodId: "per_b",
            school: { id: "sch_b", name: "Optics" },
            classroom: { id: "cls_bell", name: "Class A" },
            concept: { id: "cpt_1", title: "Lenses" },
            concepts: [{ id: "cpt_1", title: "Lenses" }],
            cadets: [],
            plannedMinutes: 5,
            elapsedMs: 5 * 60_000 - 1500,
            resumed: false,
            paused: false,
            transcript: [],
            xp: {
              total: 0,
              rank: "Cadet Instructor",
              next: { name: "Lecturer", minXp: 500 },
              progress: 0,
            },
          });
        if (m.type === "period.extend")
          this.reply("period.extended", { plannedMinutes: 5 + (m.payload.minutes ?? 0) });
      }
      close() {}
    }
    (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  });
  await page.route("**/api/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.waitForFunction(() => window.__lumen?.store.getState().classroom.status === "live");
  const planned = () =>
    page.evaluate(() => window.__lumen!.store.getState().classroom.plannedMinutes);
  // The bell card is drawn on the Phaser canvas; "E" is its keyboard answer.
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "docs/screens/m6-bell.png" });
  await page.keyboard.press("e");
  await expect.poll(planned).toBe(10);
  const sent = await page.evaluate(
    () => (window as unknown as { __sent: Array<{ type: string; payload: unknown }> }).__sent,
  );
  expect(sent.filter((m) => m.type === "period.extend")).toEqual([
    { type: "period.extend", payload: { minutes: 5 } },
  ]);
});
