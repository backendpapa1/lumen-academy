import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { DbHandle } from "../db/client.js";
import { newId } from "../db/ids.js";
import { chunks as chunksTable, schools, sources } from "../db/schema.js";
import { chunkSections } from "./chunk.js";
import type { Embedder } from "./embed.js";
import { parseSource, type SourceKind } from "./parse.js";

export interface IngestDeps {
  handle: DbHandle;
  embedder: Embedder;
  /** Uploaded files are copied to <dataDir>/uploads/. */
  dataDir: string;
  onStatus?: (status: SourceStatus, detail?: string) => void;
}

export type SourceStatus = "queued" | "parsing" | "embedding" | "ready" | "error";

export interface IngestInput {
  schoolId: string;
  title: string;
  kind: SourceKind;
  data: Uint8Array | string;
}

export interface IngestResult {
  sourceId: string;
  chunks: number;
  tokens: number;
  pageCount?: number;
}

const EXT: Record<SourceKind, string> = { pdf: "pdf", md: "md", txt: "txt", paste: "txt" };

/** Text sent to the embedder: heading path first, so sections are findable by topic. */
export const embeddingText = (headingPath: string[], text: string) =>
  headingPath.length ? `${headingPath.join(" > ")}\n\n${text}` : text;

export async function ingestSource(deps: IngestDeps, input: IngestInput): Promise<IngestResult> {
  const { db, sqlite } = deps.handle;
  const sourceId = newId("source");
  const now = () => new Date().toISOString();
  const setStatus = (status: SourceStatus, extra: Partial<typeof sources.$inferInsert> = {}) => {
    db.update(sources)
      .set({ status, ...extra })
      .where(eq(sources.id, sourceId))
      .run();
    deps.onStatus?.(status, extra.error ?? undefined);
  };

  let filePath: string | undefined;
  if (input.kind !== "paste") {
    const dir = join(deps.dataDir, "uploads");
    mkdirSync(dir, { recursive: true });
    filePath = join(dir, `${sourceId}.${EXT[input.kind]}`);
    writeFileSync(filePath, input.data);
  }
  db.insert(sources)
    .values({
      id: sourceId,
      schoolId: input.schoolId,
      title: input.title,
      kind: input.kind,
      filePath,
      status: "queued",
      createdAt: now(),
    })
    .run();
  deps.onStatus?.("queued");

  try {
    setStatus("parsing");
    const parsed = await parseSource(input.kind, input.data);
    const chunks = chunkSections(parsed.sections);
    if (!chunks.length) throw new Error("no text found in source");
    const rows = chunks.map((c) => ({ ...c, id: newId("chunk") }));

    sqlite.transaction(() => {
      for (const c of rows) {
        db.insert(chunksTable)
          .values({
            id: c.id,
            sourceId,
            ord: c.ord,
            text: c.text,
            headingPath: c.headingPath.length ? c.headingPath.join(" > ") : null,
            pageFrom: c.pageFrom ?? null,
            pageTo: c.pageTo ?? null,
            tokenCount: c.tokenCount,
          })
          .run();
      }
    })();
    setStatus("embedding", {
      pageCount: parsed.pageCount ?? null,
      outlineJson: JSON.stringify(parsed.outline),
    });

    const vectors = await deps.embedder.embed(
      rows.map((c) => embeddingText(c.headingPath, c.text)),
    );
    const insertVec = sqlite.prepare("INSERT INTO chunk_vec (chunk_id, embedding) VALUES (?, ?)");
    sqlite.transaction(() => rows.forEach((c, i) => insertVec.run(c.id, vectors[i]!)))();

    setStatus("ready");
    return {
      sourceId,
      chunks: rows.length,
      tokens: rows.reduce((s, c) => s + c.tokenCount, 0),
      pageCount: parsed.pageCount,
    };
  } catch (err) {
    // Leave no half-indexed chunks behind: retrieval must only see ready sources.
    sqlite
      .prepare(
        "DELETE FROM chunk_vec WHERE chunk_id IN (SELECT id FROM chunks WHERE source_id = ?)",
      )
      .run(sourceId);
    db.delete(chunksTable).where(eq(chunksTable.sourceId, sourceId)).run();
    setStatus("error", { error: (err as Error).message.slice(0, 500) });
    throw err;
  }
}

/** Finds a school by case-insensitive name, creating it on the next campus slot (S-1). */
export function ensureSchool(
  handle: DbHandle,
  name: string,
  description?: string,
): { id: string; created: boolean } {
  const { db } = handle;
  const existing = db
    .select({ id: schools.id })
    .from(schools)
    .where(sql`lower(${schools.name}) = lower(${name})`)
    .get();
  if (existing) return { id: existing.id, created: false };
  const slot = db
    .select({ max: sql<number | null>`max(${schools.campusSlot})` })
    .from(schools)
    .get()?.max;
  const id = newId("school");
  db.insert(schools)
    .values({
      id,
      name,
      description: description ?? null,
      campusSlot: (slot ?? -1) + 1,
      createdAt: new Date().toISOString(),
    })
    .run();
  return { id, created: true };
}
