import { demoClass } from "../../core/demoClass";
import { narrator, type NarratorState } from "../../core/narrator";
import { lookFor, peepSvg } from "../peeps/peep";
import { fill, h, icon, ICONS } from "./dom";
import "./tour.css";

// The guided tour (Paul's note): the Head of School walks a first-timer
// through the lobby, spotlighting the real thing on screen, then takes them
// into a pretend class (core/demoClass.ts: the real classroom, scripted). Every line is read aloud
// (narrator.ts). It runs once on first launch and replays from the lobby's
// Tour button or Settings.

const KEY = "lumen.onboarded";

/** The guide: a made-up Head of School (her voice is the narrator's). */
const GUIDE = { name: "Ms Hale", look: lookFor("guide_hale", "bun", "female") };

type Scene = "welcome" | "exam" | "keys";
type ClassScene = "room" | "teach" | "hand" | "mirror" | "clock";

interface Step {
  kicker: string;
  title: string;
  /** Shown and read aloud. */
  say: string;
  /** What to spotlight; the first one on screen wins (missing = the step is centred). */
  target?: string | string[];
  /** A simulated scene inside the guide card instead. */
  scene?: Scene;
  /** Leave the step out when its target isn't on screen. */
  optional?: boolean;
  /** A step inside the pretend class, and what happens in it. */
  inClass?: ClassScene;
}

const STEPS: Step[] = [
  {
    kicker: "Welcome, teacher",
    title: "You learn by teaching.",
    say: `Hello, I'm ${GUIDE.name}, Head of Lumen Academy. Here you teach a class of AI students. Explaining something is the quickest way to find out whether you really understand it. Let me show you around: it takes about two minutes.`,
    scene: "welcome",
  },
  {
    kicker: "Schools",
    title: "One School per topic.",
    say: "Each School is one topic you want to learn. Found one here, then add your sources: PDFs, notes, slides, a YouTube talk, a web page, even a photo of handwritten notes. The school turns them into a curriculum of modules and concepts that you can edit.",
    target: ".lobby .new-school",
  },
  {
    kicker: "In class",
    title: "This is your classroom.",
    say: "Let's step into a class. These five students are sitting a class on hashing. Each has their own personality, and none of them has seen your sources: everything they know comes from you.",
    target: ".room .desks",
    inClass: "room",
  },
  {
    kicker: "In class",
    title: "Teach it in your own words.",
    say: "You teach at the lectern: type a line, or hold Space and say it. Watch the room as it lands. Some faces light up, some frown.",
    target: ".hud .lectern",
    inClass: "teach",
  },
  {
    kicker: "In class",
    title: "When you're vague, a hand goes up.",
    say: "Ada is lost, so her hand goes up. Press Tab to call on her, and answer the question. Questions are where the learning happens.",
    // The raised hand, then her question once she's speaking.
    target: ["#speech.shown", ".hud-hands"],
    inClass: "hand",
  },
  {
    kicker: "The mirror",
    title: "They repeat your mistakes.",
    say: "Now Kenji repeats it back, wrongly. That's the mirror: when students get it wrong, it's often how it was taught. Correct him, and the whole class updates.",
    target: ["#speech.shown", ".room .desks"],
    inClass: "mirror",
  },
  {
    kicker: "In class",
    title: "Short classes, then the bell.",
    say: "Classes are short: fifteen minutes unless you change it. The clock is up here. When the bell rings, students hand you exit tickets, so you see what stuck.",
    target: ".hud-right",
    inClass: "clock",
  },
  {
    kicker: "Homework, exams, debrief",
    title: "Find the gaps, then re-teach.",
    say: "Set homework and exams, and they're marked against your sources. The debrief shows what you under-taught and what you got wrong, and Re-teach starts a class on exactly that.",
    scene: "exam",
  },
  {
    kicker: "Where to start",
    title: "Today's best class.",
    say: "Not sure what to do today? This card picks the one class worth teaching now, usually something your students are starting to forget. One button and you're in.",
    target: ".lobby .resume",
    optional: true,
  },
  {
    kicker: "Progress",
    title: "Rank, streak, and how you teach.",
    say: "Every class earns XP towards your next rank, and a gentle streak counts the days you show up. Miss a day and a banked freeze covers it. Open Your progress to see charts and a profile of your teaching style.",
    target: ".lobby .status-row",
    optional: true,
  },
  {
    kicker: "Weekly challenge",
    title: "Optional, one a week.",
    say: "Each week there's one optional challenge, like teaching without jargon. Take it on if you like, for bonus XP and a sticker.",
    target: ".lobby .challenge:not([hidden])",
    optional: true,
  },
  {
    kicker: "Study hall",
    title: "Study with company.",
    say: "Need to read up first? The study hall is a quiet desk with someone working beside you, for body doubling. Your sources are open in it, with a timer and a notepad for your study notes.",
    target: "[data-tour='studyhall']",
  },
  {
    kicker: "Your campus",
    title: "It grows with what they learn.",
    say: "Each School is a building on the campus. As your students master concepts it grows, from a blueprint to a landmark with a library, a lab and a fountain. Skip a few days and the weather turns grey, but it clears as soon as you teach again.",
    target: ".campus",
  },
  {
    kicker: "Controls",
    title: "Mostly your keyboard.",
    say: "In class: Enter to teach, hold Space to talk, Tab to call on a hand, D to draw on the board, and Escape to pause. You don't need to remember them: they're shown along the bottom.",
    scene: "keys",
  },
  {
    kicker: "Any time",
    title: "I'm here if you need me.",
    say: "That's the tour. Replay it any time with the Tour button up here, or from Settings. Now, found your first School, or pick up a class. Good luck, teacher.",
    target: "[data-tour='tour']",
  },
];

