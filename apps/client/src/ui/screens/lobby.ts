import { ApiError, type CampusView, type SchoolSummary } from "../../core/api";
import { app } from "../../core/app";
import { store } from "../../core/store";
import { hoverSchool } from "./campusSync";
import { emblem, plural, rankInsignia } from "./common";
import { fill, h, icon, ICONS } from "./dom";
import { openModal } from "./modal";
import { openSettings } from "./settings";

// The lobby over the campus (M3-09, M5): Resume in one click, rank and the
// forgiving streak, every School with its wing's tier and its classes.

export function mountLobby(root: HTMLElement): () => void {
  root.classList.add("lobby");
  const grid = h("div", { class: "school-grid", role: "list" });
  const status = h("p", { class: "lede", "aria-live": "polite" });
  const hero = h("div", { class: "lobby-hero" });
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
          { class: "btn quiet", onclick: () => openSettings() },
          icon(ICONS.settings),
          "Settings",
        ),
      ),
      hero,
      grid,
    ),
  );

  const render = () => {
    const { schools, campus } = store.getState().setup;
    fill(hero, ...(campus ? heroParts(campus) : []));
    if (!schools) {
      status.textContent = "Loading your Schools…";
      return;
    }
    status.textContent = schools.length
      ? "Pick up where you left off, or found a new School."
      : "Found your first School: pick a topic you want to really understand.";
    const wings = campus?.wings ?? [];
    fill(
      grid,
      ...schools.map((s) =>
        schoolCard(
          s,
          wings.find((w) => w.schoolId === s.id),
        ),
      ),
      newSchoolCard(),
    );
  };

  render();
  const off = store.subscribe((s, p) => {
    if (s.setup.schools !== p.setup.schools || s.setup.campus !== p.setup.campus) render();
  });
  app.loadSchools().catch((e: Error) => {
    status.textContent = e.message;
    fill(grid, newSchoolCard());
  });
  return () => {
    off();
    root.classList.remove("lobby");
    hoverSchool(null);
  };
}

/** Resume (ADHD rule 1: one click back into teaching), rank, and the forgiving streak. */
function heroParts(c: CampusView): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (c.resume) {
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
          h("div", { class: "micro" }, "Headmaster rank"),
          h("div", { class: "h2" }, c.xp.rank),
          h(
            "div",
            { class: "progress", style: "width:100%;margin:8px 0 4px" },
            h("span", { style: `width:${pct}%;background:var(--aurum)` }),
          ),
          h(
            "div",
            { class: "mono" },
            c.xp.next
              ? `${c.xp.total.toLocaleString()} XP · ${(c.xp.next.minXp - c.xp.total).toLocaleString()} to ${c.xp.next.name}`
              : `${c.xp.total.toLocaleString()} XP`,
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
          // Forgiving (P-3): never a dramatic zero; the best streak is shown with pride.
          st.missedDays >= 2
            ? "A little nebula fog drifted in. Teach once to clear it."
            : st.taughtToday
              ? "You taught today."
              : st.current
                ? "Teach today to keep it going."
                : "Teach a class to start one.",
        ),
        st.best > 0 &&
          h("div", { class: "mono", style: "margin-top:6px" }, `Best: ${plural(st.best, "day")}`),
      ),
    ),
  );
  return out;
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
            : plural(c.cadets, "cadet"),
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
              : "Open a class to meet your cadets.",
        ),
  );
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
    placeholder: "What should this School cover? (optional, helps the emblem and the cadets)",
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
