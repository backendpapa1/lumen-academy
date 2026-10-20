import { expect, test } from "@playwright/test";

test("client boots Three + Phaser with no console errors and the button works", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");
  await page.waitForFunction(() => window.__lumen !== undefined);

  const info = await page.evaluate(() => ({
    phaser: window.__lumen?.phaserVersion,
    three: window.__lumen?.threeRevision,
    world: (document.querySelector("#world") as HTMLCanvasElement).getContext("webgl2") !== null,
  }));
  expect(info.phaser).toMatch(/^4\./);
  expect(info.three).toBe("186");
  expect(info.world).toBe(true);

  // Let a few frames run, then click the Phaser button (bottom centre).
  await page.waitForTimeout(500);
  const box = await page.locator("#ui").boundingBox();
  if (!box) throw new Error("no #ui canvas");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 80);
  await expect.poll(() => page.evaluate(() => window.__lumen?.store.getState().pings)).toBe(1);

  await page.screenshot({ path: "docs/screens/m0-boot.png" });
  expect(errors).toEqual([]);
});
