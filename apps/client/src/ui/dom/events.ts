import { ARCHETYPE_INFO } from "@lumen/shared";
import { app } from "../../core/app";
import type { EventState } from "../../core/classroom";
import { store } from "../../core/store";
import { portrait, rankInsignia } from "../screens/common";
import { fill, h, icon, ICONS } from "../screens/dom";
import { voice } from "../../core/voice";

// Random events (docs/02 §6, M6-01). Pop quiz: explain the concept in a few
// sentences, graded against the source. Mix-up (the "glitch" kind): a student
// repeats me slightly wrong; catch it. Power flicker: the lights stutter and a
// misconception whispers across the room (the drawn room dims too). Inspector: the Dean watches
// my next three explanations, then reports what worked and what to fix.

const LABEL: Partial<Record<EventState["kind"], string>> = {
  pop_quiz: "Pop quiz",
  glitch: "Mix-up",
  recheck: "From your mistake journal",
  debate: "Class debate",
};

const root = h("div", { class: "event-back", hidden: true });
document.querySelector("#stage")!.append(root);
let timer: ReturnType<typeof setInterval> | null = null;
let shownId: string | null = null;
let autoClose: ReturnType<typeof setTimeout> | null = null;

const secondsLeft = (e: EventState) => Math.max(0, e.seconds - (Date.now() - e.at) / 1000);

