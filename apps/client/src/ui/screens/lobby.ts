import { openModePicker } from "./modePicker";
import {
  api,
  ApiError,
  type ArchivedSchool,
  type CampusView,
  type SchoolSummary,
  type Settings,
} from "../../core/api";
import { app } from "../../core/app";
import { desktop } from "../../core/desktop";
import { store } from "../../core/store";
import { hoverSchool } from "./campusSync";
import { emblem, plural, rankInsignia } from "./common";
import { fill, h, icon, ICONS } from "./dom";
import { openModal } from "./modal";
import { maybeTour, startTour } from "./tour";
import { openSettings } from "./settings";

// The lobby over the campus (M3-09, M5): Resume in one click, rank and the
// forgiving streak, every School with its wing's tier and its classes.

export function mountLobby(root: HTMLElement): () => void {
  root.classList.add("lobby");
  const grid = h("div", { class: "school-grid", role: "list" });
  const status = h("p", { class: "lede", "aria-live": "polite" });
  const hero = h("div", { class: "lobby-hero" });
  const challenge = h("section", {
    class: "card pad challenge",
    "aria-label": "This week's challenge",
    hidden: true,
  });
  const shelf = h("div", { class: "archived-shelf" });
  // The desktop app on a fresh install: keys first (ADR-011).
  const keysBanner = h("section", {
    class: "card pad keys-banner",
    "aria-label": "API keys needed",
    hidden: true,
  });
  root.append(
    h(
      "div",
      { class: "wrap lobby-col" },
      h(
        "header",
        { class: "topbar" },
        h(
          "div",
          {},
          h("div", { class: "micro" }, "Lumen Academy"),
          h("h1", { class: "display" }, "Your Schools"),
          status,
        ),
        h("div", { class: "spacer" }),
        h(
          "button",
          {
            class: "btn quiet",
            "data-tour": "studyhall",
            onclick: () => store.setState({ route: { name: "studyhall" } }),
          },
          icon(ICONS.book),
          "Study hall",
        ),
        h(
          "button",
          { class: "btn quiet", onclick: () => importSchoolDialog() },
          icon(ICONS.upload),
          "Import",
        ),
        h(
          "button",
          { class: "btn quiet", onclick: () => openSettings() },
          icon(ICONS.settings),
          "Settings",
        ),
        h(
          "button",
          { class: "btn quiet", "data-tour": "tour", onclick: () => startTour() },
          icon(ICONS.help),
          "Tour",
        ),
      ),
      keysBanner,
      hero,
      challenge,
      grid,
      shelf,
    ),
  );
  void loadChallenge(challenge);
  if (desktop.present) void loadKeysBanner(keysBanner);

  const render = () => {
    const { schools, campus, archived } = store.getState().setup;
    fill(hero, ...(campus ? heroParts(campus) : []));
    fill(shelf, ...archivedShelf(archived));
    if (!schools) {
      status.textContent = "Loading your Schools…";
      return;
    }
    status.textContent = schools.length
      ? "Pick up where you left off, or found a new School."
      : "Found your first School: pick a topic you want to really understand.";
    const wings = campus?.wings ?? [];
    // The lobby shows the Schools I've taught most recently; the rest are a click away.
    const shown = recentFirst(schools).slice(0, LOBBY_SCHOOLS);
    fill(
      grid,
      ...shown.map((s) =>
        schoolCard(
          s,
          wings.find((w) => w.schoolId === s.id),
        ),
      ),
      schools.length > shown.length ? allSchoolsCard(schools.length - shown.length) : null,
      newSchoolCard(),
    );
  };

  render();
  const offOnboarding = maybeTour();
  const off = store.subscribe((s, p) => {
    if (
      s.setup.schools !== p.setup.schools ||
      s.setup.campus !== p.setup.campus ||
      s.setup.archived !== p.setup.archived
    )
      render();
  });
  app.loadSchools().catch((e: Error) => {
    status.textContent = e.message;
    fill(grid, newSchoolCard());
  });
  return () => {
    off();
    offOnboarding();
    root.classList.remove("lobby");
    hoverSchool(null);
  };
}

