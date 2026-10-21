import { expect, test } from "@playwright/test";

// T-9 chalkboard on the holo-board, and T-8 peek at notes (N), on the demo class.
test("the chalkboard shows on the board; N opens the selected cadet's notes", async ({ page }) => {
  await page.route("**/api/cadets/*/notes", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "cdt_1",
        name: "Tomas Reyes",
        archetype: "lost_signal",
        notes:
          "## Merkle trees\n- Hashes are **paired** and hashed again\n- The root is stored in every transaction",
      }),
    }),
  );
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?view=classroom-demo");
  await page.waitForFunction(() => window.__lumen !== undefined);
  await page.evaluate(() =>
    window.__lumen!.receive({
      type: "board.updated",
      payload: { text: "root = H(H(a)+H(b))\nodd level → duplicate last" },
    }),
  );
  await page.keyboard.press("Tab"); // selects Tomas (first hand)
  await page.keyboard.press("n");
  const notes = page.getByRole("complementary", { name: "Student notes" });
  await expect(notes).toBeVisible();
  await expect(notes.getByText("Tomas Reyes")).toBeVisible();
  await expect(notes.locator("b", { hasText: "paired" })).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: "docs/screens/m6-board-notes.png" });
  await page.keyboard.press("n");
  await expect(notes).toBeHidden();
});
