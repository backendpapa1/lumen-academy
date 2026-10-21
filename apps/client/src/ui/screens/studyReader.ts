import { api } from "../../core/api";
import { app } from "../../core/app";
import { narrator } from "../../core/narrator";
import { SERVER_HTTP } from "../../core/net";
import { fill, h, icon, ICONS } from "./dom";
import {
  SHOW_PASSAGE,
  type ReaderChapter,
  type ShowPassage,
  type StudyData,
  type StudySource,
} from "./studyTypes";

// The study hall's reader: the PDF in the browser's own viewer, or the text
// the School indexed. A chapter at a time ("Chapter 4 · about 12 min"), ticked
// off when read; a focus band that dims all but the paragraph I'm on; reading
// aloud; and quotes into my notes, tied to the concept their passage teaches.

const LAST_SOURCE = "lumen.studySource";
const BAND_KEY = "lumen.studyFocusBand";

interface SourceText {
  title: string;
  url: string | null;
  sections: Array<{ id: string; heading: string | null; page: number | null; text: string }>;
}

export interface Reader {
  /** The passages I'm looking at now (text: on screen; PDF: the chosen chapter). */
  around(): string[];
  /** The chapter I'm in, for a one-tap intention. */
  chapterTitle(): string | null;
  dispose(): void;
}

