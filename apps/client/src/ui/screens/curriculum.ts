import type { CurriculumBuild, EditableCurriculum } from "@lumen/shared";
import {
  api,
  ApiError,
  type ConceptStatus,
  type CurriculumUnit,
  type CurriculumView,
} from "../../core/api";
import { app } from "../../core/app";
import { store } from "../../core/store";
import { fill, h, icon, ICONS } from "./dom";
import { buildProgress } from "./buildProgress";
import { confirmDialog } from "./modal";

// Curriculum Map (C-2, C-4): modules as columns, concepts as nodes edged in
// their status colour, prerequisite links drawn between them. Select a node to
// edit it; rename, reorder, move, merge, delete and add; one Save sends it all.

type Module = EditableCurriculum["modules"][number];
type Concept = Module["concepts"][number];

const STATUS_LABEL: Record<ConceptStatus, string> = {
  untaught: "Not taught yet",
  taught: "Taught",
  weak: "Needs a recap",
  mastered: "Mastered",
};

/** V5-06 */
interface StartHere {
  conceptId: string;
  title: string;
  reason: string;
  because: Array<{ cadet: string; concept: string; where: string }>;
  path: string[];
}

export function mountCurriculum(
  root: HTMLElement,
  schoolId: string,
  /** V3-04: a parked thought becomes a draft concept (saved only when I save). */
  newConcept?: string,
): () => void {
  let saved: CurriculumView | null = null;
  let draft: EditableCurriculum | null = null;
  let selected: { m: number; c: number } | null = null;
  let merging = false;
  let dirty = false;
  let problems: string[] = [];

  const toolbar = h("div", { class: "row wrap-row", style: "margin-bottom:16px" });
  const banner = h("div", { class: "card pad row extend-banner", hidden: true });
  const map = h("div", { class: "map card", "aria-label": "Curriculum map" });
  const editor = h("aside", { class: "editor card pad", "aria-label": "Concept editor" });
  const savebar = h("div", { class: "savebar card", hidden: true });
  // The build as it runs, or why it stopped; a reload or a tab switch picks it up again.
  const progress = buildProgress(() => void build());
  const setBuild = (b: CurriculumBuild | null) =>
    store.setState((st) => {
      const builds = { ...st.setup.builds };
      if (b) builds[schoolId] = b;
      else delete builds[schoolId];
      return { setup: { ...st.setup, builds } };
    });
  void api
    .get<{ build: CurriculumBuild | null }>(`/api/schools/${schoolId}/curriculum/build`)
    .then((r) => setBuild(r.build))
    .catch(() => undefined);
  root.append(
    toolbar,
    progress.el,
    banner,
    h("div", { class: "map-shell" }, h("div", {}, map, savebar), editor),
  );

  // V5-06: "start here" pins from the prerequisite detective.
  let pins = new Map<string, StartHere>();
  void api
    .get<StartHere[]>(`/api/schools/${schoolId}/start-here`)
    .then((list) => {
      pins = new Map(list.map((p) => [p.conceptId, p]));
      if (saved) render();
    })
    .catch(() => undefined);

  const load = () =>
    api
      .get<CurriculumView>(`/api/schools/${schoolId}/curriculum`)
      .then((c) => {
        saved = c;
        draft = { modules: structuredClone(c.modules) };
        dirty = false;
        problems = [];
        selected = draft.modules[0]?.concepts[0] ? { m: 0, c: 0 } : null;
        render();
        if (newConcept && draft.modules.length) {
          addConcept(draft.modules.length - 1);
          const c = conceptAt()!;
          c.title = newConcept.length > 70 ? `${newConcept.slice(0, 67)}…` : newConcept;
          c.summary = newConcept;
          newConcept = undefined;
          render();
        }
      })
      .catch((e: Error) => fill(map, h("div", { class: "empty" }, e.message)));

  const touch = () => {
    dirty = true;
    render();
  };

  // --- edits ------------------------------------------------------------------

  const allConcepts = () => draft!.modules.flatMap((m) => m.concepts);
  const renameRefs = (from: string, to: string) => {
    for (const c of allConcepts())
      c.prerequisites = c.prerequisites
        .map((p) => (p === from ? to : p))
        .filter((p, i, a) => a.indexOf(p) === i && p !== c.title);
  };
  const removeRefs = (title: string) => {
    for (const c of allConcepts()) c.prerequisites = c.prerequisites.filter((p) => p !== title);
  };
  const conceptAt = (s = selected) => (s ? draft!.modules[s.m]?.concepts[s.c] : undefined);

  const addConcept = (mi: number) => {
    const mod = draft!.modules[mi]!;
    // A new concept borrows a neighbour's citations so it stays grounded; edit as needed.
    const cite = mod.concepts[0]?.citations ?? allConcepts()[0]?.citations ?? [];
    let n = 1;
    while (allConcepts().some((c) => c.title === `New concept ${n}`)) n++;
    mod.concepts.push({
      title: `New concept ${n}`,
      summary: "What this concept is, in a sentence.",
      keyFacts: ["First key fact", "Second key fact"],
      misconceptions: [],
      prerequisites: [],
      citations: [...cite],
      difficulty: 2,
    });
    selected = { m: mi, c: mod.concepts.length - 1 };
    touch();
  };
  const addModule = () => {
    draft!.modules.push({
      title: `Module ${draft!.modules.length + 1}`,
      goal: "What the class should be able to do after this module.",
      concepts: [],
    });
    addConcept(draft!.modules.length - 1);
  };
  const moveConcept = (dir: -1 | 1) => {
    if (!selected) return;
    const list = draft!.modules[selected.m]!.concepts;
    const j = selected.c + dir;
    if (j < 0 || j >= list.length) return;
    [list[selected.c], list[j]] = [list[j]!, list[selected.c]!];
    selected = { m: selected.m, c: j };
    touch();
  };
  const moveToModule = (mi: number) => {
    if (!selected || mi === selected.m) return;
    const [c] = draft!.modules[selected.m]!.concepts.splice(selected.c, 1);
    draft!.modules[mi]!.concepts.push(c!);
    selected = { m: mi, c: draft!.modules[mi]!.concepts.length - 1 };
    touch();
  };
  const deleteConcept = () => {
    const c = conceptAt();
    if (!c || !selected) return;
    if (allConcepts().length <= 1)
      return app.notify("A curriculum needs at least one concept.", "warn");
    draft!.modules[selected.m]!.concepts.splice(selected.c, 1);
    removeRefs(c.title);
    if (!draft!.modules[selected.m]!.concepts.length) draft!.modules.splice(selected.m, 1);
    selected = null;
    touch();
  };
  /** Merge `other` into the selected concept (C-2): facts, misconceptions, citations and links combine. */
  const mergeInto = (target: { m: number; c: number }, other: { m: number; c: number }) => {
    const a = conceptAt(target)!;
    const b = conceptAt(other)!;
    if (a === b) return;
    const uniq = (xs: string[]) => [...new Set(xs)];
    a.keyFacts = uniq([...a.keyFacts, ...b.keyFacts]);
    a.misconceptions = uniq([...a.misconceptions, ...b.misconceptions]);
    a.citations = uniq([...a.citations, ...b.citations]);
    a.prerequisites = uniq([...a.prerequisites, ...b.prerequisites]).filter(
      (p) => p !== a.title && p !== b.title,
    );
    a.difficulty = Math.max(a.difficulty, b.difficulty);
    draft!.modules[other.m]!.concepts.splice(other.c, 1);
    renameRefs(b.title, a.title);
    if (!draft!.modules[other.m]!.concepts.length) draft!.modules.splice(other.m, 1);
    // Re-find the target (indices may have shifted).
    for (const [mi, m] of draft!.modules.entries()) {
      const ci = m.concepts.indexOf(a);
      if (ci >= 0) selected = { m: mi, c: ci };
    }
    merging = false;
    app.notify(`Merged "${b.title}" into "${a.title}".`);
    touch();
  };

  const save = () => {
    api
      .put<{ updated: number; added: number; deleted: number }>(
        `/api/schools/${schoolId}/curriculum`,
        draft,
      )
      .then((s) => {
        app.notify(
          `Curriculum saved: ${s.updated} updated, ${s.added} added, ${s.deleted} removed.`,
        );
        return load();
      })
      .catch((e: unknown) => {
        problems =
          e instanceof ApiError ? (e.problems.length ? e.problems : [e.message]) : [String(e)];
        render();
      });
  };

  const build = async () => {
    if (
      saved?.modules.length &&
      !(await confirmDialog(
        "Rebuild the curriculum?",
        "The Curriculum Architect will read your sources again and replace this curriculum, including your edits.",
        "Rebuild",
      ))
    )
      return;
    api
      .post(`/api/schools/${schoolId}/curriculum/generate`)
      .catch((e: Error) => app.notify(e.message, "error"));
  };

  // --- render -------------------------------------------------------------------

  const render = () => {
    const job = store.getState().setup.curriculumJob;
    const live = store.getState().setup.builds[schoolId] ?? null;
    progress.update(live);
    const building =
      (job?.schoolId === schoolId && job.status === "building") || live?.status === "building";
    const sources = store.getState().setup.school?.sources ?? [];
    const hasReady = sources.some((s) => s.status === "ready");
    fill(
      toolbar,
      h("h2", { class: "h2" }, "Curriculum map"),
      // Without live progress (an older server), at least say it's working.
      building &&
        !live &&
        h(
          "span",
          { class: "chip busy" },
          h("span", { class: "dot" }),
          "The Curriculum Architect is reading your sources…",
        ),
      job?.schoolId === schoolId &&
        job.status === "error" &&
        !live &&
        h("span", { class: "chip err" }, h("span", { class: "dot" }), job.detail ?? "Build failed"),
      h("span", { class: "spacer" }),
      legend(),
      h(
        "button",
        {
          class: `btn ${saved?.modules.length ? "" : "primary"}`,
          disabled: building || !hasReady,
          onclick: () => void build(),
          title: hasReady ? "" : "Add a source first",
        },
        icon(ICONS.sparkle),
        saved?.modules.length ? "Rebuild" : "Build curriculum",
      ),
    );
    // S-5: new sources since the curriculum was built → offer to extend (edits kept).
    const fresh = saved?.newSources ?? [];
    banner.hidden = !fresh.length || building;
    fill(
      banner,
      h(
        "div",
        { style: "flex:1" },
        h(
          "b",
          {},
          fresh.length === 1
            ? `“${fresh[0]!.title}” isn't in the curriculum yet.`
            : `${fresh.length} new sources aren't in the curriculum yet.`,
        ),
        h(
          "div",
          { class: "dim", style: "font-size:13px" },
          "Add what they cover as new modules. Your edits stay as they are.",
        ),
      ),
      h(
        "button",
        {
          class: "btn primary",
          onclick: () =>
            api
              .post(`/api/schools/${schoolId}/curriculum/extend`)
              .then(() => app.notify("The Curriculum Architect is reading the new sources…"))
              .catch((e: Error) => app.notify(e.message, "error")),
        },
        icon(ICONS.plus),
        "Add to the curriculum",
      ),
    );

    if (!draft) return fill(map, h("div", { class: "empty" }, "Loading…"));
    if (!draft.modules.length) {
      fill(
        map,
        h(
          "div",
          { class: "empty", style: "margin:auto" },
          hasReady
            ? "No curriculum yet. Build one from your sources: modules, concepts and the facts each one rests on."
            : "Add a source first; the curriculum is built from it.",
        ),
      );
      editor.hidden = true;
      return;
    }
    editor.hidden = false;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "links");
    svg.setAttribute("aria-hidden", "true");
    const addButton = h(
      "button",
      { class: "btn", style: "align-self:flex-start", onclick: addModule },
      icon(ICONS.plus),
      "Module",
    );
    const grouped = draft.modules.some((m) => m.unit);
    map.classList.toggle("grouped", grouped);
    if (!grouped) {
      fill(map, svg, ...draft.modules.map((m, mi) => moduleColumn(m, mi)), addButton);
    } else {
      // Book by book: each book's modules in a band, with what was covered.
      const bands: Array<{ key: string; title: string; sourceId: string | null; items: number[] }> =
        [];
      draft.modules.forEach((m, mi) => {
        const key = m.unit?.sourceId ?? m.unit?.title ?? "__own";
        const last = bands.at(-1);
        if (last && last.key === key) last.items.push(mi);
        else
          bands.push({
            key,
            title: m.unit?.title ?? "Your own modules",
            sourceId: m.unit?.sourceId ?? null,
            items: [mi],
          });
      });
      fill(
        map,
        svg,
        ...bands.map((b, i) =>
          h(
            "section",
            { class: "unit-band", "aria-label": b.title },
            unitHead(
              b,
              saved?.units?.find((u) => u.sourceId === b.sourceId),
            ),
            h(
              "div",
              { class: "unit-row" },
              ...b.items.map((mi) => moduleColumn(draft!.modules[mi]!, mi)),
              i === bands.length - 1 && addButton,
            ),
          ),
        ),
      );
    }
    requestAnimationFrame(() => drawLinks(svg));
    renderEditor();
    savebar.hidden = !dirty && !problems.length;
    fill(
      savebar,
      problems.length
        ? h(
            "div",
            { class: "error-text", style: "margin:0" },
            ...problems.slice(0, 4).flatMap((p) => [p, h("br")]),
          )
        : h("span", {}, "You have unsaved changes."),
      h("span", { class: "spacer" }),
      h("button", { class: "btn quiet", onclick: () => load() }, "Discard"),
      h("button", { class: "btn primary", onclick: save }, "Save changes"),
    );
  };

  /** A book's header: its name, how much of it the curriculum covers, and the gaps. */
  const unitHead = (b: { title: string; sourceId: string | null }, unit?: CurriculumUnit) => {
    const chapters = unit?.chapters ?? [];
    const taught = chapters.filter((c) => c.state === "taught").length;
    const skipped = chapters.filter((c) => c.state === "skipped");
    const failed = chapters.filter((c) => c.state === "failed");
    const concepts = chapters.reduce((n, c) => n + c.concepts, 0);
    const building = store.getState().setup.builds[schoolId]?.status === "building";
    return h(
      "header",
      { class: "unit-head" },
      h("span", { class: "micro" }, unit ? "Book" : "Added by you"),
      h("h3", { class: "unit-title" }, b.title),
      unit &&
        h(
          "span",
          {
            class: "dim small unit-cover",
            title: chapters
              .map((c) => `${c.title}: ${c.state}${c.reason ? ` (${c.reason})` : ""}`)
              .join("\n"),
          },
          `${taught} of ${chapters.length - skipped.length} chapters · ${concepts} concepts` +
            (skipped.length
              ? ` · skipped ${skipped
                  .map((c) => c.title)
                  .slice(0, 3)
                  .join(", ")}${skipped.length > 3 ? "…" : ""}`
              : ""),
        ),
      failed.length > 0 &&
        h(
          "span",
          {
            class: "chip err",
            title: failed.map((c) => `${c.title}: ${c.reason ?? ""}`).join("\n"),
          },
          `${failed.length} chapter${failed.length === 1 ? "" : "s"} couldn't be read`,
        ),
      failed.length > 0 &&
        b.sourceId &&
        h(
          "button",
          {
            class: "btn small",
            disabled: building,
            onclick: () =>
              api
                .post(`/api/schools/${schoolId}/curriculum/gaps`, { sourceId: b.sourceId })
                .then(() => app.notify(`Reading the missing chapters of “${b.title}” again…`))
                .catch((e: Error) => app.notify(e.message, "error")),
          },
          "Fill the gaps",
        ),
    );
  };

  const moduleColumn = (m: Module, mi: number) => {
    const title = h("textarea", {
      class: "grow",
      rows: 1,
      "aria-label": `Module ${mi + 1} title`,
      maxlength: 80,
    });
    title.value = m.title;
    title.addEventListener(
      "keydown",
      (e) => e.key === "Enter" && (e.preventDefault(), title.blur()),
    );
    title.addEventListener("change", () => {
      m.title = title.value.trim() || m.title;
      touch();
    });
    const goal = h("textarea", {
      class: "field grow",
      rows: 1,
      "aria-label": `Module ${mi + 1} goal`,
      style: "font-size:12px;padding:6px 8px;color:var(--ink-dim)",
    });
    goal.value = m.goal;
    goal.addEventListener("change", () => {
      m.goal = goal.value.trim();
      touch();
    });
    return h(
      "section",
      { class: "module", "aria-label": m.title },
      h(
        "div",
        { class: "module-head" },
        title,
        h(
          "button",
          {
            class: "btn small icon-only quiet",
            title: "Add a concept",
            "aria-label": `Add a concept to ${m.title}`,
            onclick: () => addConcept(mi),
          },
          icon(ICONS.plus),
        ),
      ),
      goal,
      ...m.concepts.map((c, ci) => node(c, mi, ci)),
    );
  };

  const node = (c: Concept, mi: number, ci: number) => {
    const st = c.id ? saved?.status[c.id] : undefined;
    const status: ConceptStatus = st?.status ?? "untaught";
    const isSel = selected?.m === mi && selected.c === ci;
    const b = h(
      "button",
      {
        class: `node${merging && !isSel ? " marked" : ""}`,
        "data-status": status,
        "data-title": c.title,
        "aria-pressed": String(isSel),
        "aria-label": `${c.title}. ${STATUS_LABEL[status]}.`,
        onclick: () => {
          if (merging && selected && !isSel) return mergeInto(selected, { m: mi, c: ci });
          selected = { m: mi, c: ci };
          merging = false;
          render();
        },
      },
      c.title,
      h(
        "span",
        { class: "meta" },
        `${STATUS_LABEL[status]}${st?.comprehension != null && status !== "untaught" ? ` · ${Math.round(st.comprehension * 100)}%` : ""} · ${c.keyFacts.length} facts`,
      ),
    );
    const pin = c.id ? pins.get(c.id) : undefined;
    if (pin) {
      b.classList.add("start-here");
      b.append(
        h(
          "span",
          {
            class: "pin-tag",
            title: `${pin.reason} ${pin.because
              .slice(0, 4)
              .map((x) => `${x.cadet}'s ${x.where} miss on ${x.concept}`)
              .join("; ")}. Path: ${pin.path.join(" → ")}`,
          },
          `Start here · ${pin.because.length} miss${pin.because.length === 1 ? "" : "es"}`,
        ),
      );
    }
    return b;
  };

  const drawLinks = (svg: SVGSVGElement) => {
    const box = map.getBoundingClientRect();
    const nodes = new Map<string, DOMRect>();
    map
      .querySelectorAll<HTMLElement>(".node")
      .forEach((n) => nodes.set(n.dataset.title!, n.getBoundingClientRect()));
    const sel = conceptAt();
    const paths: string[] = [];
    for (const c of allConcepts()) {
      const to = nodes.get(c.title);
      for (const p of c.prerequisites) {
        const from = nodes.get(p);
        if (!from || !to) continue;
        const x1 = from.right - box.left + map.scrollLeft;
        const y1 = from.top + from.height / 2 - box.top;
        const x2 = to.left - box.left + map.scrollLeft;
        const y2 = to.top + to.height / 2 - box.top;
        const sameColumn = Math.abs(from.left - to.left) < 4;
        const d = sameColumn
          ? `M${from.left - box.left + map.scrollLeft} ${y1} C${from.left - box.left - 24} ${y1}, ${to.left - box.left - 24} ${y2}, ${to.left - box.left + map.scrollLeft} ${y2}`
          : `M${x1} ${y1} C${x1 + 40} ${y1}, ${x2 - 40} ${y2}, ${x2} ${y2}`;
        const hot = sel && (sel.title === c.title || sel.title === p);
        paths.push(`<path d="${d}"${hot ? ' class="hot"' : ""}/>`);
      }
    }
    svg.setAttribute("width", String(map.scrollWidth));
    svg.setAttribute("height", String(map.scrollHeight));
    svg.innerHTML = paths.join(""); // numbers and fixed markup only
  };

  const renderEditor = () => {
    const c = conceptAt();
    if (!c || !selected) {
      fill(editor, h("p", { class: "dim" }, "Select a concept to edit it."));
      return;
    }
    const sel = selected;
    const others = allConcepts().filter((x) => x !== c);
    const title = h("textarea", { class: "field grow", id: "c-title", rows: 1, maxlength: 120 });
    title.value = c.title;
    title.addEventListener(
      "keydown",
      (e) => e.key === "Enter" && (e.preventDefault(), title.blur()),
    );
    title.addEventListener("change", () => {
      const t = title.value.trim();
      if (!t || t === c.title) return;
      if (allConcepts().some((x) => x !== c && x.title.toLowerCase() === t.toLowerCase())) {
        app.notify("Another concept already has that title.", "warn");
        title.value = c.title;
        return;
      }
      renameRefs(c.title, t);
      c.title = t;
      touch();
    });
    const summary = h("textarea", { class: "field grow", id: "c-summary", rows: 2 });
    summary.value = c.summary;
    summary.addEventListener("change", () => {
      c.summary = summary.value.trim() || c.summary;
      touch();
    });
    const difficulty = h(
      "select",
      { class: "field", id: "c-diff" },
      ...[1, 2, 3, 4, 5].map((d) =>
        h(
          "option",
          { value: d, selected: d === c.difficulty },
          ["", "Intro", "Easy", "Medium", "Hard", "Expert"][d]!,
        ),
      ),
    );
    difficulty.addEventListener("change", () => {
      c.difficulty = Number(difficulty.value);
      touch();
    });
    const moduleSel = h(
      "select",
      { class: "field", id: "c-module", "aria-label": "Module" },
      ...draft!.modules.map((m, mi) => h("option", { value: mi, selected: mi === sel.m }, m.title)),
    );
    moduleSel.addEventListener("change", () => moveToModule(Number(moduleSel.value)));
    const prereqs = h(
      "div",
      { class: "list-editor" },
      ...(others.length
        ? others.map((o) => {
            const box = h("input", {
              type: "checkbox",
              checked: c.prerequisites.includes(o.title),
            });
            box.addEventListener("change", () => {
              c.prerequisites = box.checked
                ? [...c.prerequisites, o.title]
                : c.prerequisites.filter((p) => p !== o.title);
              touch();
            });
            return h("label", { class: "row", style: "gap:8px;font-size:13px" }, box, o.title);
          })
        : [h("span", { class: "dim" }, "No other concepts yet.")]),
    );
    fill(
      editor,
      h("div", { class: "micro" }, "Concept"),
      h("label", { class: "lbl", for: "c-title" }, "Title"),
      title,
      h("label", { class: "lbl", for: "c-summary" }, "Summary"),
      summary,
      h("label", { class: "lbl" }, "Key facts (what a student must get right)"),
      listEditor(c.keyFacts, (xs) => ((c.keyFacts = xs), touch()), 2, "Add a fact"),
      h("label", { class: "lbl" }, "Common misconceptions"),
      listEditor(
        c.misconceptions,
        (xs) => ((c.misconceptions = xs), touch()),
        0,
        "Add a misconception",
      ),
      h(
        "div",
        { class: "two-col", style: "gap:12px" },
        h("div", {}, h("label", { class: "lbl", for: "c-diff" }, "Difficulty"), difficulty),
        h("div", {}, h("label", { class: "lbl", for: "c-module" }, "Module"), moduleSel),
      ),
      h("label", { class: "lbl" }, "Builds on"),
      prereqs,
      h(
        "p",
        { class: "mono", style: "margin:12px 0 0" },
        `Grounded in ${c.citations.length} source passage${c.citations.length === 1 ? "" : "s"}`,
      ),
      h(
        "div",
        { class: "row wrap-row", style: "margin-top:16px;gap:8px" },
        h(
          "button",
          {
            class: "btn small icon-only",
            "aria-label": "Move up",
            title: "Move up",
            onclick: () => moveConcept(-1),
          },
          icon(ICONS.up),
        ),
        h(
          "button",
          {
            class: "btn small icon-only",
            "aria-label": "Move down",
            title: "Move down",
            onclick: () => moveConcept(1),
          },
          icon(ICONS.down),
        ),
        h(
          "button",
          {
            class: `btn small${merging ? " primary" : ""}`,
            disabled: !others.length,
            onclick: () => ((merging = !merging), render()),
          },
          icon(ICONS.merge),
          merging ? "Now click the concept to merge in" : "Merge…",
        ),
        h("span", { class: "spacer" }),
        h(
          "button",
          { class: "btn small danger", onclick: deleteConcept },
          icon(ICONS.trash),
          "Delete",
        ),
      ),
    );
  };

  void load();
  const off = store.subscribe((s, p) => {
    if (s.setup.curriculumJob !== p.setup.curriculumJob) {
      if (s.setup.curriculumJob?.status === "ready" && s.setup.curriculumJob.schoolId === schoolId)
        void load();
      else render();
    }
    if (s.setup.school !== p.setup.school) render();
    if (s.setup.builds[schoolId] !== p.setup.builds[schoolId]) render();
  });
  const onResize = () => render();
  window.addEventListener("resize", onResize);
  return () => {
    off();
    progress.dispose();
    window.removeEventListener("resize", onResize);
  };
}

function listEditor(items: string[], set: (xs: string[]) => void, min: number, addLabel: string) {
  const wrap = h("div", { class: "list-editor" });
  items.forEach((it, i) => {
    const input = h("textarea", {
      class: "field grow",
      rows: 1,
      "aria-label": `${addLabel.replace("Add a ", "")} ${i + 1}`,
      style: "font-size:13px",
    });
    input.value = it;
    input.addEventListener("change", () => {
      const next = [...items];
      next[i] = input.value.trim();
      set(next.filter(Boolean).length >= min ? next.filter(Boolean) : next);
    });
    wrap.append(
      h(
        "div",
        { class: "row", style: "gap:6px" },
        input,
        h(
          "button",
          {
            class: "btn small icon-only quiet",
            "aria-label": "Remove",
            disabled: items.length <= min,
            onclick: () => set(items.filter((_, j) => j !== i)),
          },
          icon(ICONS.close),
        ),
      ),
    );
  });
  wrap.append(
    h(
      "button",
      {
        class: "btn small quiet",
        style: "align-self:flex-start",
        onclick: () => set([...items, "New item"]),
      },
      icon(ICONS.plus),
      addLabel,
    ),
  );
  return wrap;
}

function legend() {
  const item = (color: string, label: string) =>
    h("span", {}, h("i", { style: `background:${color}` }), label);
  return h(
    "div",
    { class: "legend", "aria-label": "Status colours" },
    item("var(--cobalt-wash)", "Not taught"),
    item("var(--cobalt)", "Taught"),
    item("var(--coral)", "Needs a recap"),
    item("var(--marigold)", "Mastered"),
  );
}
