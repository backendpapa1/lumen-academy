import { expect, test, type Page } from "@playwright/test";

// V3: the lobby's one button, the energy check-in and a micro-lesson's lit
// desk. API and socket are faked, so this never touches real data or models.

const campus = {
  wings: [],
  streak: { current: 8, best: 8, missedDays: 1, taughtToday: false, freezes: 1, frozenDays: 0 },
  xp: {
    total: 340,
    rank: "Student Teacher",
    next: { name: "Teacher", minXp: 500 },
    progress: 0.68,
  },
  resume: {
    schoolId: "sch_fake",
    schoolName: "Blockchain",
    classroomId: "cls_fake",
    classroomName: "Class A",
    conceptTitle: "Hashing",
    inProgress: false,
    lastAt: "2026-10-20T10:00:00Z",
  },
  fading: null,
  best: {
    classroomId: "cls_fake",
    classroomName: "Class A",
    schoolName: "Blockchain",
    conceptId: "cpt_2",
    conceptTitle: "Merkle trees",
    why: "next",
    reason: "Next in the curriculum: nobody in Class A has met it yet.",
  },
};

async function boot(page: Page) {
  await page.route("**/api/**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: r.request().url().includes("/api/campus") ? JSON.stringify(campus) : "[]",
    }),
  );
  await page.addInitScript((xp) => {
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    (window as unknown as { __sent: typeof sent }).__sent = sent;
    const cadet = (id: string, name: string, seat: number) => ({
      id,
      name,
      archetype: "skeptic",
      seat,
      homeworld: "Leeds",
      quirk: "",
      comprehension: 0.2,
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
        const m = JSON.parse(data) as { type: string; payload: Record<string, unknown> };
        sent.push(m);
        if (m.type !== "period.start") return;
        const micro = m.payload.kind === "micro";
        const payload = {
          periodId: "per_fake",
          school: { id: "sch_fake", name: "Blockchain" },
          classroom: { id: "cls_fake", name: "Class A" },
          concept: { id: "cpt_2", title: "Merkle trees" },
          concepts: [{ id: "cpt_2", title: "Merkle trees" }],
          cadets: micro
            ? [cadet("cdt_2", "Kenji Arai", 2)]
            : [cadet("cdt_1", "Ines Okoro", 1), cadet("cdt_2", "Kenji Arai", 2)],
          plannedMinutes: micro ? 3 : 15,
          elapsedMs: 0,
          resumed: false,
          paused: false,
          transcript: [],
          xp,
          kind: micro ? "micro" : "class",
          energy: m.payload.energy ?? null,
        };
        setTimeout(
          () => this.onmessage?.({ data: JSON.stringify({ type: "period.started", payload }) }),
          20,
        );
      }
      close() {}
    }
    (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  }, campus.xp);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
}

const starts = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __sent: Array<{ type: string; payload: unknown }> }).__sent.filter(
      (m) => m.type === "period.start",
    ),
  );

test("today's best class: Enter, one tap on energy, and the class starts", async ({ page }) => {
  await boot(page);
  const card = page.getByRole("region", { name: "Today's best class" });
  await expect(card.getByText("Merkle trees")).toBeVisible();
  await expect(card.getByText(/nobody in Class A/)).toBeVisible();
  await expect(page.getByText("1 freeze banked")).toBeVisible();
  await expect(card.getByRole("button", { name: "Start class" })).toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "How's your energy?" });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "docs/screens/v3-checkin.png" });
  await page.keyboard.press("3");
  await expect(page.locator(".room")).toBeVisible();
  expect(await starts(page)).toEqual([
    {
      type: "period.start",
      payload: { classroomId: "cls_fake", conceptId: "cpt_2", energy: "high" },
    },
  ]);
  await expect(page.getByText(/Press F for Hyperfocus/)).toBeVisible();
});

test("low energy offers a micro-lesson: one student under the light", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Start class" }).click();
  const dialog = page.getByRole("dialog", { name: "How's your energy?" });
  await dialog.getByRole("button", { name: /^Low/ }).click();
  await dialog.getByRole("button", { name: "Micro-lesson · 3 min" }).click();
  await expect(page.locator(".room.micro")).toBeVisible();
  await expect(page.locator(".room .seat:not(.empty)")).toHaveCount(1);
  expect((await starts(page))[0]!.payload).toEqual({
    classroomId: "cls_fake",
    conceptId: "cpt_2",
    energy: "low",
    kind: "micro",
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: "docs/screens/v3-micro.png" });
});

test("'Don't ask me again' turns the check-in off for good", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Start class" }).click();
  await page.getByRole("button", { name: "Don't ask me again" }).click();
  await expect(page.locator(".room")).toBeVisible();
  // Back in the lobby (not rejoining that class), start a micro-lesson.
  await page.evaluate(() => localStorage.removeItem("lumen.liveClassroom"));
  await page.goto("/");
  await page.getByRole("button", { name: "Micro-lesson · 3 min" }).click();
  await expect(page.locator(".room.micro")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "How's your energy?" })).toHaveCount(0);
});
