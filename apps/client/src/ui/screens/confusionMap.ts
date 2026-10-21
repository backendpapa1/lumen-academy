import { api } from "../../core/api";
import { fill, h } from "./dom";
import { openModal } from "./modal";

// Confusion map (V5-07): my explanations in one period as a timeline, each
// coloured by how many students it confused or cleared. Click a line for who.

interface Turn {
  ord: number;
  text: string;
  confused: string[];
  cleared: string[];
  fixed: number;
}

export function openConfusionMap(periodId: string) {
  const body = h("div", { class: "cmap" }, h("p", { class: "dim" }, "Reading the room…"));
  openModal("What confused them", body);
  api
    .get<Turn[]>(`/api/periods/${periodId}/confusion`)
    .then((turns) => {
      if (!turns.length)
        return fill(body, h("p", { class: "dim" }, "No explanations in this class yet."));
      const most = Math.max(1, ...turns.map((t) => Math.max(t.confused.length, t.cleared.length)));
      const worst = turns.reduce((a, t) => (t.confused.length > a.confused.length ? t : a));
      const best = turns.reduce((a, t) =>
        t.cleared.length + t.fixed > a.cleared.length + a.fixed ? t : a,
      );
      fill(
        body,
        h(
          "p",
          { class: "dim small", style: "margin-top:0" },
          "Each line is something you said. Red: students it left confused. Green: students it cleared up. Click one for who.",
        ),
        h(
          "ol",
          { class: "cmap-list" },
          ...turns.map((t) => {
            const who = h(
              "div",
              { class: "cmap-who", hidden: true },
              t.confused.length
                ? h("p", {}, h("b", {}, "Confused: "), t.confused.join(", "))
                : null,
              t.cleared.length ? h("p", {}, h("b", {}, "Cleared: "), t.cleared.join(", ")) : null,
              t.fixed ? h("p", {}, h("b", {}, "Mix-ups fixed: "), String(t.fixed)) : null,
              !t.confused.length && !t.cleared.length && !t.fixed
                ? h("p", { class: "dim" }, "Nobody changed much.")
                : null,
            );
            const tag =
              t === worst && t.confused.length
                ? "Most confusing"
                : t === best && (t.cleared.length || t.fixed)
                  ? "Clearest"
                  : "";
            return h(
              "li",
              {},
              h(
                "button",
                {
                  class: "cmap-row",
                  "aria-expanded": "false",
                  onclick: (e: Event) => {
                    who.hidden = !who.hidden;
                    (e.currentTarget as HTMLElement).setAttribute(
                      "aria-expanded",
                      String(!who.hidden),
                    );
                  },
                },
                h(
                  "span",
                  { class: "cmap-bars", "aria-hidden": "true" },
                  h("i", { class: "bad", style: `width:${(t.confused.length / most) * 100}%` }),
                  h("i", {
                    class: "good",
                    style: `width:${((t.cleared.length + t.fixed) / most) * 100}%`,
                  }),
                ),
                h(
                  "span",
                  { class: "cmap-text" },
                  t.text.length > 140 ? `${t.text.slice(0, 137)}…` : t.text,
                ),
                tag
                  ? h("span", { class: `chip ${tag === "Clearest" ? "good" : "bad"}` }, tag)
                  : null,
              ),
              who,
            );
          }),
        ),
      );
    })
    .catch((e: Error) => fill(body, h("p", { class: "error-text" }, e.message)));
}
