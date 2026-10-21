import { strFromU8, unzipSync } from "fflate";
import type { ParsedSource, Section } from "../parse.js";

// Slides (V6-03): a .pptx is a zip of XML. One section per slide, headed by its
// title placeholder (else its first line), with the speaker notes after the
// slide text. PDF slide decks go through the existing PDF path.

const xmlText = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

/** Paragraphs of a slide or notes part: <a:p> runs joined, empty ones dropped. */
function paragraphs(xml: string): string[] {
  return [...xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)]
    .map((p) => [...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => xmlText(t[1]!)).join(""))
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** The slide's title: the text in its title (or centre-title) placeholder. */
function slideTitle(xml: string): string | null {
  for (const sp of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g))
    if (/<p:ph\b[^>]*type="(title|ctrTitle)"/.test(sp[0]))
      return paragraphs(sp[0]).join(" ") || null;
  return null;
}

export function parsePptx(bytes: Uint8Array): ParsedSource {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("That .pptx file couldn't be opened.");
  }
  const num = (p: string) => Number(/(\d+)\.xml$/.exec(p)?.[1] ?? 0);
  const slides = Object.keys(files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => num(a) - num(b));
  if (!slides.length) throw new Error("No slides found in that file.");
  const sections: Section[] = [];
  for (const path of slides) {
    const n = num(path);
    const xml = strFromU8(files[path]!);
    const title = slideTitle(xml);
    const body = paragraphs(xml).filter((p) => p !== title);
    const notesPath = `ppt/notesSlides/notesSlide${n}.xml`;
    // Notes parts repeat the slide number in a placeholder; drop bare numbers.
    const notes = files[notesPath]
      ? paragraphs(strFromU8(files[notesPath]!)).filter((p) => !/^\d+$/.test(p))
      : [];
    const text = [...body, ...(notes.length ? ["", "Speaker notes:", ...notes] : [])]
      .join("\n")
      .trim();
    const heading = title ?? body[0] ?? `Slide ${n}`;
    if (!text && !title) continue;
    sections.push({ headingPath: [heading], text: text || heading, pageFrom: n, pageTo: n });
  }
  return {
    sections,
    outline: sections.map((s) => ({ title: s.headingPath[0]!, depth: 1, page: s.pageFrom })),
    pageCount: slides.length,
  };
}
