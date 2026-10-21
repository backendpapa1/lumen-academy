import type * as Phaser from "phaser";
import { transcript } from "../ui/dom/transcript";
import { lectern } from "../ui/dom/lectern";
import { statsOverlay } from "../ui/dom/stats";
import { sound } from "./audio";
import { world } from "../world/anchors";
import { app } from "./app";
import { cycle, routeKey } from "./keys";
import { store } from "./store";

// Input routing (docs/05 §4.4). Keys: a global handler over routeKey().
// Pointer: Phaser sees every event first; ClassroomHud forwards the ones no
// HUD object handled here, and we raycast them into the Three.js world.

interface HudControls {
  toggleRoster(): void;
  /** Closes the concept menu or roster if open; true if it closed something. */
  closeTop(): boolean;
  readonly hasOpen: boolean;
}

const NOT_YET = {
  hyperfocus: "Hyperfocus mode isn't built yet. It comes with the P1 features.",
  notes: "Peeking at a cadet's notes isn't built yet. It comes with the P1 features.",
};

export function installKeyboard(game: Phaser.Game): void {
  window.addEventListener("keydown", (e) => {
    const st = store.getState();
    const c = st.classroom;
    if (st.route.name !== "classroom" || c.status !== "live" || e.isComposing) return;
    const active = document.activeElement;
    const hud = game.scene.isActive("classroomHud")
      ? (game.scene.getScene("classroomHud") as unknown as HudControls)
      : null;
    const action = routeKey({
      key: e.key,
      shift: e.shiftKey,
      focus:
        active === lectern.el
          ? "lectern"
          : active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
            ? "field"
            : null,
      lecternEmpty: lectern.el.value.trim() === "",
      somethingOpen: transcript.open || !!hud?.hasOpen,
      paused: c.clock.paused,
    });
    const queue = c.hands.map((h) => h.cadetId);
    switch (action.do) {
      case "none":
        return;
      case "focusLectern":
        lectern.focus();
        break;
      case "blur":
        (active as HTMLElement | null)?.blur();
        if (transcript.open && active !== lectern.el) transcript.toggle(false);
        break;
      case "cycleHands":
        if (!queue.length) return; // let Tab move focus normally
        app.select(cycle(queue, st.selectedId, action.dir));
        break;
      case "callSelected": {
        const id = st.selectedId && queue.includes(st.selectedId) ? st.selectedId : queue[0];
        if (!id) return;
        app.call(id);
        break;
      }
      case "callPosition": {
        const id = queue[action.index];
        if (id) app.call(id);
        break;
      }
      case "closeTop":
        if (!hud?.closeTop()) transcript.toggle(false);
        break;
      case "pause":
        app.pause();
        break;
      case "resume":
        app.resume();
        break;
      case "transcript":
        transcript.toggle();
        break;
      case "roster":
        hud?.toggleRoster();
        break;
      case "stats":
        statsOverlay.toggle();
        break;
      case "mute":
        app.notify(sound.toggleMute() ? "Sound off (M to turn it back on)." : "Sound on.");
        break;
      case "notYet":
        if (action.feature === "notes") void import("../ui/dom/notes").then((m) => m.toggleNotes());
        else if (action.feature === "hyperfocus")
          void import("./hyperfocus").then((m) => m.toggleHyperfocus());
        else app.notify(NOT_YET[action.feature]);
        break;
    }
    e.preventDefault();
  });
}

/** Pointer events no HUD object handled, in stage pixels. */
export const pointer = {
  move(x: number, y: number, canvas: HTMLCanvasElement) {
    const id = world.pick?.(x, y) ?? null;
    if (store.getState().hoveredId !== id) {
      store.setState({ hoveredId: id });
      canvas.style.cursor = id ? "pointer" : "";
    }
    world.pointer = { x, y };
  },
  /** The pointer is over the HUD (or left the stage): nothing in the world is hovered. */
  leave() {
    if (store.getState().hoveredId) store.setState({ hoveredId: null });
  },
  click(x: number, y: number) {
    const id = world.pick?.(x, y) ?? null;
    app.select(id);
    // Clicking a cadet with a raised hand calls on them, like their queue card.
    if (id && store.getState().classroom.hands.some((h) => h.cadetId === id)) app.call(id);
  },
};
