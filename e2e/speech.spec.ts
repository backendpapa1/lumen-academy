import { expect, test } from "@playwright/test";

test("speech panel types the stream in and shimmers on a rewrite", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/?view=classroom-demo");
  await page.waitForFunction(() => window.__lumen !== undefined);

  const panel = page.locator("#speech");
  await expect(panel).toHaveClass(/shown/);
  await expect(panel.locator(".who")).toHaveText("Ines Okoro-Vale");
  // Typing, not dumped: partway through shortly after it appears.
  const early = (await panel.locator("p").textContent())!.length;
  expect(early).toBeLessThan(88);
  await expect(panel.locator("p")).toHaveText(/odd number\?$/, { timeout: 8000 });

  await page.evaluate(() => {
    const r = window.__lumen!.receive;
    r({
      type: "cadet.done",
      payload: {
        cadetId: "cdt_0",
        streamId: "s1",
        messageId: "msg_1",
        text: "Headmaster, you said neighbouring hashes are paired. What if a level has an odd number?",
        kind: "question",
        mood: "curious",
      },
    });
    r({
      type: "cadet.rewrite",
      payload: { messageId: "msg_1", cadetId: "cdt_0", text: "What happens when a level is odd?" },
    });
  });
  await expect(panel).toHaveClass(/rephrasing/);
  await page.waitForTimeout(400);
  await page.screenshot({ path: "docs/screens/m2-speech-rephrasing.png" });
  await expect(panel.locator("p")).toHaveText("What happens when a level is odd?");
  await expect(panel).not.toHaveClass(/rephrasing/, { timeout: 2000 });
  await expect(page.locator("#stage [aria-live]")).toContainText(
    "What happens when a level is odd?",
  );
  expect(errors).toEqual([]);
});
