import { rhythm } from "../../core/rhythm";
import { h } from "./dom";
import { openModal } from "./modal";

// Energy check-in (V3-02, VD7): one tap, optional, never a nag. Low offers a
// micro-lesson first; "Don't ask me" turns it off for good (Settings brings it
// back). Esc cancels the class; Skip starts it without saying.

export type Energy = "low" | "ok" | "high";
export interface CheckIn {
  energy?: Energy;
  /** Low energy took the micro-lesson offer. */
  micro?: boolean;
}

export function energyCheckIn(opts: { micro: boolean }): Promise<CheckIn | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: CheckIn | null) => {
      settled = true;
      resolve(v);
      close();
    };
    const choice = (energy: Energy, label: string, hint: string, key: string) =>
      h(
        "button",
        {
          class: `btn energy ${energy}`,
          "data-energy": energy,
          onclick: () => (energy === "low" && !opts.micro ? offerMicro() : done({ energy })),
        },
        h("span", { class: "energy-meter", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
        h("b", {}, label),
        h("span", { class: "dim small" }, hint),
        h("kbd", {}, key),
      );
    const choices = h(
      "div",
      { class: "energy-row", role: "group", "aria-label": "Energy" },
      choice("low", "Low", "Gentle, short questions, no surprises", "1"),
      choice("ok", "OK", "A normal class", "2"),
      choice("high", "High", "Sharp: Hyperfocus on offer", "3"),
    );
    const body = h(
      "div",
      { class: "checkin" },
      h("p", { class: "dim", style: "margin-top:0" }, "One tap. It sets the tone of the class."),
      choices,
      h(
        "div",
        { class: "actions" },
        h(
          "button",
          {
            class: "btn quiet small",
            onclick: () => {
              rhythm.set({ checkIn: false });
              done({});
            },
          },
          "Don't ask me again",
        ),
        h("button", { class: "btn quiet", onclick: () => done({}) }, "Skip"),
      ),
    );
    const offerMicro = () =>
      body.replaceChildren(
        h(
          "p",
          { class: "dim", style: "margin-top:0" },
          "Low days count too. One idea, one student, three minutes, and it keeps your streak.",
        ),
        h(
          "div",
          { class: "actions" },
          h(
            "button",
            { class: "btn quiet", onclick: () => done({ energy: "low" }) },
            "A full class, gently",
          ),
          h(
            "button",
            { class: "btn primary", onclick: () => done({ energy: "low", micro: true }) },
            "Micro-lesson · 3 min",
          ),
        ),
      );
    const onKey = (e: KeyboardEvent) => {
      if (!body.contains(choices)) return;
      const i = ["1", "2", "3"].indexOf(e.key);
      if (i < 0) return;
      e.preventDefault();
      choices.querySelectorAll<HTMLButtonElement>("button")[i]!.click();
    };
    document.addEventListener("keydown", onKey, true);
    const close = openModal("How's your energy?", body, {
      onClose: () => {
        document.removeEventListener("keydown", onKey, true);
        if (!settled) resolve(null);
      },
    });
    // The primary action after a tap is the focused one (Enter works).
    queueMicrotask(() => choices.querySelector<HTMLButtonElement>('[data-energy="ok"]')?.focus());
  });
}