export function mountReader(el: HTMLElement, d: StudyData): Reader {
  const none: Reader = { around: () => [], chapterTitle: () => null, dispose: () => {} };
  if (!d.sources.length) {
    fill(
      el,
      h(
        "div",
        { class: "sh-empty" },
        h("div", { class: "h2" }, "No sources ready yet"),
        h(
          "p",
          { class: "dim" },
          `Add a PDF, notes or a link on ${d.school.name}'s Sources tab, and it opens here.`,
        ),
        h(
          "button",
          { class: "btn", onclick: () => app.openSchool(d.school.id, "sources") },
          "Open Sources",
        ),
      ),
    );
    return none;
  }
  let remembered: string | null = null;
  try {
    remembered = localStorage.getItem(`${LAST_SOURCE}.${d.school.id}`);
  } catch {
    /* fine */
  }
  let band = false;
  try {
    band = localStorage.getItem(BAND_KEY) === "1";
  } catch {
    /* fine */
  }
  let current: StudySource = d.sources.find((s) => s.id === remembered) ?? d.sources[0]!;
  let mode: "original" | "text" = current.original ? "original" : "text";
  let chapters: ReaderChapter[] = [];
  let chapter: ReaderChapter | null = null;
  /** Scroll to this passage once the text is in. */
  let pending: string | null = null;
  const visible = new Set<string>();
  let observer: IntersectionObserver | null = null;
  let focusObserver: IntersectionObserver | null = null;

  const body = h("div", { class: "sh-page" });
  const bar = h("div", { class: "sh-bar" });
  const chapterBar = h("div", { class: "sh-chapters" });
  const fileUrl = (page?: number | null) =>
    `${SERVER_HTTP}/api/schools/${d.school.id}/sources/${current.id}/file#view=FitH${page ? `&page=${page}` : ""}`;

  const remember = () => {
    try {
      localStorage.setItem(`${LAST_SOURCE}.${d.school.id}`, current.id);
    } catch {
      /* fine */
    }
  };

  // --- chapters ---------------------------------------------------------------------
  const loadChapters = () => {
    const sid = current.id;
    chapters = [];
    chapter = null;
    fill(chapterBar);
    api
      .get<{ chapters: ReaderChapter[] }>(`/api/schools/${d.school.id}/sources/${sid}/chapters`)
      .then((r) => {
        if (current.id !== sid) return;
        chapters = r.chapters.filter((c) => !c.skip);
        chapter = chapters.find((c) => !c.read) ?? chapters[0] ?? null;
        renderChapters();
      })
      .catch(() => undefined);
  };
  const chapterOf = (chunkId: string) => chapters.find((c) => c.chunkIds.includes(chunkId));
  const renderChapters = () => {
    if (chapters.length < 2) return fill(chapterBar);
    const read = chapters.filter((c) => c.read).length;
    const pick = h(
      "select",
      {
        class: "field",
        "aria-label": "Chapter",
        onchange: (e: Event) => {
          chapter = chapters.find((c) => c.key === (e.target as HTMLSelectElement).value) ?? null;
          if (chapter) goTo(chapter.firstChunkId, chapter.firstPage);
          renderChapters();
        },
      },
      ...chapters.map((c) =>
        h(
          "option",
          { value: c.key, selected: c.key === chapter?.key },
          `${c.read ? "✓ " : ""}${c.title} · about ${c.minutes} min`,
        ),
      ),
    );
    const mark =
      chapter &&
      h(
        "button",
        {
          class: `btn small ${chapter.read ? "quiet" : ""}`,
          onclick: () => {
            const c = chapter!;
            const next = !c.read;
            void api
              .put(`/api/schools/${d.school.id}/sources/${current.id}/chapters/${c.key}/read`, {
                read: next,
              })
              .then(() => {
                c.read = next;
                if (next) {
                  app.notify(`Read: ${c.title}.`);
                  const after = chapters[chapters.indexOf(c) + 1];
                  if (after && !after.read) chapter = after;
                }
                renderChapters();
              })
              .catch((e: Error) => app.notify(e.message, "error"));
          },
        },
        chapter.read ? "Read ✓" : "Mark as read",
      );
    fill(
      chapterBar,
      pick,
      mark,
      h("span", { class: "spacer" }),
      h(
        "div",
        {
          class: "sh-progress",
          title: `${read} of ${chapters.length} chapters read`,
          role: "img",
          "aria-label": `${read} of ${chapters.length} chapters read`,
        },
        h("i", { style: `width:${Math.round((read / chapters.length) * 100)}%` }),
      ),
      h("span", { class: "mono small" }, `${read}/${chapters.length}`),
    );
  };

  /** Show a passage: scroll to it in the text, or open the PDF at its page. */
  const goTo = (chunkId: string, page: number | null) => {
    if (mode === "original") {
      const frame = body.querySelector("iframe");
      if (frame) frame.src = fileUrl(page);
      return;
    }
    const at = body.querySelector<HTMLElement>(`[data-chunk="${CSS.escape(chunkId)}"]`);
    if (!at) {
      pending = chunkId;
      return;
    }
    at.scrollIntoView({ block: "start", behavior: "smooth" });
    at.classList.add("sh-flash");
    setTimeout(() => at.classList.remove("sh-flash"), 1600);
  };

  // --- the page -----------------------------------------------------------------------
  const readAloud = () => {
    const paras = [...body.querySelectorAll<HTMLElement>(".sh-text p")];
    const top = body.getBoundingClientRect().top;
    const from = paras.findIndex((p) => p.getBoundingClientRect().bottom > top + 8);
    const text = paras
      .slice(Math.max(0, from), Math.max(0, from) + 4)
      .map((p) => p.textContent ?? "")
      .join("\n\n");
    if (!text.trim()) return app.notify("Scroll to what you want read first.");
    void narrator.say(text);
  };

  const render = () => {
    remember();
    observer?.disconnect();
    focusObserver?.disconnect();
    visible.clear();
    fill(
      bar,
      d.sources.length > 1
        ? h(
            "select",
            {
              class: "field",
              "aria-label": "Source",
              onchange: (e: Event) => {
                current = d.sources.find((s) => s.id === (e.target as HTMLSelectElement).value)!;
                mode = current.original ? "original" : "text";
                render();
                loadChapters();
              },
            },
            ...d.sources.map((s) =>
              h("option", { value: s.id, selected: s.id === current.id }, s.title),
            ),
          )
        : h("b", { class: "sh-title" }, current.title),
      h("span", { class: "spacer" }),
      current.original &&
        h(
          "div",
          { class: "seg", role: "group", "aria-label": "View" },
          ...(["original", "text"] as const).map((m) =>
            h(
              "button",
              {
                "aria-pressed": String(mode === m),
                onclick: () => {
                  mode = m;
                  render();
                },
              },
              m === "original" ? "PDF" : "Text",
            ),
          ),
        ),
      mode === "text" &&
        h(
          "button",
          {
            class: "btn small quiet",
            "aria-pressed": String(band),
            title: "Dim everything but the paragraph you're on",
            onclick: () => {
              band = !band;
              try {
                localStorage.setItem(BAND_KEY, band ? "1" : "0");
              } catch {
                /* fine */
              }
              render();
            },
          },
          "Focus band",
        ),
      mode === "text" &&
        h(
          "button",
          {
            class: "btn small quiet",
            title: "Read the next few paragraphs aloud",
            onclick: readAloud,
          },
          icon(ICONS.speaker),
          "Read aloud",
        ),
      mode === "text" &&
        h(
          "button",
          {
            class: "btn small",
            title: "Select some text first",
            onclick: () => void quoteSelection(body, d.school.id, current),
          },
          icon(ICONS.pencil),
          "Add selection to notes",
        ),
      current.url &&
        h(
          "a",
          { class: "btn small quiet", href: current.url, target: "_blank", rel: "noreferrer" },
          "Open the link",
        ),
      mode === "original" &&
        h(
          "a",
          { class: "btn small quiet", href: fileUrl(), target: "_blank", rel: "noreferrer" },
          "Open in a new tab",
        ),
    );
    if (mode === "original") {
      fill(
        body,
        h("iframe", { class: "sh-pdf", title: current.title, src: fileUrl(chapter?.firstPage) }),
      );
      return;
    }
    fill(body, h("p", { class: "dim pad" }, "Opening…"));
    const id = current.id;
    api
      .get<SourceText>(`/api/schools/${d.school.id}/sources/${id}/text`)
      .then((t) => {
        if (current.id !== id) return;
        const art = article(t);
        art.classList.toggle("banded", band);
        fill(body, art);
        // What's on screen: for the student who leans over, and the chapter I'm in.
        observer = new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              const k = (e.target as HTMLElement).dataset.chunk!;
              if (e.isIntersecting) visible.add(k);
              else visible.delete(k);
            }
            const first = [...visible][0];
            const ch = first ? chapterOf(first) : undefined;
            if (ch && ch !== chapter) {
              chapter = ch;
              renderChapters();
            }
          },
          { root: body },
        );
        art.querySelectorAll<HTMLElement>("[data-chunk]").forEach((s) => observer!.observe(s));
        if (band) {
          // The paragraph crossing the upper middle of the page is the one in focus.
          focusObserver = new IntersectionObserver(
            (entries) => {
              for (const e of entries) e.target.classList.toggle("in-focus", e.isIntersecting);
            },
            { root: body, rootMargin: "-30% 0px -55% 0px" },
          );
          art.querySelectorAll("p").forEach((p) => focusObserver!.observe(p));
        }
        if (pending) {
          const p = pending;
          pending = null;
          requestAnimationFrame(() => goTo(p, null));
        }
      })
      .catch((e: Error) => fill(body, h("p", { class: "error-text pad" }, e.message)));
  };

  const onShow = (e: Event) => {
    const { sourceId, chunkId } = (e as CustomEvent<ShowPassage>).detail;
    const src = d.sources.find((s) => s.id === sourceId);
    if (!src) return app.notify("That passage's source isn't ready to read.");
    if (src.id !== current.id || mode !== "text") {
      current = src;
      mode = "text";
      pending = chunkId;
      render();
      loadChapters();
    } else goTo(chunkId, null);
  };
  document.addEventListener(SHOW_PASSAGE, onShow);

  fill(el, bar, chapterBar, body);
  render();
  loadChapters();
  return {
    around: () =>
      mode === "text" && visible.size ? [...visible] : (chapter?.chunkIds.slice(0, 40) ?? []),
    chapterTitle: () => chapter?.title ?? null,
    dispose() {
      observer?.disconnect();
      focusObserver?.disconnect();
      document.removeEventListener(SHOW_PASSAGE, onShow);
      narrator.stop();
    },
  };
}

