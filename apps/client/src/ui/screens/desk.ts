import {
  ARCHETYPE_INFO,
  type Archetype,
  type AssignmentView,
  type SubmissionView,
} from "@lumen/shared";
import { api, ApiError, type DeskView } from "../../core/api";
import { app } from "../../core/app";
import { serverEvents } from "../../core/bus";
import { store } from "../../core/store";
import { portrait, plural, statusChip } from "./common";
import { fill, h, icon, ICONS } from "./dom";

// The Class Desk (M4-03, M4-06): assignments (create, collect, grade with the
// Grader's ghost marker) and module exams for one class.

type Tab = "assignments" | "exams";

export function mountDesk(root: HTMLElement, schoolId: string, classroomId: string): () => void {
  const header = h("header", { class: "topbar" });
  const tabs = h("div", { class: "seg tabs", role: "tablist", "aria-label": "Desk sections" });
  const panel = h("section", { role: "tabpanel" });
  root.append(h("div", { class: "wrap" }, header, tabs, panel));
  let desk: DeskView | null = null;
  const jobs = new Map<string, { status: string; done: number; total: number; detail?: string }>();
  const examJobs = new Map<string, { status: string; detail?: string }>();

  const route = () => {
    const r = store.getState().route;
    return r.name === "desk" ? r : null;
  };
  const load = () =>
    api
      .get<DeskView>(`/api/classrooms/${classroomId}/desk`)
      .then((d) => {
        desk = d;
        render();
      })
      .catch((e: Error) => fill(panel, h("div", { class: "empty" }, e.message)));

  const render = () => {
    const r = route();
    if (!r) return;
    fill(
      header,
      h(
        "button",
        { class: "btn quiet", onclick: () => app.openSchool(schoolId, "classes") },
        icon(ICONS.back),
        desk?.classroom.schoolName ?? "School",
      ),
      h(
        "div",
        {},
        h("div", { class: "micro" }, "Class desk"),
        h("h1", { class: "display" }, desk?.classroom.name ?? "…"),
        desk &&
          h(
            "p",
            { class: "lede" },
            `${plural(desk.cadets, "student")} · assignments, grading and exams`,
          ),
      ),
      h("span", { class: "spacer" }),
      h(
        "button",
        {
          class: "btn",
          title: "After a module: a parent asks why their child struggled",
          onclick: () => store.setState({ route: { name: "meeting", classroomId, schoolId } }),
        },
        "Parent meeting",
      ),
      h(
        "button",
        { class: "btn primary", onclick: () => app.startClass(classroomId) },
        icon(ICONS.play),
        "Teach",
      ),
    );
    fill(
      tabs,
      ...(
        [
          ["assignments", "Assignments"],
          ["exams", "Exams"],
        ] as Array<[Tab, string]>
      ).map(([id, label]) =>
        h(
          "button",
          {
            role: "tab",
            "aria-selected": String(id === r.tab),
            onclick: () => app.openDesk(schoolId, classroomId, id),
          },
          label,
        ),
      ),
    );
    if (!desk) return fill(panel, h("div", { class: "empty" }, "Loading…"));
    if (r.tab === "exams") return renderExams(desk);
    if (r.assignmentId) return void renderAssignment(r.assignmentId);
    renderAssignments(desk);
  };

  // --- assignments ---------------------------------------------------------------

  const renderAssignments = (d: DeskView) => {
    const picked = new Set<string>();
    const taught = d.modules.flatMap((m) => m.concepts.filter((c) => c.taught));
    let mode: "examiner" | "own" = "examiner";
    const err = h("p", { class: "error-text", role: "alert" });
    const own = h("textarea", {
      class: "field",
      rows: 3,
      placeholder: "One question per line.",
      hidden: true,
      "aria-label": "Your questions",
    });
    const create = h(
      "button",
      { class: "btn primary", disabled: true },
      icon(ICONS.sparkle),
      "Set homework",
    );
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Who writes the questions" });
    const renderSeg = () => {
      fill(
        seg,
        h(
          "button",
          {
            "aria-pressed": String(mode === "examiner"),
            onclick: () => ((mode = "examiner"), (own.hidden = true), renderSeg()),
          },
          "Examiner drafts 3–5",
        ),
        h(
          "button",
          {
            "aria-pressed": String(mode === "own"),
            onclick: () => ((mode = "own"), (own.hidden = false), own.focus(), renderSeg()),
          },
          "Write my own",
        ),
      );
    };
    renderSeg();
    const sync = () => (create.disabled = !picked.size);
    const conceptBoxes = d.modules.map((m) =>
      h(
        "fieldset",
        { class: "concept-pick" },
        h("legend", { class: "micro" }, m.title),
        ...m.concepts.map((c) => {
          const box = h("input", { type: "checkbox", disabled: !c.taught });
          box.addEventListener("change", () => {
            if (box.checked) picked.add(c.id);
            else picked.delete(c.id);
            sync();
          });
          return h(
            "label",
            { class: `row pick${c.taught ? "" : " untaught"}`, style: "gap:8px" },
            box,
            c.title,
            !c.taught && h("span", { class: "tag-untaught" }, "not taught"),
          );
        }),
      ),
    );
    create.addEventListener("click", () => {
      err.textContent = "";
      create.disabled = true;
      create.textContent = mode === "examiner" ? "The Examiner is writing…" : "Setting…";
      api
        .post<{ assignmentId: string }>(`/api/classrooms/${classroomId}/assignments`, {
          conceptIds: [...picked],
          ...(mode === "own" ? { prompt: own.value } : {}),
        })
        .then((r) => {
          app.notify("Homework set. Your students are working on it.");
          app.openDesk(schoolId, classroomId, "assignments", r.assignmentId);
          void load();
        })
        .catch((e: unknown) => {
          err.textContent = e instanceof ApiError ? e.message : String(e);
          sync();
          create.replaceChildren(icon(ICONS.sparkle), "Set homework");
        });
    });
    fill(
      panel,
      h(
        "div",
        { class: "card pad" },
        h("div", { class: "h2" }, "New homework"),
        taught.length
          ? h(
              "p",
              { class: "dim" },
              "Pick what to test. Each student answers from what they actually understood, so their work shows how well each idea landed.",
            )
          : h(
              "p",
              { class: "dim" },
              "Teach a class first: homework can only cover concepts you've taught.",
            ),
        h("div", { class: "concept-grid" }, ...conceptBoxes),
        h(
          "div",
          { class: "row wrap-row", style: "margin-top:14px" },
          seg,
          h("span", { class: "spacer" }),
          create,
        ),
        own,
        err,
      ),
      h("h2", { class: "h2", style: "margin:28px 0 12px" }, "Homework"),
      d.assignments.length
        ? h(
            "div",
            { class: "card" },
            ...d.assignments.map((a) => {
              const job = jobs.get(a.id);
              return h(
                "button",
                {
                  class: "source-row list-btn",
                  onclick: () => app.openDesk(schoolId, classroomId, "assignments", a.id),
                },
                h(
                  "div",
                  {},
                  h("div", {}, a.title),
                  h(
                    "div",
                    { class: "mono" },
                    `${a.graded} of ${a.submitted} graded · ${new Date(a.createdAt).toLocaleDateString()}`,
                  ),
                ),
                h("span", { class: "spacer" }),
                job && job.status === "collecting"
                  ? statusChip("busy", `Students working ${job.done}/${job.total}`)
                  : statusChip(
                      a.status === "graded" ? "ready" : a.status === "issued" ? "busy" : "",
                      a.status === "submitted"
                        ? "To grade"
                        : a.status === "graded"
                          ? "Graded"
                          : "Students working",
                    ),
              );
            }),
          )
        : h("div", { class: "card empty" }, "No homework yet."),
    );
  };

  const renderAssignment = async (id: string) => {
    let a: AssignmentView;
    try {
      a = await api.get<AssignmentView>(`/api/assignments/${id}`);
    } catch (e) {
      return fill(panel, h("div", { class: "empty" }, (e as Error).message));
    }
    if (route()?.assignmentId !== id) return;
    const job = jobs.get(id);
    const waiting = a.status === "issued";
    fill(
      panel,
      h(
        "button",
        {
          class: "btn quiet",
          style: "margin-bottom:12px",
          onclick: () => app.openDesk(schoolId, classroomId, "assignments"),
        },
        icon(ICONS.back),
        "All homework",
      ),
      h(
        "div",
        { class: "card pad" },
        h(
          "div",
          { class: "row" },
          h("h2", { class: "h2" }, a.title),
          h("span", { class: "spacer" }),
          statusChip(
            waiting ? "busy" : a.status === "graded" ? "ready" : "",
            waiting
              ? `Students working${job ? ` ${job.done}/${job.total}` : ""}`
              : a.status === "graded"
                ? "All graded"
                : `${a.submissions.filter((s) => s.myScore === null).length} to grade`,
          ),
        ),
        h(
          "ol",
          { class: "questions" },
          ...a.questions.map((q) =>
            h(
              "li",
              {},
              h("div", {}, q.prompt),
              h(
                "div",
                { class: "mono" },
                `${q.kind === "eli10" ? "Explain like I'm 10" : q.kind} · ${q.conceptTitle} · ${plural(q.citations.length, "source passage")}`,
              ),
            ),
          ),
        ),
      ),
      waiting && !a.submissions.length
        ? h(
            "div",
            { class: "card empty", style: "margin-top:16px" },
            "Your students are answering. Their work appears here as it comes in.",
          )
        : h("div", { class: "subs" }, ...a.submissions.map((s) => submissionCard(a, s))),
    );
  };

  const submissionCard = (a: AssignmentView, s: SubmissionView) => {
    const accent = ARCHETYPE_INFO[s.archetype as Archetype]?.accent ?? "#2A40FF";
    let score = s.myScore ?? 0;
    const comment = h("textarea", {
      class: "field",
      rows: 2,
      placeholder: `Feedback for ${s.cadetName.split(" ")[0]}: what was right, what to fix. Your words teach them.`,
      "aria-label": `Feedback for ${s.cadetName}`,
    });
    comment.value = s.myComment ?? "";
    const scale = h("div", { class: "seg", role: "radiogroup", "aria-label": "Grade 1 to 5" });
    const note = h("p", { class: "disagree", hidden: true });
    const err = h("p", { class: "error-text", role: "alert" });
    const reaction = h("p", { class: "reaction" }, s.reaction ?? "");
    const ret = h(
      "button",
      { class: "btn primary", disabled: !score },
      s.gradedAt ? "Update grade" : "Return to student",
    );
    const ghost = s.refScore;
    const renderScale = () => {
      fill(
        scale,
        ...[1, 2, 3, 4, 5].map((n) =>
          h(
            "button",
            {
              role: "radio",
              "aria-checked": String(n === score),
              "aria-pressed": String(n === score),
              class: ghost !== null && Math.round(ghost) === n ? "ghost" : "",
              title:
                ghost !== null && Math.round(ghost) === n
                  ? `The Grader's reference: ${ghost.toFixed(1)}`
                  : "",
              onclick: () => {
                score = n;
                ret.disabled = false;
                renderScale();
              },
            },
            String(n),
          ),
        ),
      );
      // A-4: where my grade and the reference disagree by 2+.
      const off = ghost !== null && score > 0 && Math.abs(score - ghost) >= 2;
      note.hidden = !off;
      note.textContent = off
        ? `The Grader gave ${ghost!.toFixed(1)} against the source. ${score > ghost! ? "You were more generous: check the answers against the key facts." : "You were stricter: maybe they got more right than it seems."}`
        : "";
    };
    renderScale();
    ret.addEventListener("click", () => {
      err.textContent = "";
      ret.disabled = true;
      api
        .put<{ reaction: string; comprehensionDelta: number | null }>(
          `/api/submissions/${s.id}/grade`,
          { score, comment: comment.value },
        )
        .then((r) => {
          reaction.textContent = r.reaction;
          ret.textContent = "Update grade";
          if (r.comprehensionDelta && r.comprehensionDelta > 0.005)
            app.notify(
              `${s.cadetName.split(" ")[0]} learned from your feedback (+${Math.round(r.comprehensionDelta * 100)}% understanding).`,
            );
          void load();
        })
        .catch((e: unknown) => (err.textContent = e instanceof ApiError ? e.message : String(e)))
        .finally(() => (ret.disabled = false));
    });
    return h(
      "article",
      { class: `card pad sub${s.gradedAt ? " graded" : ""}`, style: `--accent:${accent}` },
      h(
        "div",
        { class: "row" },
        portrait({ id: s.cadetId, archetype: s.archetype as Archetype, name: s.cadetName }),
        h(
          "div",
          {},
          h("div", { class: "who" }, s.cadetName),
          h(
            "div",
            { class: "dim", style: "font-size:13px" },
            ARCHETYPE_INFO[s.archetype as Archetype]?.label ?? s.archetype,
          ),
        ),
      ),
      h(
        "ol",
        { class: "answers" },
        ...a.questions.map((q) => {
          const ans = s.answers.find((x) => x.questionId === q.id);
          return h(
            "li",
            {},
            h("div", { class: "q" }, q.prompt),
            h("div", { class: "ans" }, ans?.answer ?? "(no answer)"),
            ans?.refScore != null &&
              (ans.refRationale
                ? h(
                    "details",
                    { class: "ref" },
                    h("summary", {}, `Grader: ${ans.refScore}/5`),
                    ans.refRationale,
                  )
                : h("div", { class: "ref" }, `Grader: ${ans.refScore}/5`)),
          );
        }),
      ),
      h(
        "div",
        { class: "row wrap-row", style: "margin-top:12px" },
        h("span", { class: "micro" }, "Your grade"),
        scale,
        ghost !== null && h("span", { class: "mono" }, `ghost = Grader ${ghost.toFixed(1)}`),
      ),
      note,
      comment,
      h(
        "div",
        { class: "row", style: "margin-top:10px" },
        reaction,
        h("span", { class: "spacer" }),
        ret,
      ),
      err,
    );
  };

  // --- exams ---------------------------------------------------------------------

  const renderExams = (d: DeskView) => {
    fill(
      panel,
      h(
        "p",
        { class: "dim", style: "margin-top:0" },
        `A module exam unlocks once you've taught ${Math.round(d.unlock * 100)}% of its concepts. The students sit it in the exam hall; the Grader marks it against the source.`,
      ),
      ...d.modules.map((m) => {
        const pct = Math.round(m.eligibility.fraction * 100);
        const exams = d.exams.filter((e) => e.moduleId === m.id);
        const job = [...examJobs.entries()].find(([id]) => exams.some((e) => e.id === id))?.[1];
        const err = h("p", { class: "error-text", role: "alert" });
        const set = h(
          "button",
          {
            class: "btn primary",
            disabled: !m.eligibility.eligible || exams.some((e) => e.status === "generating"),
          },
          icon(ICONS.sparkle),
          "Set exam",
        );
        set.addEventListener("click", () => {
          set.disabled = true;
          api
            .post<{ examId: string }>(`/api/classrooms/${classroomId}/exams`, { moduleId: m.id })
            .then(() => {
              app.notify("The Examiner is writing the exam (about a minute).");
              void load();
            })
            .catch((e: unknown) => {
              err.textContent = e instanceof ApiError ? e.message : String(e);
              set.disabled = false;
            });
        });
        return h(
          "article",
          { class: "card pad", style: "margin-bottom:16px" },
          h(
            "div",
            { class: "row wrap-row" },
            h(
              "div",
              {},
              h("div", { class: "h2" }, m.title),
              h(
                "div",
                { class: "mono" },
                `${m.eligibility.taught} of ${m.eligibility.total} concepts taught`,
              ),
            ),
            h("span", { class: "spacer" }),
            set,
          ),
          h(
            "div",
            { class: "elig" },
            h(
              "div",
              { class: "progress", style: "width:100%" },
              h("span", {
                style: `width:${pct}%;background:${m.eligibility.eligible ? "var(--marigold)" : "var(--cobalt)"}`,
              }),
            ),
            h("i", {
              style: `left:${d.unlock * 100}%`,
              title: `${Math.round(d.unlock * 100)}%: exam unlocks`,
            }),
          ),
          ...exams.map((e) =>
            h(
              "div",
              { class: "source-row", style: "padding-left:0;padding-right:0" },
              h(
                "div",
                {},
                h(
                  "div",
                  {},
                  `Exam · ${new Date(e.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`,
                ),
                e.classAverage !== null &&
                  h("div", { class: "mono" }, `Class average ${Math.round(e.classAverage * 100)}%`),
              ),
              h("span", { class: "spacer" }),
              e.status === "generating"
                ? statusChip("busy", job?.status === "error" ? "Failed" : "Examiner writing…")
                : e.status === "done"
                  ? h(
                      "button",
                      {
                        class: "btn",
                        onclick: () =>
                          store.setState({
                            route: { name: "debrief", examId: e.id, classroomId, schoolId },
                          }),
                      },
                      "Results",
                    )
                  : h(
                      "button",
                      {
                        class: "btn primary",
                        onclick: () =>
                          store.setState({
                            route: { name: "exam", examId: e.id, classroomId, schoolId },
                          }),
                      },
                      icon(ICONS.play),
                      e.status === "running" ? "Watch" : "Start exam",
                    ),
            ),
          ),
          err,
        );
      }),
    );
  };

  const onMessage = (m: import("@lumen/shared").ServerMessage) => {
    if (m.type === "assignment.status" && m.payload.classroomId === classroomId) {
      jobs.set(m.payload.assignmentId, m.payload);
      // load() re-renders, including an open assignment as its submissions arrive.
      if (m.payload.status !== "collecting" || route()?.assignmentId === m.payload.assignmentId)
        void load();
      else render();
    }
    if (m.type === "exam.status" && m.payload.classroomId === classroomId) {
      examJobs.set(m.payload.examId, m.payload);
      if (m.payload.status === "error")
        app.notify(`The exam couldn't be written: ${m.payload.detail ?? "unknown error"}`, "error");
      void load();
    }
  };
  serverEvents.on("message", onMessage);
  void load();
  const off = store.subscribe((s, p) => s.route !== p.route && render());
  return () => {
    off();
    serverEvents.off("message", onMessage);
  };
}
