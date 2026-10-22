import { app } from "../../core/app";
import { store } from "../../core/store";
import { voice } from "../../core/voice";
import "./overlay.css";

// The lectern: a real <textarea> (IME, paste, selection, accessibility) in the
// HUD (docs/05 §1). Enter sends, Shift+Enter is a newline. V1 push-to-talk:
// hold Space while it's empty (or use the mic button) and let go to send.

const el = document.createElement("textarea");
el.id = "lectern";
el.rows = 2;
el.placeholder = "Teach your next idea. Keep it short.";
el.setAttribute("aria-label", "Teach the class");
document.querySelector("#stage")!.appendChild(el);

/** The recogniser's words as last placed in the lectern (to learn from my edits). */
let suggested: string | null = null;

// Space in an empty lectern: a tap calls the selected hand (v1), a hold talks.
const HOLD_MS = 250;
let spaceTimer: ReturnType<typeof setTimeout> | null = null;

function callSelectedHand() {
  const st = store.getState();
  const queue = st.classroom.hands.map((h) => h.cadetId);
  const id = st.selectedId && queue.includes(st.selectedId) ? st.selectedId : queue[0];
  if (id) app.call(id);
}

el.addEventListener("keydown", (e) => {
  if (e.key === " " && el.value === "" && voice.canListen && !e.isComposing) {
    // Ours, not the global "call" shortcut: decided on release or after the hold.
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat && !spaceTimer && !talk.held)
      spaceTimer = setTimeout(() => {
        spaceTimer = null;
        void talk.start();
      }, HOLD_MS);
  } else if (e.key === " " && talk.held) {
    e.preventDefault(); // holding Space repeats; don't type while recording
    e.stopPropagation();
  } else if (e.key === "Escape" && voice.state.recording) {
    e.preventDefault();
    void talk.stop(true);
  } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    // If I fixed what it heard, learn the swaps for next time.
    if (suggested && el.value.trim() && el.value.trim() !== suggested.trim()) {
      const from = suggested;
      const to = el.value;
      void voice.learn(from, to).then((learned) => {
        if (learned.length)
          app.notify(
            `Got it: I'll listen for ${learned.map((l) => `“${l.meant}”`).join(", ")} next time.`,
          );
      });
    }
    const spoken = suggested !== null;
    suggested = null;
    app.teach(el.value, { spoken });
    el.value = "";
  } else if (e.key === "Escape") {
    el.blur();
  }
});
el.addEventListener("keyup", (e) => {
  if (e.key !== " ") return;
  if (spaceTimer) {
    clearTimeout(spaceTimer);
    spaceTimer = null;
    callSelectedHand();
  } else if (talk.held) {
    e.preventDefault();
    void talk.stop();
  }
});
el.addEventListener("blur", () => talk.held && void talk.stop());

/** Push-to-talk: record, then send what was heard (or leave it here to edit). */
export const talk = {
  held: false,
  async start() {
    if (el.disabled) return;
    talk.held = true;
    try {
      await voice.startRecording();
    } catch (err) {
      talk.held = false;
      app.notify((err as Error).message, "warn");
    }
  },
  async stop(cancel = false) {
    if (!talk.held) return;
    talk.held = false;
    try {
      const heard = await voice.stopRecording(cancel);
      if (!heard) {
        if (!cancel) app.notify("I didn't catch that. Hold Space a little longer, or type it.");
        return;
      }
      if (voice.prefs.autoSend) {
        app.teach(await voice.fix(heard), { spoken: true });
        return;
      }
      // Review first: the raw words now, the fixed ones when they land (unless I've edited).
      el.value = heard;
      suggested = heard;
      el.focus();
      const fixed = await voice.fix(heard);
      if (el.value === heard && fixed !== heard) {
        el.value = fixed;
        suggested = fixed;
        el.classList.remove("fixed");
        void el.offsetWidth;
        el.classList.add("fixed");
      }
    } catch (err) {
      app.notify((err as Error).message, "warn");
    }
  },
  /** The mic button: click to start, click again to send. */
  toggle() {
    if (talk.held) void talk.stop();
    else void talk.start();
  },
};

// The lectern's frame shows the mic state.
voice.on(() => {
  const frame = el.parentElement;
  frame?.classList.toggle("listening", voice.state.recording);
  frame?.classList.toggle("hearing", voice.state.transcribing);
  frame?.style.setProperty("--level", String(voice.state.level));
  if (voice.state.recording) el.placeholder = "Listening… let go of Space to send (Esc cancels)";
  else if (voice.state.transcribing) el.placeholder = "Writing down what you said…";
});

store.subscribe((s) => {
  if (voice.state.recording || voice.state.transcribing) return; // the mic owns the hint
  const live = s.classroom.status === "live";
  const paused = live && s.classroom.clock.paused;
  el.disabled = !live || paused;
  if (paused && document.activeElement === el) el.blur();
  const touch = document.documentElement.dataset.pointer === "coarse";
  el.placeholder =
    s.classroom.cost.state === "pause"
      ? "This month's AI budget is used up."
      : paused
        ? touch
          ? "Paused."
          : "Paused. Press Esc to resume."
        : live
          ? voice.canListen
            ? touch
              ? "Teach your next idea, or hold the mic and say it."
              : "Teach your next idea, or hold Space and say it."
            : "Teach your next idea. Keep it short."
          : "Class isn't running.";
});

export const lectern = {
  el,
  place(x: number, y: number, w: number, h: number, scale: number) {
    Object.assign(el.style, {
      display: "block",
      left: `${x}px`,
      top: `${y}px`,
      width: `${w}px`,
      height: `${h}px`,
      fontSize: `${Math.round(16 * scale)}px`,
    });
  },
  hide() {
    el.style.display = "none";
  },
  focus() {
    el.focus();
  },
  /** V7-06: the lectern's text came from my voice (then maybe edited). */
  takeSpoken(): boolean {
    const was = suggested !== null;
    suggested = null;
    return was;
  },
};