/** Resume (ADHD rule 1: one click back into teaching), rank, and the forgiving streak. */
function heroParts(c: CampusView): HTMLElement[] {
  const out: HTMLElement[] = [];
  // V3-03: with nothing in progress, the one button is "today's best class".
  if (c.best && !c.resume?.inProgress) out.push(bestCard(c.best));
  else if (c.resume) {
    const r = c.resume;
    const go = h(
      "button",
      { class: "btn primary resume-btn", onclick: () => app.startClass(r.classroomId) },
      icon(ICONS.play),
      r.inProgress ? "Resume class" : "Teach again",
    );
    out.push(
      h(
        "section",
        { class: "card pad resume", "aria-label": "Resume" },
        h(
          "div",
          { class: "micro" },
          r.inProgress ? "Class in progress" : "Pick up where you left off",
        ),
        h("div", { class: "h2", style: "margin:6px 0 2px" }, r.conceptTitle ?? r.classroomName),
        h("div", { class: "dim" }, `${r.schoolName} · ${r.classroomName}`),
        h("div", { class: "row", style: "margin-top:14px" }, go),
      ),
    );
    // Enter goes straight in: the lobby opens with Resume focused.
    queueMicrotask(() => go.focus({ preventScroll: true }));
  }
  if (c.fading && !c.resume?.inProgress && !c.best) out.push(fadingCard(c.fading));
  const insignia = rankInsignia(c.xp.rank);
  const pct = Math.round(c.xp.progress * 100);
  const st = c.streak;
  out.push(
    h(
      "section",
      { class: "status-row" },
      h(
        "div",
        { class: "card pad rank" },
        insignia ? h("img", { src: insignia, alt: "" }) : null,
        h(
          "div",
          { style: "flex:1;min-width:0" },
          h("div", { class: "micro" }, "Teacher rank"),
          h("div", { class: "h2" }, c.xp.rank),
          h(
            "div",
            { class: "progress", style: "width:100%;margin:8px 0 4px" },
            h("span", { style: `width:${pct}%;background:var(--marigold)` }),
          ),
          h(
            "div",
            { class: "mono" },
            c.xp.next
              ? `${c.xp.total.toLocaleString()} XP · ${(c.xp.next.minXp - c.xp.total).toLocaleString()} to ${c.xp.next.name}`
              : `${c.xp.total.toLocaleString()} XP`,
          ),
          h(
            "button",
            {
              class: "btn small quiet",
              style: "margin-top:8px;padding:0",
              onclick: () => store.setState({ route: { name: "progress" } }),
            },
            "Your progress and teaching style →",
          ),
        ),
      ),
      h(
        "div",
        { class: "card pad streak" },
        h("div", { class: "micro" }, "Streak"),
        h(
          "div",
          { class: "h2" },
          st.current ? plural(st.current, "day") : st.best ? "A fresh start" : "Day one",
        ),
        h(
          "div",
          { class: "dim", style: "font-size:13px;margin-top:4px" },
          // Forgiving (P-3, V3-07): it celebrates showing up, never a dramatic zero.
          st.missedDays >= 2 && !st.current
            ? "A few clouds rolled in over the campus. Teach once to clear the sky."
            : st.taughtToday
              ? "You showed up today. That's the whole trick."
              : st.missedDays >= 2
                ? "A freeze is holding your streak. Even 3 minutes today counts."
                : st.current
                  ? "Teach today to keep it going. A micro-lesson counts."
                  : "Teach a class to start one.",
        ),
        (st.freezes > 0 || st.frozenDays > 0) &&
          h(
            "div",
            { class: "mono freeze", style: "margin-top:6px" },
            st.freezes > 0
              ? `${plural(st.freezes, "freeze")} banked (a week earns one)`
              : `A freeze covered ${plural(st.frozenDays, "missed day")}`,
          ),
        st.best > 0 &&
          h("div", { class: "mono", style: "margin-top:6px" }, `Best: ${plural(st.best, "day")}`),
      ),
    ),
  );
  return out;
}

