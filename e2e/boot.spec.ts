import { expect, test } from "@playwright/test";

test("boots Three + Phaser and lists classes from the server, no console errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  const schools = page.waitForResponse((r) => r.url().endsWith("/api/schools") && r.ok());
  await page.goto("/");
  await page.waitForFunction(() => window.__lumen !== undefined);
  await schools;
  const info = await page.evaluate(() => ({
    phaser: window.__lumen?.phaserVersion,
    three: window.__lumen?.threeRevision,
    route: window.__lumen?.store.getState().route.name,
    world: (document.querySelector("#world") as HTMLCanvasElement).getContext("webgl2") !== null,
  }));
  expect(info).toMatchObject({ three: "186", route: "boot", world: true });
  expect(info.phaser).toMatch(/^4\./);
  await page.waitForTimeout(400);
  await page.screenshot({ path: "docs/screens/m2-boot.png" });
  expect(errors).toEqual([]);
});
