import { api } from "../../core/api";
import { app } from "../../core/app";
import { fill, h, icon, ICONS } from "./dom";

// Progress (V7-06/07): the v2 gate evidence in charts, drawn in SVG in the
// room's line style, and the teaching-style profile (three sentences and one
// suggestion, from my own numbers).

interface Week {
  week: string;
  minutes: number;
  sessions: number;
  mastered: number;
  clarity: number | null;
  accuracy: number | null;
  voice: number | null;
}
interface Progress {
  weeks: Week[];
  energy: Array<{
    energy: string;
    sessions: number;
    clarity: number | null;
    accuracy: number | null;
    minutes: number;
  }>;
  totals: { minutes: number; sessions: number; mastered: number; turns: number };
}
interface Style {
  computedAt: string | null;
  enough: boolean;
  needed?: number;
  written?: boolean;
  sentences?: string[];
  suggestion?: string;
  stats: { turns: number };
}

const NS = "http://www.w3.org/2000/svg";
const W = 360;
const H = 150;
const short = (d: string) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(d),
  );

/** Bars for one number per week, labelled with the value; empty weeks show a stub. */
function bars(title: string, weeks: Week[], pick: (w: Week) => number, unit = ""): HTMLElement {
  const vals = weeks.map(pick);
  const max = Math.max(1, ...vals);
  const bw = (W - 20) / weeks.length;
  const parts = vals
    .map((v, i) => {
      const bh = v ? Math.max(3, (v / max) * (H - 40)) : 2;
      const x = 10 + i * bw + 4;
      const y = H - 22 - bh;
      return `<rect class="${v ? "bar" : "bar none"}" x="${x}" y="${y}" width="${bw - 8}" height="${bh}"/>${
        v
          ? `<text class="val" x="${x + (bw - 8) / 2}" y="${y - 4}" text-anchor="middle">${v}${unit}</text>`
          : ""
      }<text class="wk" x="${x + (bw - 8) / 2}" y="${H - 6}" text-anchor="middle">${i === weeks.length - 1 ? "now" : short(weeks[i]!.week)}</text>`;
    })
    .join("");
  return chartCard(title, parts);
}

