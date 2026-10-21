import { api, ApiError, type SchoolDetail, type SourceRow } from "../../core/api";
import { app } from "../../core/app";
import type { SourceJob } from "../../core/setup";
import { store, type AppState } from "../../core/store";
import { mountCurriculum } from "./curriculum";
import { emblem, plural, statusChip } from "./common";
import { fill, h, icon, ICONS } from "./dom";

// The School Wing (M3-05, M3-09): Sources, Curriculum and Classes for one School.

type Tab = "sources" | "curriculum" | "classes";
const TABS: Array<[Tab, string]> = [
  ["sources", "Sources"],
  ["curriculum", "Curriculum"],
  ["classes", "Classes"],
];
const ACCEPT = ".pdf,.md,.markdown,.txt";

export function mountSchool(root: HTMLElement, schoolId: string): () => void {
  const header = h("header", { class: "topbar" });
  const tabs = h("div", { class: "seg tabs", role: "tablist", "aria-label": "School sections" });
  const panel = h("section", { role: "tabpanel" });
  root.append(h("div", { class: "wrap" }, header, tabs, panel));

  let tab: Tab | null = null;
  let unmountPanel: (() => void) | null = null;

  const renderHeader = (s: SchoolDetail | null) => {
    fill(
      header,
      h(
        "button",
        {
          class: "btn quiet",
          onclick: () => app.backToBoot(),
          "aria-label": "Back to your Schools",
        },
        icon(ICONS.back),
        "Schools",
      ),
      s && emblem(s, true),
      h(
        "div",
        {},
        h("div", { class: "micro" }, "School"),
        h("h1", { class: "display" }, s?.name ?? "…"),
        s?.description ? h("p", { class: "lede" }, s.description) : null,
      ),
    );
  };

  const renderTabs = (current: Tab) => {
    fill(
      tabs,
      ...TABS.map(([id, label]) =>
        h(
          "button",
          {
            role: "tab",
            id: `tab-${id}`,
            "aria-selected": String(id === current),
            onclick: () => store.setState({ route: { name: "school", schoolId, tab: id } }),
          },
          label,
        ),
      ),
    );
  };

  const renderPanel = (st: AppState) => {
    const route = st.route;
    if (route.name !== "school") return;
    if (route.tab === tab && unmountPanel) return;
    unmountPanel?.();
    tab = route.tab;
    renderTabs(tab);
    panel.replaceChildren();
    panel.setAttribute("aria-labelledby", `tab-${tab}`);
    unmountPanel =
      tab === "sources"
        ? mountSources(panel, schoolId)
        : tab === "curriculum"
          ? mountCurriculum(panel, schoolId)
          : mountClasses(panel, schoolId);
  };

  renderHeader(store.getState().setup.school);
  renderPanel(store.getState());
  const off = store.subscribe((s, p) => {
    if (s.setup.school !== p.setup.school) renderHeader(s.setup.school);
    if (s.route !== p.route) renderPanel(s);
  });
  return () => {
    off();
    unmountPanel?.();
  };
}

// --- Sources (S-2, S-3) ------------------------------------------------------------

const STEP: Record<SourceJob["status"], [number, string]> = {
  queued: [0.1, "Queued"],
  parsing: [0.35, "Reading"],
  embedding: [0.7, "Indexing"],
  ready: [1, "Ready"],
  error: [1, "Failed"],
};