/** V3-03: one button, no choosing. Enter starts it; a micro-lesson is right beside it. */
function bestCard(b: NonNullable<CampusView["best"]>): HTMLElement {
  const go = h(
    "button",
    {
      class: "btn primary resume-btn",
      onclick: () => app.startClass(b.classroomId, { conceptId: b.conceptId }),
    },
    icon(ICONS.play),
    "Start class",
  );
  queueMicrotask(() => go.focus({ preventScroll: true }));
  return h(
    "section",
    { class: `card pad resume best why-${b.why}`, "aria-label": "Today's best class" },
    h("div", { class: "micro" }, "Today's best class"),
    h("div", { class: "h2", style: "margin:6px 0 2px" }, b.conceptTitle),
    h("div", { class: "dim" }, `${b.schoolName} · ${b.classroomName}`),
    h("p", { class: "best-why" }, b.reason),
    h(
      "div",
      { class: "row wrap-row", style: "margin-top:14px" },
      go,
      h(
        "button",
        {
          class: "btn",
          onclick: () => app.startClass(b.classroomId, { conceptId: b.conceptId, kind: "micro" }),
        },
        "Micro-lesson · 3 min",
      ),
      h(
        "button",
        {
          class: "btn quiet",
          onclick: () => openModePicker(b.classroomId, b.conceptId),
        },
        "Other ways to teach",
      ),
    ),
  );
}

/** V2-03: a gentle nudge, not an alarm. One concept, one button. */
function fadingCard(f: NonNullable<CampusView["fading"]>): HTMLElement {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const when = f.days === 0 ? "today" : f.days === 1 ? "yesterday" : `${f.days} days ago`;
  return h(
    "section",
    { class: "card pad fading", "aria-label": "Your class is forgetting" },
    h(
      "div",
      { class: "fading-art", "aria-hidden": "true" },
      h("span", { class: "q" }, "?"),
      h("span", { class: "q two" }, "?"),
    ),
    h(
      "div",
      { style: "flex:1;min-width:0" },
      h("div", { class: "micro" }, "Your class is forgetting"),
      h("div", { class: "h2", style: "margin:6px 0 2px" }, f.conceptTitle),
      h(
        "div",
        { class: "dim" },
        `${f.classroomName} · ${f.schoolName}: ${pct(f.was)} → ${pct(f.now)} since you taught it ${when}.`,
      ),
      h(
        "div",
        { class: "row", style: "margin-top:12px" },
        h(
          "button",
          {
            class: "btn",
            onclick: () => app.startClass(f.classroomId, { conceptId: f.conceptId, minutes: 5 }),
          },
          icon(ICONS.play),
          "5-minute refresher",
        ),
        h("span", { class: "dim small" }, "A short review now makes it stick longer."),
      ),
    ),
  );
}

function schoolCard(s: SchoolSummary, wing?: CampusView["wings"][number]): HTMLElement {
  const classes = s.classrooms.filter((c) => c.status === "active" || c.status === "registering");
  const rows = classes.map((c) => {
    const inProgress = c.openPeriodElapsedMs != null;
    return h(
      "div",
      { class: "class-row" },
      h(
        "div",
        { style: "flex:1;min-width:0" },
        h("div", { class: "name" }, c.name),
        h(
          "div",
          { class: inProgress ? "meta gold" : "meta" },
          inProgress
            ? `In progress · ${Math.floor(c.openPeriodElapsedMs! / 60_000)} min in`
            : plural(c.cadets, "student"),
        ),
      ),
      c.status === "active"
        ? h(
            "button",
            {
              class: `btn small ${inProgress ? "primary" : ""}`,
              onclick: (e: Event) => {
                e.stopPropagation();
                app.startClass(c.id);
              },
            },
            icon(ICONS.play),
            inProgress ? "Resume" : "Teach",
          )
        : h("span", { class: "chip busy" }, h("span", { class: "dot" }), "registering"),
    );
  });
  const open = () =>
    app.openSchool(s.id, classes.length ? "classes" : s.concepts ? "curriculum" : "sources");
  return h(
    "article",
    {
      class: "card pad interactive school-card",
      role: "listitem",
      tabindex: 0,
      "aria-label": `Open ${s.name}`,
      onclick: open,
      onkeydown: (e: Event) =>
        (e as KeyboardEvent).key === "Enter" && e.target === e.currentTarget && open(),
      // The campus camera flies to this School's wing.
      onmouseenter: () => hoverSchool(s.id),
      onmouseleave: () => hoverSchool(null),
      onfocus: () => hoverSchool(s.id),
    },
    h(
      "div",
      { class: "head" },
      emblem(s),
      h(
        "div",
        { style: "flex:1;min-width:0" },
        h("h2", { class: "h2" }, s.name),
        h(
          "div",
          { class: "mono" },
          `${plural(s.sources, "source")} · ${plural(s.concepts, "concept")}`,
        ),
        wing &&
          h(
            "div",
            {
              class: "tier",
              title:
                wing.nextAt !== null
                  ? `${Math.round(wing.masteredFraction * 100)}% mastered; the next tier needs ${Math.round(wing.nextAt * 100)}%`
                  : "Top tier",
            },
            h(
              "span",
              { class: "micro", style: "color:var(--aurum)" },
              `Tier ${wing.tier} · ${wing.tierName}`,
            ),
          ),
      ),
    ),
    rows.length
      ? h("div", {}, ...rows)
      : h(
          "p",
          { class: "dim", style: "margin:0" },
          !s.sources
            ? "Add a source to get started."
            : !s.concepts
              ? "Build the curriculum next."
              : "Open a class to meet your students.",
        ),
  );
}

