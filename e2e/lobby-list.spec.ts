import { expect, test } from "@playwright/test";

// Paul's notes: a growing School list (the lobby shows the 5 most recent, the
// rest behind "See all") and deleting an archived School. API faked.

const school = (i: number, last: string | null) => ({
  id: `sch_${i}`,
  name: [
    "Blockchain",
    "Statistics",
    "Geology",
    "Optics",
    "Rust",
    "Jazz theory",
    "Tax law",
    "Botany",
  ][i],
  description: null,
  accent: "#2A40FF",
  emblemUrl: null,
  sources: 1,
  concepts: 10 + i,
  classrooms: [
    { id: `cls_${i}`, name: "Class A", status: "active", cadets: 8, lastPeriodAt: last },
  ],
});

test.beforeEach(async ({ page }) => {
  const deleted: string[] = [];
  await page.route("**/api/**", async (r) => {
    const url = r.request().url();
    let body: unknown = [];
    let status = 200;
    if (/\/api\/schools$/.test(url))
      body = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
        school(i, i === 6 ? "2026-10-21T09:00:00Z" : i < 3 ? `2026-10-0${i + 1}T09:00:00Z` : null),
      );
    else if (url.includes("/api/schools/archived"))
      body = deleted.includes("sch_old")
        ? []
        : [{ id: "sch_old", name: "Old Physics", accent: null, concepts: 12, classrooms: 1 }];
    else if (url.includes("/api/schools/sch_old/delete")) {
      const name = (r.request().postDataJSON() as { name: string }).name;
      if (name.toLowerCase() === "old physics") {
        deleted.push("sch_old");
        body = { ok: true };
      } else {
        status = 400;
        body = { error: "Type the School's name." };
      }
    } else if (url.includes("/api/campus"))
      body = {
        wings: [],
        streak: {
          current: 1,
          best: 1,
          missedDays: 0,
          taughtToday: true,
          freezes: 0,
          frozenDays: 0,
        },
        xp: { total: 0, rank: "Student Teacher", next: null, progress: 0 },
        resume: null,
        fading: null,
        best: null,
      };
    else if (url.includes("/api/looks")) body = {};
    await r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.addInitScript(() => {
    localStorage.setItem("lumen.onboarded", "1");
    localStorage.setItem("lumen.rhythm", JSON.stringify({ checkIn: false, breaks: "off" }));
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
});

test("five recent Schools on the lobby, the rest in a searchable list", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.locator(".school-grid .school-card:not(.new-school):not(.all-schools)"),
  ).toHaveCount(5);
  // Most recently taught first.
  await expect(page.locator(".school-grid .school-card .h2").first()).toHaveText("Tax law");
  await page.getByRole("button", { name: /See all Schools \(3 more\)/ }).click();
  const dialog = page.getByRole("dialog", { name: "All Schools · 8" });
  await expect(dialog.locator(".all-row")).toHaveCount(8);
  await dialog.getByRole("searchbox").fill("bot");
  await expect(dialog.locator(".all-row")).toHaveCount(1);
  await expect(dialog.getByText("Botany")).toBeVisible();
  await dialog.getByRole("searchbox").fill("");
  await page.screenshot({ path: "docs/screens/notes-all-schools.png" });
});

test("delete an archived School only after typing its name", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Archived · 1").click();
  await page.getByRole("button", { name: "Delete Old Physics for good" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Old Physics?" });
  const go = dialog.getByRole("button", { name: "Delete for good" });
  await expect(go).toBeDisabled();
  await dialog.getByRole("textbox", { name: "School name" }).fill("old physics");
  await expect(go).toBeEnabled();
  await page.screenshot({ path: "docs/screens/notes-delete-school.png" });
  await go.click();
  await expect(page.getByText("Old Physics is deleted.")).toBeVisible();
  await expect(page.getByText("Archived · 1")).toHaveCount(0);
});
