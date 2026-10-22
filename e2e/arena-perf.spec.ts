import { expect, test } from "./test";

// M6-09 frame check: the arena with 15 cadets and beams in flight holds 60 FPS.
test("the exam arena with 15 cadets and live beams holds 60 FPS", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const cadets = Array.from({ length: 15 }, (_, i) => ({
    id: `cdt_${i}`,
    name: `Cadet ${i}`,
    archetype: ["skeptic", "connector", "quiet", "overachiever", "pragmatist"][i % 5],
    seat: i,
    homeworld: "Titan",
    quirk: "q",
    comprehension: 0,
    state: "attentive",
  }));
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
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  await page.route("**/api/**", (r) => r.fulfill(json([])));
  await page.route("**/api/classrooms/cls_p", (r) => r.fulfill(json({ cadets })));
  await page.route("**/api/exams/exm_p/run", (r) => r.fulfill(json({})));
  await page.route("**/api/exams/exm_p", (r) =>
    r.fulfill(
      json({
        id: "exm_p",
        moduleTitle: "Perf",
        status: "running",
        passThreshold: 0.7,
        classAverage: null,
        questions: [{ id: "q_1", ord: 1, kind: "short", prompt: "Why?", conceptTitle: "Hashing" }],
        results: [],
      }),
    ),
  );
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.waitForFunction(
    () => typeof (window as unknown as { __push?: unknown }).__push === "function",
  );
  const gpu = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2")!;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "unknown";
  });
  test.skip(/SwiftShader/.test(gpu), "no GPU: software GL can't measure frame rate");
  await page.evaluate(() =>
    window.__lumen!.store.setState({
      route: { name: "exam", examId: "exm_p", classroomId: "cls_p", schoolId: "sch_p" },
    }),
  );
  await page.waitForTimeout(1500);
  // A steady stream of answers: several beams and a shatter always in flight.
  await page.evaluate(() => {
    const push = (window as unknown as { __push: (m: unknown) => void }).__push;
    let n = 0;
    setInterval(() => {
      const score = [1, 0.1, 0.5, 0.9][n % 4]!;
      push({
        type: "exam.answer",
        payload: {
          examId: "exm_p",
          questionId: "q_1",
          ord: 1,
          cadetId: `cdt_${n % 15}`,
          score,
          integrity: 0.6,
        },
      });
      n++;
    }, 180);
  });
  const samples: Array<{ fps: number; drawCalls: number }> = [];
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(250);
    samples.push(await page.evaluate(() => ({ ...window.__lumen!.stats })));
  }
  const fps = samples.map((s) => s.fps).sort((a, b) => a - b);
  const p50 = fps[Math.floor(fps.length / 2)]!;
  const drawCalls = Math.max(...samples.map((s) => s.drawCalls));
  console.log(JSON.stringify({ arena: true, gpu, fpsP50: p50, fpsMin: fps[0], drawCalls }));
  expect(p50).toBeGreaterThanOrEqual(55);
  expect(drawCalls).toBeLessThanOrEqual(150);
  expect(errors).toEqual([]);
});
