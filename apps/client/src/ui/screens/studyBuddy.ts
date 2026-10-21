import { api, ApiError } from "../../core/api";
import { app } from "../../core/app";
import { sound } from "../../core/audio";
import { lookFor, peepSvg } from "../peeps/peep";
import { fill, h } from "./dom";
import type { Classmate, ExplanationCheck } from "./studyTypes";

// A student from my class leans over while I read: "wait, so what's a Merkle
// root?" I answer in a line or two; the Explanation Coach checks it against the
// concept's key facts and the student says back what they got. The same check
// runs on a rehearsal ("practise explaining it") from a prep card.

interface Question {
  concept: { id: string; title: string };
  cadet: Classmate | null;
  text: string;
}

interface Explained {
  check: ExplanationCheck;
  keyFacts: string[];
  xp: number;
}

/** POST an explanation; renders the coach's answer into `out`. */
export async function explain(
  schoolId: string,
  out: HTMLElement,
  body: {
    conceptId: string;
    kind: "rehearse" | "answer";
    cadetId: string | null;
    question: string | null;
    text: string;
  },
  who: string,
): Promise<boolean> {
  fill(out, h("p", { class: "dim small" }, `${who} is thinking about what you said…`));
  try {
    const r = await api.post<Explained>(`/api/schools/${schoolId}/study/explain`, body);
    fill(out, checkView(r, who));
    if (r.xp) app.notify(`+${r.xp} XP for explaining it`);
    return true;
  } catch (e) {
    fill(out, h("p", { class: "error-text" }, e instanceof ApiError ? e.message : String(e)));
    return false;
  }
}

function checkView(r: Explained, who: string): HTMLElement {
  const c = r.check;
  const verdict = { clear: "Clear", partly: "Partly there", unclear: "Not yet" }[c.verdict];
  return h(
    "div",
    { class: `sh-check ${c.verdict}` },
    h("p", { class: "sh-reply" }, h("b", {}, `${who}: `), `“${c.studentReply}”`),
    h(
      "div",
      { class: "row", style: "gap:8px;flex-wrap:wrap" },
      h("span", { class: `chip verdict ${c.verdict}` }, verdict),
      h("span", { class: "dim small" }, `${c.covered.length} of ${r.keyFacts.length} key facts`),
    ),
    c.wrong && h("p", { class: "sh-wrong" }, h("b", {}, "Check this: "), c.wrong),
    c.missed.length > 0 &&
      h(
        "details",
        {},
        h("summary", {}, `What you left out (${c.missed.length})`),
        h("ul", {}, ...c.missed.map((f) => h("li", {}, f))),
      ),
    c.tip && h("p", { class: "dim small" }, h("b", {}, "Next time: "), c.tip),
  );
}

/** The bubble at the reader's corner (the caller places `el`). */
export function studyBuddy(schoolId: () => string | null) {
  const el = h("aside", { class: "sh-buddy card", hidden: true, "aria-live": "polite" });
  let open = false;

  const close = () => {
    open = false;
    el.hidden = true;
    fill(el);
  };

  const ask = async (around: string[]) => {
    const id = schoolId();
    if (!id || open) return;
    const r = await api
      .get<{ question: Question | null }>(
        `/api/schools/${id}/study/question?chunks=${encodeURIComponent(around.slice(0, 40).join(","))}`,
      )
      .catch(() => null);
    const q = r?.question;
    if (!q || open || schoolId() !== id) return;
    open = true;
    const who = q.cadet?.name ?? "The student at the next desk";
    const face = h("div", { class: "sh-buddy-face", "aria-hidden": "true" });
    face.innerHTML = peepSvg(
      lookFor(q.cadet?.id ?? "cdt_study_companion", q.cadet?.hair, q.cadet?.register as never),
      { pose: "hand", face: "Smile" },
    );
    const answer = h("textarea", {
      class: "field",
      rows: 3,
      maxlength: 3000,
      placeholder: "Answer in a line or two, in your own words.",
      "aria-label": `Your answer to ${who}`,
    }) as HTMLTextAreaElement;
    const out = h("div");
    const send = h("button", { class: "btn primary small" }, "Answer");
    send.addEventListener("click", async () => {
      if (answer.value.trim().length < 3) return answer.focus();
      send.disabled = true;
      answer.disabled = true;
      await explain(
        id,
        out,
        {
          conceptId: q.concept.id,
          kind: "answer",
          cadetId: q.cadet?.id ?? null,
          question: q.text,
          text: answer.value.trim(),
        },
        who,
      );
      fill(actions, h("button", { class: "btn small", onclick: close }, "Back to reading"));
    });
    const actions = h(
      "div",
      { class: "row", style: "gap:8px;margin-top:8px" },
      send,
      h("button", { class: "btn small quiet", onclick: close }, "Not now"),
    );
    fill(
      el,
      h(
        "div",
        { class: "sh-buddy-head" },
        face,
        h(
          "div",
          {},
          h("div", { class: "micro" }, `${who} leans over`),
          h("p", { class: "sh-buddy-q" }, q.text),
        ),
      ),
      answer,
      out,
      actions,
    );
    el.hidden = false;
    sound.cue("hand");
  };

  return { el, ask, isOpen: () => open, close };
}
