import { expect, test } from "./test";

// Live traffic must not cost frames: stream deltas, reactions, turns and hand
// updates arrive while the frame budget holds (M2 gate). Driven from rAF so
// the measurement itself doesn't depend on timers.
test("live message traffic keeps every frame under ~2 vsyncs", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/?view=classroom-demo&cadets=15");
  await page.waitForFunction(() => window.__lumen !== undefined);
  const gpu = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2")!;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "unknown";
  });
  test.skip(/SwiftShader/.test(gpu), "no GPU: software GL can't measure frame time");
  await page.waitForTimeout(1500);
  const worst = await page.evaluate(
    () =>
      new Promise<Record<string, number>>((done) => {
        const L = window.__lumen!;
        const st = [
          "confused",
          "attentive",
          "excited",
          "bored",
          "skeptical",
          "notetaking",
        ] as const;
        const phases: Array<[string, (i: number) => void]> = [
          ["idle", () => {}],
          [
            "stream",
            () =>
              L.receive({
                type: "cadet.stream",
                payload: { cadetId: "cdt_3", streamId: "sx", delta: "word " },
              }),
          ],
          [
            "reaction",
            (i) =>
              L.receive({
                type: "crowd.reaction",
                payload: { turnId: "t1", cadetId: `cdt_${i % 15}`, state: st[i % 6]! },
              }),
          ],
          [
            "turn",
            (i) =>
              L.receive({
                type: "turn.started",
                payload: { turnId: `t${i}`, text: `Point number ${i}` },
              }),
          ],
          [
            "hands",
            (i) =>
              L.receive({
                type: "hands.update",
                payload: {
                  queue: [
                    { cadetId: `cdt_${i % 15}`, intent: "clarify", preview: "Why?", urgency: 0.5 },
                  ],
                },
              }),
          ],
        ];
        const out: Record<string, number> = {};
        let p = 0;
        let i = 0;
        let max = 0;
        let last = performance.now();
        const tick = (t: number) => {
          if (i > 0) max = Math.max(max, t - last);
          last = t;
          if (i % 2 === 0) phases[p]![1](i);
          if (++i >= 60) {
            out[phases[p]![0]] = Math.round(max);
            p++;
            i = 0;
            max = 0;
            if (p >= phases.length) return done(out);
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  console.log(JSON.stringify({ worstFrameMs: worst, gpu }));
  for (const ms of Object.values(worst)) expect(ms).toBeLessThan(34);
});