/** Schools put away: folded by default, one click to bring one back. */
let shelfOpen = false;
function archivedShelf(list: ArchivedSchool[]): HTMLElement[] {
  if (!list.length) return [];
  const details = h(
    "details",
    { class: "archived", ...(shelfOpen ? { open: "" } : {}) },
    h("summary", { class: "micro" }, `Archived · ${list.length}`),
    h(
      "ul",
      { class: "archived-list" },
      ...list.map((s) =>
        h(
          "li",
          { class: "archived-row" },
          h("span", { class: "dot", style: `background:${s.accent ?? "var(--lumen)"}` }),
          h(
            "div",
            { style: "flex:1;min-width:0" },
            h("div", { class: "name" }, s.name),
            h(
              "div",
              { class: "meta" },
              `${plural(s.concepts, "concept")} · ${plural(s.classrooms, "class", "classes")}`,
            ),
          ),
          h(
            "button",
            {
              class: "btn small",
              "aria-label": `Restore ${s.name}`,
              onclick: (e: Event) => {
                const b = e.currentTarget as HTMLButtonElement;
                b.disabled = true;
                app.restoreSchool(s.id, s.name).catch((err: Error) => {
                  b.disabled = false;
                  app.notify(err.message, "error");
                });
              },
            },
            icon(ICONS.restore),
            "Restore",
          ),
          h(
            "button",
            {
              class: "btn small quiet danger",
              "aria-label": `Delete ${s.name} for good`,
              onclick: () => confirmDelete(s),
            },
            icon(ICONS.trash),
            "Delete",
          ),
        ),
      ),
    ),
  );
  details.addEventListener("toggle", () => (shelfOpen = details.open));
  return [details];
}

/** Deleting is for good, so the School's name has to be typed first. */
function confirmDelete(s: ArchivedSchool) {
  const input = h("input", {
    class: "field",
    "aria-label": "School name",
    placeholder: s.name,
    autocomplete: "off",
  }) as HTMLInputElement;
  const err = h("p", { class: "error-text", role: "alert" });
  const go = h(
    "button",
    {
      class: "btn primary danger",
      disabled: true,
      onclick: () => {
        go.disabled = true;
        app
          .deleteSchool(s.id, s.name, input.value)
          .then(() => close())
          .catch((e: Error) => {
            err.textContent = e.message;
            go.disabled = false;
          });
      },
    },
    icon(ICONS.trash),
    "Delete for good",
  ) as HTMLButtonElement;
  input.addEventListener("input", () => {
    go.disabled = input.value.trim().toLowerCase() !== s.name.trim().toLowerCase();
  });
  input.addEventListener("keydown", (e) => e.key === "Enter" && !go.disabled && go.click());
  const close = openModal(
    `Delete ${s.name}?`,
    h(
      "div",
      { class: "stack" },
      h(
        "p",
        { style: "margin-top:0" },
        `This removes ${plural(s.concepts, "concept")}, ${plural(s.classrooms, "class", "classes")}, their students, transcripts, exams and the School's sources and pictures. It can't be undone. Your XP and rank stay.`,
      ),
      h(
        "p",
        { class: "dim small" },
        "Want a copy first? Restore it and use Export on the School screen.",
      ),
      h("label", { class: "micro" }, `Type “${s.name}” to confirm`),
      input,
      err,
      h(
        "div",
        { class: "actions" },
        h("button", { class: "btn quiet", onclick: () => close() }, "Keep it"),
        h("span", { class: "spacer" }),
        go,
      ),
    ),
  );
  input.focus();
}

