import {
  ARCHETYPE_INFO,
  type CadetView,
  type QuestionView,
  type ServerMessage,
} from "@lumen/shared";
import { api } from "../../core/api";
import { app } from "../../core/app";
import { serverEvents } from "../../core/bus";
import { store } from "../../core/store";
import { withArena } from "../../world/anchors";
import { fill, h, icon, ICONS } from "./dom";

// Exam arena (E-3, M4-06, M6-09): the class sits the exam in the 3D arena
// (world/scenes/ArenaScene). Each graded answer lands as it's marked: a beam
// from the cadet's terminal locks green or shatters red, Class Integrity fills
// the floor ring, and the question card turns as the exam goes on. This DOM
// layer carries the readable text: the question, the meter, the answer rail.

interface ExamInfo {
  id: string;
  moduleTitle: string;
  status: "generating" | "ready" | "running" | "done";
  passThreshold: number;
  classAverage: number | null;
  questions: Array<
    Pick<QuestionView, "id" | "ord" | "kind" | "prompt" | "options" | "conceptTitle">
  >;
  results: Array<{ questionId: string; cadetId: string; score: number }>;
}

export function mountArena(
  root: HTMLElement,
  examId: string,
  classroomId: string,
  schoolId: string,
): () => void {
  root.classList.add("arena");
  const top = h("div", { class: "arena-top" });
  const card = h("div", { class: "arena-card card" });
  const rail = h("div", { class: "arena-rail card" });
  const end = h("div", { class: "stinger", hidden: true });
  root.append(top, card, rail, end);
  let exam: ExamInfo | null = null;
  let cadets: CadetView[] = [];
  const scores = new Map<string, number>(); // `${questionId}|${cadetId}`
  let integrity = 0;
  let currentOrd = 1;
  let finished = false;

  const render = () => {
    if (!exam) return;
    // The final class average is the last word on integrity.
    if (exam.status === "done" && exam.classAverage != null) integrity = exam.classAverage;
    const pct = Math.round(integrity * 100);
    const pass = Math.round(exam.passThreshold * 100);
    fill(
      top,
      h("div", { class: "micro" }, "Module exam"),
      h("h1", { class: "display" }, exam.moduleTitle),
      h(
        "div",
        {
          class: "integrity",
          role: "meter",
          "aria-label": "Class integrity",
          "aria-valuenow": pct,
          "aria-valuemin": 0,
          "aria-valuemax": 100,
        },
        h("span", {
          class: "fill",
          style: `width:${pct}%;background:${integrity >= exam.passThreshold ? "var(--aurum)" : "var(--lumen)"}`,
        }),
        h("i", { style: `left:${pass}%`, title: `Pass mark ${pass}%` }),
      ),
      h("div", { class: "mono" }, `Class integrity ${pct}% · pass ${pass}%`),
    );
    const q = exam.questions.find((x) => x.ord === currentOrd) ?? exam.questions.at(-1);
    if (q && card.dataset.q !== q.id) {
      card.dataset.q = q.id;
      card.classList.remove("flip");
      void card.offsetWidth; // restart the flip
      card.classList.add("flip");
      const kind =
        q.kind === "mcq"
          ? "Multiple choice"
          : q.kind === "eli10"
            ? "Explain like I'm 10"
            : "Short answer";
      const total = exam.questions.length;
      withArena((a) => a.setQuestion(q.ord, total, q.conceptTitle, kind));
      fill(
        card,
        h(
          "div",
          { class: "row" },
          h("span", { class: "micro" }, `Question ${q.ord} of ${total}`),
          h("span", { class: "spacer" }),
          h("span", { class: "chip" }, kind),
        ),
        h("div", { class: "h2", style: "margin:8px 0 6px" }, q.prompt),
        q.options && h("ol", { class: "opts", type: "A" }, ...q.options.map((o) => h("li", {}, o))),
        h("div", { class: "dim", style: "font-size:13px;margin-top:6px" }, q.conceptTitle),
      );
    }
    fill(
      rail,
      h("div", { class: "micro", style: "margin-bottom:8px" }, "Answers"),
      ...cadets.map((c) =>
        h(
          "div",
          { class: "arena-cadet" },
          h("span", { class: "dot", style: `background:${ARCHETYPE_INFO[c.archetype].accent}` }),
          h("span", { class: "name" }, c.name.split(" ")[0]),
          h(
            "span",
            { class: "ticks" },
            ...exam!.questions.map((qq) => {
              const s = scores.get(`${qq.id}|${c.id}`);
              return h("i", {
                class: s === undefined ? "" : s >= 0.6 ? "ok" : s >= 0.3 ? "mid" : "bad",
                title: s === undefined ? "" : `${Math.round(s * 100)}%`,
              });
            }),
          ),
        ),
      ),
    );
    if (exam.status === "done") {
      const avg = exam.classAverage ?? integrity;
      const passed = avg >= exam.passThreshold;
      if (!finished) {
        finished = true;
        // The arena pushes in on the card first; the stinger follows the reveal.
        withArena((a) => a.finish(avg, passed));
      }
      end.hidden = false;
      root.classList.add("done");
      fill(
        end,
        h("div", { class: "micro" }, exam.moduleTitle),
        h("div", { class: "display" }, `${Math.round(avg * 100)}%`),
        h(
          "p",
          { class: "lede", style: "margin:0 auto 18px" },
          passed
            ? "Passed. Your class understood this module."
            : "Not yet. The debrief shows what to re-teach.",
        ),
        h(
          "button",
          {
            class: "btn primary",
            onclick: () =>
              store.setState({ route: { name: "debrief", examId, classroomId, schoolId } }),
          },
          "See the debrief",
        ),
      );
    }
  };

  const onMessage = (m: ServerMessage) => {
    if (!exam) return;
    if (m.type === "exam.answer" && m.payload.examId === examId) {
      scores.set(`${m.payload.questionId}|${m.payload.cadetId}`, m.payload.score);
      integrity = m.payload.integrity;
      currentOrd = Math.max(currentOrd, m.payload.ord);
      const { cadetId, score } = m.payload;
      withArena((a) => {
        a.answer(cadetId, score);
        a.setIntegrity(integrity);
      });
      render();
    }
    if (m.type === "exam.status" && m.payload.examId === examId) {
      if (m.payload.status === "done") void refresh();
      if (m.payload.status === "error")
        app.notify(`The exam stopped: ${m.payload.detail ?? "unknown error"}`, "error");
    }
  };

  const refresh = async () => {
    exam = await api.get<ExamInfo>(`/api/exams/${examId}`);
    for (const r of exam.results) scores.set(`${r.questionId}|${r.cadetId}`, r.score);
    if (exam.results.length) {
      integrity = exam.results.reduce((s, r) => s + r.score, 0) / exam.results.length;
      const answered = new Set(exam.results.map((r) => r.questionId));
      currentOrd = Math.max(
        1,
        ...exam.questions.filter((q) => answered.has(q.id)).map((q) => q.ord),
      );
    }
    render();
  };

  serverEvents.on("message", onMessage);
  void (async () => {
    const room = await api.get<{ cadets: CadetView[] }>(`/api/classrooms/${classroomId}`);
    cadets = room.cadets.map((c) => ({ ...c, comprehension: 0, state: "attentive" }));
    await refresh();
    const loaded = exam as ExamInfo | null; // assigned by refresh()
    withArena((a) => {
      a.setCadets(cadets);
      if (loaded) a.setPassMark(loaded.passThreshold);
      a.setIntegrity(integrity);
    });
    if (loaded?.status === "ready")
      await api
        .post(`/api/exams/${examId}/run`)
        .catch((e: Error) => app.notify(e.message, "error"));
  })().catch((e: Error) => fill(card, h("p", { class: "error-text" }, e.message)));

  root.append(
    h(
      "button",
      {
        class: "btn quiet arena-back",
        onclick: () => app.openDesk(schoolId, classroomId, "exams"),
      },
      icon(ICONS.back),
      "Desk",
    ),
  );
  return () => {
    serverEvents.off("message", onMessage);
    root.classList.remove("arena", "done");
  };
}