let active: (() => void) | null = null;

/** First launch only; returns a cleanup for when the lobby goes. */
export function maybeTour(): () => void {
  // Already showing (it left the lobby for the pretend class and came back).
  if (active) return () => {};
  try {
    if (localStorage.getItem(KEY)) return () => {};
  } catch {
    return () => {}; // no storage: don't nag every time
  }
  // Let the lobby lay out first, so the spotlights land.
  const t = setTimeout(() => startTour(), 600);
  // Only the pending start: the tour leaves the lobby for the pretend class
  // and back, so it closes itself.
  return () => clearTimeout(t);
}

export function startTour(): void {
  active?.();
  const steps = STEPS.filter((s) => !s.optional || !s.target || !!find(s.target));
  let i = 0;
  let stopScene: (() => void) | null = null;

  const back = h("div", {
    class: "tour",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": "Guided tour of Lumen Academy",
  });
  const hole = h("div", { class: "tour-hole", "aria-hidden": "true" });
  const card = h("section", { class: "card tour-card" });
  back.append(hole, card);
  document.querySelector("#stage")!.append(back);
  const before = document.activeElement as HTMLElement | null;

  const speakBtn = h("button", {
    class: "btn small quiet tour-speak",
    onclick: () => {
      narrator.unlock();
      if (narrator.state === "blocked") narrator.on = true;
      else narrator.on = !narrator.on;
      paintSpeaker(narrator.state);
      if (narrator.on) void narrator.say(steps[i]!.say);
    },
  });
  const paintSpeaker = (s: NarratorState) => {
    const on = narrator.on && s !== "blocked" && s !== "unavailable";
    fill(
      speakBtn,
      icon(on ? ICONS.speaker : ICONS.mute),
      s === "blocked"
        ? "Tap to hear me"
        : s === "unavailable"
          ? "No voice right now"
          : on
            ? s === "loading"
              ? "Warming up the voice…"
              : "Voice on"
            : "Voice off",
    );
    speakBtn.title =
      s === "unavailable"
        ? "The narrator's voice isn't set up on this computer; the text is all here."
        : "";
    speakBtn.setAttribute("aria-pressed", String(on));
    speakBtn.classList.toggle("pulse", s === "blocked");
    card.classList.toggle("talking", s === "speaking");
  };
  const offNarrator = narrator.onChange(paintSpeaker);

  const finish = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* fine */
    }
    close();
  };
  const close = () => {
    narrator.stop();
    offNarrator();
    stopScene?.();
    clearInterval(replace);
    demoClass.stop();
    back.remove();
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", place);
    active = null;
    before?.focus?.();
  };
  active = close;

  const go = (to: number) => {
    narrator.unlock();
    i = Math.max(0, Math.min(steps.length - 1, to));
    render();
  };

  function place() {
    const s = steps[i]!;
    const el = s.target ? find(s.target) : null;
    const r = el ? el.getBoundingClientRect() : null;
    back.classList.toggle("spot", !!r);
    if (r) {
      const pad = 8;
      Object.assign(hole.style, {
        left: `${Math.max(4, r.left - pad)}px`,
        top: `${Math.max(4, r.top - pad)}px`,
        width: `${Math.min(innerWidth - 8, r.width + pad * 2)}px`,
        height: `${Math.min(innerHeight - 8, r.height + pad * 2)}px`,
      });
      // The card sits on the other side of the screen from what it points at.
      const right = r.left + r.width / 2 < innerWidth / 2;
      card.dataset.side = innerWidth < 760 ? "bottom" : right ? "right" : "left";
    } else card.dataset.side = "centre";
  }

  function render() {
    const s = steps[i]!;
    const last = i === steps.length - 1;
    stopScene?.();
    stopScene = null;
    // Into the pretend class, a scene in it, or back out to the lobby.
    if (s.inClass) {
      demoClass.start();
      if (s.inClass !== "room") demoClass.play(s.inClass);
      else demoClass.clear();
    } else demoClass.stop();
    const el = s.target ? find(s.target) : null;
    el?.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
    const sceneEl = s.scene ? h("div", { class: `tour-scene scene-${s.scene}` }) : null;
    const next = h(
      "button",
      { class: "btn primary", onclick: () => (last ? finish() : go(i + 1)) },
      last ? "Let's teach" : "Next",
    );
    fill(
      card,
      h(
        "div",
        { class: "tour-head" },
        drawn("tour-guide", peepSvg(GUIDE.look, { face: "Smile" })),
        h(
          "div",
          { style: "min-width:0" },
          h("div", { class: "micro" }, `${s.kicker} · ${i + 1} of ${steps.length}`),
          h("div", { class: "h2 tour-title" }, s.title),
        ),
      ),
      sceneEl,
      h("p", { class: "tour-say", "aria-live": "polite" }, s.say),
      h(
        "div",
        { class: "row wrap-row tour-actions" },
        speakBtn,
        h("span", { class: "spacer" }),
        !last && h("button", { class: "btn quiet", onclick: finish }, "Skip tour"),
        i > 0 && h("button", { class: "btn", onclick: () => go(i - 1) }, "Back"),
        next,
      ),
    );
    if (sceneEl) stopScene = playScene(s.scene!, sceneEl);
    place();
    paintSpeaker(narrator.state);
    next.focus({ preventScroll: true });
    void narrator.say(s.say);
    if (!last) narrator.prefetch(steps[i + 1]!.say);
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") finish();
    else if (e.key === "ArrowRight") go(i + 1);
    else if (e.key === "ArrowLeft") go(i - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", place);
  // Screens change under the tour (lobby ↔ class) and hands or speech appear a
  // moment into a step, so the spotlight keeps finding its target.
  const replace = setInterval(place, 400);
  render();
}

/** The first of the targets that's on screen now. */
function find(target: string | string[]): HTMLElement | null {
  for (const sel of Array.isArray(target) ? target : [target]) {
    const el = document.querySelector<HTMLElement>(sel);
    const r = el?.getBoundingClientRect();
    if (el && r && r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden")
      return el;
  }
  return null;
}

// --- simulated scenes ---------------------------------------------------------

/** Our own drawing (peeps and SVG, no user text) in a div. */
function drawn(cls: string, markup: string): HTMLElement {
  const d = h("div", { class: cls, "aria-hidden": "true" });
  d.innerHTML = markup;
  return d;
}

const student = (id: string, hair: string, face: string, pose: "idle" | "hand" | "talk" = "idle") =>
  drawn(`t-peep ${pose}`, peepSvg(lookFor(id, hair), { face: face as never, pose }));

/** Builds a scene and runs its little timeline; returns a stop. */
function playScene(scene: Scene, el: HTMLElement): () => void {
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

  if (scene === "welcome") {
    el.append(
      h(
        "div",
        { class: "t-welcome" },
        drawn("t-hall", HALL),
        h(
          "div",
          { class: "t-row" },
          student("tour_a", "afro", "Smile"),
          student("tour_b", "long", "BigSmile", "hand"),
          student("tour_c", "short", "Calm"),
        ),
      ),
    );
  }

  if (scene === "exam") {
    const rows = [
      ["Ada", 0.86],
      ["Kenji", 0.71],
      ["Noor", 0.54],
      ["Sora", 0.78],
    ] as const;
    const bars = rows.map(([name]) =>
      h("div", { class: "t-bar" }, h("span", {}, name), h("i", {}), h("b", {}, "")),
    );
    const debrief = h(
      "div",
      { class: "t-debrief", hidden: true },
      h("span", { class: "micro" }, "Debrief"),
      h("p", {}, "Under-taught: Merkle proofs · 1 thing you got wrong"),
      h("span", { class: "btn small primary", "aria-hidden": "true" }, "Re-teach it"),
    );
    el.append(
      h(
        "div",
        { class: "t-exam" },
        h("div", { class: "micro" }, "Module 2 exam · class average 72%"),
        ...bars,
      ),
      debrief,
    );
    rows.forEach(([, v], k) =>
      at(300 + k * 350, () => {
        const b = bars[k]!;
        (b.querySelector("i") as HTMLElement).style.setProperty("--v", String(v));
        b.querySelector("b")!.textContent = `${Math.round(v * 100)}%`;
        b.classList.add("on");
      }),
    );
    at(2200, () => (debrief.hidden = false));
  }

  if (scene === "keys") {
    const keys: Array<[string, string]> = [
      ["Enter", "teach"],
      ["Space", "hold to talk"],
      ["Tab", "pick a hand"],
      ["D", "draw"],
      ["P", "park a thought"],
      ["Esc", "pause"],
    ];
    el.append(
      h(
        "div",
        { class: "t-keys" },
        ...keys.map(([k, what], n) =>
          h("div", { class: "t-key", style: `--n:${n}` }, h("kbd", {}, k), h("span", {}, what)),
        ),
      ),
    );
  }

  return () => timers.forEach(clearTimeout);
}

/** The Academy hall, small, in the campus style. */
const HALL = `<svg viewBox="0 0 220 120" aria-hidden="true">
  <path class="ped" d="M10 46 L110 10 L210 46z"/>
  <rect class="fac" x="20" y="46" width="180" height="66"/>
  ${[0, 1, 2, 3, 4].map((k) => `<rect class="col" x="${36 + k * 34}" y="54" width="10" height="58"/>`).join("")}
  <rect class="sign" x="62" y="50" width="96" height="14"/>
  <text x="110" y="60.5" text-anchor="middle">LUMEN ACADEMY</text>
  <rect class="step" x="70" y="110" width="80" height="6"/>
</svg>`;