/** One or two 0..1 lines per week (gaps where there's no data). */
function lines(
  title: string,
  weeks: Week[],
  series: Array<[string, (w: Week) => number | null]>,
): HTMLElement {
  const bw = (W - 20) / weeks.length;
  const y = (v: number) => H - 22 - v * (H - 40);
  const parts = series
    .map(([cls, pick]) => {
      const pts = weeks
        .map((w, i) => [10 + i * bw + bw / 2, pick(w)] as const)
        .filter((p): p is readonly [number, number] => p[1] !== null);
      return `<polyline class="line ${cls}" points="${pts.map(([x, v]) => `${x},${y(v)}`).join(" ")}"/>${pts
        .map(([x, v]) => `<circle class="dot ${cls}" cx="${x}" cy="${y(v)}" r="3.5"/>`)
        .join("")}`;
    })
    .join("");
  const axis = `<line class="axis" x1="10" x2="${W - 10}" y1="${y(0)}" y2="${y(0)}"/><line class="axis faint" x1="10" x2="${W - 10}" y1="${y(1)}" y2="${y(1)}"/>${weeks
    .map(
      (w, i) =>
        `<text class="wk" x="${10 + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${i === weeks.length - 1 ? "now" : short(w.week)}</text>`,
    )
    .join("")}`;
  return chartCard(
    title,
    axis + parts,
    series.map(([cls]) => cls),
  );
}

function chartCard(title: string, inner: string, legend: string[] = []): HTMLElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "chart");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", title);
  svg.innerHTML = inner;
  return h(
    "section",
    { class: "card pad chart-card" },
    h(
      "div",
      { class: "row", style: "gap:10px" },
      h("div", { class: "micro", style: "flex:1" }, title),
      ...legend.map((l) => h("span", { class: `legend ${l}` }, l)),
    ),
    svg,
  );
}

const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);

export function mountProgress(root: HTMLElement): () => void {
  root.classList.add("progress-screen");
  const totals = h("div", { class: "prog-totals" });
  const charts = h("div", { class: "prog-grid" }, h("p", { class: "dim" }, "Counting…"));
  const energy = h("section", { class: "card pad", "aria-label": "Energy days" });
  const style = h("section", { class: "card pad style-card", "aria-label": "Your teaching style" });
  root.append(
    h(
      "div",
      { class: "wrap" },
      h(
        "header",
        { class: "topbar" },
        h(
          "button",
          { class: "btn quiet", onclick: () => app.backToBoot() },
          icon(ICONS.back),
          "Campus",
        ),
        h(
          "div",
          {},
          h("div", { class: "micro" }, "The last eight weeks"),
          h("h1", { class: "display" }, "Your progress"),
        ),
      ),
      totals,
      style,
      charts,
      energy,
    ),
  );

  const renderStyle = (s: Style, refreshing = false) => {
    fill(
      style,
      h(
        "div",
        { class: "row", style: "gap:10px" },
        h("div", { class: "micro", style: "flex:1" }, "Your teaching style"),
        s.enough &&
          h(
            "button",
            {
              class: "btn small quiet",
              disabled: refreshing,
              onclick: () => {
                renderStyle(s, true);
                void api.get<Style>("/api/style?refresh=1").then((x) => renderStyle(x));
              },
            },
            refreshing ? "Reading your turns…" : "Refresh",
          ),
      ),
      s.enough
        ? h(
            "div",
            {},
            ...(s.sentences ?? []).map((t) => h("p", { class: "style-line" }, t)),
            h("p", { class: "style-tip" }, h("b", {}, "Try next: "), s.suggestion ?? ""),
            h(
              "p",
              { class: "dim small", style: "margin:0" },
              `From ${s.stats.turns} of your teaching turns · refreshed ${s.computedAt ? new Date(s.computedAt).toLocaleDateString() : ""} · it changes weekly`,
            ),
          )
        : h(
            "p",
            { class: "dim" },
            `Teach a bit more first: the profile needs ${s.needed ?? 20} teaching turns (you have ${s.stats.turns}).`,
          ),
    );
  };

  void api.get<Progress>("/api/progress").then((p) => {
    const t = p.totals;
    fill(
      totals,
      ...[
        [`${t.minutes}`, "minutes taught"],
        [`${t.sessions}`, "sessions"],
        [`${t.mastered}`, "concepts mastered"],
        [`${t.turns}`, "teaching turns"],
      ].map(([n, l]) =>
        h(
          "div",
          { class: "card pad prog-total" },
          h("b", {}, n!),
          h("span", { class: "micro" }, l!),
        ),
      ),
    );
    fill(
      charts,
      bars("Minutes taught", p.weeks, (w) => w.minutes),
      bars("Sessions", p.weeks, (w) => w.sessions),
      bars("Concepts mastered", p.weeks, (w) => w.mastered),
      lines("Clarity and accuracy (the Director's view)", p.weeks, [
        ["clarity", (w) => w.clarity],
        ["accuracy", (w) => w.accuracy],
      ]),
      bars(
        "Taught by voice",
        p.weeks,
        (w) => (w.voice === null ? 0 : Math.round(w.voice * 100)),
        "%",
      ),
    );
    const named: Record<string, string> = {
      low: "Low-energy days",
      ok: "OK days",
      high: "High-energy days",
      unset: "No check-in",
    };
    const best = [...p.energy]
      .filter((e) => e.sessions && e.clarity !== null)
      .sort((a, b) => (b.clarity ?? 0) - (a.clarity ?? 0))[0];
    fill(
      energy,
      h("div", { class: "micro" }, "Which energy days went well"),
      h(
        "div",
        { class: "energy-stats" },
        ...p.energy.map((e) =>
          h(
            "div",
            { class: `energy-stat ${e.energy}${best === e ? " best" : ""}` },
            h("b", {}, named[e.energy] ?? e.energy),
            h("span", { class: "mono small" }, `${e.sessions} sessions · ${e.minutes} min`),
            h(
              "span",
              { class: "small" },
              `clarity ${pct(e.clarity)} · accuracy ${pct(e.accuracy)}`,
            ),
          ),
        ),
      ),
      best &&
        h(
          "p",
          { class: "dim small", style: "margin:8px 0 0" },
          `Your clearest teaching happens on ${named[best.energy]!.toLowerCase()}.`,
        ),
    );
  });
  void api.get<Style>("/api/style").then((s) => renderStyle(s));
  return () => root.classList.remove("progress-screen");
}