/** Cards on the lobby before the rest go behind "See all". */
const LOBBY_SCHOOLS = 5;

const lastTaught = (s: SchoolSummary) =>
  s.classrooms.reduce((m, c) => (c.lastPeriodAt && c.lastPeriodAt > m ? c.lastPeriodAt : m), "");

/** Most recently taught first; never-taught Schools keep their order at the end. */
function recentFirst(list: SchoolSummary[]): SchoolSummary[] {
  return list
    .map((s, i) => ({ s, i, t: lastTaught(s) }))
    .sort((a, b) => (a.t === b.t ? a.i - b.i : a.t < b.t ? 1 : -1))
    .map((x) => x.s);
}

function allSchoolsCard(more: number): HTMLElement {
  return h(
    "button",
    {
      class: "card pad interactive school-card all-schools",
      onclick: () => openAllSchools(),
      "aria-label": `See all Schools (${more} more)`,
    },
    h(
      "div",
      {},
      h("div", { class: "more-count" }, `+${more}`),
      h("div", { class: "h2" }, "See all Schools"),
      h("p", { class: "dim", style: "margin:6px 0 0" }, "Search and open any of them."),
    ),
  );
}

/** Every School in one list, searchable, newest teaching first. */
export function openAllSchools() {
  const schools = store.getState().setup.schools ?? [];
  const wings = store.getState().setup.campus?.wings ?? [];
  const search = h("input", {
    class: "field",
    type: "search",
    placeholder: "Search your Schools",
    "aria-label": "Search your Schools",
  }) as HTMLInputElement;
  const list = h("ul", { class: "all-list", role: "list" });
  const when = (iso: string) =>
    iso
      ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(iso))
      : "not taught yet";
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const rows = recentFirst(schools).filter(
      (s) =>
        !q || s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q),
    );
    fill(
      list,
      ...(rows.length
        ? rows.map((s) => {
            const w = wings.find((x) => x.schoolId === s.id);
            return h(
              "li",
              {},
              h(
                "button",
                {
                  class: "all-row",
                  onclick: () => {
                    close();
                    app.openSchool(s.id);
                  },
                },
                emblem(s),
                h(
                  "span",
                  { class: "all-name" },
                  h("b", {}, s.name),
                  h(
                    "span",
                    { class: "dim small" },
                    `${plural(s.concepts, "concept")} · ${plural(s.classrooms.length, "class", "classes")} · ${w ? w.tierName : "Blueprint"}`,
                  ),
                ),
                h("span", { class: "mono small dim" }, when(lastTaught(s))),
              ),
            );
          })
        : [h("li", { class: "dim" }, `No School matches “${search.value}”.`)]),
    );
  };
  search.addEventListener("input", render);
  render();
  const close = openModal(
    `All Schools · ${schools.length}`,
    h("div", { class: "all-schools-body" }, search, list),
  );
  search.focus();
}

function newSchoolCard(): HTMLElement {
  return h(
    "button",
    {
      class: "card pad interactive school-card new-school",
      onclick: () => newSchoolDialog(),
      "aria-label": "Found a new School",
    },
    h(
      "div",
      {},
      h("div", { class: "plus" }, icon(ICONS.plus)),
      h("div", { class: "h2" }, "Found a School"),
      h("p", { class: "dim", style: "margin:6px 0 0" }, "One School per topic you want to learn."),
    ),
  );
}

export function newSchoolDialog() {
  const name = h("input", {
    class: "field",
    id: "school-name",
    maxlength: 60,
    placeholder: "e.g. Blockchain, Cell Biology, Jazz Harmony",
  });
  const desc = h("textarea", {
    class: "field",
    id: "school-desc",
    maxlength: 400,
    placeholder: "What should this School cover? (optional, helps the emblem and the students)",
  });
  const err = h("p", { class: "error-text", role: "alert" });
  const create = h("button", { class: "btn primary", type: "submit" }, "Found School");
  const form = h(
    "form",
    {},
    h("label", { class: "lbl", for: "school-name" }, "Topic"),
    name,
    h("label", { class: "lbl", for: "school-desc" }, "Description"),
    desc,
    err,
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn quiet", type: "button", onclick: () => close() }, "Cancel"),
      create,
    ),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (name.value.trim().length < 2) {
      err.textContent = "Give the School a name of at least 2 characters.";
      name.focus();
      return;
    }
    create.disabled = true;
    app
      .createSchool(name.value.trim(), desc.value.trim())
      .then(() => close())
      .catch((e: unknown) => {
        err.textContent = e instanceof ApiError ? e.message : String(e);
        create.disabled = false;
      });
  });
  const close = openModal("Found a School", form);
}

