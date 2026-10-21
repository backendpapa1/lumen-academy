import { expect, test } from "@playwright/test";

test("boots the drawn campus and opens the lobby with Schools from the server, no console errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  const schools = page.waitForResponse((r) => r.url().endsWith("/api/schools") && r.ok());
  await page.goto("/");
  await page.waitForFunction(() => window.__lumen !== undefined);
  await schools;
  expect(await page.evaluate(() => window.__lumen?.store.getState().route.name)).toBe("boot");
  // ADR-009: no WebGL; the campus is an SVG behind the lobby.
  await expect(page.locator(".campus svg .hall")).toHaveCount(1);
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Your Schools" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Found a new School" })).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: "docs/screens/m3-lobby.png" });
  expect(errors).toEqual([]);
});
