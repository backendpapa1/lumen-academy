import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, runMigrations, type DbHandle } from "../db/client.js";
import { chunks, sources } from "../db/schema.js";
import { chunkSections, estimateTokens } from "./chunk.js";
import { EMBEDDING_DIMS, OpenAIEmbedder, type Embedder } from "./embed.js";
import { parseMarkdown, parseSource } from "./parse.js";
import { embeddingText, ensureSchool, ingestSource } from "./pipeline.js";
import { loadConfig } from "../config/load.js";

/** A real (tiny) PDF with one line of text per page. */
function makePdf(pages: string[]): Uint8Array {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  const fontId = 3 + pages.length * 2;
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
    );
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

const para = (n: number, word = "merkle") =>
  Array.from({ length: n }, (_, i) => `${word}${i}`).join(" ") + ".";

describe("parse", () => {
  it("splits markdown on headings with a heading path, ignoring # inside code fences", () => {
    const parsed = parseMarkdown(
      "# Book\nIntro.\n## Merkle Trees\nPairs.\n```\n# not a heading\n```\n### Paths\nLog2.\n## Mining\nHash.",
    );
    expect(parsed.sections.map((s) => [s.headingPath.join(" > "), s.text.split("\n")[0]])).toEqual([
      ["Book", "Intro."],
      ["Book > Merkle Trees", "Pairs."],
      ["Book > Merkle Trees > Paths", "Log2."],
      ["Book > Mining", "Hash."],
    ]);
    expect(parsed.sections[1]!.text).toContain("# not a heading");
    expect(parsed.outline.map((o) => o.depth)).toEqual([1, 2, 3, 2]);
  });

  it("parses PDFs page by page", async () => {
    const parsed = await parseSource(
      "pdf",
      makePdf(["The Merkle root lives in the header.", "Light clients use Merkle paths."]),
    );
    expect(parsed.pageCount).toBe(2);
    expect(parsed.sections.map((s) => [s.pageFrom, s.text])).toEqual([
      [1, "The Merkle root lives in the header."],
      [2, "Light clients use Merkle paths."],
    ]);
  });

  it("treats pasted text with headings as markdown", async () => {
    expect((await parseSource("paste", "## A\nx")).sections[0]!.headingPath).toEqual(["A"]);
    expect((await parseSource("paste", "just text")).sections[0]!.headingPath).toEqual([]);
  });
});

describe("chunkSections", () => {
  it("keeps chunks near the target size and never crosses a heading", () => {
    const sections = [
      { headingPath: ["A"], text: Array.from({ length: 12 }, () => para(80)).join("\n\n") },
      { headingPath: ["B"], text: para(20, "pow") },
    ];
    const out = chunkSections(sections, { targetTokens: 600, overlapTokens: 80 });
    const a = out.filter((c) => c.headingPath[0] === "A");
    const b = out.filter((c) => c.headingPath[0] === "B");
    expect(a.length).toBeGreaterThan(2);
    expect(Math.max(...a.map((c) => c.tokenCount))).toBeLessThanOrEqual(600 + 80);
    expect(b).toHaveLength(1);
    expect(b[0]!.text).not.toContain("merkle");
    expect(out.map((c) => c.ord)).toEqual(out.map((_, i) => i));
  });

  it("overlaps consecutive chunks by about the overlap size", () => {
    const out = chunkSections(
      [
        {
          headingPath: [],
          text: Array.from({ length: 10 }, (_, i) => para(80, `p${i}w`)).join("\n\n"),
        },
      ],
      { targetTokens: 300, overlapTokens: 40 },
    );
    const prevTail = out[0]!.text.split(" ").slice(-3).join(" ");
    expect(out[1]!.text).toContain(prevTail);
    const overlap = out[1]!.text.slice(0, out[1]!.text.indexOf("\n\n"));
    expect(estimateTokens(overlap)).toBeLessThanOrEqual(45);
  });

  it("splits a single oversized paragraph", () => {
    const out = chunkSections([{ headingPath: [], text: para(2000) }], {
      targetTokens: 600,
      overlapTokens: 0,
    });
    expect(out.length).toBeGreaterThan(3);
    expect(Math.max(...out.map((c) => c.tokenCount))).toBeLessThanOrEqual(600);
  });

  it("lets PDF chunks span pages and records the page range", () => {
    const pages = [1, 2, 3].map((p) => ({
      headingPath: [],
      text: para(150, `pg${p}w`),
      pageFrom: p,
      pageTo: p,
    }));
    const out = chunkSections(pages, { targetTokens: 600, overlapTokens: 0 });
    expect(out[0]!.pageFrom).toBe(1);
    expect(out[0]!.pageTo).toBeGreaterThan(1);
    expect(out.at(-1)!.pageTo).toBe(3);
  });
});

/** Deterministic fake: one-hot-ish vectors so tests don't call the API. */
class FakeEmbedder implements Embedder {
  calls: string[][] = [];
  async embed(texts: string[]) {
    this.calls.push(texts);
    return texts.map((t) => {
      const v = new Float32Array(EMBEDDING_DIMS);
      v[t.length % EMBEDDING_DIMS] = 1;
      return v;
    });
  }
}

