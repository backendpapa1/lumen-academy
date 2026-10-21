import { expect, test } from "@playwright/test";

// The guided tour (Paul's note; replaces M6-07's cards): a fresh browser gets
// it once; it spotlights the lobby, plays simulated class scenes, reads each
// line aloud, and replays from the Tour button.
test.use({ storageState: { cookies: [], origins: [] } });

test("first run: the Head of School's tour, then never again unless asked", async ({ page }) => {
  const narrated: string[] = [];
  await page.route("**/api/**", (r) => {
    const url = r.request().url();
    if (url.includes("/api/speech/narrate")) {
      narrated.push((r.request().postDataJSON() as { text: string }).text);
      return r.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    }
    return r.fulfill({
      status: 200,
      contentType: "application/json",
      body: url.includes("/api/campus")
        ? JSON.stringify({
            wings: [],
            streak: {
              current: 0,
              best: 0,
              missedDays: 0,
              taughtToday: false,
              freezes: 0,
              frozenDays: 0,
            },
            xp: {
              total: 0,
              rank: "Student Teacher",
              next: { name: "Teacher", minXp: 500 },
              progress: 0,
            },
            resume: null,
            fading: null,
            best: null,
          })
        : "[]",
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const tour = page.getByRole("dialog", { name: "Guided tour of Lumen Academy" });
  await expect(tour).toBeVisible();
  await expect(tour.getByText("You learn by teaching.")).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "docs/screens/notes-tour-welcome.png" });

  // Schools: the spotlight is on Found a School.
  await tour.getByRole("button", { name: "Next" }).click();
  await expect(tour.getByText("One School per topic.")).toBeVisible();
  await expect(page.locator(".tour.spot .tour-hole")).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "docs/screens/notes-tour-spotlight.png" });

  // A simulated class: the board fills, then a hand goes up.
  await tour.getByRole("button", { name: "Next" }).click();
  await expect(tour.getByText("Wait, a fingerprint of what exactly?")).toBeVisible({
    timeout: 8000,
  });
  await page.screenshot({ path: "docs/screens/notes-tour-class.png" });

  await page.keyboard.press("ArrowRight");
  await expect(tour.getByText(/That's what you told us!/)).toBeVisible({ timeout: 8000 });
  await page.keyboard.press("ArrowRight");
  await expect(tour.getByText("Re-teach it")).toBeVisible({ timeout: 6000 });
  await page.screenshot({ path: "docs/screens/notes-tour-exam.png" });

  // After a click, each line goes to the narrator sentence by sentence (the
  // browser's own voice reads it when the local one is off, as here).
  expect(narrated).toContain("Hello, I'm Ms Hale, Head of Lumen Academy.");
  expect(narrated).toContain("Each School is one topic you want to learn.");
  expect(narrated.length).toBeGreaterThanOrEqual(5);

  for (let i = 0; i < 12 && (await tour.getByRole("button", { name: "Next" }).count()); i++)
    await tour.getByRole("button", { name: "Next" }).click();
  await expect(tour.getByText("I'm here if you need me.")).toBeVisible();
  await tour.getByRole("button", { name: "Let's teach" }).click();
  await expect(tour).toBeHidden();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Your Schools" })).toBeVisible();
  await page.waitForTimeout(900);
  await expect(tour).toHaveCount(0);
  await page.getByRole("button", { name: "Tour" }).click();
  await expect(tour.getByText("You learn by teaching.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tour).toHaveCount(0);
});
