import { store } from "../../core/store";
import "./overlay.css";

// Perf overlay (M2-10): FPS, frame time, draw calls, DPR and the last
// send → first reaction latency. P toggles it; ?stats=1 opens it on load.

export interface FrameStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  dpr: number;
}

const el = document.createElement("pre");
el.id = "stats";
el.setAttribute("aria-hidden", "true");
document.querySelector("#stage")!.appendChild(el);

let source: FrameStats | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function render() {
  if (!source) return;
  const c = store.getState().classroom;
  el.textContent = [
    `${source.fps.toFixed(0).padStart(3)} fps  ${source.frameMs.toFixed(1)} ms`,
    `${source.drawCalls} draws  ${(source.triangles / 1000).toFixed(1)}k tris`,
    `dpr ${source.dpr.toFixed(2)}`,
    `reaction ${c.lastReactionMs === undefined ? "–" : `${c.lastReactionMs} ms`}`,
  ].join("\n");
}

export const statsOverlay = {
  attach(stats: FrameStats) {
    source = stats;
    if (new URLSearchParams(location.search).has("stats")) this.toggle(true);
  },
  toggle(open = !el.classList.contains("open")) {
    el.classList.toggle("open", open);
    if (timer) clearInterval(timer);
    timer = open ? setInterval(render, 250) : null;
    render();
  },
};
