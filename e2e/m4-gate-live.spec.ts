import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// M4 gate = MVP (live): one sitting, in the browser: teach → exit ticket →
// homework → grade → exam → debrief → re-teach. Real models (≈$0.10).
// Opt-in: LUMEN_LIVE=1, LUMEN_GATE_SCHOOL=<school name prefix>; run against a
// copy of the database (LUMEN_DATA_DIR).
test.skip(
  !process.env.LUMEN_LIVE || !process.env.LUMEN_GATE_SCHOOL,
  "set LUMEN_LIVE=1 and LUMEN_GATE_SCHOOL",
);
test.setTimeout(1_500_000);

const LESSON: Record<number, string[]> = {
  0: [
    "Photosynthesis is how plants, algae and some bacteria capture light energy and store it as chemical energy in sugar.",
    "Overall: six carbon dioxide plus six water, with light, make one glucose and six oxygen. The oxygen comes from splitting water, not from CO2.",
  ],
  1: [
    "The overall equation: 6 CO2 + 6 H2O + light → C6H12O6 + 6 O2. The oxygen released comes from the water molecules.",
    "So the O2 a plant gives off is a by-product of splitting water during the light reactions.",
  ],
  2: [
    "It all happens in chloroplasts. Inside are stacks of flat sacs called thylakoids; a stack is a granum; the fluid around them is the stroma.",
    "The light reactions happen on the thylakoid membranes, and the Calvin cycle happens in the stroma.",
  ],
};

