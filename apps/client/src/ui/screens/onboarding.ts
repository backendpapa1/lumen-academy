import { fill, h } from "./dom";

// First run (M6-07): five short cards over the campus, a minute or two in
// total. Skippable with Esc; never shown again (remembered in this browser).

const KEY = "lumen.onboarded";

const STEPS: Array<{ kicker: string; title: string; body: string }> = [
  {
    kicker: "Welcome, teacher",
    title: "You learn by teaching.",
    body: "Lumen Academy is a school where you teach a class of AI students. Explaining something is the fastest way to find out whether you really understand it.",
  },
  {
    kicker: "Schools",
    title: "One School per topic.",
    body: "Found a School, drop in a PDF or your notes, and the Curriculum Architect turns it into modules and concepts. Edit anything you like.",
  },
  {
    kicker: "The mirror",
    title: "Your students only know what you teach.",
    body: "They react as you explain, raise their hands when you're vague, and repeat your mistakes back to you. When they're confused, that's where your own understanding is thin.",
  },
  {
    kicker: "The loop",
    title: "Teach, assign, examine, re-teach.",
    body: "Homework and exams are graded against the source. The debrief shows what you under-taught and what you got wrong, and Re-teach starts a class on exactly that.",
  },
  {
    kicker: "Controls",
    title: "Mostly your keyboard.",
    body: "Enter to teach · Tab and Space to call on a hand · Esc to pause · ` for the transcript · N for a student's notes · F for Hyperfocus · M for sound.",
  },
];

/** Shows the first-run cards if they haven't been seen; returns a cleanup for when the lobby goes. */
export function maybeOnboard(root: HTMLElement): () => void {
  try {
    if (localStorage.getItem(KEY)) return () => {};
  } catch {
    return () => {}; // no storage: don't nag every time
  }
  let step = 0;
  const back = h("div", {
    class: "onboard-back",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": "Welcome to Lumen Academy",
  });
  const done = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* fine */
    }
    back.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const render = () => {
    const s = STEPS[step]!;
    const last = step === STEPS.length - 1;
    const next = h(
      "button",
      { class: "btn primary", onclick: () => (last ? done() : ((step += 1), render())) },
      last ? "Let's teach" : "Next",
    );
    fill(
      back,
      h(
        "section",
        { class: "card onboard" },
        h("div", { class: "micro" }, s.kicker),
        h("div", { class: "display", style: "font-size:32px" }, s.title),
        h("p", { class: "lede", style: "margin:8px 0 22px" }, s.body),
        h(
          "div",
          { class: "row" },
          h(
            "div",
            { class: "dots", "aria-hidden": "true" },
            ...STEPS.map((_, i) => h("i", { class: i === step ? "on" : "" })),
          ),
          h("span", { class: "spacer" }),
          !last && h("button", { class: "btn quiet", onclick: done }, "Skip"),
          next,
        ),
      ),
    );
    next.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      done();
    }
  };
  document.addEventListener("keydown", onKey, true);
  root.append(back);
  render();
  // Leaving the lobby mid-way (e.g. a reload rejoining a class): no stray Esc handler.
  return () => document.removeEventListener("keydown", onKey, true);
}
