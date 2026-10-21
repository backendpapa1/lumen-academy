import type { CurriculumBuild } from "@lumen/shared";
import { fill, h } from "./dom";

// The curriculum build as it runs (Paul: "a progress bar and stage update, so
// I know it's not hanging, and if there is an error, truly state it"). A bar,
// the stage in words, each source ticked off, and a heartbeat: how long it's
// been, how many steps, and when DeepSeek is on one long step, for how long.

const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60
    ? `${m} min ${s % 60 ? `${s % 60} s` : ""}`.trim()
    : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const clock = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** A panel that keeps its "ago" times live; call update() with each new state. */
export function buildProgress(onRebuild?: () => void): {
  el: HTMLElement;
  update: (b: CurriculumBuild | null) => void;
  dispose: () => void;
} {
  const el = h("section", { class: "build card pad", "aria-live": "polite", hidden: true });
  let current: CurriculumBuild | null = null;

  const render = () => {
    const b = current;
    el.hidden = !b || b.status === "ready";
    if (!b || b.status === "ready") return;
    const failed = b.status === "error";
    const pct = Math.round(b.fraction * 100);
    const waitingFor = b.waitingSince ? (Date.now() - Date.parse(b.waitingSince)) / 1000 : 0;
    const quiet = (Date.now() - Date.parse(b.lastActivityAt)) / 1000;
    const heartbeat = failed
      ? `Stopped after ${ago(b.startedAt)} and ${b.calls} steps.`
      : waitingFor > 20
        ? waitingFor > 360
          ? `DeepSeek has been on one step for ${clock(b.waitingSince!)}: longer than usual. It may still finish; if not, Rebuild starts over.`
          : `DeepSeek is working on a long step (${clock(b.waitingSince!)}). Big books mean big steps.`
        : quiet > 90
          ? `No activity for ${ago(b.lastActivityAt)}. If this stays, the build may be stuck: Rebuild starts over.`
          : `Working: last step ${ago(b.lastActivityAt)} ago.`;
    el.classList.toggle("failed", failed);
    fill(
      el,
      h(
        "div",
        { class: "build-head" },
        h("span", { class: `dot ${failed ? "" : "live"}`, "aria-hidden": "true" }),
        h(
          "div",
          { style: "flex:1;min-width:0" },
          h(
            "div",
            { class: "micro" },
            failed ? "Curriculum build failed" : "Building the curriculum",
          ),
          h("div", { class: "build-label" }, failed ? (b.error ?? "The build stopped.") : b.label),
        ),
        h("div", { class: "build-pct mono" }, failed ? "" : `${pct}%`),
      ),
      !failed &&
        h(
          "div",
          {
            class: "build-bar",
            role: "progressbar",
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            "aria-valuenow": pct,
            "aria-label": "Curriculum build progress",
          },
          h("i", { style: `width:${Math.max(2, pct)}%` }),
        ),
      h(
        "p",
        { class: "build-meta dim small" },
        failed ? heartbeat : `${heartbeat} · ${ago(b.startedAt)} so far · ${b.calls} steps`,
      ),
      b.sources.length > 1 &&
        h(
          "ul",
          { class: "build-sources" },
          ...b.sources.map((s) =>
            h(
              "li",
              { class: s.state, title: s.title },
              h(
                "span",
                { "aria-hidden": "true" },
                s.state === "done" ? "✓" : s.state === "reading" ? "•" : "○",
              ),
              s.title,
            ),
          ),
        ),
      failed &&
        onRebuild &&
        h(
          "div",
          { class: "row", style: "margin-top:10px" },
          h("button", { class: "btn primary", onclick: onRebuild }, "Rebuild"),
        ),
    );
  };
  const tick = setInterval(render, 1000);
  return {
    el,
    update(b) {
      current = b;
      render();
    },
    dispose: () => clearInterval(tick),
  };
}
