import { expect, test } from "./test";

// V7-01: a decorated room (every upgrade on its spot, the class reacting to a
// new one) and the Decorate picker. Socket and API faked.

test("a decorated room: the class notices what's new", async ({ page }) => {
  await page.route("**/api/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.addInitScript(() => {
    localStorage.setItem("lumen.rhythm", JSON.stringify({ checkIn: false, breaks: "off" }));
    localStorage.setItem("lumen.liveClassroom", "cls_fake");
    const cadet = (i: number, name: string, archetype: string) => ({
      id: `cdt_${i}`,
      name,
      archetype,
      seat: i,
      homeworld: "Leeds",
      quirk: "",
      comprehension: 0.5,
      state: "attentive",
    });
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        setTimeout(() => this.onopen?.(), 10);
      }
      send(data: string) {
        const m = JSON.parse(data) as { type: string };
        if (m.type !== "period.start") return;
        const payload = {
          periodId: "per_fake",
          school: { id: "sch_fake", name: "Blockchain" },
          classroom: { id: "cls_fake", name: "Class A" },
          concept: { id: "cpt_1", title: "Merkle trees" },
          concepts: [{ id: "cpt_1", title: "Merkle trees" }],
          cadets: [
            cadet(1, "Ivy Achebe", "connector"),
            cadet(2, "Ada Quill", "lost_signal"),
            cadet(3, "Sora Lee", "quiet"),
            cadet(4, "Kenji Arai", "skeptic"),
          ],
          plannedMinutes: 15,
          elapsedMs: 0,
          resumed: false,
          paused: false,
          transcript: [],
          xp: { total: 2400, rank: "Senior Teacher", next: null, progress: 0 },
          stickers: [],
          upgrades: [
            "plant",
            "poster",
            "goldfish",
            "cat",
            "reading_corner",
            "string_lights",
            "globe",
            "rug",
          ],
          newUpgrades: ["goldfish"],
          emblemUrl: null,
        };
        setTimeout(
          () => this.onmessage?.({ data: JSON.stringify({ type: "period.started", payload }) }),
          20,
        );
      }
      close() {}
    }
    (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await expect(page.locator(".room .upgrades > *")).toHaveCount(8);
  await expect(page.getByText("A fish! Does it have a name?")).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "docs/screens/v7-decorated-room.png" });
});

test("Decorate: slots by rank, chosen items marked, full means no more", async ({ page }) => {
  await page.route("**/api/**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        r.request().url().includes("/upgrades")
          ? { slots: 3, rank: "Senior Teacher", chosen: ["goldfish", "string_lights", "cat"] }
          : r.request().url().includes("/api/campus")
            ? {
                wings: [],
                streak: {
                  current: 3,
                  best: 8,
                  missedDays: 0,
                  taughtToday: true,
                  freezes: 1,
                  frozenDays: 0,
                },
                xp: { total: 2400, rank: "Senior Teacher", next: null, progress: 0.1 },
                resume: null,
                fading: null,
                best: null,
              }
            : [],
      ),
    }),
  );
  await page.addInitScript(() =>
    localStorage.setItem("lumen.rhythm", JSON.stringify({ checkIn: false, breaks: "off" })),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.evaluate(async () => {
    const m = await import("/src/ui/screens/decorate.ts");
    m.openDecorate("cls_fake", "Class A");
  });
  const dialog = page.getByRole("dialog", { name: "Decorate Class A" });
  await expect(dialog.getByText("Senior Teacher: 3 slots, 0 free")).toBeVisible();
  await expect(dialog.locator(".deco-card.on")).toHaveCount(3);
  await expect(dialog.getByRole("button", { name: /Rug/ })).toBeDisabled();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "docs/screens/v7-decorate.png" });
});
