import { expect, test } from "@playwright/test";

// V3-05: a Pomodoro break after a work block; a reload during it comes back
// to the break, and nothing is lost. Socket and API are faked.

test("a break after 15 minutes of teaching survives a reload", async ({ page }) => {
  await page.route("**/api/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.addInitScript(() => {
    localStorage.setItem("lumen.rhythm", JSON.stringify({ checkIn: false, breaks: "15/3" }));
    localStorage.setItem("lumen.liveClassroom", "cls_fake");
    const sent: string[] = [];
    (window as unknown as { __sent: string[] }).__sent = sent;
    const cadets = [1, 2, 3].map((i) => ({
      id: `cdt_${i}`,
      name: ["Ines Okoro", "Kenji Arai", "Sol Ferreira"][i - 1],
      archetype: "skeptic",
      seat: i,
      homeworld: "Leeds",
      quirk: "",
      comprehension: 0.4,
      state: "attentive",
    }));
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
        sent.push(m.type);
        // Paused state survives the reload, like the server's.
        const paused = localStorage.getItem("__paused") === "1";
        if (m.type === "period.start")
          this.reply("period.started", {
            periodId: "per_fake",
            school: { id: "sch_fake", name: "Blockchain" },
            classroom: { id: "cls_fake", name: "Class A" },
            concept: { id: "cpt_1", title: "Merkle trees" },
            concepts: [{ id: "cpt_1", title: "Merkle trees" }],
            cadets,
            plannedMinutes: 45,
            // One second before the first work block ends.
            elapsedMs: 15 * 60_000 - 1200,
            resumed: paused,
            paused,
            transcript: [],
            xp: { total: 0, rank: "Student Teacher", next: null, progress: 0 },
          });
        if (m.type === "period.pause" || m.type === "period.resume") {
          localStorage.setItem("__paused", m.type === "period.pause" ? "1" : "0");
          this.reply("period.paused", {
            paused: m.type === "period.pause",
            elapsedMs: 15 * 60_000,
          });
        }
      }
      close() {}
    }
    (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");

  const card = page.getByRole("dialog", { name: "Break" });
  await expect(card).toBeVisible({ timeout: 8000 });
  await expect(card.getByRole("timer")).toHaveText(/^[23]:\d\d$/);
  await expect(page.locator(".room.break")).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: "docs/screens/v3-break.png" });

  await page.reload();
  await expect(page.getByRole("dialog", { name: "Break" })).toBeVisible();
  await page.getByRole("button", { name: "Back to it" }).click();
  await expect(page.getByRole("dialog", { name: "Break" })).toHaveCount(0);
  await expect(page.locator(".room.break")).toHaveCount(0);
  const sent = await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent);
  expect(sent).toContain("period.resume");
});
