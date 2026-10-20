import type { Section } from "./parse.js";

// Chunk step (docs/05 §7): ~600 tokens, 80-token overlap, never across a
// heading boundary. Tokens are estimated (≈4 chars per token for English):
// close enough for sizing, and avoids shipping a tokenizer.

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export interface ChunkOptions {
  targetTokens?: number;
  overlapTokens?: number;
}

export interface Chunk {
  ord: number;
  text: string;
  headingPath: string[];
  pageFrom?: number;
  pageTo?: number;
  tokenCount: number;
}

/** Paragraphs, with fenced code blocks kept whole. */
function paragraphs(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === "") {
      if (current.length) out.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) out.push(current.join("\n"));
  return out;
}

/** Splits an oversized paragraph on sentence ends, then on words. */
function splitLong(p: string, maxTokens: number): string[] {
  if (estimateTokens(p) <= maxTokens) return [p];
  const sentences = p.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [p];
  const pieces: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (estimateTokens(buf + s) > maxTokens && buf) {
      pieces.push(buf.trim());
      buf = "";
    }
    if (estimateTokens(s) > maxTokens) {
      const words = s.split(/\s+/);
      let w = "";
      for (const word of words) {
        if (estimateTokens(`${w} ${word}`) > maxTokens && w) {
          pieces.push(w.trim());
          w = "";
        }
        w += ` ${word}`;
      }
      buf += w;
    } else {
      buf += s;
    }
  }
  if (buf.trim()) pieces.push(buf.trim());
  return pieces;
}

/** The last ~n tokens of text, cut at a word boundary. */
function tail(text: string, tokens: number): string {
  const chars = tokens * 4;
  if (text.length <= chars) return text;
  const cut = text.slice(-chars);
  const space = cut.indexOf(" ");
  return space > 0 ? cut.slice(space + 1) : cut;
}

interface Part {
  text: string;
  page?: number;
}

/**
 * Consecutive sections with the same heading path (e.g. PDF pages) form one
 * stream, so chunks can span page breaks; each chunk records its page range.
 */
function streams(sections: Section[]): Array<{ headingPath: string[]; parts: Part[] }> {
  const out: Array<{ headingPath: string[]; parts: Part[] }> = [];
  for (const section of sections) {
    const parts = paragraphs(section.text).map((text) => ({ text, page: section.pageFrom }));
    const last = out.at(-1);
    const samePath = last && last.headingPath.join("\u0000") === section.headingPath.join("\u0000");
    if (last && samePath && section.pageFrom !== undefined) last.parts.push(...parts);
    else out.push({ headingPath: section.headingPath, parts });
  }
  return out;
}

export function chunkSections(sections: Section[], opts: ChunkOptions = {}): Chunk[] {
  const target = opts.targetTokens ?? 600;
  const overlap = opts.overlapTokens ?? 80;
  const chunks: Chunk[] = [];

  for (const stream of streams(sections)) {
    const parts = stream.parts.flatMap((p) =>
      splitLong(p.text, target).map((text) => ({ text, page: p.page })),
    );
    let buf: Part[] = [];
    let carried = "";

    const emit = () => {
      const body = buf
        .map((p) => p.text)
        .join("\n\n")
        .trim();
      if (!body) return;
      const text = carried ? `${carried}\n\n${body}` : body;
      const pages = buf.map((p) => p.page).filter((p): p is number => p !== undefined);
      chunks.push({
        ord: chunks.length,
        text,
        headingPath: stream.headingPath,
        ...(pages.length ? { pageFrom: Math.min(...pages), pageTo: Math.max(...pages) } : {}),
        tokenCount: estimateTokens(text),
      });
      carried = overlap > 0 ? tail(body, overlap) : "";
      buf = [];
    };

    for (const part of parts) {
      const size =
        estimateTokens([...buf.map((p) => p.text), part.text].join("\n\n")) +
        estimateTokens(carried);
      if (size > target && buf.length) emit();
      buf.push(part);
    }
    emit();
  }
  return chunks;
}
