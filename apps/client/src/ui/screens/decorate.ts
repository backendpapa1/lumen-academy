import { UPGRADES, type UpgradeItem } from "@lumen/shared";
import { api, ApiError } from "../../core/api";
import { fill, h } from "./dom";
import { openModal } from "./modal";

// Decorate a classroom (V7-01): your rank gives you slots; fill them with what
// you'd like to see while you teach. The class notices new things next time.

interface State {
  slots: number;
  rank: string;
  chosen: UpgradeItem[];
}

export function openDecorate(classroomId: string, className: string) {
  const body = h("div", { class: "decorate" }, h("p", { class: "dim" }, "Loading…"));
  openModal(`Decorate ${className}`, body);
  const render = (s: State, err = "") => {
    const free = s.slots - s.chosen.length;
    fill(
      body,
      h(
        "p",
        { class: "dim", style: "margin-top:0" },
        `${s.rank}: ${s.slots} slot${s.slots === 1 ? "" : "s"}, ${free} free. Rank up for more.`,
      ),
      err && h("p", { class: "error-text", role: "alert" }, err),
      h(
        "div",
        { class: "deco-grid" },
        ...UPGRADES.map((u) => {
          const on = s.chosen.includes(u.item);
          return h(
            "button",
            {
              class: `btn deco-card${on ? " on" : ""}`,
              "aria-pressed": String(on),
              disabled: !on && free <= 0,
              onclick: () => {
                const req = on
                  ? api.del<State>(`/api/classrooms/${classroomId}/upgrades/${u.item}`)
                  : api.put<State>(`/api/classrooms/${classroomId}/upgrades/${u.item}`, {});
                req
                  .then((x) => render(x))
                  .catch((e: unknown) => render(s, e instanceof ApiError ? e.message : String(e)));
              },
            },
            h("b", {}, u.label),
            h("span", { class: "dim small" }, u.blurb),
            h(
              "span",
              { class: "mono small" },
              on ? "In the room · click to remove" : free > 0 ? "Add" : "No free slot",
            ),
          );
        }),
      ),
    );
  };
  api
    .get<State>(`/api/classrooms/${classroomId}/upgrades`)
    .then((s) => render(s))
    .catch((e: Error) => fill(body, h("p", { class: "error-text" }, e.message)));
}
