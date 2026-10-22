import { expect, test } from "./test";

// M6-03: sound starts only after a gesture, follows the room, and M mutes it.
test("audio unlocks on the first gesture, and M toggles it", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?view=classroom-demo");
  await page.waitForFunction(() => window.__lumen !== undefined);
  const ctx = () =>
    page.evaluate(
      () => (window.__lumen!.sound as unknown as { ctx: AudioContext | null }).ctx?.state ?? "none",
    );
  expect(await ctx()).toBe("none"); // nothing before a gesture
  await page.mouse.click(640, 400);
  await expect.poll(ctx).not.toBe("none");
  await page.keyboard.press("m"); // the classroom key map: mute
  await expect.poll(() => page.evaluate(() => window.__lumen!.sound.muted)).toBe(true);
  await expect.poll(ctx).toBe("none");
  await page.keyboard.press("m");
  await expect.poll(() => page.evaluate(() => window.__lumen!.sound.muted)).toBe(false);
  expect(errors).toEqual([]);
});