/** The indexed text, with headings and page marks; text nodes only, never HTML. */
function article(t: SourceText): HTMLElement {
  const out = h("article", { class: "sh-text" }, h("h2", { class: "h2" }, t.title));
  let lastHeading: string | null = null;
  let lastPage: number | null = null;
  for (const s of t.sections) {
    if (s.page !== null && s.page !== lastPage) {
      out.append(h("div", { class: "sh-pagemark mono small" }, `p. ${s.page}`));
      lastPage = s.page;
    }
    const heading = s.heading?.split(" > ").at(-1) ?? null;
    const sec = h("section", { "data-chunk": s.id, "data-page": s.page ?? "" });
    if (heading && heading !== lastHeading) {
      sec.append(h("h3", {}, heading));
      lastHeading = heading;
    }
    for (const para of s.text.split(/\n{2,}/)) {
      const line = para.trim();
      if (!line) continue;
      const md = /^(#{1,6})\s+(.*)$/.exec(line);
      sec.append(md ? h("h4", {}, md[2]!) : h("p", {}, line));
    }
    out.append(sec);
  }
  return out;
}

/** "Add selection to notes": the quote, where it came from, and the concept it teaches. */
async function quoteSelection(scope: HTMLElement, schoolId: string, source: StudySource) {
  const sel = getSelection();
  const text = sel?.toString().trim() ?? "";
  if (!text || !sel?.anchorNode || !scope.contains(sel.anchorNode)) {
    app.notify("Select a passage in the text first.");
    return;
  }
  const sec = sel.anchorNode.parentElement?.closest<HTMLElement>("[data-chunk]");
  const page = sec?.dataset.page ? Number(sec.dataset.page) : null;
  const flat = text.replace(/\n+/g, " ");
  let concept: { title: string } | null = null;
  try {
    concept = (
      await api.post<{ concept: { title: string } | null }>(
        `/api/schools/${schoolId}/study/quotes`,
        {
          text: flat,
          sourceId: source.id,
          chunkId: sec?.dataset.chunk ?? null,
          page,
        },
      )
    ).concept;
  } catch {
    /* the note still gets the quote */
  }
  document.dispatchEvent(
    new CustomEvent("study:quote", {
      detail: `> ${flat}\n> (${source.title}${page ? `, p. ${page}` : ""}${concept ? ` · ${concept.title}` : ""})\n\n`,
    }),
  );
  if (concept) app.notify(`Quoted, and linked to ${concept.title}: it'll show in class.`);
}