function mountSources(root: HTMLElement, schoolId: string): () => void {
  const fileInput = h("input", { type: "file", accept: ACCEPT, hidden: true });
  const dropErr = h("p", { class: "error-text", role: "alert" });
  const drop = h(
    "div",
    {
      class: "dropzone",
      role: "button",
      tabindex: 0,
      "aria-label": "Upload a source: PDF, Markdown or text",
    },
    icon(ICONS.upload),
    h("div", { class: "h2" }, "Drop a PDF, Markdown or text file"),
    h("div", {}, "or click to choose one. Up to 50 MB."),
  );
  const pasteTitle = h("input", {
    class: "field",
    id: "paste-title",
    maxlength: 120,
    placeholder: "Title, e.g. Lecture 3 notes",
  });
  const pasteText = h("textarea", {
    class: "field",
    id: "paste-text",
    rows: 6,
    placeholder: "Paste notes or an article here.",
  });
  const pasteErr = h("p", { class: "error-text", role: "alert" });
  const pasteBtn = h("button", { class: "btn", type: "submit" }, "Add pasted text");
  const pasteForm = h(
    "form",
    { class: "card pad" },
    h("div", { class: "h2" }, "Or paste text"),
    h("label", { class: "lbl", for: "paste-title" }, "Title"),
    pasteTitle,
    h("label", { class: "lbl", for: "paste-text" }, "Text"),
    pasteText,
    pasteErr,
    h("div", { class: "row", style: "margin-top:12px" }, h("span", { class: "spacer" }), pasteBtn),
  );
  const list = h("div", { class: "card", "aria-live": "polite" });
  const next = h("div");

  root.append(
    h(
      "div",
      { class: "two-col" },
      h("div", { class: "stack" }, drop, dropErr, fileInput),
      pasteForm,
    ),
    h(
      "div",
      { class: "row", style: "margin:28px 0 12px" },
      h("h2", { class: "h2" }, "Sources"),
      h("span", { class: "spacer" }),
      next,
    ),
    list,
  );

  const upload = (file: File) => {
    dropErr.textContent = "";
    if (!/\.(pdf|md|markdown|txt)$/i.test(file.name)) {
      dropErr.textContent = "Use a PDF, Markdown or text file.";
      return;
    }
    api
      .upload(`/api/schools/${schoolId}/sources`, file)
      .then(() => app.notify(`Indexing "${file.name}"…`))
      .catch((e: unknown) => (dropErr.textContent = e instanceof ApiError ? e.message : String(e)));
  };
  drop.addEventListener("click", () => fileInput.click());
  drop.addEventListener(
    "keydown",
    (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), fileInput.click()),
  );
  fileInput.addEventListener("change", () => fileInput.files?.[0] && upload(fileInput.files[0]));
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const f = e.dataTransfer?.files[0];
    if (f) upload(f);
  });
  pasteForm.addEventListener("submit", (e) => {
    e.preventDefault();
    pasteErr.textContent = "";
    pasteBtn.disabled = true;
    api
      .post(`/api/schools/${schoolId}/sources`, {
        title: pasteTitle.value.trim(),
        text: pasteText.value,
      })
      .then(() => {
        pasteTitle.value = "";
        pasteText.value = "";
      })
      .catch(
        (err: unknown) =>
          (pasteErr.textContent = err instanceof ApiError ? err.message : String(err)),
      )
      .finally(() => (pasteBtn.disabled = false));
  });

  const render = (st: AppState) => {
    const school = st.setup.school;
    const jobs = st.setup.sourceJobs;
    const rows: HTMLElement[] = [];
    const known = new Set<string>();
    for (const s of school?.sources ?? []) {
      known.add(s.title);
      rows.push(sourceRow(s, jobs[s.title]));
    }
    // Jobs the list doesn't know yet (just uploaded).
    for (const j of Object.values(jobs)) if (!known.has(j.title)) rows.push(jobRow(j));
    if (!rows.length)
      fill(
        list,
        h("div", { class: "empty" }, "No sources yet. Add the material you want to learn from."),
      );
    else fill(list, ...rows);
    const ready = (school?.sources ?? []).some((s) => s.status === "ready");
    fill(
      next,
      ready &&
        h(
          "button",
          {
            class: "btn primary",
            onclick: () =>
              store.setState({ route: { name: "school", schoolId, tab: "curriculum" } }),
          },
          "Next: curriculum",
        ),
    );
  };
  render(store.getState());
  return store.subscribe((s, p) => (s.setup !== p.setup ? render(s) : undefined));
}

function sourceRow(s: SourceRow, job?: SourceJob): HTMLElement {
  const status = job && job.status !== "ready" && s.status !== "ready" ? job.status : s.status;
  return h(
    "div",
    { class: "source-row" },
    icon(ICONS.file),
    h(
      "div",
      {},
      h("div", {}, s.title),
      h(
        "div",
        { class: "mono" },
        `${s.kind} · ${plural(s.chunks, "passage")}${s.pageCount ? ` · ${s.pageCount} pages` : ""}`,
      ),
    ),
    h("span", { class: "spacer" }),
    status === "error" && s.error
      ? h("span", { class: "error-text", style: "margin:0" }, s.error)
      : null,
    progressOrChip(status),
  );
}

