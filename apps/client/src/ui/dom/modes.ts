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
const guest = h("aside", {
  class: "guest-card card",
  hidden: true,
  "aria-label": "Guest lecturer",
});
const source = h("aside", {
  class: "guest-card source-card card",
  hidden: true,
  "aria-label": "From your sources",
});
document.querySelector("#stage")!.append(banner, panel, guest, source);

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
  renderGuest(c, live);
  renderSource(c, live);
  const tb = c.teachBack;
  panel.hidden = !live || !(tb || c.analogy || c.eli || c.sub);
  if (panel.hidden) return;
  if (tb) renderTeachBack(c, tb);
  else if (c.analogy) renderAnalogies(c, c.analogy);
  else if (c.eli) renderEli(c.eli);
  else if (c.sub) renderSub(c.sub);
}

// --- V5-04 analogy lab ---------------------------------------------------------------

const drafts = new Map<number, { verdict?: "good" | "misleading"; reason: string }>();
let draftsFor = "";

function renderAnalogies(c: ClassroomState, a: NonNullable<ClassroomState["analogy"]>) {
  const key = a.cards.join("|");
  if (draftsFor !== key) {
    draftsFor = key;
    drafts.clear();
  }
  // Keep typing intact: only rebuild when a result lands or the cards change.
  const sig = `${key}#${Object.keys(a.results).join(",")}`;
  if (panel.dataset.sig === sig) return;
  panel.dataset.sig = sig;
  const who = c.cadets[a.cadetId]?.name.split(" ")[0] ?? "The Connector";
  fill(
    panel,
    h("div", { class: "micro" }, `${who}'s analogies`),
    h(
      "p",
      { class: "dim small", style: "margin:4px 0 10px" },
      "Good or misleading? Then say where it breaks down: every analogy breaks somewhere.",
    ),
    ...a.cards.map((text, i) => {
      const r = a.results[i];
      const d = drafts.get(i) ?? { reason: "" };
      drafts.set(i, d);
      if (r)
        return h(
          "div",
          { class: `an-card done ${r.right ? "right" : "wrong"}` },
          h("p", { class: "an-text" }, `“${text}”`),
          h(
            "p",
            { class: "small" },
            h("b", {}, r.sound ? "Sound. " : "Misleading. "),
            r.right ? "You called it right." : "You called it the other way.",
          ),
          h("p", { class: "small" }, h("b", {}, "Where it breaks: "), r.breaks),
          h(
            "p",
            { class: "dim small" },
            `Your reason: ${Math.round(r.reasonScore * 100)}% · ${r.feedback}`,
          ),
        );
      const reason = h("textarea", {
        class: "field",
        rows: 2,
        placeholder: "Where does it break down?",
        "aria-label": `Where analogy ${i + 1} breaks down`,
      });
      reason.value = d.reason;
      reason.addEventListener("input", () => (d.reason = reason.value));
      const pick = (v: "good" | "misleading") =>
        h(
          "button",
          {
            class: `btn small ${d.verdict === v ? "primary" : ""}`,
            "aria-pressed": String(d.verdict === v),
            onclick: () => {
              d.verdict = v;
              panel.dataset.sig = "";
              render(store.getState().classroom, store.getState().route.name);
            },
          },
          v === "good" ? "Good" : "Misleading",
        );
      return h(
        "div",
        { class: "an-card" },
        h("p", { class: "an-text" }, `“${text}”`),
        h("div", { class: "row", style: "gap:6px" }, pick("good"), pick("misleading")),
        reason,
        h(
          "button",
          {
            class: "btn small primary",
            disabled: !d.verdict,
            onclick: (e: Event) => {
              (e.currentTarget as HTMLButtonElement).disabled = true;
              app.judgeAnalogy(i, d.verdict!, d.reason);
            },
          },
          "Judge",
        ),
      );
    }),
  );
}

// --- V5-05 ELI ladder ------------------------------------------------------------------

function renderEli(e: NonNullable<ClassroomState["eli"]>) {
  delete panel.dataset.sig;
  const names = ["5-year-olds", "15-year-olds", "the experts"];
  const done = e.scores.length >= e.of;
  fill(
    panel,
    h("div", { class: "micro" }, done ? "ELI ladder, done" : `Round ${e.round} of ${e.of}`),
    !done && h("p", { class: "eli-now" }, `Explain it to ${e.audience}.`),
    !done &&
      h(
        "p",
        { class: "dim small" },
        e.level === "eli5"
          ? "No jargon at all. A picture they'd get."
          : e.level === "eli15"
            ? "Plain words, a few real terms explained, one example."
            : "Rigour: precise terms and the real mechanism. They'll press you.",
      ),
    ...e.scores.map((s) =>
      h(
        "div",
        { class: "eli-score" },
        h("b", {}, `To ${names[s.round - 1]}: ${Math.round(s.score * 100)}%`),
        h("p", { class: "small" }, s.feedback),
      ),
    ),
  );
}

// --- V5-08 substitute teacher --------------------------------------------------------------

let shown = 0;
let shownFor = "";
let revealTimer: ReturnType<typeof setTimeout> | null = null;

