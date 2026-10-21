import { expect, test } from "@playwright/test";

// M6-09: the 3D exam arena. A scripted exam (fake socket + mocked API): beams
// for each graded answer, Class Integrity on the floor ring, the final reveal.

const ARCH = [
  "skeptic",
  "literalist",
  "overachiever",
  "lost_signal",
  "connector",
  "pragmatist",
  "quiet",
  "saboteur",
] as const;
const NAMES = [
  "Ines Okoro-Vale",
  "Tomas Reyes",
  "Oskar Lind",
  "Mira Chen",
  "Dax Obi",
  "Yara Sol",
  "Kenji Hart",
  "Lu Wren",
  "Ada Nnamdi",
  "Rafe Kade",
];
const cadets = Array.from({ length: 10 }, (_, i) => ({
  id: `cdt_${i}`,
  name: NAMES[i]!,
  archetype: ARCH[i % ARCH.length],
  seat: i,
  homeworld: "Titan",
  quirk: "q",
  comprehension: 0,
  state: "attentive",
}));
const questions = [1, 2, 3].map((ord) => ({
  id: `q_${ord}`,
  ord,
  kind: ord === 2 ? "mcq" : "short",
  prompt: `Question ${ord}: why does pairing hashes make the root tamper-evident?`,
  options:
    ord === 2
      ? ["Any change alters the root", "It encrypts the data", "It compresses", "It signs"]
      : undefined,
  conceptTitle: ord === 3 ? "Block header" : "Merkle tree construction",
}));

test("the arena: beams lock or shatter per answer, integrity fills, the result is revealed", async ({
  page,
}) => {
  let status = "ready";
  let classAverage: number | null = null;
  await page.addInitScript(() => {
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        (window as unknown as { __push: (m: unknown) => void }).__push = (m) =>
          this.onmessage?.({ data: JSON.stringify(m) });
        setTimeout(() => this.onopen?.(), 5);
      }
      send() {}
      close() {}
    }
    (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  });
  await page.route("**/api/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route("**/api/classrooms/cls_x", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cadets }) }),
  );
  await page.route("**/api/exams/exm_x/run", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/exams/exm_x", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "exm_x",
        moduleTitle: "Merkle Trees & Blocks",
        status,
        passThreshold: 0.7,
        classAverage,
        questions,
        results: [],
      }),
    }),
  );
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.waitForFunction(
    () => typeof (window as unknown as { __push?: unknown }).__push === "function",
  );
  await page.evaluate(() =>
    window.__lumen!.store.setState({
      route: { name: "exam", examId: "exm_x", classroomId: "cls_x", schoolId: "sch_x" },
    }),
  );
  await expect(page.getByText("Merkle Trees & Blocks")).toBeVisible();

  // Question 1 and half of 2 are marked: mostly right, a few wrong.
  const scores = [0.9, 1, 0.2, 0.8, 0.5, 1, 0.1, 0.9, 0.7, 0.8, 1, 0.9, 0.4, 1, 0.8];
  await page.evaluate((list) => {
    const push = (window as unknown as { __push: (m: unknown) => void }).__push;
    let sum = 0;
    list.forEach((score, n) => {
      sum += score;
      const ord = n < 10 ? 1 : 2;
      setTimeout(
        () =>
          push({
            type: "exam.answer",
            payload: {
              examId: "exm_x",
              questionId: `q_${ord}`,
              ord,
              cadetId: `cdt_${n % 10}`,
              score,
              integrity: sum / (n + 1),
            },
          }),
        n * 140,
      );
    });
  }, scores);
  await expect(page.getByText("Question 2 of 3").first()).toBeVisible({ timeout: 6000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: "docs/screens/m6-arena.png" });
  const meter = page.getByRole("meter", { name: "Class integrity" });
  expect(Number(await meter.getAttribute("aria-valuenow"))).toBeGreaterThan(60);

  status = "done";
  classAverage = 0.76;
  await page.evaluate(() =>
    (window as unknown as { __push: (m: unknown) => void }).__push({
      type: "exam.status",
      payload: { examId: "exm_x", classroomId: "cls_x", status: "done" },
    }),
  );
  await expect(page.getByRole("button", { name: "See the debrief" })).toBeVisible();
  await page.waitForTimeout(4000); // the push-in and the stinger
  await page.screenshot({ path: "docs/screens/m6-arena-result.png" });
});
