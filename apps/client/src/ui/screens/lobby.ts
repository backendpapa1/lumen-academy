import { ApiError, type SchoolSummary } from "../../core/api";
import { app } from "../../core/app";
import { store } from "../../core/store";
import { emblem, plural } from "./common";
import { fill, h, icon, ICONS } from "./dom";
import { openModal } from "./modal";
import { openSettings } from "./settings";

// The lobby (simple School Wing entrance, M3-09): every School with its
// classes, one click to teach or resume, and "Found a School".

export function mountLobby(root: HTMLElement): () => void {
  const grid = h("div", { class: "school-grid", role: "list" });
  const status = h("p", { class: "lede", "aria-live": "polite" });
  root.append(
    h(
      "div",
      { class: "wrap" },
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
      grid,
    ),
  );

  const render = (schools: SchoolSummary[] | null) => {
    if (!schools) {
      status.textContent = "Loading your Schools…";
      return;
    }
    status.textContent = schools.length
      ? "Pick up where you left off, or found a new School."
      : "Found your first School: pick a topic you want to really understand.";
    fill(grid, ...schools.map(schoolCard), newSchoolCard());
  };

  render(store.getState().setup.schools);
  const off = store.subscribe(
    (s, p) => s.setup.schools !== p.setup.schools && render(s.setup.schools),
  );
  app.loadSchools().catch((e: Error) => {
    status.textContent = e.message;
    fill(grid, newSchoolCard());
  });
  return off;
}

function schoolCard(s: SchoolSummary): HTMLElement {
  const classes = s.classrooms.filter((c) => c.status === "active" || c.status === "registering");
  const rows = classes.map((c) => {
    const inProgress = c.openPeriodElapsedMs != null;
    return h(
      "div",
      { class: "class-row" },
      h("span", { class: "name" }, c.name),
      h("span", { class: "dim" }, plural(c.cadets, "cadet")),
      inProgress &&
        h(
          "span",
          { class: "chip gold" },
          `In progress · ${Math.floor(c.openPeriodElapsedMs! / 60_000)} min`,
        ),
      h("span", { class: "spacer" }),
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
    },
    h(
      "div",
      { class: "head" },
      emblem(s),
      h(
        "div",
        {},
        h("h2", { class: "h2" }, s.name),
        h(
          "div",
          { class: "mono" },
          `${plural(s.sources, "source")} · ${plural(s.concepts, "concept")}`,
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
