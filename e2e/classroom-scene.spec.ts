import { expect, test } from "./test";

test("the drawn classroom seats every student, with no console errors (ADR-009)", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/?view=classroom-demo");
  await page.waitForFunction(() => window.__lumen !== undefined);
  await page.waitForTimeout(1500);
  const students = await page.evaluate(
    () => Object.keys(window.__lumen!.store.getState().classroom.cadets).length,
  );
  await expect(page.locator(".room .seat[data-id]")).toHaveCount(students);
  // Raised hands show the pointing-up pose and their queue number.
  await expect(page.locator(".room .badge text")).toHaveCount(2);
  await expect(page.locator(".hud .hand-card")).toHaveCount(2);
  await page.screenshot({ path: "docs/screens/m2-classroom-hud.png" });
  expect(errors).toEqual([]);
});