describe("ingestSource", () => {
  let h: DbHandle;
  let dataDir: string;
  beforeEach(() => {
    h = openDb(":memory:");
    runMigrations(h);
    dataDir = mkdtempSync(join(tmpdir(), "lumen-ingest-"));
  });
  afterEach(() => h.close());

  it("indexes the fixture chapter: chunks, FTS, vectors, outline, status ready", async () => {
    const school = ensureSchool(h, "Blockchain");
    expect(ensureSchool(h, "blockchain")).toEqual({ id: school.id, created: false });
    const statuses: string[] = [];
    const embedder = new FakeEmbedder();
    const md = readFileSync(
      join(import.meta.dirname, "../../../../fixtures/blockchain-ch1/source.md"),
      "utf8",
    );
    const res = await ingestSource(
      { handle: h, embedder, dataDir, onStatus: (s) => statuses.push(s) },
      { schoolId: school.id, title: "Ch. 11", kind: "md", data: md },
    );

    expect(statuses).toEqual(["queued", "parsing", "embedding", "ready"]);
    expect(res.chunks).toBeGreaterThan(8);
    const src = h.db.select().from(sources).where(eq(sources.id, res.sourceId)).get()!;
    expect(src.status).toBe("ready");
    expect(
      JSON.parse(src.outlineJson!).some((o: { title: string }) => o.title === "Merkle Trees"),
    ).toBe(true);
    expect(readFileSync(src.filePath!, "utf8")).toBe(md);

    const vecCount = h.sqlite.prepare("SELECT count(*) n FROM chunk_vec").get() as { n: number };
    expect(vecCount.n).toBe(res.chunks);
    const fts = h.sqlite
      .prepare(
        "SELECT c.heading_path FROM chunk_fts f JOIN chunks c ON c.rowid = f.rowid WHERE chunk_fts MATCH 'merkle' LIMIT 50",
      )
      .all() as { heading_path: string }[];
    expect(fts.some((r) => r.heading_path.includes("Merkle Trees"))).toBe(true);
    // Embedding input carries the heading path; stored text does not.
    expect(embedder.calls[0]!.some((t) => t.startsWith("The Blockchain > Merkle Trees\n\n"))).toBe(
      true,
    );
    expect(
      h.db
        .select()
        .from(chunks)
        .all()
        .every((c) => !c.text.startsWith("The Blockchain >")),
    ).toBe(true);
  });

  it("marks the source as error and leaves no chunks when embedding fails", async () => {
    const school = ensureSchool(h, "X");
    const failing: Embedder = {
      embed: async () => {
        throw new Error("rate limited");
      },
    };
    await expect(
      ingestSource(
        { handle: h, embedder: failing, dataDir },
        { schoolId: school.id, title: "t", kind: "paste", data: "Some text." },
      ),
    ).rejects.toThrow("rate limited");
    const src = h.db.select().from(sources).get()!;
    expect(src).toMatchObject({ status: "error", error: "rate limited" });
    expect(h.db.select().from(chunks).all()).toEqual([]);
  });

  it("rejects an empty source", async () => {
    const school = ensureSchool(h, "X");
    await expect(
      ingestSource(
        { handle: h, embedder: new FakeEmbedder(), dataDir },
        { schoolId: school.id, title: "t", kind: "txt", data: "   " },
      ),
    ).rejects.toThrow(/no text/);
  });

  it("formats embedding text", () => {
    expect(embeddingText(["A", "B"], "x")).toBe("A > B\n\nx");
    expect(embeddingText([], "x")).toBe("x");
  });
});

describe("OpenAIEmbedder", () => {
  const config = loadConfig({ env: {} }).models;
  it("batches by 100, meters usage, keeps order and checks dimensions", async () => {
    const recorded: unknown[] = [];
    let calls = 0;
    const client = {
      embeddings: {
        create: async ({ input }: { input: string[] }) => {
          calls++;
          return {
            data: input
              .map((_, i) => ({
                index: input.length - 1 - i,
                embedding: Array(EMBEDDING_DIMS).fill(input.length - 1 - i),
              }))
              .reverse(),
            usage: { prompt_tokens: input.length * 10, total_tokens: input.length * 10 },
          };
        },
      },
    };
    const embedder = new OpenAIEmbedder({
      config,
      env: {},
      client: client as never,
      meter: { record: (e) => recorded.push(e), assertCanCall: () => {} },
    });
    const out = await embedder.embed(Array.from({ length: 250 }, (_, i) => `t${i}`));
    expect(calls).toBe(3);
    expect(out).toHaveLength(250);
    expect(out[1]![0]).toBe(1);
    expect(recorded).toHaveLength(3);
    expect(recorded[0]).toMatchObject({
      agent: "embeddings",
      model: "text-embedding-3-small",
      inputTokens: 1000,
    });
  });

  it("refuses when the budget guard pauses", async () => {
    const embedder = new OpenAIEmbedder({
      config,
      env: {},
      client: { embeddings: { create: async () => ({ data: [], usage: {} }) } } as never,
      meter: {
        record: () => {},
        assertCanCall: () => {
          throw new Error("paused");
        },
      },
    });
    await expect(embedder.embed(["x"])).rejects.toThrow("paused");
  });
});
