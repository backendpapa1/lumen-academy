import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// M5 gate (live): boot → Resume → teaching in ≤ 2 clicks and < 10 s, timed in
// the browser. It opens a real period, so it's opt-in (LUMEN_LIVE=1); run it
// against a copy of the database (LUMEN_DATA_DIR).
test.skip(!process.env.LUMEN_LIVE, "set LUMEN_LIVE=1");

test("boot → Resume → teaching in ≤ 2 clicks and < 10s", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const t0 = Date.now();
  await page.goto("/");
  const resume = page.locator(".resume-btn");
  await expect(resume).toBeVisible({ timeout: 10_000 });
  const shown = Date.now() - t0;
  await expect(resume).toBeFocused(); // Enter alone would do it: zero clicks
  await resume.click(); // click 1
  await page.waitForFunction(
    () => window.__lumen!.store.getState().classroom.status === "live",
    null,
    { timeout: 10_000 },
  );
  const live = Date.now() - t0;
  await page.screenshot({ path: "docs/screens/m5-resumed.png" });
  // A resumed period opens paused ("Welcome back"): Esc, or click 2 on Resume.
  const paused = await page.evaluate(() => window.__lumen!.store.getState().classroom.clock.paused);
  if (paused) await page.keyboard.press("Escape");
  await page.waitForFunction(() => !window.__lumen!.store.getState().classroom.clock.paused, null, {
    timeout: 5000,
  });
  const teaching = Date.now() - t0;
  const report = {
    resumeShownMs: shown,
    liveMs: live,
    teachingMs: teaching,
    clicks: paused ? 2 : 1,
    at: new Date().toISOString(),
  };
  console.log(JSON.stringify(report));
  mkdirSync("eval/reports", { recursive: true });
  writeFileSync("eval/reports/m5-resume.json", JSON.stringify(report, null, 2) + "\n");
  expect(teaching).toBeLessThan(10_000);
  await page.keyboard.press("Escape");
});
