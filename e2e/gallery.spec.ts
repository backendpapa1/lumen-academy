import { expect, test } from "@playwright/test";

test("component gallery renders with fonts and no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/?view=gallery");
  await page.waitForFunction(() => window.__lumen !== undefined);
  const fonts = await page.evaluate(() =>
    ["Space Grotesk", "Inter", "JetBrains Mono"].map((f) => document.fonts.check(`16px "${f}"`)),
  );
  expect(fonts).toEqual([true, true, true]);
  await page.waitForTimeout(700);
  await page.screenshot({ path: "docs/screens/m2-gallery.png" });
  expect(errors).toEqual([]);
});
