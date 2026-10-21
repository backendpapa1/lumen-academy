import { expect, test } from "@playwright/test";

// M6-07: a fresh browser sees the first-run cards once; Skip or Esc ends them.
test.use({ storageState: { cookies: [], origins: [] } });

test("first run shows five cards, then never again", async ({ page }) => {
  await page.route("**/api/**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: r.request().url().includes("/api/campus")
        ? JSON.stringify({
            wings: [],
            streak: { current: 0, best: 0, missedDays: 0, taughtToday: false },
            xp: {
              total: 0,
              rank: "Cadet Instructor",
              next: { name: "Lecturer", minXp: 500 },
              progress: 0,
            },
            resume: null,
          })
        : "[]",
    }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const dialog = page.getByRole("dialog", { name: "Welcome to Lumen Academy" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("You learn by teaching.")).toBeVisible();
  await page.screenshot({ path: "docs/screens/m6-onboarding.png" });
  for (let i = 0; i < 4; i++) await dialog.getByRole("button", { name: "Next" }).click();
  await expect(dialog.getByText("Mostly your keyboard.")).toBeVisible();
  await dialog.getByRole("button", { name: "Let's teach" }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your Schools" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Welcome to Lumen Academy" })).toHaveCount(0);
});