/** O-5: bring a School exported from Lumen (its .zip) onto this campus. */
function importSchoolDialog() {
  const input = h("input", { type: "file", accept: ".zip", class: "field", id: "import-zip" });
  const err = h("p", { class: "error-text", role: "alert" });
  const go = h("button", { class: "btn primary", type: "submit" }, "Import School");
  const form = h(
    "form",
    {},
    h(
      "p",
      { class: "dim" },
      "Choose a School exported from Lumen Academy (its .zip). Sources, curriculum, classes, students and history all come with it.",
    ),
    h("label", { class: "lbl", for: "import-zip" }, "Export file"),
    input,
    err,
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn quiet", type: "button", onclick: () => close() }, "Cancel"),
      go,
    ),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const file = input.files?.[0];
    if (!file) return void (err.textContent = "Choose the .zip first.");
    go.disabled = true;
    api
      .upload<{ schoolId: string; name: string }>("/api/schools/import", file)
      .then((r) => {
        close();
        app.notify(`${r.name} is on your campus.`);
        void app.loadSchools();
      })
      .catch((e: unknown) => {
        err.textContent = e instanceof ApiError ? e.message : String(e);
        go.disabled = false;
      });
  });
  const close = openModal("Import a School", form);
}

/** V7-04: one opt-in challenge a week. Progress is the server's count of my own turns. */
interface Challenge {
  title: string;
  blurb: string;
  of: number;
  done: number;
  accepted: boolean;
  completed: boolean;
}
async function loadKeysBanner(el: HTMLElement) {
  const s = await api.get<Settings>("/api/settings").catch(() => null);
  if (!s || (s.hasDeepSeekKey && s.hasOpenAiKey)) return;
  const missing = [!s.hasDeepSeekKey && "DeepSeek", !s.hasOpenAiKey && "OpenAI"].filter(Boolean);
  fill(
    el,
    h(
      "div",
      { style: "flex:1;min-width:0" },
      h("div", { class: "micro" }, "One step before your first class"),
      h(
        "div",
        { class: "h2" },
        `Add your ${missing.join(" and ")} key${missing.length > 1 ? "s" : ""}`,
      ),
      h(
        "p",
        { class: "dim", style: "margin:4px 0 0" },
        "Your students think with DeepSeek; OpenAI reads your sources and draws the school. The keys stay on this computer.",
      ),
    ),
    h(
      "button",
      { class: "btn primary", onclick: () => desktop.openConfigurator() },
      "Add API keys…",
    ),
  );
  el.hidden = false;
}

async function loadChallenge(el: HTMLElement) {
  const render = (c: Challenge) => {
    el.hidden = false;
    fill(
      el,
      h(
        "div",
        { style: "flex:1;min-width:0" },
        h(
          "div",
          { class: "micro" },
          c.completed ? "Challenge done this week" : "This week's challenge",
        ),
        h("div", { class: "h2", style: "margin:4px 0 2px" }, c.title),
        h("div", { class: "dim small" }, c.blurb),
      ),
      c.accepted
        ? h(
            "div",
            { class: "challenge-dots", "aria-label": `${c.done} of ${c.of}` },
            ...Array.from({ length: c.of }, (_, i) => h("i", { class: i < c.done ? "on" : "" })),
            h(
              "span",
              { class: "mono small" },
              c.completed ? "Done! +XP and a sticker" : `${c.done} / ${c.of}`,
            ),
          )
        : h(
            "button",
            {
              class: "btn",
              onclick: () => void api.post<Challenge>("/api/challenge/accept").then(render),
            },
            "Take it on",
          ),
    );
  };
  try {
    render(await api.get<Challenge>("/api/challenge"));
  } catch {
    /* no challenge this time */
  }
}
