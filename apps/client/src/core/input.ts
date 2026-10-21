import type * as Phaser from "phaser";
import { transcript } from "../ui/dom/transcript";
import { lectern } from "../ui/dom/lectern";
import { app } from "./app";
import { store } from "./store";

// Global keyboard (docs/02 §3.4). While the lectern has focus it owns the keys,
// except Esc (leave the lectern) and Tab (cycle hands).

export function installKeyboard(game: Phaser.Game): void {
  window.addEventListener("keydown", (e) => {
    const c = store.getState().classroom;
    if (store.getState().route.name !== "classroom" || c.status !== "live") return;
    const inLectern = document.activeElement === lectern.el;
    const inField = inLectern || document.activeElement instanceof HTMLInputElement;
    if (inField && e.key !== "Tab") return;
    const hud = game.scene.getScene("classroomHud") as unknown as { toggleRoster(): void } | null;
    if (/^[1-9]$/.test(e.key)) {
      const h = c.hands[Number(e.key) - 1];
      if (h) app.call(h.cadetId);
    } else if (e.key === "`") {
      e.preventDefault();
      transcript.toggle();
    } else if (e.key.toLowerCase() === "r") {
      hud?.toggleRoster();
    } else if (e.key === "Enter") {
      e.preventDefault();
      lectern.focus();
    }
  });
}
