import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// M2 gate, frame side: a full house (15 cadets) at 1080p holds ~60 FPS.
test("15 cadets at 1080p hold 60 FPS within the draw-call budget", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/?view=classroom-demo&cadets=15");
  await page.waitForFunction(() => window.__lumen !== undefined);
  await page.waitForTimeout(1500); // shaders compiled, DPR settled
  const gpu = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2")!;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "unknown";
  });
  test.skip(/SwiftShader/.test(gpu), "no GPU: software GL can't measure frame rate");
  const samples: Array<{ fps: number; drawCalls: number; dpr: number }> = [];
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(250);
    samples.push(await page.evaluate(() => ({ ...window.__lumen!.stats })));
  }
  const fps = samples.map((s) => s.fps).sort((a, b) => a - b);
  const report = {
    cadets: Object.keys(
      await page.evaluate(() => window.__lumen!.store.getState().classroom.cadets),
    ).length,
    viewport: "1920x1080",
    gpu,
    fpsP50: Number(fps[Math.floor(fps.length / 2)]!.toFixed(1)),
    fpsMin: Number(fps[0]!.toFixed(1)),
    drawCalls: Math.max(...samples.map((s) => s.drawCalls)),
    dpr: samples.at(-1)!.dpr,
    at: new Date().toISOString(),
  };
  console.log(JSON.stringify(report));
  mkdirSync("eval/reports", { recursive: true });
  writeFileSync("eval/reports/m2-perf.json", JSON.stringify(report, null, 2) + "\n");
  expect(report.cadets).toBe(15);
  expect(report.fpsP50).toBeGreaterThanOrEqual(55);
  expect(report.drawCalls).toBeLessThanOrEqual(150);
  await page.screenshot({ path: "docs/screens/classroom.png" });
  expect(errors).toEqual([]);
});