function renderSub(sb: NonNullable<ClassroomState["sub"]>) {
  delete panel.dataset.sig;
  const key = sb.lines.join("|");
  if (shownFor !== key) {
    shownFor = key;
    shown = 1;
  }
  const reveal = () => {
    if (shown < sb.lines.length) shown++;
    render(store.getState().classroom, store.getState().route.name);
  };
  if (revealTimer) clearTimeout(revealTimer);
  const r = sb.result;
  const paused = store.getState().classroom.clock.paused;
  if (!r && !paused && shown < sb.lines.length)
    revealTimer = setTimeout(reveal, 3500 + (sb.lines[shown - 1]?.length ?? 0) * 35);
  fill(
    panel,
    h(
      "div",
      { class: "micro" },
      r ? "The substitute's lesson, checked" : "The substitute is teaching",
    ),
    h(
      "p",
      { class: "dim small", style: "margin:4px 0 10px" },
      r
        ? `You caught ${r.caught} of ${r.caught + r.missed}${r.falseAlarms ? `, ${r.falseAlarms} false alarm${r.falseAlarms === 1 ? "" : "s"}` : ""}.`
        : "Object when you hear a mistake (O objects to the latest line).",
    ),
    h(
      "ol",
      { class: "sub-lines" },
      ...sb.lines.slice(0, r ? sb.lines.length : shown).map((text, i) => {
        const o = sb.objections[i];
        const res = r?.lines[i];
        const cls = res
          ? `${res.planted ? "planted" : "fine"} ${res.objected ? "objected" : ""}`
          : o
            ? `objected ${o.planted ? "planted" : "fine"}`
            : "";
        return h(
          "li",
          { class: `sub-line ${cls}` },
          h("p", {}, text),
          res
            ? h(
                "small",
                {},
                res.planted
                  ? res.objected
                    ? `Caught. True: ${res.correction}`
                    : `Missed. True: ${res.correction}`
                  : res.objected
                    ? "This one was fine: a false alarm."
                    : "",
              )
            : o
              ? h(
                  "small",
                  {},
                  o.planted ? `Good catch. True: ${o.correction}` : "That one was right, actually.",
                )
              : h("button", { class: "btn small", onclick: () => app.objectToSub(i) }, "Object!"),
        );
      }),
    ),
    !r &&
      h(
        "div",
        { class: "row", style: "margin-top:10px" },
        shown < sb.lines.length &&
          h("button", { class: "btn small", onclick: reveal }, "Next line"),
        h(
          "button",
          { class: "btn small primary", onclick: () => app.finishSub() },
          shown < sb.lines.length ? "Stop here and score" : "Finish and score",
        ),
      ),
  );
}

// O objects to the latest line the substitute said.
window.addEventListener("keydown", (e) => {
  const c = store.getState().classroom;
  if (!c.sub || c.sub.result || e.key.toLowerCase() !== "o" || e.metaKey || e.ctrlKey) return;
  const t = e.target as HTMLElement | null;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
  const i = shown - 1;
  if (i >= 0 && !c.sub.objections[i]) {
    e.preventDefault();
    app.objectToSub(i);
  }
});

function renderTeachBack(c: ClassroomState, tb: NonNullable<ClassroomState["teachBack"]>) {
  delete panel.dataset.sig;
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

// --- V5-09 guest lecturer ------------------------------------------------------------------

function renderGuest(c: ClassroomState, live: boolean) {
  const g = c.guest;
  guest.hidden = !live || !g;
  if (!g || guest.dataset.for === g.answer) return;
  guest.dataset.for = g.answer;
  fill(
    guest,
    h(
      "div",
      { class: "row", style: "gap:8px" },
      h("div", { class: "micro", style: "flex:1" }, `Guest lecturer · ${g.name}`),
      h(
        "button",
        { class: "btn small quiet", onclick: () => app.dismissGuest(), "aria-label": "Close" },
        "×",
      ),
    ),
    h("p", { class: "dim small", style: "margin:4px 0" }, `On: “${g.question}”`),
    h("p", { class: "guest-answer" }, g.answer),
    g.citations.length
      ? h(
          "p",
          { class: "dim small" },
          h("b", {}, "From your sources: "),
          g.citations
            .map(
              (x) =>
                `${x.source}${x.heading ? ` › ${x.heading}` : ""}${x.page ? ` (p.${x.page})` : ""}`,
            )
            .join(" · "),
        )
      : null,
    h(
      "p",
      { class: "dim small", style: "margin-bottom:0" },
      `Only you hear the guest; your class learns from you. ${g.left} visit${g.left === 1 ? "" : "s"} left this week.`,
    ),
  );
}

// --- V6-06 /source -------------------------------------------------------------------

function renderSource(c: ClassroomState, live: boolean) {
  const p = c.sourcePassage;
  source.hidden = !live || !p || !!c.guest;
  if (!p || source.dataset.for === p.text) return;
  source.dataset.for = p.text;
  const ref = `${p.source}${p.heading ? ` › ${p.heading}` : ""}${p.page ? ` (p.${p.page})` : ""}`;
  fill(
    source,
    h(
      "div",
      { class: "row", style: "gap:8px" },
      h("div", { class: "micro", style: "flex:1" }, "From your sources"),
      h(
        "button",
        { class: "btn small quiet", onclick: () => app.dismissSource(), "aria-label": "Close" },
        "×",
      ),
    ),
    h("p", { class: "dim small", style: "margin:4px 0" }, `Checking: “${p.query}”`),
    h("p", { class: "guest-answer" }, p.text.length > 900 ? `${p.text.slice(0, 897)}…` : p.text),
    h(
      "p",
      { class: "dim small" },
      p.url ? h("a", { href: p.url, target: "_blank", rel: "noreferrer" }, ref) : ref,
    ),
    h(
      "p",
      { class: "dim small", style: "margin-bottom:0" },
      "Only you see this. An exam set in the next hour counts as open-book.",
    ),
  );
}
