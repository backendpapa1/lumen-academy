import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "./test";

// M3 gate (live): in the browser, found a School, upload a PDF, build and edit
// the curriculum, open a class and watch cadets arrive with real portraits.
// Real server + DeepSeek + OpenAI images (≈$0.30). Opt-in: LUMEN_LIVE=1 and
// LUMEN_GATE_PDF=<file>; run it against a copy of the database (LUMEN_DATA_DIR).
test.skip(
  !process.env.LUMEN_LIVE || !process.env.LUMEN_GATE_PDF,
  "set LUMEN_LIVE=1 and LUMEN_GATE_PDF",
);
test.setTimeout(900_000);

test("M3 gate: School → PDF → curriculum → class with portraits, no CLI", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const marks: Record<string, number> = {};
  const t0 = Date.now();
  const mark = (k: string) => (marks[k] = Date.now() - t0);
  const name = `Photosynthesis ${new Date().toISOString().slice(11, 16).replace(":", "")}`;
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");

  await page.getByRole("button", { name: "Found a new School" }).click();
  await page.getByLabel("Topic").fill(name);
  await page
    .getByLabel("Description")
    .fill("How plants turn light into sugar: pigments, the light reactions and the Calvin cycle.");
  await page.getByRole("button", { name: "Found School" }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  mark("schoolCreated");

  await page.locator('input[type="file"]').setInputFiles(process.env.LUMEN_GATE_PDF!);
  await expect(page.locator(".source-row .chip.ok")).toBeVisible({ timeout: 180_000 });
  mark("sourceIndexed");
  await page.screenshot({ path: "docs/screens/m3-gate-sources.png" });

  await page.getByRole("button", { name: "Next: curriculum" }).click();
  await page.getByRole("button", { name: "Build curriculum" }).click();
  await expect(page.locator(".node").first()).toBeVisible({ timeout: 480_000 });
  mark("curriculumBuilt");
  const concepts = await page.locator(".node").count();
  await page.screenshot({ path: "docs/screens/m3-gate-curriculum.png" });

  // Edit: rename the first concept and save.
  await page.locator(".node").first().click();
  const title = page.locator("#c-title");
  const original = await title.inputValue();
  await title.fill(`${original} (core)`);
  await title.blur();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/Curriculum saved/)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".node").first()).toContainText("(core)");

  await page.getByRole("tab", { name: "Classes" }).click();
  await page.getByRole("button", { name: "Open a class" }).last().click();
  await expect(page.locator(".enroll").first()).toBeVisible({ timeout: 60_000 });
  mark("firstArrival");
  await expect(page.getByText("Class assembled")).toBeVisible({ timeout: 240_000 });
  mark("assembled");
  const cadets = await page.locator(".enroll").count();
  // Portraits keep landing after the class assembles.
  await expect
    .poll(async () => page.locator(".enroll .portrait img:not(.sil)").count(), {
      timeout: 240_000,
      intervals: [3000],
    })
    .toBeGreaterThanOrEqual(Math.min(cadets, 4));
  await page.waitForTimeout(8000);
  const portraits = await page.locator(".enroll .portrait img:not(.sil)").count();
  mark("portraits");
  await page.screenshot({ path: "docs/screens/m3-gate-registration.png" });

  await page.getByRole("button", { name: "Start teaching" }).click();
  await page.waitForFunction(
    () => window.__lumen!.store.getState().classroom.status === "live",
    null,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(3000);
  await page.screenshot({ path: "docs/screens/m3-gate-classroom.png" });
  await page.screenshot({ path: "docs/screens/classroom.png" });
  await page.keyboard.press("Escape");

  const report = {
    school: name,
    concepts,
    cadets,
    portraits,
    ms: marks,
    at: new Date().toISOString(),
  };
  console.log(JSON.stringify(report));
  mkdirSync("eval/reports", { recursive: true });
  writeFileSync("eval/reports/m3-gate.json", JSON.stringify(report, null, 2) + "\n");
  expect(marks.firstArrival! - marks.curriculumBuilt!).toBeLessThan(120_000);
  expect(errors).toEqual([]);
});
