import { api, ApiError } from "../../core/api";
import { app } from "../../core/app";
import { SERVER_HTTP } from "../../core/net";
import { fill, h, icon, ICONS } from "./dom";

// "What I actually know" (V2-07/08, VD6): the evidence from my classes, per
// concept, shaky first. My own 1–5 rating sits beside each one; where it and
// the evidence disagree, it says so (kindly). Study notes download as Markdown.

type Status = "mastered" | "shaky" | "avoided";
interface ConceptKnowledge {
  id: string;
  title: string;
  module: string;
  status: Status;
  peak: number | null;
  now: number | null;
  turns: number;
  daysSinceTaught: number | null;
  openMistakes: Array<{ claim: string; correction: string }>;
  selfRating: number | null;
  mismatch: "over" | "under" | null;
  references: string[];
}
interface Report {
  school: { id: string; name: string };
  concepts: ConceptKnowledge[];
  counts: Record<Status, number>;
  agreement: { rated: number; within: number } | null;
}

const SECTIONS: Array<[Status, string, string]> = [
  [
    "shaky",
    "Shaky: review these",
    "Taught, but the class is middling, it's fading, or you got something wrong.",
  ],
  ["avoided", "Not taught yet", "In the curriculum, but barely taught."],
  ["mastered", "Mastered", "Your class got it, and kept it."],
];

const pct = (n: number | null) => (n === null ? "–" : `${Math.round(n * 100)}%`);

export function mountKnowledge(root: HTMLElement, schoolId: string): () => void {
  const top = h("div", { class: "know-top" });
  const summary = h("div", { class: "know-summary", hidden: true });
  const body = h(
    "div",
    { class: "know-body" },
    h("p", { class: "dim" }, "Gathering the evidence…"),
  );
  root.append(top, summary, body);
  let report: Report | null = null;

  const load = async () => {
    try {
      report = await api.get<Report>(`/api/schools/${schoolId}/knowledge`);
      render();
    } catch (e) {
      fill(body, h("p", { class: "error-text" }, (e as Error).message));
    }
  };

  const render = () => {
    const r = report!;
    const ag = r.agreement;
    const askSummary = h(
      "button",
      {
        class: "btn",
        onclick: async () => {
          askSummary.disabled = true;
          summary.hidden = false;
          fill(summary, h("span", { class: "spinner" }), " Reading the evidence…");
          try {
            const s = await api.post<{ summary: string }>(
              `/api/schools/${schoolId}/knowledge/summary`,
            );
            fill(summary, h("div", { class: "micro" }, "In short"), h("p", {}, s.summary));
          } catch (e) {
            fill(
              summary,
              h("p", { class: "error-text" }, e instanceof ApiError ? e.message : String(e)),
            );
          } finally {
            askSummary.disabled = false;
          }
        },
      },
      icon(ICONS.sparkle),
      "Write a summary",
    );
    fill(
      top,
      ...SECTIONS.map(([s, label]) =>
        h(
          "div",
          { class: `card know-count ${s}` },
          h("b", {}, String(r.counts[s])),
          h("span", { class: "micro" }, label.split(":")[0]!),
        ),
      ),
      h(
        "div",
        { class: "know-actions" },
        h(
          "p",
          { class: "dim small" },
          ag
            ? `Your own ratings agree with the evidence on ${ag.within} of ${ag.rated} (within one step).`
            : "Rate how well you think you know each concept (1–5) to see where you and the evidence disagree.",
        ),
        h(
          "div",
          { class: "row" },
          askSummary,
          h(
            "a",
            {
              class: "btn quiet",
              href: `${SERVER_HTTP}/api/schools/${schoolId}/knowledge.md`,
              download: "",
            },
            icon(ICONS.file),
            "Study notes (.md)",
          ),
        ),
      ),
    );
    fill(
      body,
      ...SECTIONS.flatMap(([status, title, blurb]) => {
        const cs = r.concepts.filter((c) => c.status === status);
        if (!cs.length) return [];
        return [
          h("h2", { class: "h2 know-h" }, `${title} (${cs.length})`),
          h("p", { class: "dim small", style: "margin:0 0 12px" }, blurb),
          h("div", { class: "know-list" }, ...cs.map((c) => conceptCard(c))),
        ];
      }),
    );
  };

  const conceptCard = (c: ConceptKnowledge): HTMLElement => {
    const rating = h(
      "div",
      {
        class: "seg know-rate",
        role: "radiogroup",
        "aria-label": `How well do you know ${c.title}?`,
      },
      ...[1, 2, 3, 4, 5].map((n) =>
        h(
          "button",
          {
            role: "radio",
            "aria-checked": String(c.selfRating === n),
            "aria-pressed": String(c.selfRating === n),
            title: ["Not at all", "A little", "Sort of", "Well", "I could teach it cold"][n - 1],
            onclick: async () => {
              const next = c.selfRating === n ? null : n;
              try {
                await api.put(`/api/concepts/${c.id}/self-rating`, { rating: next });
                await load();
              } catch (e) {
                app.notify((e as Error).message, "error");
              }
            },
          },
          String(n),
        ),
      ),
    );
    const meta = [
      c.daysSinceTaught === null
        ? "never taught"
        : `last taught ${c.daysSinceTaught === 0 ? "today" : c.daysSinceTaught === 1 ? "yesterday" : `${c.daysSinceTaught} days ago`}`,
      `${c.turns.toFixed(1)} turns per student`,
    ].join(" · ");
    return h(
      "article",
      { class: `card know-card ${c.status}` },
      h(
        "div",
        { class: "know-head" },
        h(
          "div",
          { style: "flex:1;min-width:0" },
          h("div", { class: "micro" }, c.module),
          h("div", { class: "h2", style: "font-size:17px;margin-top:2px" }, c.title),
          h("div", { class: "mono small" }, meta),
        ),
        h("div", { class: "know-rating" }, h("span", { class: "micro" }, "You'd say"), rating),
      ),
      c.peak !== null &&
        h(
          "div",
          { class: "know-bar", title: `At best ${pct(c.peak)}, today ${pct(c.now)}` },
          h("i", { class: "peak", style: `width:${(c.peak ?? 0) * 100}%` }),
          h("i", { class: "now", style: `width:${(c.now ?? 0) * 100}%` }),
          h("span", { class: "mono" }, `${pct(c.peak)} → ${pct(c.now)} today, across your classes`),
        ),
      c.mismatch &&
        h(
          "p",
          { class: `know-mismatch ${c.mismatch}` },
          c.mismatch === "over"
            ? "You rate this higher than your class shows. Worth a refresher."
            : "Your class knows this better than you give yourself credit for.",
        ),
      ...c.openMistakes.map((m) =>
        h(
          "div",
          { class: "know-mistake" },
          h("p", {}, h("b", {}, "You said: "), m.claim),
          h("p", {}, h("b", {}, "The source: "), m.correction),
        ),
      ),
      c.references.length > 0 &&
        h("p", { class: "dim small know-refs" }, h("b", {}, "Read: "), c.references.join(" · ")),
    );
  };

  void load();
  return () => {};
}