async function waitLive(page: Page) {
  await page.waitForFunction(
    () => window.__lumen!.store.getState().classroom.status === "live",
    null,
    { timeout: 60_000 },
  );
  if (await page.evaluate(() => window.__lumen!.store.getState().classroom.clock.paused))
    await page.keyboard.press("Escape");
}
async function teach(page: Page, text: string) {
  const before = await page.evaluate(
    () => window.__lumen!.store.getState().classroom.transcript.length,
  );
  await page.locator("#lectern").fill(text);
  await page.locator("#lectern").press("Enter");
  await page.waitForFunction(
    (n) => {
      const c = window.__lumen!.store.getState().classroom;
      return c.transcript.length > n && !c.thinking;
    },
    before,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(3500); // let the Director commit
}

test("M4 gate: teach → exit ticket → homework → grade → exam → debrief → re-teach", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on(
    "console",
    (m) => m.type() === "error" && !m.text().includes("favicon") && errors.push(m.text()),
  );
  const t0 = Date.now();
  const marks: Record<string, number> = {};
  const mark = (k: string) => (marks[k] = Math.round((Date.now() - t0) / 1000));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.locator(".school-card", { hasText: process.env.LUMEN_GATE_SCHOOL! }).first().click();
  await page.getByRole("tab", { name: "Classes" }).click();
  await page.getByRole("button", { name: "Teach" }).first().click();
  await waitLive(page);

  // 1. Teach module 1, concept by concept.
  const concepts = await page.evaluate(() => window.__lumen!.store.getState().classroom.concepts);
  for (const [i, lines] of Object.entries(LESSON)) {
    const c = concepts[Number(i)]!;
    await page.evaluate((id) => window.__lumen!.app.setConcept(id), c.id);
    await page.waitForTimeout(500);
    for (const line of lines) await teach(page, line);
  }
  // Answer one hand.
  if ((await page.evaluate(() => window.__lumen!.store.getState().classroom.hands.length)) > 0) {
    await page.keyboard.press("Tab");
    await page.keyboard.press("Space");
    await page.waitForFunction(
      () => window.__lumen!.store.getState().classroom.speech?.done,
      null,
      { timeout: 60_000 },
    );
    await teach(
      page,
      "Good question. The light reactions make ATP and NADPH; the Calvin cycle uses them to build sugar in the stroma.",
    );
  }
  mark("taught");
  await page.screenshot({ path: "docs/screens/m4-gate-teaching.png" });

  // 2. Bell → exit ticket.
  await page.mouse.click(1600 - 28 - 220 * 0.83, 50);
  await page.waitForSelector(".exit-card", { timeout: 120_000 });
  const rows = page.locator(".exit-row");
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const text = (await row.textContent()) ?? "";
    // A reasonable Headmaster: ✗ anything that sounds like a known slip.
    const looksWrong =
      /every transaction|from carbon dioxide|from the co2|only plants|in the dark/i.test(text);
    await row.getByRole("button", { name: looksWrong ? /^False/ : /^True/ }).click();
  }
  await expect(page.locator(".exit-card").getByRole("button", { name: "Continue" })).toBeVisible({
    timeout: 15_000,
  });
  await page.screenshot({ path: "docs/screens/m4-gate-exit-ticket.png" });
  await page.locator(".exit-card").getByRole("button", { name: "Continue" }).click();
  mark("exitTicket");

  // 3. Bell card → Set homework → Examiner drafts → cadets answer.
  await page.waitForTimeout(800);
  await page.mouse.click(800, 600); // dismiss focus
  const desk = await page.evaluate(() => {
    const s = window.__lumen!.store.getState();
    return { school: s.classroom.school!.id, room: s.classroom.classroom!.id };
  });
  await page.evaluate((d) => window.__lumen!.app.openDesk(d.school, d.room, "assignments"), desk);
  await page.waitForSelector(".concept-pick");
  const boxes = page.locator(".concept-pick input:not([disabled])");
  const nb = await boxes.count();
  for (let i = 0; i < Math.min(nb, 3); i++) await boxes.nth(i).check();
  await page.getByRole("button", { name: "Set homework" }).click();
  await expect(page.locator(".sub").first()).toBeVisible({ timeout: 300_000 });
  await expect(page.getByText(/to grade/)).toBeVisible({ timeout: 400_000 });
  mark("homeworkIn");
  await page.screenshot({ path: "docs/screens/m4-gate-homework.png", fullPage: true });

  // 4. Grade two submissions with feedback.
  for (const i of [0, 1]) {
    const sub = page.locator(".sub").nth(i);
    await sub
      .locator(".seg button")
      .nth(i === 0 ? 3 : 1)
      .click();
    await sub
      .locator("textarea")
      .fill(
        i === 0
          ? "Good: you have the equation right. Remember the oxygen comes from splitting water, not from CO2."
          : "Not quite. The light reactions happen on the thylakoid membranes; the Calvin cycle is in the stroma.",
      );
    await sub.getByRole("button", { name: /Return to cadet/ }).click();
    await expect(sub.locator(".reaction")).not.toBeEmpty({ timeout: 60_000 });
  }
  mark("graded");
  await page.screenshot({ path: "docs/screens/m4-gate-grading.png" });

  // 5. Exam: set → wait → start → arena.
  await page.getByRole("tab", { name: "Exams" }).click();
  await page.getByRole("button", { name: "Set exam" }).first().click();
  await expect(page.getByRole("button", { name: "Start exam" })).toBeVisible({ timeout: 300_000 });
  mark("examReady");
  await page.getByRole("button", { name: "Start exam" }).click();
  await page.waitForSelector(".arena-card");
  await page.waitForTimeout(20_000);
  await page.screenshot({ path: "docs/screens/m4-gate-arena.png" });
  await expect(page.getByRole("button", { name: "See the debrief" })).toBeVisible({
    timeout: 900_000,
  });
  mark("examDone");
  await page.screenshot({ path: "docs/screens/m4-gate-exam-done.png" });

  // 6. Debrief → re-teach.
  await page.getByRole("button", { name: "See the debrief" }).click();
  await expect(page.getByRole("heading", { name: "Concept by concept" })).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: "docs/screens/m4-gate-debrief.png", fullPage: true });
  const avg = await page.locator(".big-num").textContent();
  const reteach = page.getByRole("button", { name: "Re-teach" }).first();
  const canReteach = await reteach.isVisible().catch(() => false);
  if (canReteach) {
    await reteach.click();
    await waitLive(page);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: "docs/screens/m4-gate-reteach.png" });
    await page.keyboard.press("Escape");
  }
  mark("done");
  const report = {
    classAverage: avg,
    reteach: canReteach,
    seconds: marks,
    at: new Date().toISOString(),
  };
  console.log(JSON.stringify(report));
  mkdirSync("eval/reports", { recursive: true });
  writeFileSync("eval/reports/m4-gate.json", JSON.stringify(report, null, 2) + "\n");
  expect(errors).toEqual([]);
});
