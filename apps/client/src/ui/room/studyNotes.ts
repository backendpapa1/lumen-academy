import { api } from "../../core/api";
import { openModal } from "../screens/modal";
import { h } from "../screens/dom";

// In class, beside the concept: what I quoted and wrote about it in the study
// hall. Only for me (it's my preparation); students never see it.

interface ConceptNotes {
  quotes: Array<{ id: string; text: string; page: number | null; source: string | null }>;
  explanations: Array<{ id: string; kind: string; question: string | null; text: string }>;
}

/** A chip that appears when the current concept has study notes. */
export function studyNotesChip(): {
  el: HTMLElement;
  show: (schoolId?: string, conceptId?: string) => void;
} {
  const el = h("button", {
    class: "chip study-notes",
    hidden: true,
    title: "What you prepared for this in the study hall",
  });
  let key = "";
  let notes: ConceptNotes | null = null;
  let title = "";
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!notes) return;
    openModal(
      `Your study notes: ${title}`,
      h(
        "div",
        { class: "stack study-notes-body" },
        ...notes.explanations
          .slice(0, 2)
          .map((x) =>
            h(
              "div",
              { class: "card pad" },
              h(
                "div",
                { class: "micro" },
                x.kind === "answer" ? `You answered: ${x.question ?? ""}` : "Your rehearsal",
              ),
              h("p", { style: "margin:6px 0 0" }, x.text),
            ),
          ),
        ...notes.quotes
          .slice(0, 5)
          .map((q) =>
            h(
              "blockquote",
              {},
              q.text,
              h(
                "div",
                { class: "dim small" },
                [q.source, q.page ? `p. ${q.page}` : null].filter(Boolean).join(", "),
              ),
            ),
          ),
      ),
    );
  });
  return {
    el,
    show(schoolId, conceptId) {
      const k = `${schoolId}|${conceptId}`;
      if (k === key) return;
      key = k;
      notes = null;
      el.hidden = true;
      if (!schoolId || !conceptId) return;
      void api
        .get<ConceptNotes & { concept: { title: string } | null }>(
          `/api/schools/${schoolId}/study/concepts/${conceptId}?ifAny=1`,
        )
        .then((r) => {
          if (key !== k) return;
          const n = r.quotes.length + r.explanations.length;
          if (!n || !r.concept) return;
          notes = r;
          title = r.concept.title;
          el.textContent = `Your study notes (${n})`;
          el.hidden = false;
        })
        .catch(() => undefined);
    },
  };
}
