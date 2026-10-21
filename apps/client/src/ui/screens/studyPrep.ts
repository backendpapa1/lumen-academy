import { api } from "../../core/api";
import { app } from "../../core/app";
import { fill, h } from "./dom";
import { explain } from "./studyBuddy";
import {
  SHOW_PASSAGE,
  type ClassPrep,
  type Lookup,
  type Passage,
  type ShowPassage,
  type StudyConcept,
  type StudyData,
} from "./studyTypes";

// Prepare for the next class: the concept each class meets next, the
// passages it was built from (one tap opens them in the reader), a rehearsal
// of my explanation, checked like a dress rehearsal, and what to look up first
// (questions I left hanging, my mistakes, what students believe wrongly).

const WHY: Record<ClassPrep["why"], string> = {
  current: "is on",
  next: "meets next",
  weak: "is weakest on",
};

const show = (p: Passage) =>
  document.dispatchEvent(
    new CustomEvent<ShowPassage>(SHOW_PASSAGE, {
      detail: { sourceId: p.sourceId, chunkId: p.chunkId },
    }),
  );

export function prepPanel(d: StudyData, focusConceptId?: string): HTMLElement {
  const el = h("div", { class: "sh-prep" });
  const focus = h("div");
  if (focusConceptId) {
    // From "What I know" → "Study it": that concept first.
    api
      .get<{ concept: StudyConcept; passages: Passage[] }>(
        `/api/schools/${d.school.id}/study/concepts/${focusConceptId}`,
      )
      .then((r) =>
        fill(focus, conceptCard(d.school.id, "Studying", r.concept, r.passages, null, true)),
      )
      .catch(() => undefined);
  }
  const classes = d.prep.map((p) =>
    conceptCard(
      d.school.id,
      `${p.classroomName} ${WHY[p.why]}`,
      p.concept,
      p.passages,
      p.studied,
      !focusConceptId && p === d.prep[0],
    ),
  );
  fill(
    el,
    focus,
    ...classes,
    !d.prep.length &&
      !focusConceptId &&
      h(
        "p",
        { class: "dim small" },
        "Open a class in this School and its next concept shows here, with the passages to read first.",
      ),
    lookupList(d),
  );
  return el;
}

function conceptCard(
  schoolId: string,
  heading: string,
  c: StudyConcept,
  passages: Passage[],
  studied: ClassPrep["studied"] | null,
  openFirst: boolean,
): HTMLElement {
  const out = h("div");
  const area = h("textarea", {
    class: "field",
    rows: 4,
    maxlength: 3000,
    placeholder: `Explain ${c.title} as you would to the class: what it is, why it matters, an example.`,
    "aria-label": `Your explanation of ${c.title}`,
  }) as HTMLTextAreaElement;
  const check = h("button", { class: "btn small primary" }, "Check my explanation");
  check.addEventListener("click", async () => {
    if (area.value.trim().length < 3) return area.focus();
    check.disabled = true;
    await explain(
      schoolId,
      out,
      { conceptId: c.id, kind: "rehearse", cadetId: null, question: null, text: area.value.trim() },
      "A student hearing it",
    );
    check.disabled = false;
    check.textContent = "Check again";
  });
  return h(
    "details",
    { class: "card pad sh-prep-card", ...(openFirst ? { open: true } : {}) },
    h(
      "summary",
      {},
      h("div", { class: "micro" }, heading),
      h("div", { class: "h2 sh-prep-title" }, c.title),
      studied &&
        studied.quotes + studied.explanations > 0 &&
        h(
          "span",
          { class: "chip" },
          `studied: ${studied.quotes} quote${studied.quotes === 1 ? "" : "s"}, ${studied.explanations} explanation${studied.explanations === 1 ? "" : "s"}`,
        ),
    ),
    h("p", { class: "small", style: "margin:6px 0" }, c.summary),
    passages.length > 0 &&
      h(
        "div",
        { class: "sh-passages" },
        h("div", { class: "micro" }, "Read first"),
        ...passages.map((p) =>
          h(
            "button",
            { class: "sh-passage", onclick: () => show(p) },
            h(
              "span",
              { class: "mono small" },
              [p.sourceTitle, p.heading, p.page ? `p. ${p.page}` : null]
                .filter(Boolean)
                .join(" · "),
            ),
            h("span", { class: "small" }, p.excerpt),
          ),
        ),
      ),
    c.misconceptions.length > 0 &&
      h(
        "p",
        { class: "dim small" },
        h("b", {}, "Students may think: "),
        c.misconceptions.slice(0, 2).join(" · "),
      ),
    h("div", { class: "micro", style: "margin-top:10px" }, "Practise explaining it"),
    area,
    h("div", { class: "row", style: "margin-top:6px" }, check),
    out,
  );
}

function lookupList(d: StudyData): HTMLElement | null {
  if (!d.lookups.length) return null;
  const list = h("div", { class: "sh-lookups" });
  const label: Record<Lookup["kind"], string> = {
    question: "Asked in class, never answered",
    mistake: "Something you got wrong",
    misconception: "Your class believes",
  };
  const row = (l: Lookup): HTMLElement => {
    const item = h(
      "div",
      { class: `sh-lookup ${l.kind}` },
      h(
        "div",
        { class: "micro" },
        label[l.kind],
        l.who && l.kind === "question" ? ` · ${l.who}` : "",
      ),
      h("p", { style: "margin:4px 0" }, l.text),
      l.kind === "misconception" && l.who && h("div", { class: "dim small" }, l.who),
      h(
        "div",
        { class: "row", style: "gap:8px" },
        l.conceptId &&
          h(
            "button",
            {
              class: "btn small quiet",
              onclick: () =>
                api
                  .get<{ passages: Passage[] }>(
                    `/api/schools/${d.school.id}/study/concepts/${l.conceptId}`,
                  )
                  .then((r) =>
                    r.passages[0]
                      ? show(r.passages[0])
                      : app.notify("No passage is cited for that concept."),
                  )
                  .catch((e: Error) => app.notify(e.message, "error")),
            },
            `Read about ${l.conceptTitle ?? "it"}`,
          ),
        h(
          "button",
          {
            class: "btn small",
            onclick: () =>
              api
                .post(`/api/schools/${d.school.id}/study/lookups/${encodeURIComponent(l.id)}/done`)
                .then(() => {
                  item.remove();
                  app.notify(
                    l.kind === "question"
                      ? "Looked up. Tell the class next time: “I found out what you asked me.”"
                      : "Looked up.",
                  );
                })
                .catch((e: Error) => app.notify(e.message, "error")),
          },
          "Looked it up ✓",
        ),
      ),
    );
    return item;
  };
  fill(list, h("h3", { class: "h2 sh-lookups-h" }, "Look up before class"), ...d.lookups.map(row));
  return list;
}
