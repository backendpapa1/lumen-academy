import type { DebriefView } from "@lumen/shared";
import { api } from "../../core/api";
import { app } from "../../core/app";
import { fill, h, icon, ICONS } from "./dom";

// Debrief (E-4, E-5, M4-07): how the class did, concept by concept and cadet
// by cadet, what you under-taught (with where to look in the source), what you
// said that the source contradicts, and a re-teach plan; one click starts a
// focused period on a weak concept.

const pctOf = (x: number) => `${Math.round(x * 100)}%`;
const heat = (x: number) =>
  // red → amber → green, kept dark enough for white text
  x >= 0.7
    ? "rgba(74, 222, 128, 0.55)"
    : x >= 0.4
      ? "rgba(245, 198, 107, 0.5)"
      : "rgba(255, 92, 122, 0.5)";

export function mountDebrief(
  root: HTMLElement,
  examId: string,
  classroomId: string,
  schoolId: string,
): () => void {
  const wrap = h("div", { class: "wrap" }, h("p", { class: "dim" }, "Loading…"));
  root.append(wrap);
  api
    .get<DebriefView>(`/api/exams/${examId}/results`)
    .then((d) => {
      fill(wrap, ...view(d, classroomId, schoolId));
      // V5-06: where the misses really start.
      void api
        .get<
          Array<{
            conceptId: string;
            title: string;
            reason: string;
            because: Array<{ cadet: string; concept: string; where: string }>;
            path: string[];
          }>
        >(`/api/schools/${schoolId}/start-here`)
        .then((pins) => {
          if (!pins.length) return;
          wrap.append(
            h(
              "section",
              { class: "card pad start-here-card", "aria-label": "Start here" },
              h("div", { class: "micro" }, "Start here"),
              h(
                "p",
                { class: "dim small" },
                "Some misses start in an earlier concept. Fixing these first lifts the rest.",
              ),
              ...pins.slice(0, 4).map((p) =>
                h(
                  "div",
                  { class: "row", style: "gap:12px;margin-top:10px;align-items:flex-start" },
                  h(
                    "div",
                    { style: "flex:1;min-width:0" },
                    h("b", {}, p.title),
                    h("p", { class: "small", style: "margin:2px 0" }, p.reason),
                    h(
                      "p",
                      { class: "dim small", style: "margin:0" },
                      `${p.because
                        .slice(0, 3)
                        .map((x) => `${x.cadet}'s ${x.where} miss on ${x.concept}`)
                        .join(" · ")} · ${p.path.join(" → ")}`,
                    ),
                  ),
                  h(
                    "button",
                    {
                      class: "btn primary small",
                      onclick: () => app.reteach(classroomId, p.conceptId),
                    },
                    icon(ICONS.play),
                    "Teach this",
                  ),
                ),
              ),
            ),
          );
        })
        .catch(() => undefined);
    })
    .catch((e: Error) => fill(wrap, h("p", { class: "error-text" }, e.message)));
  return () => {};
}

function view(d: DebriefView, classroomId: string, schoolId: string): HTMLElement[] {
  const weak = d.concepts
    .filter((c) => c.score < d.passThreshold)
    .sort((a, b) => a.score - b.score);
  const reteach = (conceptId: string) =>
    h(
      "button",
      { class: "btn primary small", onclick: () => app.reteach(classroomId, conceptId) },
      icon(ICONS.play),
      "Re-teach",
    );
  return [
    h(
      "header",
      { class: "topbar" },
      h(
        "button",
        { class: "btn quiet", onclick: () => app.openDesk(schoolId, classroomId, "exams") },
        icon(ICONS.back),
        "Desk",
      ),
      h(
        "div",
        {},
        h("div", { class: "micro" }, "Debrief"),
        h("h1", { class: "display" }, d.moduleTitle),
        h(
          "div",
          { class: "row wrap-row" },
          h("span", { class: "big-num" }, pctOf(d.classAverage)),
          h(
            "span",
            { class: `chip ${d.passed ? "ok" : "err"}` },
            h("span", { class: "dot" }),
            d.passed ? "Passed" : `Below the ${pctOf(d.passThreshold)} pass mark`,
          ),
          d.xpEarned > 0 && h("span", { class: "chip gold" }, `+${d.xpEarned} XP`),
          d.openBook &&
            h(
              "span",
              {
                class: "chip",
                title: "You checked your sources (/source) within the hour before this exam.",
              },
              "Open-book",
            ),
        ),
      ),
    ),
    d.graduated
      ? h(
          "section",
          { class: "card debrief-grad" },
          h("div", { class: "micro" }, "Graduation"),
          h("div", { class: "h2", style: "color:var(--aurum)" }, "This class has graduated."),
          h(
            "p",
            { class: "dim", style: "margin:4px 0 0" },
            "Every module passed. Your students graduate, and the School's building grows.",
          ),
        )
      : h("span"),
    d.analysis
      ? h(
          "section",
          { class: "two-col" },
          h(
            "div",
            { class: "card pad" },
            h("div", { class: "micro" }, "What landed"),
            h("ul", { class: "plain" }, ...d.analysis.strengths.map((s) => h("li", {}, s))),
          ),
          h(
            "div",
            { class: "card pad" },
            h("div", { class: "micro" }, "What your class needs"),
            h("ul", { class: "plain" }, ...d.analysis.gaps.map((s) => h("li", {}, s))),
          ),
        )
      : h("span"),
    d.analysis?.plan.length
      ? h(
          "section",
          { class: "card pad", style: "margin-top:20px" },
          h("div", { class: "h2" }, "Re-teach plan"),
          h(
            "ol",
            { class: "plan" },
            ...d.analysis.plan.map((p) => {
              const c = d.concepts.find((x) => x.conceptId === p.conceptId);
              return h(
                "li",
                {},
                h(
                  "div",
                  { class: "row" },
                  h("div", {}, h("b", {}, c?.title ?? ""), h("div", { class: "dim" }, p.step)),
                  h("span", { class: "spacer" }),
                  reteach(p.conceptId),
                ),
              );
            }),
          ),
        )
      : h("span"),
    h("h2", { class: "h2", style: "margin:28px 0 12px" }, "Concept by concept"),
    h(
      "div",
      { class: "card" },
      ...d.concepts.map((c) =>
        h(
          "div",
          { class: "source-row concept-result", style: "align-items:flex-start" },
          h(
            "div",
            { style: "flex:1;min-width:0" },
            h(
              "div",
              { class: "row wrap-row" },
              h("b", {}, c.title),
              c.underTaught && h("span", { class: "chip err" }, "Under-taught"),
              c.score >= d.passThreshold && h("span", { class: "chip ok" }, "Solid"),
            ),
            h(
              "div",
              { class: "mono" },
              `${pctOf(c.score)} on the exam · ${c.turns.toFixed(1)} teaching turns per student`,
            ),
            h(
              "div",
              { class: "progress", style: "width:100%;margin:8px 0" },
              h("span", { style: `width:${pctOf(c.score)};background:${heat(c.score)}` }),
            ),
            c.score < d.passThreshold &&
              c.references.length > 0 &&
              h(
                "details",
                {},
                h("summary", { class: "dim" }, "Where the source covers it"),
                ...c.references.map((r) =>
                  h("blockquote", {}, h("div", { class: "mono" }, r.where), r.excerpt + "…"),
                ),
              ),
          ),
          c.score < d.passThreshold ? reteach(c.conceptId) : null,
        ),
      ),
    ),
    h("h2", { class: "h2", style: "margin:28px 0 12px" }, "Who got what"),
    heatmap(d),
    h(
      "h2",
      { class: "h2", style: "margin:28px 0 12px" },
      "Things you said that the source contradicts",
    ),
    d.teacherErrors.length
      ? h(
          "div",
          { class: "card" },
          ...d.teacherErrors.map((e) =>
            h(
              "div",
              { class: "source-row", style: "align-items:flex-start" },
              h(
                "div",
                {},
                h("div", {}, `You said: “${e.claim}”`),
                h("div", { class: "dim" }, `The source: ${e.correction}`),
                e.conceptTitle && h("div", { class: "mono" }, e.conceptTitle),
              ),
            ),
          ),
        )
      : h(
          "div",
          { class: "card empty" },
          "Nothing. Everything you taught in this module matched the source.",
        ),
    weak.length
      ? h(
          "p",
          { class: "dim", style: "margin-top:20px" },
          `Weak concepts are now marked "Needs a recap" on your Curriculum map.`,
        )
      : h("span"),
  ];
}

function heatmap(d: DebriefView): HTMLElement {
  const table = h("table", { class: "heat" });
  table.append(
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        h("th", { scope: "col" }, "Student"),
        ...d.concepts.map((c) => h("th", { scope: "col", title: c.title }, c.title)),
      ),
    ),
    h(
      "tbody",
      {},
      ...d.heatmap.map((row) =>
        h(
          "tr",
          {},
          h("th", { scope: "row" }, row.name),
          ...d.concepts.map((c) => {
            const x = row.scores[c.conceptId] ?? 0;
            return h(
              "td",
              {
                style: `background:${heat(x)}`,
                "aria-label": `${row.name}, ${c.title}: ${pctOf(x)}`,
              },
              pctOf(x),
            );
          }),
        ),
      ),
    ),
  );
  return h("div", { class: "card heat-wrap" }, table);
}
