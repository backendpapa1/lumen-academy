import { expect, test, type Page } from "./test";

// M6-01 random events on the demo class: the glitch card (Y/N), the pop quiz
// (typing never triggers classroom keys), and the power-flicker banner.

type Sent = Array<{ type: string; payload: Record<string, unknown> }>;

async function boot(page: Page) {
  await page.addInitScript(() => {
    const sent: Sent = [];
    (window as unknown as { __sent: Sent }).__sent = sent;
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        setTimeout(() => this.onopen?.(), 5);
      }
      send(data: string) {
        sent.push(JSON.parse(data) as Sent[number]);
      }
      close() {}
    }
    (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?view=classroom-demo");
  await page.waitForFunction(() => window.__lumen !== undefined);
  return page.evaluate(() => Object.keys(window.__lumen!.store.getState().classroom.cadets));
}
const sent = (page: Page, type: string) =>
  page.evaluate(
    (t) => (window as unknown as { __sent: Sent }).__sent.filter((m) => m.type === t),
    type,
  );

test("a hologram glitch: N says it's wrong, and the result shows what was scrambled", async ({
  page,
}) => {
  const [cadet] = await boot(page);
  await page.evaluate(
    (cadetId) =>
      window.__lumen!.receive({
        type: "event.start",
        payload: {
          eventId: "msg_g",
          kind: "glitch",
          cadetId: cadetId!,
          text: "Wait, so you said the Merkle root is stored inside every single transaction?",
          seconds: 30,
        },
      }),
    cadet,
  );
  const card = page.getByRole("dialog", { name: "Mix-up" });
  await expect(card).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "docs/screens/m6-glitch.png" });
  await page.keyboard.press("n");
  await expect
    .poll(() => sent(page, "event.answer"))
    .toEqual([{ type: "event.answer", payload: { eventId: "msg_g", wrong: true } }]);
  await page.evaluate(() =>
    window.__lumen!.receive({
      type: "event.result",
      payload: {
        eventId: "msg_g",
        kind: "glitch",
        caught: true,
        explanation: "The root lives in the block header, not in each transaction.",
        xp: 50,
      },
    }),
  );
  await expect(card.getByText("Caught it.")).toBeVisible();
  await expect(card.getByText("+50 XP")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(card).toBeHidden();
});

test("a pop quiz takes a typed answer without the keys leaking into the classroom", async ({
  page,
}) => {
  const [cadet] = await boot(page);
  await page.evaluate(
    (cadetId) =>
      window.__lumen!.receive({
        type: "event.start",
        payload: {
          eventId: "msg_q",
          kind: "pop_quiz",
          cadetId: cadetId!,
          text: 'Pop quiz, Headmaster! In a few sentences: explain "Merkle Trees" so I\'d get it.',
          seconds: 90,
        },
      }),
    cadet,
  );
  const box = page.getByRole("textbox", { name: "Your answer" });
  await expect(box).toBeFocused();
  await box.fill("Pairs of hashes get hashed, level by level, up to one root.");
  // Keys that mean something in class (call cadet 1, mute, roster) stay in the box.
  await page.keyboard.type(" 1mr");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "docs/screens/m6-pop-quiz.png" });
  await page.keyboard.press("Control+Enter");
  const answers = await sent(page, "event.answer");
  expect(answers[0]!.payload.text).toContain("up to one root. 1mr");
  expect(await sent(page, "hand.call")).toEqual([]);
  expect(await page.evaluate(() => window.__lumen!.sound.muted)).toBe(false);
  await page.evaluate(() =>
    window.__lumen!.receive({
      type: "event.result",
      payload: { eventId: "msg_q", kind: "pop_quiz", score: 4, explanation: "Solid.", xp: 24 },
    }),
  );
  await expect(page.getByText("4 / 5")).toBeVisible();
});

test("a power flicker shows who whispered what, then clears itself", async ({ page }) => {
  const [a, b] = await boot(page);
  await page.evaluate(
    ([from, to]) =>
      window.__lumen!.receive({
        type: "event.start",
        payload: {
          eventId: "msg_f",
          kind: "power_flicker",
          cadetId: from!,
          toCadetId: to!,
          text: "The root is in every transaction.",
          seconds: 6,
        },
      }),
    [a, b],
  );
  const banner = page.getByRole("status").filter({ hasText: "The lights flickered" });
  await expect(banner).toContainText("The root is in every transaction.");
  // The drawn room browns out, then the lights come back.
  await expect(page.locator(".room.flicker")).toHaveCount(1);
  await page.waitForTimeout(700);
  await page.screenshot({ path: "docs/screens/m6-power-flicker.png" });
  await expect(banner).toBeHidden({ timeout: 12_000 });
  await expect(page.locator(".room.flicker")).toHaveCount(0);
});

test("the visiting Dean tallies three explanations, then reports", async ({ page }) => {
  await boot(page);
  await page.evaluate(() =>
    window.__lumen!.receive({
      type: "event.start",
      payload: {
        eventId: "msg_d",
        kind: "inspector",
        text: "The Dean is observing your next 3 explanations.",
        seconds: 0,
      },
    }),
  );
  const watching = page.getByRole("status").filter({ hasText: "Visiting inspector" });
  await expect(watching).toContainText("0 / 3");
  for (const [i, text] of [
    "Pairs are hashed.",
    "Up to one root.",
    "It lives in the header.",
  ].entries()) {
    await page.evaluate(
      ([turnId, t]) =>
        window.__lumen!.receive({ type: "turn.started", payload: { turnId: turnId!, text: t! } }),
      [`trn_${i}`, text],
    );
  }
  await expect(watching).toContainText("Writing the report");
  await page.evaluate(() =>
    window.__lumen!.receive({
      type: "event.result",
      payload: {
        eventId: "msg_d",
        kind: "inspector",
        explanation:
          "You kept it concrete, but you never said why one changed leaf changes the root.",
        xp: 0,
        feedback: {
          strengths: ["The tournament-bracket picture of pairing was clear."],
          improve: ["You skipped why tampering is detectable.", "“Leaf” was never defined."],
          tip: "Change one transaction on the board and walk the new hash up to the root.",
        },
      },
    }),
  );
  const report = page.getByRole("dialog", { name: "The Dean's report" });
  await expect(report.getByText("Fix next")).toBeVisible();
  await expect(report.getByText("“Leaf” was never defined.")).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "docs/screens/m6-dean.png" });
  await report.getByRole("button", { name: "Back to class" }).click();
  await expect(report).toBeHidden();
});
