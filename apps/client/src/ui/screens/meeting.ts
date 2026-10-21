import { api, ApiError } from "../../core/api";
import { app } from "../../core/app";
import { lookFor, peepSvg } from "../peeps/peep";
import { fill, h, icon, ICONS } from "./dom";
import "./meeting.css";

// Parent–teacher meeting (V5-10): the parent of the student who struggled most
// sits across the desk. I explain the gaps with evidence; vague answers get
// kind pushback; naming the real gaps and a plan earns their thanks.

interface Turn {
  parent: string;
  child: { id: string; name: string };
  module: string;
  evidence: string[];
  reply: string;
  satisfied: boolean;
  pushback: boolean;
}

export function mountMeeting(root: HTMLElement, classroomId: string, schoolId: string): () => void {
  root.classList.add("meeting");
  const history: Array<{ who: "parent" | "teacher"; text: string }> = [];
  const talk = h("ol", { class: "mt-talk", "aria-live": "polite" });
  const evidence = h("section", { class: "card pad mt-evidence", "aria-label": "Evidence" });
  const person = h("div", { class: "mt-person", "aria-hidden": "true" });
  const input = h("textarea", {
    class: "field",
    rows: 3,
    placeholder: "Explain what's behind it: which idea, which mix-up, and your plan.",
    "aria-label": "What you say to the parent",
  });
  const say = h("button", { class: "btn primary" }, "Say it");
  const status = h("p", { class: "dim small", style: "margin:6px 0 0" });
  let done = false;

  const line = (who: "parent" | "teacher", text: string, name: string) =>
    talk.append(h("li", { class: `mt-line ${who}` }, h("b", {}, name), h("p", {}, text)));

  const turn = async () => {
    say.disabled = true;
    status.textContent = history.length ? "They're thinking…" : "They're sitting down…";
    try {
      const t = await api.post<Turn>(`/api/classrooms/${classroomId}/meeting`, { history });
      if (!history.length) {
        person.innerHTML = peepSvg(lookFor(`parent:${t.child.id}`), { face: "Concerned" });
        fill(
          evidence,
          h("div", { class: "micro" }, `${t.child.name.split(" ")[0]} · ${t.module}`),
          h("p", { class: "dim small" }, "What the records show (the parent has seen this too):"),
          h("ul", { class: "mt-ev" }, ...t.evidence.map((e) => h("li", {}, e.replace(/^- /, "")))),
        );
      }
      history.push({ who: "parent", text: t.reply });
      line("parent", t.reply, t.parent);
      person.innerHTML = peepSvg(lookFor(`parent:${t.child.id}`), {
        face: t.satisfied ? "Smile" : t.pushback ? "Concerned" : "Calm",
      });
      const teacherTurns = history.filter((x) => x.who === "teacher").length;
      if (t.satisfied || teacherTurns >= 4) {
        done = true;
        status.textContent = t.satisfied
          ? "They left reassured: you named the real gaps and a plan."
          : "They left still unsure. Next time, name the exact idea and the mix-up.";
        input.disabled = true;
        say.hidden = true;
      } else status.textContent = t.pushback ? "They want specifics." : "";
    } catch (e) {
      status.textContent = e instanceof ApiError ? e.message : String(e);
    } finally {
      say.disabled = done;
    }
  };
  say.addEventListener("click", () => {
    const text = input.value.trim();
    if (!text || done) return;
    history.push({ who: "teacher", text });
    line("teacher", text, "You");
    input.value = "";
    void turn();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      say.click();
    }
  });

  root.append(
    h(
      "div",
      { class: "wrap" },
      h(
        "header",
        { class: "topbar" },
        h(
          "button",
          { class: "btn quiet", onclick: () => app.openDesk(schoolId, classroomId, "exams") },
          icon(ICONS.back),
          "Class desk",
        ),
        h(
          "div",
          {},
          h("div", { class: "micro" }, "After the module"),
          h("h1", { class: "display" }, "Parent meeting"),
        ),
      ),
      h(
        "div",
        { class: "mt-grid" },
        h("div", { class: "mt-scene card" }, person, h("div", { class: "mt-desk" })),
        h(
          "div",
          { class: "mt-side" },
          evidence,
          h(
            "section",
            { class: "card pad" },
            talk,
            input,
            h("div", { class: "row", style: "margin-top:8px" }, say),
            status,
          ),
        ),
      ),
    ),
  );
  void turn();
  return () => root.classList.remove("meeting");
}
