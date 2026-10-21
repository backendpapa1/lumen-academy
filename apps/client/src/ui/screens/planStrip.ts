import { api, ApiError } from "../../core/api";
import { app } from "../../core/app";
import { store } from "../../core/store";
import { fill, h, icon, ICONS } from "./dom";

// Goal-shaped plan (V6-07): "I have an exam on Friday" as a strip of days,
// each with the concepts to teach that day, in prerequisite order. Today's
// first concept is one click away.

interface PlanConcept {
  id: string;
  title: string;
  status: string;
  minutes: number;
}
interface Plan {
  examDate: string;
  daysLeft: number;
  days: Array<{ date: string; label: string; concepts: PlanConcept[]; minutes: number }>;
  perDay: number;
  done: number;
}

export function planStrip(schoolId: string): HTMLElement {
  const el = h("section", { class: "card pad plan", "aria-label": "Exam plan" });

  const ask = (err = "") => {
    const input = h("input", {
      class: "field",
      id: "plan-when",
      placeholder: "Friday, in 5 days, or a date",
      "aria-label": "When is the exam?",
    });
    const set = h("button", { class: "btn", type: "submit" }, "Plan it");
    const form = h(
      "form",
      { class: "row plan-ask", style: "gap:10px;flex-wrap:wrap" },
      h("b", { class: "micro" }, "Exam coming up?"),
      input,
      set,
      h("span", { class: "error-text", role: "alert" }, err),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      set.disabled = true;
      api
        .put<{ plan: Plan | null }>(`/api/schools/${schoolId}/goal`, { when: input.value })
        .then((r) => (r.plan ? show(r.plan) : ask()))
        .catch((e: unknown) => ask(e instanceof ApiError ? e.message : String(e)));
    });
    fill(el, form);
  };

  const show = (p: Plan) => {
    const room = store.getState().setup.school?.classrooms.find((c) => c.status === "active");
    const when = new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    }).format(new Date(p.examDate));
    const first = p.days[0]?.concepts[0];
    fill(
      el,
      h(
        "div",
        { class: "row", style: "gap:12px;flex-wrap:wrap;align-items:baseline" },
        h("div", { class: "micro" }, "Exam plan"),
        h(
          "b",
          {},
          `${when} · ${p.daysLeft === 0 ? "today" : `${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"} to go`}`,
        ),
        h(
          "span",
          { class: `dim small ${p.perDay > 60 ? "warn" : ""}` },
          `about ${p.perDay} min a day${p.perDay > 60 ? ": a lot; micro-lessons help" : ""}${p.done ? ` · ${p.done} mastered already` : ""}`,
        ),
        h("span", { class: "spacer" }),
        first &&
          room &&
          h(
            "button",
            {
              class: "btn primary small",
              onclick: () => app.startClass(room.id, { conceptId: first.id }),
            },
            icon(ICONS.play),
            `Teach today's: ${first.title}`,
          ),
        h(
          "button",
          {
            class: "btn quiet small",
            onclick: () =>
              void api.put(`/api/schools/${schoolId}/goal`, { when: null }).then(() => ask()),
          },
          "Clear",
        ),
      ),
      h(
        "ol",
        { class: "plan-days" },
        ...p.days.map((d, i) =>
          h(
            "li",
            { class: `plan-day${i === 0 ? " today" : ""}` },
            h("div", { class: "micro" }, d.label),
            h("div", { class: "mono small dim" }, `${d.minutes} min`),
            ...d.concepts.map((c) =>
              h(
                "span",
                { class: `plan-chip ${c.status}`, title: `${c.status} · about ${c.minutes} min` },
                c.title,
              ),
            ),
            !d.concepts.length && h("span", { class: "dim small" }, "Review"),
          ),
        ),
      ),
    );
  };

  void api
    .get<{ plan: Plan | null }>(`/api/schools/${schoolId}/plan`)
    .then((r) => (r.plan ? show(r.plan) : ask()))
    .catch(() => ask());
  return el;
}
