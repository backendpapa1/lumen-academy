import { modeInfo } from "@lumen/shared";
import { app } from "../../core/app";
import type { ClassroomState } from "../../core/classroom";
import { store } from "../../core/store";
import { fill, h } from "../screens/dom";
import "./modes.css";

// Teaching modes in class (V5): a banner saying what this mode asks of me,
// and the mode's own panel (teach-back marking, analogy cards, ELI rounds,
// the substitute's lesson). One DOM layer over the room, driven by the store.

const banner = h("div", { class: "mode-banner card", hidden: true, role: "status" });
const panel = h("aside", { class: "mode-panel card", hidden: true });
document.querySelector("#stage")!.append(banner, panel);

let marked = new Set<number>();
let markedFor: string | null = null;

function render(c: ClassroomState, route: string) {
  const live = route === "classroom" && (c.status === "live" || c.status === "ended");
  const kind = c.kind;
  banner.hidden = !live || kind === "class" || kind === "micro";
  if (!banner.hidden) {
    const seat = c.hotSeat ? c.cadets[c.hotSeat]?.name.split(" ")[0] : null;
    const m = modeInfo(kind);
    fill(
      banner,
      h("b", {}, m.label),
      h(
        "span",
        {},
        kind === "socratic" && seat ? `Questions only. ${seat} is in the hot seat.` : m.blurb,
      ),
    );
  }
  const tb = c.teachBack;
  panel.hidden = !live || !tb;
  if (tb) renderTeachBack(c, tb);
}

function renderTeachBack(c: ClassroomState, tb: NonNullable<ClassroomState["teachBack"]>) {
  const key = tb.sentences.join("|");
  if (markedFor !== key) {
    markedFor = key;
    marked = new Set();
  }
  const who = c.cadets[tb.cadetId]?.name.split(" ")[0] ?? "Your student";
  const r = tb.result;
  fill(
    panel,
    h("div", { class: "micro" }, r ? "Teach-back, checked" : `${who} explains it back`),
    h(
      "p",
      { class: "dim small", style: "margin:4px 0 10px" },
      r
        ? `You caught ${r.caught} of ${r.caught + r.missed}${r.falseAlarms ? `, ${r.falseAlarms} false alarm${r.falseAlarms === 1 ? "" : "s"}` : ""}.`
        : "Click each sentence that's wrong, then Check. Only the wrong ones.",
    ),
    h(
      "ol",
      { class: "tb-lines" },
      ...tb.sentences.map((s, i) => {
        const res = r?.lines[i];
        const cls = res
          ? `${res.true ? "true" : "false"} ${res.marked ? "marked" : ""}`
          : marked.has(i)
            ? "marked"
            : "";
        return h(
          "li",
          {},
          h(
            "button",
            {
              class: `tb-line ${cls}`,
              "aria-pressed": String(res ? res.marked : marked.has(i)),
              disabled: !!r,
              onclick: () => {
                if (marked.has(i)) marked.delete(i);
                else marked.add(i);
                render(store.getState().classroom, store.getState().route.name);
              },
            },
            s,
            res &&
              h(
                "small",
                {},
                res.true
                  ? res.marked
                    ? "True: a false alarm"
                    : "True"
                  : res.marked
                    ? "Wrong: caught"
                    : "Wrong: missed",
              ),
          ),
        );
      }),
    ),
    !r &&
      h(
        "div",
        { class: "row", style: "margin-top:10px" },
        h(
          "button",
          { class: "btn primary", onclick: () => app.markTeachBack([...marked]) },
          "Check",
        ),
        h("span", { class: "dim small" }, `${marked.size} marked`),
      ),
  );
}

store.subscribe((s, p) => {
  if (s.classroom !== p.classroom || s.route !== p.route) render(s.classroom, s.route.name);
});
