import type { FrameStats } from "../../core/frames";
import { store } from "../../core/store";
import { voice } from "../../core/voice";
import "./overlay.css";

// Perf overlay (M2-10): FPS, frame time, DPR and the last send → first
// reaction latency. P toggles it; ?stats=1 opens it on load.

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
    `${document.querySelectorAll("#stage *").length} nodes`,
    `dpr ${source.dpr.toFixed(2)}`,
    `reaction ${c.lastReactionMs === undefined ? "–" : `${c.lastReactionMs} ms`}`,
    `voice in ${voice.metrics.sttMs ?? "–"} ms · out ${voice.metrics.firstAudioMs ?? "–"} ms`,
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
