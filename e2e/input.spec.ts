import { expect, test, type Page } from "./test";

// The demo has no server, so record what the client tries to send instead.
async function sent(page: Page) {
  return page.evaluate(() => (window as unknown as { __sent: unknown[] }).__sent);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const log: unknown[] = [];
    (window as unknown as { __sent: unknown[] }).__sent = log;
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      log.push(JSON.parse(String(data)));
      return send.call(this, data);
    };
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/?view=classroom-demo");
  await page.waitForFunction(() => window.__lumen !== undefined);
  await page.waitForTimeout(800);
});

test("Tab cycles the hand queue, Space calls the selected hand", async ({ page }) => {
  const selected = () => page.evaluate(() => window.__lumen!.store.getState().selectedId);
  await page.keyboard.press("Tab");
  expect(await selected()).toBe("cdt_1");
  await page.keyboard.press("Tab");
  expect(await selected()).toBe("cdt_8");
  await page.keyboard.press("Shift+Tab");
  expect(await selected()).toBe("cdt_1");
  await page.keyboard.press("Space");
  await expect.poll(async () => JSON.stringify(await sent(page))).toContain('"cadetId":"cdt_1"');
});

test("the lectern owns typing; Esc leaves it; Enter returns to it", async ({ page }) => {
  await page.keyboard.press("Enter");
  await expect(page.locator("#lectern")).toBeFocused();
  await page.keyboard.type("r 2 f");
  await expect(page.locator("#lectern")).toHaveValue("r 2 f");
  expect(await page.evaluate(() => window.__lumen!.store.getState().classroom.toasts.length)).toBe(
    0,
  );
  await page.keyboard.press("Escape");
  await expect(page.locator("#lectern")).not.toBeFocused();
  await page.keyboard.press("`");
  await expect(page.locator("#transcript")).toHaveClass(/open/);
  await page.keyboard.press("Escape");
  await expect(page.locator("#transcript")).not.toHaveClass(/open/);
  await page.keyboard.press("f");
  // Any toast: a dev server on :5174, if one is running, may answer the demo with its own.
  await expect
    .poll(() =>
      page.evaluate(() =>
        window
          .__lumen!.store.getState()
          .classroom.toasts.map((t) => t.text)
          .join(" | "),
      ),
    )
    .toContain("Hyperfocus on");
  expect(JSON.stringify(await sent(page))).toContain('"type":"focus.toggle"');
});

test("hovering a cadet tags them; clicking a raised hand calls on them", async ({ page }) => {
  // Find a point on Tomas (cdt_1, hand up) with the world's own picker.
  // Aim at the middle of their hit area: the camera's breathing drift moves edges.
  const at = await page.evaluate(() => {
    const hits: Array<[number, number]> = [];
    for (let y = 0; y < innerHeight; y += 8)
      for (let x = 0; x < innerWidth; x += 8)
        if (
          window.__lumen!.world.pick?.(x, y) === "cdt_1" &&
          // Only where their seat is on top (on a phone the HUD covers part of it).
          document.elementFromPoint(x, y)?.closest(".seat")?.getAttribute("data-id") === "cdt_1"
        )
          hits.push([x, y]);
    if (!hits.length) return null;
    const [x, y] = hits[Math.floor(hits.length / 2)]!;
    return { x, y };
  });
  expect(at).not.toBeNull();
  await page.mouse.move(at!.x, at!.y);
  await expect(page.locator("#cadet-tag")).toHaveClass(/shown/);
  await expect(page.locator("#cadet-tag b")).toHaveText("Tomas Reyes");
  await page.screenshot({ path: "docs/screens/m2-hover.png" });
  await page.mouse.click(at!.x, at!.y);
  expect(await page.evaluate(() => window.__lumen!.store.getState().selectedId)).toBe("cdt_1");
  await expect.poll(async () => JSON.stringify(await sent(page))).toContain('"type":"hand.call"');
});
