import { api } from "../../core/api";
import { app } from "../../core/app";
import { sound } from "../../core/audio";
import { fill, h, icon, ICONS } from "./dom";
import { openModal } from "./modal";

// The study hall's focus timer, as a session: one line on what I'll do (it
// makes starting easier), focused minutes that count toward the streak and
// XP, "did you?" at the bell, then a real break. A gentle stop after a long
// day of it. The button is built once and only its label changes, so a click
// always lands (it used to be rebuilt four times a second, and Pause missed).

const PRESETS = [15, 25, 45];
const LONG_KEY = "lumen.studyLongNudge";

export interface TimerHooks {
  schoolId: () => string | null;
  /** One-tap intentions: "Prep Merkle trees for Class A", "Read Chapter 4". */
  suggestions: () => string[];
  /** Four times a second: whether a focus block is running (for the student who leans over). */
  onFocusTick: (running: boolean) => void;
  onBreak: (on: boolean) => void;
  todayMinutes: () => number;
  settings: () => { breakMinutes: number; longStudyMinutes: number };
}

interface Session {
  id: Promise<string | null>;
  intention: string;
  synced: number;
}

export function studyTimer(hooks: TimerHooks) {
  let minutes = 25;
  let endsAt: number | null = null;
  let leftMs = minutes * 60_000;
  let session: Session | null = null;
  let breakEnds: number | null = null;
  /** Today's minutes as the server last counted them (after a block ends). */
  let today: number | null = null;

  const digits = h("div", { class: "sh-digits", role: "timer", "aria-live": "off" });
  const label = h("span");
  const glyph = h("span", { class: "sh-glyph" });
  const startBtn = h("button", { class: "btn primary sh-start" }, glyph, label);
  const stopBtn = h(
    "button",
    { class: "btn quiet", hidden: true, title: "End this block now" },
    "Finish",
  );
  const presetRow = h("div", { class: "seg", role: "group", "aria-label": "Minutes" });
  const intentLine = h("div", { class: "sh-intent", hidden: true });
  const form = h("form", { class: "sh-intent-form card pad", hidden: true });
  const breakCard = h("div", {
    class: "sh-break",
    hidden: true,
    role: "dialog",
    "aria-label": "Break",
  });
  const nudge = h("div", { class: "sh-nudge card pad", hidden: true, role: "status" });

  const focusedMs = () => minutes * 60_000 - (endsAt ? Math.max(0, endsAt - Date.now()) : leftMs);
  let shown = { text: "", label: "", running: false };

  const show = () => {
    const ms = endsAt ? Math.max(0, endsAt - Date.now()) : leftMs;
    const s = Math.ceil(ms / 1000);
    const text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    const lbl = endsAt ? "Pause" : session ? "Carry on" : "Start";
    if (text !== shown.text) digits.textContent = text;
    if (lbl !== shown.label || !!endsAt !== shown.running) {
      label.textContent = lbl;
      fill(glyph, icon(endsAt ? ICONS.pause : ICONS.play));
      for (const b of presetRow.querySelectorAll("button")) b.disabled = !!session;
      stopBtn.hidden = !session;
    }
    shown = { text, label: lbl, running: !!endsAt };
  };

  const pressedPreset = () => {
    for (const b of presetRow.querySelectorAll("button"))
      b.setAttribute("aria-pressed", String(Number(b.dataset.min) === minutes));
  };
  for (const m of PRESETS)
    presetRow.append(
      h(
        "button",
        {
          type: "button",
          "data-min": m,
          onclick: () => {
            if (session) return;
            minutes = m;
            leftMs = m * 60_000;
            pressedPreset();
            show();
          },
        },
        `${m} min`,
      ),
    );
  pressedPreset();

  // --- starting: one line on what I'll do ------------------------------------------
  const intent = h("input", {
    class: "field",
    name: "intention",
    maxlength: 200,
    placeholder: "What will you do in this block? e.g. read chapter 4 and make notes",
    "aria-label": "What will you do in this block?",
  }) as HTMLInputElement;
  const begin = (intention: string) => {
    form.hidden = true;
    const schoolId = hooks.schoolId();
    session = {
      intention,
      synced: 0,
      id: api
        .post<{ id: string }>("/api/study/sessions", { schoolId, intention: intention || null })
        .then((r) => r.id)
        .catch(() => null),
    };
    fill(intentLine, intention ? h("span", {}, h("b", {}, "Now: "), intention) : "Focus block");
    intentLine.hidden = false;
    endsAt = Date.now() + leftMs;
    show();
  };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    begin(intent.value.trim());
  });
  const openForm = () => {
    intent.value = "";
    const chips = hooks.suggestions().slice(0, 3);
    fill(
      form,
      h("label", { class: "micro", for: "sh-intention" }, "Before you start"),
      intent,
      chips.length > 0 &&
        h(
          "div",
          { class: "row wrap-row sh-chips" },
          ...chips.map((c) =>
            h("button", { type: "button", class: "chip", onclick: () => begin(c) }, c),
          ),
        ),
      h(
        "div",
        { class: "row", style: "margin-top:10px;gap:8px" },
        h("button", { type: "submit", class: "btn primary" }, "Start"),
        h("button", { type: "button", class: "btn quiet", onclick: () => begin("") }, "Just start"),
        h("span", { class: "spacer" }),
        h(
          "button",
          { type: "button", class: "btn quiet", onclick: () => (form.hidden = true) },
          "Cancel",
        ),
      ),
    );
    intent.id = "sh-intention";
    form.hidden = false;
    intent.focus();
  };

  startBtn.addEventListener("click", () => {
    if (endsAt) {
      leftMs = Math.max(0, endsAt - Date.now());
      endsAt = null;
    } else if (session) endsAt = Date.now() + leftMs;
    else return openForm();
    show();
  });
  stopBtn.addEventListener("click", () => void finish(true));

  // --- the bell: did you?, then a real break -----------------------------------------
  const patch = (body: object) =>
    session?.id.then((id) => (id ? api.patch<EndResult>(`/api/study/sessions/${id}`, body) : null));

  const finish = async (early: boolean) => {
    if (!session) return;
    const s = session;
    const mins = Math.floor(focusedMs() / 60_000);
    endsAt = null;
    leftMs = minutes * 60_000;
    session = null;
    intentLine.hidden = true;
    show();
    sound.cue("bell");
    const res = await s.id
      .then((id) =>
        id ? api.patch<EndResult>(`/api/study/sessions/${id}`, { minutes: mins, end: true }) : null,
      )
      .catch(() => null);
    if (res) {
      today = res.todayMinutes;
      const bits = [
        `${mins} focused minute${mins === 1 ? "" : "s"}`,
        res.xp ? `+${res.xp} XP` : null,
        res.countsForStreak ? `streak ${res.streak} day${res.streak === 1 ? "" : "s"}` : null,
      ].filter(Boolean);
      app.notify(bits.join(" · "));
    }
    if (s.intention) await askDid(s, mins);
    if (!early) startBreak();
    maybeNudge(0);
  };

  const askDid = (s: Session, mins: number) =>
    new Promise<void>((resolve) => {
      const pick = (outcome: "done" | "partly" | "not") => {
        void s.id.then(
          (id) => id && api.patch(`/api/study/sessions/${id}`, { outcome }).catch(() => undefined),
        );
        close();
        resolve();
      };
      const close = openModal(
        "Did you?",
        h(
          "div",
          { class: "stack" },
          h("p", { style: "margin-top:0" }, `You said you'd: `, h("b", {}, s.intention)),
          h(
            "p",
            { class: "dim small" },
            `${mins} focused minute${mins === 1 ? "" : "s"}. No wrong answer: this is just for you.`,
          ),
          h(
            "div",
            { class: "actions" },
            h("button", { class: "btn primary", onclick: () => pick("done") }, "Done"),
            h("button", { class: "btn", onclick: () => pick("partly") }, "Partly"),
            h("button", { class: "btn quiet", onclick: () => pick("not") }, "Not this time"),
          ),
        ),
        { onClose: () => resolve() },
      );
    });

  const breakLeft = h("div", { class: "sh-digits" });
  const startBreak = () => {
    breakEnds = Date.now() + hooks.settings().breakMinutes * 60_000;
    fill(
      breakCard,
      h(
        "div",
        { class: "card pad sh-break-card" },
        h("div", { class: "micro" }, "Break"),
        h("h2", { class: "h2" }, "Stand up. Get some water. Look out of a window."),
        h(
          "p",
          { class: "dim" },
          "Away from the screen counts double. The next block starts when you're back.",
        ),
        breakLeft,
        h(
          "div",
          { class: "row", style: "gap:8px;justify-content:center" },
          h("button", { class: "btn primary", onclick: () => endBreak() }, "Back to work"),
        ),
      ),
    );
    breakCard.hidden = false;
    hooks.onBreak(true);
  };
  const endBreak = () => {
    breakEnds = null;
    breakCard.hidden = true;
    hooks.onBreak(false);
  };

  // --- a gentle stop after a long day of it ------------------------------------------
  const maybeNudge = (extra: number) => {
    const day = new Date().toDateString();
    let seen: string | null = null;
    try {
      seen = localStorage.getItem(LONG_KEY);
    } catch {
      /* per-viewer convenience */
    }
    const long = hooks.settings().longStudyMinutes;
    if (seen === day || (today ?? hooks.todayMinutes()) + extra < long) return;
    try {
      localStorage.setItem(LONG_KEY, day);
    } catch {
      /* fine */
    }
    fill(
      nudge,
      h("b", {}, `That's ${long} minutes of study today.`),
      " Your brain files things away while you rest. Take a proper break: 15 minutes away from the screen.",
      h("button", { class: "btn small quiet", onclick: () => (nudge.hidden = true) }, "OK"),
    );
    nudge.hidden = false;
  };

  const tick = setInterval(() => {
    show();
    if (breakEnds) {
      const s = Math.max(0, Math.ceil((breakEnds - Date.now()) / 1000));
      breakLeft.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      if (s === 0) {
        sound.cue("arrive");
        endBreak();
      }
    }
    if (!session) return hooks.onFocusTick(false);
    hooks.onFocusTick(!!endsAt);
    const mins = Math.floor(focusedMs() / 60_000);
    if (mins > session.synced) {
      session.synced = mins;
      void patch({ minutes: mins })?.catch(() => undefined);
      maybeNudge(mins);
    }
    if (endsAt && endsAt <= Date.now()) void finish(false);
  }, 250);
  show();

  return {
    el: h(
      "section",
      { class: "sh-timer", "aria-label": "Timer" },
      digits,
      presetRow,
      startBtn,
      stopBtn,
    ),
    /** Under the header: what I'm doing now, the start form, the gentle stop. */
    strip: h("div", { class: "sh-strip" }, intentLine, form, nudge),
    breakCard,
    startBtn,
    running: () => !!endsAt,
    dispose() {
      clearInterval(tick);
      if (session) {
        const mins = Math.floor(focusedMs() / 60_000);
        void patch({ minutes: mins, end: true })?.catch(() => undefined);
      }
    },
  };
}

interface EndResult {
  minutes: number;
  xp: number;
  todayMinutes: number;
  streak: number;
  countsForStreak: boolean;
}
