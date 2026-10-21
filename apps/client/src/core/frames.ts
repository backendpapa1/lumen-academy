// Frame timing for the perf overlay (P) and the perf specs: one rAF loop,
// smoothed. The drawn scenes are DOM, so there are no draw calls to count.

export interface FrameStats {
  fps: number;
  frameMs: number;
  /** Kept for the perf specs' budget check; always 0 without WebGL. */
  drawCalls: number;
  dpr: number;
}

export const frames: FrameStats = { fps: 60, frameMs: 16.7, drawCalls: 0, dpr: devicePixelRatio };

let last = 0;
function tick(now: number) {
  if (last) {
    const ms = Math.min(now - last, 250);
    frames.frameMs = frames.frameMs * 0.9 + ms * 0.1;
    frames.fps = 1000 / frames.frameMs;
  }
  last = now;
  frames.dpr = devicePixelRatio;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
