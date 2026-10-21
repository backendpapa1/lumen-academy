import { ARCHETYPE_INFO } from "@lumen/shared";
import { app } from "../../core/app";
import { initialClassroom } from "../../core/classroom";
import type { Registration } from "../../core/setup";
import { store } from "../../core/store";
import { badgeSrc, portrait } from "./common";
import { fill, h, icon, ICONS } from "./dom";

// Registration (docs/02 §4, M3-07): the 3D classroom fills as cadets arrive;
// enrollment cards slide into the roster; "Class assembled" when all are in.
// Arrivals are paced 1.5–4s apart for drama even when the server is faster.

const MIN_GAP_MS = 1500;
const MAX_GAP_MS = 4000;

export function mountRegistration(
  root: HTMLElement,
  classroomId: string,
  schoolId: string,
): () => void {
  root.classList.add("registration");
  const title = h("h1", { class: "display" }, "…");
  const count = h("div", { class: "mono", "aria-live": "polite" });
  const bar = h(
    "div",
    { class: "progress", style: "width:100%" },
    h("span", { style: "width:0%" }),
  );
  const list = h("div", { class: "reg-list", role: "list", "aria-label": "Enrolled cadets" });
  const panel = h(
    "div",
    { class: "reg-panel" },
    h("div", { class: "micro" }, "Registration"),
    title,
    h("div", { class: "row" }, count),
    bar,
    list,
    h(
      "div",
      { class: "row" },
      h(
        "button",
        { class: "btn quiet", onclick: () => app.openSchool(schoolId, "classes") },
        icon(ICONS.back),
        "School",
      ),
    ),
  );
  const stinger = h("div", { class: "stinger", hidden: true });
  root.append(panel, stinger);

  let shown = 0;
  const cards = new Map<string, { el: HTMLElement; portraitUrl: string | null | undefined }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastShownAt = 0;

  /** Show the next queued arrival after a dramatic pause, if any. */
  const pace = () => {
    if (timer) return;
    const r = store.getState().setup.registration;
    if (!r || r.classroomId !== classroomId || shown >= r.arrivals.length) return finish(r);
    const gap = shown === 0 ? 0 : MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS);
    const wait = Math.max(0, lastShownAt + gap - performance.now());
    timer = setTimeout(() => {
      timer = null;
      lastShownAt = performance.now();
      shown++;
      render(store.getState().setup.registration!);
      pace();
    }, wait);
  };

  const render = (r: Registration) => {
    title.textContent = r.name;
    const visible = r.arrivals.slice(0, shown);
    count.textContent = `${visible.length} of ${r.total} cadets arrived`;
    (bar.firstElementChild as HTMLElement).style.width =
      `${(visible.length / Math.max(1, r.total)) * 100}%`;
    // Cards: newest at the top. Existing cards stay put (no replayed animation);
    // a portrait that just landed swaps in place.
    for (const c of visible) {
      const had = cards.get(c.id);
      if (had) {
        if (had.portraitUrl !== c.portraitUrl) {
          had.el.querySelector(".portrait")!.replaceWith(portrait(c));
          had.portraitUrl = c.portraitUrl;
        }
        continue;
      }
      const info = ARCHETYPE_INFO[c.archetype];
      const badge = badgeSrc(c.archetype);
      const el = h(
        "article",
        { class: "card enroll", role: "listitem", style: `--accent:${info.accent}` },
        portrait(c),
        h(
          "div",
          {},
          h("div", { class: "who" }, c.name),
          h(
            "div",
            { class: "dim", style: "font-size:13px" },
            badge && h("img", { class: "badge", src: badge, alt: "" }),
            `${info.label} · ${c.homeworld}`,
          ),
          c.quirk && h("div", { class: "quirk" }, c.quirk),
        ),
      );
      cards.set(c.id, { el, portraitUrl: c.portraitUrl });
      list.prepend(el);
    }
    // The 3D room shows the cadets that have "arrived" so far.
    store.setState((s) => ({
      classroom: {
        ...initialClassroom(),
        school: { id: schoolId, name: s.setup.school?.name ?? "" },
        classroom: { id: classroomId, name: r.name },
        cadets: Object.fromEntries(visible.map((c) => [c.id, { ...c }])),
      },
    }));
  };

  const finish = (r: Registration | null) => {
    if (!r || r.classroomId !== classroomId) return;
    if (r.status === "error") {
      stinger.hidden = false;
      fill(
        stinger,
        h(
          "div",
          { class: "card pad", style: "max-width:420px" },
          h("div", { class: "h2" }, "Registration didn't finish"),
          h(
            "p",
            { class: "dim" },
            r.detail ?? "Something went wrong while the cadets were registering.",
          ),
          h(
            "button",
            { class: "btn primary", onclick: () => app.openSchool(schoolId, "classes") },
            "Back to the School",
          ),
        ),
      );
      return;
    }
    if (r.status !== "assembled" || shown < r.arrivals.length) return;
    stinger.hidden = false;
    fill(
      stinger,
      h("div", { class: "micro" }, r.name),
      h("div", { class: "display" }, "Class assembled"),
      h(
        "p",
        { class: "lede", style: "margin:0 auto 20px" },
        `${r.total} cadets are in their seats, waiting for you.`,
      ),
      h(
        "button",
        { class: "btn primary", onclick: () => app.startClass(classroomId) },
        icon(ICONS.play),
        "Start teaching",
      ),
    );
    stinger.querySelector("button")?.focus();
  };

  const r0 = store.getState().setup.registration;
  if (r0) render(r0);
  pace();
  const off = store.subscribe((s, p) => {
    if (s.setup.registration === p.setup.registration || !s.setup.registration) return;
    render(s.setup.registration);
    pace();
  });
  return () => {
    off();
    if (timer) clearTimeout(timer);
    root.classList.remove("registration");
  };
}