function jobRow(j: SourceJob): HTMLElement {
  return h(
    "div",
    { class: "source-row" },
    icon(ICONS.file),
    h("div", {}, h("div", {}, j.title), h("div", { class: "mono" }, "New source")),
    h("span", { class: "spacer" }),
    j.status === "error" && j.detail
      ? h("span", { class: "error-text", style: "margin:0" }, j.detail)
      : null,
    progressOrChip(j.status),
  );
}

function progressOrChip(status: SourceJob["status"]) {
  if (status === "ready" || status === "error") return statusChip(status, STEP[status][1]);
  const bar = h("div", {
    class: `progress${status === "embedding" ? " indeterminate" : ""}`,
    role: "progressbar",
    "aria-label": STEP[status][1],
  });
  bar.append(h("span", { style: `width:${STEP[status][0] * 100}%` }));
  return h("div", { class: "row" }, h("span", { class: "mono" }, STEP[status][1]), bar);
}

// --- Classes (R-1) -----------------------------------------------------------------

function mountClasses(root: HTMLElement, schoolId: string): () => void {
  const list = h("div", { class: "card" });
  let difficulty: "gentle" | "standard" | "ruthless" = "standard";
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Difficulty" });
  const err = h("p", { class: "error-text", role: "alert" });
  const openBtn = h("button", { class: "btn primary" }, icon(ICONS.plus), "Open a new class");
  const renderSeg = () =>
    fill(
      seg,
      ...(["gentle", "standard", "ruthless"] as const).map((d) =>
        h(
          "button",
          {
            "aria-pressed": String(d === difficulty),
            onclick: () => ((difficulty = d), renderSeg()),
          },
          d[0]!.toUpperCase() + d.slice(1),
        ),
      ),
    );
  renderSeg();
  openBtn.addEventListener("click", () => {
    err.textContent = "";
    openBtn.disabled = true;
    app
      .openClassroom(schoolId, difficulty)
      .catch((e: unknown) => (err.textContent = e instanceof ApiError ? e.message : String(e)))
      .finally(() => (openBtn.disabled = false));
  });
  root.append(
    list,
    h(
      "div",
      { class: "card pad", style: "margin-top:20px" },
      h("div", { class: "h2" }, "Open a new class"),
      h(
        "p",
        { class: "dim" },
        "4–15 cadets register with their own personalities. Gentle cadets forgive vague explanations; ruthless ones don't.",
      ),
      h("div", { class: "row wrap-row" }, seg, h("span", { class: "spacer" }), openBtn),
      err,
    ),
  );
  const render = (school: SchoolDetail | null) => {
    if (!school) return fill(list, h("div", { class: "empty" }, "Loading…"));
    const classes = school.classrooms;
    openBtn.disabled = classes.length >= school.classroomLimit;
    if (!classes.length)
      return fill(list, h("div", { class: "empty" }, "No classes yet. Open one below."));
    fill(
      list,
      ...classes.map((c) =>
        h(
          "div",
          { class: "source-row" },
          h(
            "div",
            {},
            h("div", { class: "h2" }, c.name),
            h(
              "div",
              { class: "mono" },
              `${plural(c.cadets, "cadet")} · ${c.difficulty ?? "standard"}`,
            ),
          ),
          h("span", { class: "spacer" }),
          c.status === "active"
            ? h(
                "div",
                { class: "row", style: "gap:8px" },
                h(
                  "button",
                  { class: "btn", onclick: () => app.openDesk(schoolId, c.id) },
                  "Homework & exams",
                ),
                h(
                  "button",
                  { class: "btn primary", onclick: () => app.startClass(c.id) },
                  icon(ICONS.play),
                  "Teach",
                ),
              )
            : statusChip(c.status),
        ),
      ),
    );
  };
  render(store.getState().setup.school);
  return store.subscribe((s, p) =>
    s.setup.school !== p.setup.school ? render(s.setup.school) : undefined,
  );
}
