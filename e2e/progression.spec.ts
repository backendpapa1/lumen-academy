import { expect, test } from "@playwright/test";

// V7: the class photo, decorating a room, and the progress screen, over a
// faked API (no real data or models).

const names = [
  "Ivy Achebe",
  "Ada Quill",
  "Sora Lee",
  "Kenji Arai",
  "Noor Haddad",
  "Bo Renn",
  "Fen Ito",
  "Jo Kaur",
  "Eli Varga",
  "Hal Brandt",
  "Mia Lund",
  "Tariq Osei",
];

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (r) => {
    const url = r.request().url();
    let body: unknown = [];
    if (url.includes("/photo-data"))
      body = {
        className: "Class A",
        school: "Blockchain",
        accent: "#0E8A80",
        graduated: true,
        saved: false,
        date: "2026-10-21",
        students: names.map((name, i) => ({
          id: `cdt_${i}`,
          name,
          archetype: "skeptic",
          hair: ["afro", "long braids", "bun", "short", "curly"][i % 5],
          stickers:
            i % 3 === 0 ? ["best_analogy", "fixed_confusion"] : i % 4 === 0 ? ["landed"] : [],
        })),
      };
    else if (url.includes("/api/progress"))
      body = {
        weeks: [
          "2026-09-01",
          "2026-09-08",
          "2026-09-15",
          "2026-09-22",
          "2026-09-29",
          "2026-10-06",
          "2026-10-13",
          "2026-10-20",
        ].map((week, i) => ({
          week,
          minutes: [0, 15, 40, 25, 60, 30, 75, 50][i],
          sessions: [0, 1, 3, 2, 4, 2, 5, 3][i],
          mastered: [0, 0, 1, 0, 2, 1, 3, 1][i],
          clarity: i ? 0.55 + i * 0.04 : null,
          accuracy: i ? 0.7 + i * 0.03 : null,
          voice: i > 4 ? 0.2 * (i - 4) : 0,
        })),
        energy: [
          { energy: "low", sessions: 4, clarity: 0.62, accuracy: 0.81, minutes: 30 },
          { energy: "ok", sessions: 8, clarity: 0.74, accuracy: 0.88, minutes: 160 },
          { energy: "high", sessions: 5, clarity: 0.81, accuracy: 0.9, minutes: 105 },
          { energy: "unset", sessions: 3, clarity: 0.7, accuracy: 0.85, minutes: 0 },
        ],
        totals: { minutes: 295, sessions: 20, mastered: 8, turns: 240 },
      };
    else if (url.includes("/api/style"))
      body = {
        computedAt: "2026-10-21T10:00:00Z",
        enough: true,
        written: true,
        stats: { turns: 240 },
        sentences: [
          "You use an analogy in 31% of your turns but give a worked example in only 6%.",
          "Your explanations average 42 words, longer on high-energy days.",
          "You check for understanding in 12% of turns and correct wrong claims kindly 9 times out of 11.",
        ],
        suggestion: "After each new idea, ask one quick question before moving on.",
      };
    else if (url.includes("/upgrades"))
      body = { slots: 3, rank: "Senior Teacher", chosen: ["goldfish", "string_lights"] };
    else if (url.includes("/api/campus"))
      body = {
        wings: [],
        streak: {
          current: 3,
          best: 8,
          missedDays: 0,
          taughtToday: true,
          freezes: 1,
          frozenDays: 0,
        },
        xp: {
          total: 2400,
          rank: "Senior Teacher",
          next: { name: "Head of Department", minXp: 6000 },
          progress: 0.1,
        },
        resume: null,
        fading: null,
        best: null,
      };
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.addInitScript(() =>
    localStorage.setItem("lumen.rhythm", JSON.stringify({ checkIn: false, breaks: "off" })),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
});

test("the class photo: caps, gowns, stickers and a banner", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const m = await import("/src/ui/screens/classPhoto.ts");
    m.openClassPhoto("cls_fake");
  });
  const dialog = page.getByRole("dialog", { name: "Class photo" });
  await expect(dialog.getByRole("img", { name: "Class A's class photo" })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "docs/screens/v7-class-photo.png" });
  await expect(dialog.getByRole("button", { name: "Keep it for the yearbook" })).toBeVisible();
});

test("progress: totals, weekly charts, energy days and the style profile", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Your progress and teaching style/ }).click();
  await expect(page.getByRole("heading", { name: "Your progress" })).toBeVisible();
  await expect(page.getByText("295")).toBeVisible();
  await expect(page.getByRole("img", { name: "Minutes taught" })).toBeVisible();
  await expect(page.getByText("You use an analogy in 31%")).toBeVisible();
  await expect(page.getByText(/clearest teaching happens on high-energy days/)).toBeVisible();
  await page.screenshot({ path: "docs/screens/v7-progress.png", fullPage: true });
});

test("campus: tier pieces, trophies, and festival day for a new Landmark", async ({ page }) => {
  const school = (id: string, name: string, accent: string) => ({
    id,
    name,
    description: null,
    accent,
    emblemUrl: null,
    sources: 1,
    concepts: 12,
    classrooms: [],
  });
  const wing = (schoolId: string, slot: number, tier: number, trophies: number) => ({
    schoolId,
    slot,
    tier,
    tierName: ["Blueprint", "Frame", "Wing", "Tower", "Landmark"][tier],
    masteredFraction: tier / 4,
    nextAt: null,
    graduations: 0,
    decalUrl: null,
    trophies,
  });
  await page.route(/\/api\/schools$/, (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        school("sch_a", "Blockchain", "#0E8A80"),
        school("sch_b", "Statistics", "#F0442E"),
      ]),
    }),
  );
  await page.route("**/api/campus", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        wings: [wing("sch_a", 0, 4, 3), wing("sch_b", 2, 3, 0)],
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
      }),
    }),
  );
  // The Blockchain building was a Tower last time I looked.
  await page.addInitScript(() =>
    localStorage.setItem("lumen.seenTiers", JSON.stringify({ sch_a: 3, sch_b: 3 })),
  );
  await page.goto("/");
  await expect(page.getByText(/Festival day! Blockchain is now a Landmark/)).toBeVisible();
  await expect(page.locator(".campus .fountain")).toHaveCount(1);
  await expect(page.locator(".campus .lab")).toHaveCount(2);
  await expect(page.locator(".campus .trophies .cup")).toHaveCount(3);
  await expect(page.locator(".campus .bunting")).toHaveCount(1);
  await expect(page.locator(".campus .crowd .cheer")).toHaveCount(5);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "docs/screens/v7-campus-festival.png" });
});
