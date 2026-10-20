import { extractText } from "unpdf";

// Parse step of ingestion (docs/05 §7): plain text with heading and page markers.

export type SourceKind = "pdf" | "md" | "txt" | "paste";

export interface Section {
  /** e.g. ["The Blockchain", "Merkle Trees"]; empty when the source has no headings. */
  headingPath: string[];
  text: string;
  pageFrom?: number;
  pageTo?: number;
}

export interface OutlineNode {
  title: string;
  depth: number;
  page?: number;
}

export interface ParsedSource {
  sections: Section[];
  outline: OutlineNode[];
  pageCount?: number;
}

/** Markdown: split on ATX headings outside code fences; keep a heading stack. */
export function parseMarkdown(md: string): ParsedSource {
  const sections: Section[] = [];
  const outline: OutlineNode[] = [];
  const stack: string[] = [];
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text) sections.push({ headingPath: [...stack], text });
    buffer = [];
  };

  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      const depth = heading[1]!.length;
      const title = heading[2]!.trim();
      stack.length = Math.min(stack.length, depth - 1);
      while (stack.length < depth - 1) stack.push("");
      stack.push(title);
      outline.push({ title, depth });
      continue;
    }
    buffer.push(line);
  }
  flush();
  for (const s of sections) s.headingPath = s.headingPath.filter(Boolean);
  return { sections, outline };
}

export function parseText(text: string): ParsedSource {
  const clean = text.replace(/\r\n?/g, "\n").trim();
  return { sections: clean ? [{ headingPath: [], text: clean }] : [], outline: [] };
}

/** PDF: one section per page (headings aren't reliable in PDF text). */
export async function parsePdf(bytes: Uint8Array): Promise<ParsedSource> {
  const { totalPages, text } = await extractText(bytes, { mergePages: false });
  const sections = text
    .map((pageText, i) => ({
      headingPath: [],
      text: pageText.replace(/[ \t]+\n/g, "\n").trim(),
      pageFrom: i + 1,
      pageTo: i + 1,
    }))
    .filter((s) => s.text.length > 0);
  return {
    sections,
    outline: sections.map((s) => ({ title: `Page ${s.pageFrom}`, depth: 1, page: s.pageFrom })),
    pageCount: totalPages,
  };
}

/** Pasted text is treated as Markdown when it has headings, else plain text. */
export async function parseSource(
  kind: SourceKind,
  data: Uint8Array | string,
): Promise<ParsedSource> {
  const asText = () => (typeof data === "string" ? data : new TextDecoder().decode(data));
  switch (kind) {
    case "pdf":
      if (typeof data === "string") throw new Error("PDF sources must be bytes");
      return parsePdf(data);
    case "md":
      return parseMarkdown(asText());
    case "txt":
      return parseText(asText());
    case "paste": {
      const text = asText();
      return /^#{1,6}\s+\S/m.test(text) ? parseMarkdown(text) : parseText(text);
    }
  }
}
