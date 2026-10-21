import { ARCHETYPE_INFO } from "@lumen/shared";
import { app } from "../../core/app";
import type { ExitTicketsState } from "../../core/classroom";
import { store } from "../../core/store";
import { portrait } from "../screens/common";
import { fill, h } from "../screens/dom";

// Exit ticket (docs/02 §5, M4-05): at the bell, one minute to mark each
// cadet's statement true ✓ or false ✗. Y / N (or ← / →) mark the focused one.

const root = h("div", { class: "exit-back", hidden: true });
document.querySelector("#stage")!.append(root);
let timer: ReturnType<typeof setInterval> | null = null;
let dismissedFor: string | null = null;
let finishedFor: string | null = null;

function render(e: ExitTicketsState | undefined) {
  if (!e || dismissedFor === e.periodId) {
    root.hidden = true;
    stopTimer();
    return;
  }
  root.hidden = false;
  const cadets = store.getState().classroom.cadets;
  const left = Math.max(0, e.seconds - (Date.now() - e.at) / 1000);
  const allMarked = e.tickets.every((t) => t.verdict !== undefined);
  if ((allMarked || left <= 0) && finishedFor !== e.periodId) {
    finishedFor = e.periodId;
    app.finishExitTickets(e.periodId);
  }
  const done = allMarked || left <= 0;
  const caught = e.tickets.filter((t) => t.isTrue === false && t.verdict === false).length;
  const falseOnes = e.tickets.filter((t) => t.isTrue === false).length;
  fill(
    root,
    h(
      "section",
      {
        class: "card exit-card",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "Exit ticket",
      },
      h(
        "div",
        { class: "row" },
        h(
          "div",
          {},
          h("div", { class: "micro" }, "Exit ticket"),
          h("div", { class: "h2" }, e.conceptTitle),
        ),
        h("span", { class: "spacer" }),
        h(
          "div",
          { class: "mono exit-clock", "aria-live": "off" },
          done ? "Done" : `${Math.ceil(left)}s`,
        ),
      ),
      h(
        "p",
        { class: "dim", style: "margin:6px 0 12px" },
        done
          ? summaryLine(e, caught, falseOnes)
          : "Is each thing your cadets took away true? ✓ or ✗. Y / N to mark, ↑ ↓ to move.",
      ),
      h(
        "div",
        { class: "progress exit-bar", style: "width:100%;margin-bottom:14px" },
        h("span", { style: `width:${(left / e.seconds) * 100}%;background:var(--aurum)` }),
      ),
      h(
        "ol",
        { class: "exit-list" },
        ...e.tickets.map((t, i) => {
          const c = cadets[t.cadetId];
          const marked = t.verdict !== undefined;
          const result = t.right === undefined ? null : t.right ? "right" : "wrong";
          return h(
            "li",
            { class: `exit-row ${result ?? ""}`, tabindex: marked ? -1 : 0, "data-i": i },
            c ? portrait(c) : h("span"),
            h(
              "div",
              { class: "exit-text" },
              h(
                "div",
                {
                  class: "who",
                  style: `color:${c ? ARCHETYPE_INFO[c.archetype].accent : "inherit"}`,
                },
                c?.name ?? "Cadet",
              ),
              h("div", {}, `“${t.statement}”`),
              result &&
                h(
                  "div",
                  { class: "exit-verdict" },
                  t.isTrue
                    ? "True, from what you taught."
                    : t.verdict === false
                      ? "False, and you caught it: corrected."
                      : "False: a misconception slipped through.",
                ),
            ),
            h(
              "div",
              { class: "row", style: "gap:6px" },
              h(
                "button",
                {
                  class: `btn small${t.verdict === true ? " primary" : ""}`,
                  disabled: marked || done,
                  "aria-label": `True: ${t.statement}`,
                  onclick: () => app.markExitTicket(t.id, true),
                },
                "✓",
              ),
              h(
                "button",
                {
                  class: `btn small${t.verdict === false ? " primary" : ""}`,
                  disabled: marked || done,
                  "aria-label": `False: ${t.statement}`,
                  onclick: () => app.markExitTicket(t.id, false),
                },
                "✗",
              ),
            ),
          );
        }),
      ),
      done &&
        h(
          "div",
          { class: "row", style: "margin-top:16px" },
          e.summary?.xp ? h("span", { class: "chip gold" }, `+${e.summary.xp} XP`) : null,
          h("span", { class: "spacer" }),
          h(
            "button",
            { class: "btn primary", onclick: () => ((dismissedFor = e.periodId), render(e)) },
            "Continue",
          ),
        ),
    ),
  );
  if (!done) {
    startTimer();
    (
      root.querySelector<HTMLElement>(".exit-row[tabindex='0']") ?? root.querySelector("button")
    )?.focus({ preventScroll: true });
  } else {
    stopTimer();
    root.querySelector<HTMLElement>(".btn.primary")?.focus();
  }
}

function summaryLine(e: ExitTicketsState, caught: number, falseOnes: number) {
  const right = e.tickets.filter((t) => t.right).length;
  return falseOnes
    ? `You marked ${right} of ${e.tickets.length} right and caught ${caught} of ${falseOnes} misconceptions.`
    : `You marked ${right} of ${e.tickets.length} right. No misconceptions this time.`;
}

/** Each second only the clock moves; the cards are rebuilt only when time runs out. */
function tick() {
  const e = store.getState().classroom.exit;
  if (!e) return stopTimer();
  const left = Math.max(0, e.seconds - (Date.now() - e.at) / 1000);
  if (left <= 0) return render(e);
  const clock = root.querySelector(".exit-clock");
  if (clock) clock.textContent = `${Math.ceil(left)}s`;
  const bar = root.querySelector<HTMLElement>(".exit-bar > span");
  if (bar) bar.style.width = `${(left / e.seconds) * 100}%`;
}
const startTimer = () => (timer ??= setInterval(tick, 1000));
function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

root.addEventListener("keydown", (ev) => {
  const row = (ev.target as HTMLElement).closest<HTMLElement>(".exit-row");
  const e = store.getState().classroom.exit;
  if (!row || !e) return;
  const t = e.tickets[Number(row.dataset.i)];
  if (!t || t.verdict !== undefined) return;
  const key = ev.key.toLowerCase();
  if (key === "y" || ev.key === "ArrowLeft") app.markExitTicket(t.id, true);
  else if (key === "n" || ev.key === "ArrowRight") app.markExitTicket(t.id, false);
  else if (ev.key === "ArrowDown") (row.nextElementSibling as HTMLElement | null)?.focus();
  else if (ev.key === "ArrowUp") (row.previousElementSibling as HTMLElement | null)?.focus();
  else return;
  ev.preventDefault();
  ev.stopPropagation();
});

store.subscribe((s, p) => {
  if (s.classroom.exit !== p.classroom.exit || s.route !== p.route)
    render(s.route.name === "classroom" ? s.classroom.exit : undefined);
});
