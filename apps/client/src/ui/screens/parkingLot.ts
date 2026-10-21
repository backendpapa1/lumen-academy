import { api } from "../../core/api";
import { app } from "../../core/app";
import type { ParkedItem } from "../../core/classroom";
import { store } from "../../core/store";
import { fill, h } from "./dom";

// The parking lot outside class (V3-04): open thoughts to sort, and the notes
// I kept. Used on the School's "What I know" tab and in the Study hall, where
// a new thought can be filed too.

export function parkingLot(
  schoolId: string,
  opts: { add?: boolean; title?: string } = {},
): HTMLElement {
  const list = h("div", { class: "lot-list" });
  const el = h(
    "section",
    { class: "card pad lot", "aria-label": "Parking lot" },
    h("div", { class: "micro" }, opts.title ?? "Parking lot"),
  );
  if (opts.add) {
    const input = h("input", {
      class: "field",
      placeholder: "A stray thought… (Enter parks it)",
      "aria-label": "Park a thought",
      maxlength: 500,
    });
    input.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter" || !input.value.trim()) return;
      e.preventDefault();
      await api.post(`/api/schools/${schoolId}/parking`, { text: input.value.trim() });
      input.value = "";
      void load();
    });
    el.append(input);
  }
  el.append(list);

  const act = async (p: ParkedItem, status: ParkedItem["status"]) => {
    try {
      await api.patch(`/api/parking/${p.id}`, { status });
    } catch (e) {
      return app.notify((e as Error).message, "error");
    }
    if (status === "concept")
      store.setState({
        route: { name: "school", schoolId, tab: "curriculum", newConcept: p.text },
      });
    else void load();
  };

  const load = async () => {
    const items = (
      await api.get<ParkedItem[]>(`/api/schools/${schoolId}/parking?status=all`)
    ).filter((p) => p.status === "open" || p.status === "kept");
    if (!items.length) {
      fill(
        list,
        h(
          "p",
          { class: "dim small" },
          "Nothing parked. In class, press P (or type /park …) to file a stray thought without losing the thread.",
        ),
      );
      return;
    }
    fill(
      list,
      ...items.map((p) =>
        h(
          "div",
          { class: `parked-item ${p.status}` },
          h("p", {}, p.text),
          h(
            "div",
            { class: "row" },
            p.status === "open" &&
              h("button", { class: "btn small", onclick: () => act(p, "kept") }, "Keep as a note"),
            h(
              "button",
              { class: "btn small", onclick: () => act(p, "concept") },
              "Make it a concept",
            ),
            h(
              "button",
              { class: "btn small quiet", onclick: () => act(p, "dismissed") },
              p.status === "kept" ? "Done with it" : "Let it go",
            ),
            p.status === "kept" && h("span", { class: "mono small dim" }, "Kept"),
          ),
        ),
      ),
    );
  };
  void load().catch((e: Error) => fill(list, h("p", { class: "error-text" }, e.message)));
  return el;
}
