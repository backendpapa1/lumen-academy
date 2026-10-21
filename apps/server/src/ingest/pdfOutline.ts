import type { getDocumentProxy } from "unpdf";

type PDFDocumentProxy = Awaited<ReturnType<typeof getDocumentProxy>>;

// A PDF's own outline (bookmarks): chapters and sections with the page each
// starts on. Without it a book is just "Page 1 … Page 484", and the
// curriculum can't follow its chapters.

export interface PdfOutlineNode {
  title: string;
  depth: number;
  page: number;
}

export async function readPdfOutline(
  pdf: PDFDocumentProxy,
  maxDepth = 3,
): Promise<PdfOutlineNode[]> {
  const out: PdfOutlineNode[] = [];
  const walk = async (
    items: Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>,
    depth: number,
  ) => {
    for (const it of items ?? []) {
      let page: number | null = null;
      try {
        const dest = typeof it.dest === "string" ? await pdf.getDestination(it.dest) : it.dest;
        const ref = dest?.[0];
        if (ref && typeof ref === "object") page = (await pdf.getPageIndex(ref as never)) + 1;
        else if (typeof ref === "number") page = ref + 1;
      } catch {
        /* a broken bookmark: skip it */
      }
      const title = it.title.replace(/\s+/g, " ").trim();
      if (page && title) out.push({ title, depth, page });
      if (depth < maxDepth && it.items?.length) await walk(it.items, depth + 1);
    }
  };
  try {
    await walk(await pdf.getOutline(), 1);
  } catch {
    return [];
  }
  return out;
}

/** The chapter and section a page sits in (the last of each that starts on or before it). */
export function headingsForPage(outline: PdfOutlineNode[], page: number): string[] {
  const at = (depth: number, from: number) =>
    outline.filter((o) => o.depth === depth && o.page <= page && o.page >= from).at(-1);
  const chapter = at(1, 0);
  if (!chapter) return [];
  const section = at(2, chapter.page);
  return section ? [chapter.title, section.title] : [chapter.title];
}