function render(e: EventState | undefined) {
  stopTimer();
  if (autoClose) clearTimeout(autoClose);
  autoClose = null;
  if (!e) {
    root.hidden = true;
    shownId = null;
    return fill(root);
  }
  const fresh = shownId !== e.id;
  shownId = e.id;
  root.hidden = false;
  root.className = `event-back ${e.kind}`;
  const cadets = store.getState().classroom.cadets;
  const c = e.cadetId ? cadets[e.cadetId] : undefined;
  const who = (id?: string) => (id && cadets[id]?.name) || "A cadet";
  const accent = c ? ARCHETYPE_INFO[c.archetype].accent : "var(--lumen)";

  if (e.kind === "power_flicker") {
    fill(
      root,
      h(
        "section",
        { class: "card event-card flicker", role: "status", "aria-live": "polite" },
        h("div", { class: "micro" }, "The lights flickered"),
        h(
          "p",
          { style: "margin:6px 0 0" },
          `In the dark, ${who(e.cadetId)} whispered to ${e.toCadetId ? who(e.toCadetId) : "a neighbour"}: `,
          h("em", {}, `“${e.text}”`),
        ),
        h(
          "p",
          { class: "dim", style: "margin:6px 0 0;font-size:13px" },
          "Now two of them believe it. Clear it up in your next explanation.",
        ),
      ),
    );
    autoClose = setTimeout(() => app.dismissEvent(), 9000);
    return;
  }
  if (e.kind === "inspector") return renderInspector(e);
  // V5-11: someone new takes a seat.
  if (e.kind === "transfer") {
    fill(
      root,
      h(
        "section",
        { class: "card event-card", role: "status", "aria-live": "polite" },
        h("div", { class: "micro" }, "A transfer student"),
        h("p", { style: "margin:6px 0 0" }, e.text),
        h(
          "p",
          { class: "dim", style: "margin:6px 0 0;font-size:13px" },
          "Catch them up: a short recap now saves a lot later.",
        ),
      ),
    );
    autoClose = setTimeout(() => app.dismissEvent(), 10000);
    return;
  }

  const done = !!e.result;
  const head = h(
    "div",
    { class: "row" },
    c ? portrait(c) : h("span"),
    h(
      "div",
      { style: "flex:1;min-width:0" },
      h("div", { class: "micro" }, LABEL[e.kind] ?? "Mix-up"),
      h("div", { class: "who", style: `color:${accent}` }, c?.name ?? "Student"),
    ),
    h("div", { class: "mono event-clock" }, done ? "" : `${Math.ceil(secondsLeft(e))}s`),
  );
  const bar = done
    ? null
    : h(
        "div",
        { class: "progress event-bar", style: "width:100%;margin:12px 0" },
        h("span", { style: `width:${(secondsLeft(e) / e.seconds) * 100}%;background:${accent}` }),
      );
  const parts: Array<HTMLElement | null | false> = [head, bar];

  if (e.kind === "pop_quiz" || e.kind === "recheck") {
    parts.push(h("p", { class: "event-line" }, e.text));
    if (!done) {
      const box = h("textarea", {
        class: "field",
        id: "event-answer",
        rows: 4,
        maxlength: 1200,
        placeholder: "Explain it in your own words…",
        disabled: !!e.sent,
        "aria-label": "Your answer",
      });
      const send = () => !e.sent && app.answerEvent(e.id, { text: box.value });
      box.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
          ev.preventDefault();
          send();
        }
      });
      // V1-09: answer aloud. Hold the button (or press and hold it with Space).
      const mic = h(
        "button",
        {
          class: "btn small",
          type: "button",
          hidden: !voice.canListen || !!e.sent,
          title: "Hold to answer aloud",
        },
        icon(ICONS.mic),
        "Hold to say it",
      );
      const begin = () =>
        void voice.startRecording().catch((err: Error) => app.notify(err.message, "warn"));
      const end = () =>
        void voice
          .stopRecording()
          .then((text) => {
            if (text) box.value = `${box.value ? `${box.value} ` : ""}${text}`;
            box.focus();
          })
          .catch((err: Error) => app.notify(err.message, "warn"));
      mic.addEventListener("pointerdown", begin);
      mic.addEventListener("pointerup", end);
      mic.addEventListener("pointerleave", () => voice.state.recording && end());
      mic.addEventListener("keydown", (ev) => {
        if (ev.key === " " && !ev.repeat) {
          ev.preventDefault();
          begin();
        }
      });
      mic.addEventListener("keyup", (ev) => {
        if (ev.key === " ") end();
      });
      parts.push(
        box,
        h(
          "div",
          { class: "actions" },
          mic,
          h(
            "span",
            { class: "dim", style: "font-size:12px" },
            e.sent ? "Grading…" : "Ctrl+Enter to send",
          ),
          h("span", { class: "spacer" }),
          h(
            "button",
            {
              class: "btn quiet",
              disabled: !!e.sent,
              onclick: () => app.answerEvent(e.id, { text: "" }),
            },
            "Skip",
          ),
          h("button", { class: "btn primary", disabled: !!e.sent, onclick: send }, "Answer"),
        ),
      );
      if (fresh) queueMicrotask(() => box.focus({ preventScroll: true }));
    } else {
      const r = e.result!;
      parts.push(
        h(
          "div",
          { class: "event-outcome" },
          h("div", { class: "h2" }, `${r.score ?? 0} / 5`),
          h("p", { class: "dim", style: "margin:4px 0 0" }, r.explanation),
        ),
      );
    }
  } else if (e.kind === "debate") {
    // V5-11: two students argue a claim; I listen, then rule.
    parts.push(
      h("p", { class: "event-line" }, `“${e.text}”`),
      h(
        "p",
        { class: "dim", style: "margin:0 0 12px;font-size:13px" },
        `${who(e.cadetId)} argues for it, ${who(e.toCadetId)} against. Listen, then rule.`,
      ),
    );
    if (!done)
      parts.push(
        h(
          "div",
          { class: "actions" },
          h("span", { class: "dim", style: "font-size:12px" }, "Y right · N wrong"),
          h("span", { class: "spacer" }),
          h(
            "button",
            {
              class: "btn",
              disabled: !!e.sent,
              onclick: () => app.answerEvent(e.id, { wrong: false }),
            },
            "The claim is right",
          ),
          h(
            "button",
            {
              class: "btn",
              disabled: !!e.sent,
              onclick: () => app.answerEvent(e.id, { wrong: true }),
            },
            "The claim is wrong",
          ),
        ),
      );
    else {
      const r = e.result!;
      parts.push(
        h(
          "div",
          { class: `event-outcome ${r.caught ? "good" : "bad"}` },
          h("div", { class: "h2" }, r.caught ? "Good ruling." : "Not this time."),
          h("p", { class: "dim", style: "margin:4px 0 0" }, r.explanation),
        ),
      );
    }
  } else {
    // Mix-up: the repeated line, scribbled under.
    parts.push(
      h(
        "p",
        { class: `event-line glitch-text${done ? " settled" : ""}`, "data-text": e.text },
        e.text,
      ),
    );
    if (!done) {
      parts.push(
        h(
          "p",
          { class: "dim", style: "margin:0 0 12px;font-size:13px" },
          "Is that what you taught? Something may have got mixed up on the way.",
        ),
        h(
          "div",
          { class: "actions" },
          h("span", { class: "dim", style: "font-size:12px" }, "Y right · N wrong"),
          h("span", { class: "spacer" }),
          h(
            "button",
            {
              class: "btn",
              disabled: !!e.sent,
              onclick: () => app.answerEvent(e.id, { wrong: false }),
            },
            "That's right",
          ),
          h(
            "button",
            {
              class: "btn",
              disabled: !!e.sent,
              onclick: () => app.answerEvent(e.id, { wrong: true }),
            },
            "That's wrong",
          ),
        ),
      );
    } else {
      const r = e.result!;
      parts.push(
        h(
          "div",
          { class: `event-outcome ${r.caught ? "good" : "bad"}` },
          h("div", { class: "h2" }, r.caught ? "Caught it." : "It slipped past."),
          h("p", { class: "dim", style: "margin:4px 0 0" }, r.explanation),
        ),
      );
    }
  }
  if (done)
    parts.push(
      h(
        "div",
        { class: "actions" },
        e.result!.xp ? h("span", { class: "chip gold" }, `+${e.result!.xp} XP`) : null,
        h("span", { class: "spacer" }),
        h(
          "button",
          { class: "btn primary", id: "event-continue", onclick: () => app.dismissEvent() },
          "Back to class",
        ),
      ),
    );

  fill(
    root,
    h(
      "section",
      {
        class: "card event-card",
        role: "dialog",
        "aria-modal": "false",
        "aria-label": LABEL[e.kind] ?? "Mix-up",
        style: `--event-accent:${accent}`,
      },
      ...parts,
    ),
  );
  if (done) queueMicrotask(() => root.querySelector<HTMLElement>("#event-continue")?.focus());
  else if (!e.sent) startTimer();
  if (fresh && e.kind === "glitch" && !done)
    queueMicrotask(() =>
      root.querySelector<HTMLElement>(".actions .btn")?.focus({ preventScroll: true }),
    );
}

