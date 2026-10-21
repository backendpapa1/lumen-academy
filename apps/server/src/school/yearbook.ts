import type { GameConfig, TeachingAnalysis } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { schoolConceptStatuses } from "../game/schoolStatus.js";

// The Yearbook (P-6): everything you taught, concept by concept, with what
// you covered, what you didn't, how the class did, and what you got wrong.
// Your study notes, built from the record: no model call, nothing invented.

const STATUS = {
  untaught: "not taught yet",
  taught: "taught",
  weak: "needs a recap",
  mastered: "mastered",
} as const;

export function yearbookMarkdown(handle: DbHandle, game: GameConfig, schoolId: string): string {
  const { sqlite } = handle;
  const school = sqlite
    .prepare("SELECT name, description FROM schools WHERE id = ?")
    .get(schoolId) as { name: string; description: string | null } | undefined;
  if (!school) throw new Error("no such School");
  const statuses = schoolConceptStatuses(handle, schoolId, game.status);
  const modules = sqlite
    .prepare("SELECT id, title, goal FROM modules WHERE school_id = ? ORDER BY ord")
    .all(schoolId) as Array<{
    id: string;
    title: string;
    goal: string | null;
  }>;
  // Teacher messages per concept, in order.
  const said = sqlite
    .prepare(
      `SELECT m.concept_id AS conceptId, m.text, m.kind, m.created_at AS at FROM messages m
       JOIN periods p ON p.id = m.period_id JOIN classrooms c ON c.id = p.classroom_id
       WHERE c.school_id = ? AND m.speaker = 'teacher' AND m.text != '' ORDER BY m.created_at`,
    )
    .all(schoolId) as Array<{ conceptId: string | null; text: string; kind: string; at: string }>;
  // Facts the Director credited as covered, per concept.
  const covered = new Map<string, Set<string>>();
  for (const r of sqlite
    .prepare(
      `SELECT t.analysis_json FROM turns t JOIN periods p ON p.id = t.period_id JOIN classrooms c ON c.id = p.classroom_id WHERE c.school_id = ?`,
    )
    .all(schoolId) as Array<{ analysis_json: string }>) {
    const a = JSON.parse(r.analysis_json) as TeachingAnalysis;
    for (const id of a.conceptIds) {
      const set = covered.get(id) ?? new Set<string>();
      for (const f of a.teaching.coverage) set.add(f.toLowerCase().trim());
      covered.set(id, set);
    }
  }
  const examScore = new Map(
    (
      sqlite
        .prepare(
          `SELECT q.concept_id AS id, avg(r.score) AS s FROM exam_results r JOIN exam_questions q ON q.id = r.question_id
           JOIN exams e ON e.id = r.exam_id JOIN classrooms c ON c.id = e.classroom_id WHERE c.school_id = ? GROUP BY q.concept_id`,
        )
        .all(schoolId) as Array<{ id: string; s: number }>
    ).map((r) => [r.id, r.s]),
  );
  const errors = sqlite
    .prepare(
      `SELECT te.concept_id AS conceptId, te.claim, te.correction FROM teacher_errors te
       JOIN turns t ON t.id = te.turn_id JOIN periods p ON p.id = t.period_id JOIN classrooms c ON c.id = p.classroom_id
       WHERE c.school_id = ?`,
    )
    .all(schoolId) as Array<{ conceptId: string | null; claim: string; correction: string }>;

  const out: string[] = [`# ${school.name}: Yearbook`, ""];
  if (school.description) out.push(`_${school.description}_`, "");
  const all = Object.values(statuses);
  const count = (k: keyof typeof STATUS) => all.filter((s) => s.status === k).length;
  out.push(
    `${all.length} concepts · ${count("mastered")} mastered · ${count("taught")} taught · ${count("weak")} need a recap · ${count("untaught")} not taught yet`,
    `Generated ${new Date().toISOString().slice(0, 10)} by Lumen Academy from your classes.`,
    "",
  );
  const weak = Object.entries(statuses).filter(([, s]) => s.status === "weak");
  if (weak.length) {
    out.push("## Review first", "");
    for (const [id] of weak) {
      const t = sqlite.prepare("SELECT title FROM concepts WHERE id = ?").get(id) as {
        title: string;
      };
      out.push(`- **${t.title}**: your class didn't get this yet.`);
    }
    out.push("");
  }
  for (const m of modules) {
    out.push(`## ${m.title}`, "");
    if (m.goal) out.push(`_${m.goal}_`, "");
    const concepts = sqlite
      .prepare(
        "SELECT id, title, summary, key_facts_json FROM concepts WHERE module_id = ? ORDER BY ord",
      )
      .all(m.id) as Array<{ id: string; title: string; summary: string; key_facts_json: string }>;
    for (const c of concepts) {
      const st = statuses[c.id];
      const exam = examScore.get(c.id);
      const meta = [
        STATUS[st?.status ?? "untaught"],
        st?.comprehension != null
          ? `class understanding ${Math.round(st.comprehension * 100)}%`
          : null,
        exam !== undefined ? `exam ${Math.round(exam * 100)}%` : null,
      ].filter(Boolean);
      out.push(`### ${c.title}`, "", `${c.summary}`, "", `_${meta.join(" · ")}_`, "");
      const facts = JSON.parse(c.key_facts_json) as string[];
      const got = covered.get(c.id) ?? new Set<string>();
      const isCovered = (f: string) =>
        [...got].some(
          (g) => g === f.toLowerCase().trim() || (g.length > 20 && f.toLowerCase().includes(g)),
        );
      out.push("**Key facts**", "");
      for (const f of facts) out.push(`- [${isCovered(f) ? "x" : " "}] ${f}`);
      out.push("");
      const mine = said.filter((s) => s.conceptId === c.id);
      if (mine.length) {
        out.push("**What you taught**", "");
        for (const s of mine.slice(0, 30))
          out.push(`> ${s.kind === "board" ? "(board) " : ""}${s.text.replace(/\n/g, " ")}`, ">");
        if (out.at(-1) === ">") out.pop();
        out.push("");
      }
      const errs = errors.filter((e) => e.conceptId === c.id);
      if (errs.length) {
        out.push("**Corrections (you said / the source says)**", "");
        for (const e of errs) out.push(`- ~~${e.claim}~~ → ${e.correction}`);
        out.push("");
      }
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}
