import { MODES, type PeriodKind } from "@lumen/shared";
import { app } from "../../core/app";
import { store } from "../../core/store";
import { h } from "./dom";
import { openModal } from "./modal";

// V5-01: how do I want to teach this time? One card per mode, Lecture first.
// Number keys pick; Enter takes the focused one.

export function openModePicker(classroomId: string, conceptId?: string) {
  const on = store.getState().setup.campus?.modes ?? MODES.map((m) => m.kind);
  const modes = MODES.filter((m) => on.includes(m.kind));
  let close = () => {};
  const pick = (kind: PeriodKind) => {
    close();
    app.startClass(classroomId, { ...(conceptId ? { conceptId } : {}), kind });
  };
  const grid = h(
    "div",
    { class: "mode-grid", role: "list" },
    ...modes.map((m, i) =>
      h(
        "button",
        { class: `btn mode-card ${m.kind}`, role: "listitem", onclick: () => pick(m.kind) },
        h("kbd", {}, String(i + 1)),
        h("b", {}, m.label),
        h("span", { class: "dim small" }, m.blurb),
        h(
          "span",
          { class: "mono small trains" },
          `${m.trains}${m.minutes ? ` · ${m.minutes} min` : ""}`,
        ),
      ),
    ),
  );
  const onKey = (e: KeyboardEvent) => {
    const i = Number(e.key) - 1;
    if (Number.isInteger(i) && modes[i]) {
      e.preventDefault();
      pick(modes[i]!.kind);
    }
  };
  document.addEventListener("keydown", onKey, true);
  close = openModal("How do you want to teach?", grid, {
    onClose: () => document.removeEventListener("keydown", onKey, true),
  });
}