/** The Dean at the back of the room: a quiet tally while watching, then the report. */
function renderInspector(e: EventState) {
  const seal = rankInsignia("Dean");
  const watched = e.watched ?? 0;
  const head = h(
    "div",
    { class: "row" },
    seal ? h("img", { class: "dean-seal", src: seal, alt: "" }) : null,
    h(
      "div",
      { style: "flex:1;min-width:0" },
      h("div", { class: "micro" }, "Visiting inspector"),
      h("div", { class: "who", style: "color:var(--coral)" }, "The Dean"),
    ),
    !e.result && h("div", { class: "mono event-clock" }, `${watched} / 3`),
  );
  if (!e.result) {
    fill(
      root,
      h(
        "section",
        {
          class: "card event-card inspector watching",
          role: "status",
          "aria-live": "polite",
          style: "--event-accent:var(--marigold)",
        },
        head,
        h(
          "p",
          { class: "dim", style: "margin:8px 0 0;font-size:13px" },
          watched >= 3
            ? "Writing the report…"
            : "Observing your next explanations. Teach as you normally would.",
        ),
        h(
          "div",
          { class: "dean-ticks", "aria-hidden": "true" },
          ...[0, 1, 2].map((i) => h("i", { class: i < watched ? "on" : "" })),
        ),
      ),
    );
    return;
  }
  const r = e.result;
  const list = (title: string, cls: string, items: string[]) =>
    items.length
      ? h(
          "div",
          { class: `dean-list ${cls}` },
          h("div", { class: "micro" }, title),
          h("ul", {}, ...items.map((t) => h("li", {}, t))),
        )
      : null;
  fill(
    root,
    h(
      "section",
      {
        class: "card event-card inspector",
        role: "dialog",
        "aria-modal": "false",
        "aria-label": "The Dean's report",
        style: "--event-accent:var(--marigold)",
      },
      head,
      h("p", { class: "event-line dean-verdict" }, `“${r.explanation}”`),
      list("Worked", "good", r.feedback?.strengths ?? []),
      list("Fix next", "bad", r.feedback?.improve ?? []),
      r.feedback?.tip &&
        h("p", { class: "dean-tip" }, h("b", {}, "Next explanation: "), r.feedback.tip),
      h(
        "div",
        { class: "actions" },
        h("span", { class: "spacer" }),
        h(
          "button",
          { class: "btn primary", id: "event-continue", onclick: () => app.dismissEvent() },
          "Back to class",
        ),
      ),
    ),
  );
}

/** Only the clock moves each second; at zero my answer so far is sent. */
function tick() {
  const e = store.getState().classroom.event;
  if (!e || e.sent || e.result) return stopTimer();
  const left = secondsLeft(e);
  if (left <= 0) {
    stopTimer();
    const text = root.querySelector<HTMLTextAreaElement>("#event-answer")?.value ?? "";
    return app.answerEvent(
      e.id,
      e.kind === "pop_quiz" || e.kind === "recheck" ? { text } : { wrong: false },
    );
  }
  const clock = root.querySelector(".event-clock");
  if (clock) clock.textContent = `${Math.ceil(left)}s`;
  const bar = root.querySelector<HTMLElement>(".event-bar > span");
  if (bar) bar.style.width = `${(left / e.seconds) * 100}%`;
}
const startTimer = () => (timer ??= setInterval(tick, 1000));
function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

// The card owns its keys: typing an answer never calls a cadet or pauses the class.
root.addEventListener("keydown", (ev) => {
  const e = store.getState().classroom.event;
  if (!e) return;
  const inField = ev.target instanceof HTMLTextAreaElement;
  if ((e.kind === "glitch" || e.kind === "debate") && !e.result && !e.sent && !inField) {
    const k = ev.key.toLowerCase();
    if (k === "y") app.answerEvent(e.id, { wrong: false });
    else if (k === "n") app.answerEvent(e.id, { wrong: true });
  }
  if (ev.key === "Escape" && e.result) app.dismissEvent();
  ev.stopPropagation();
});

store.subscribe((s, p) => {
  if (s.classroom.event !== p.classroom.event || s.route !== p.route) {
    const e = s.route.name === "classroom" ? s.classroom.event : undefined;
    // Re-render only when what's shown changes, not while the clock runs.
    const prev = p.classroom.event;
    if (
      e &&
      prev &&
      e.id === prev.id &&
      e.sent === prev.sent &&
      e.result === prev.result &&
      e.watched === prev.watched
    )
      return;
    render(e);
  }
});
