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
    app.teach(el.value);
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
      const text = await voice.stopRecording(cancel);
      if (!text) {
        if (!cancel) app.notify("I didn't catch that. Hold Space a little longer, or type it.");
        return;
      }
      if (voice.prefs.autoSend) app.teach(text);
      else {
        el.value = text;
        el.focus();
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
  el.placeholder =
    s.classroom.cost.state === "pause"
      ? "This month's AI budget is used up."
      : paused
        ? "Paused. Press Esc to resume."
        : live
          ? voice.canListen
            ? "Teach your next idea, or hold Space and say it."
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
};
