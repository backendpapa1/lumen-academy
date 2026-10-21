import { store } from "../../core/store";
import { rankInsignia } from "../screens/common";
import { fill, h } from "../screens/dom";

// The rank-up moment (M5-04): when a period promotes you, the new insignia
// arrives over the bell card. One click (or Esc) to carry on.

const root = h("div", { class: "rankup-back", hidden: true });
document.querySelector("#stage")!.append(root);
let shownFor: string | null = null;

function close() {
  root.hidden = true;
}

store.subscribe((s, p) => {
  const ended = s.classroom.ended;
  if (!ended || ended === p.classroom.ended || !ended.xp.rankedUp) return;
  const key = `${s.classroom.periodId}:${ended.xp.standing.rank}`;
  if (shownFor === key) return;
  shownFor = key;
  const rank = ended.xp.standing.rank;
  const src = rankInsignia(rank);
  root.hidden = false;
  fill(
    root,
    h(
      "section",
      {
        class: "card rankup",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": `New rank: ${rank}`,
      },
      src && h("img", { src, alt: "" }),
      h("div", { class: "micro" }, "New rank"),
      h("div", { class: "display" }, rank),
      h(
        "p",
        { class: "lede", style: "margin:0 auto 18px" },
        ended.xp.standing.next
          ? `${ended.xp.standing.total.toLocaleString()} XP. Next: ${ended.xp.standing.next.name} at ${ended.xp.standing.next.minXp.toLocaleString()}.`
          : `${ended.xp.standing.total.toLocaleString()} XP. The highest rank there is.`,
      ),
      h("button", { class: "btn primary", onclick: close }, "Carry on"),
    ),
  );
  root.querySelector<HTMLElement>("button")?.focus();
});
root.addEventListener("keydown", (e) => e.key === "Escape" && close());
