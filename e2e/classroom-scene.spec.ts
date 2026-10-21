import { expect, test } from "@playwright/test";

test("classroom scene renders within the draw-call budget, no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/?view=classroom-demo");
  await page.waitForFunction(() => window.__lumen !== undefined);
  await page.waitForTimeout(1500);
  const stats = await page.evaluate(() => ({ ...window.__lumen!.stats }));
  console.log(`stats: ${JSON.stringify(stats)}`);
  expect(stats.drawCalls).toBeGreaterThan(0);
  expect(stats.drawCalls).toBeLessThanOrEqual(150);
  await page.screenshot({ path: "docs/screens/m2-classroom-hud.png" });
  expect(errors).toEqual([]);
});
