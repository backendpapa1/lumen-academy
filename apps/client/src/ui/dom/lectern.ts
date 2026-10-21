import { app } from "../../core/app";
import { store } from "../../core/store";
import "./overlay.css";

// The lectern: a real <textarea> (IME, paste, selection, accessibility) that
// Phaser frames and positions (docs/05 §1). Enter sends, Shift+Enter is a newline.

const el = document.createElement("textarea");
el.id = "lectern";
el.rows = 2;
el.placeholder = "Teach your next idea. Keep it short.";
el.setAttribute("aria-label", "Teach the class");
document.querySelector("#stage")!.appendChild(el);

el.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    app.teach(el.value);
    el.value = "";
  } else if (e.key === "Escape") {
    el.blur();
  }
});

store.subscribe((s) => {
  const live = s.classroom.status === "live";
  el.disabled = !live;
  el.placeholder =
    s.classroom.cost.state === "pause"
      ? "This month's AI budget is used up."
      : live
        ? "Teach your next idea. Keep it short."
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
