import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { CurriculumZ, normalizeCurriculum, type Curriculum } from "@lumen/shared";
import { createDeepAgent } from "deepagents";
import type { DbHandle } from "../../db/client.js";
import type { Embedder } from "../../ingest/embed.js";
import type { ModelFactory } from "../../models/factory.js";
import { loadPrompt } from "../prompts/load.js";
import { sourceTools } from "../tools/source.js";

// Curriculum Architect (docs/03 §3.1–3.2): a deep agent with source-analyst and
// curriculum-editor subagents. The server seeds input files into the agent's
// virtual filesystem, reads /out/curriculum.json, validates it, and re-invokes
// once with the problems appended.

export interface ArchitectDeps {
  factory: ModelFactory;
  handle: DbHandle;
  embedder: Embedder;
}

export interface ArchitectResult {
  curriculum: Curriculum;
  warnings: string[];
  attempts: number;
  /** Why earlier attempts were rejected (empty when the first one passed). */
  rejections: string[][];
}

interface SourceRow {
  id: string;
  title: string;
  outline_json: string | null;
}
interface ChunkRow {
  id: string;
  heading_path: string | null;
  page_from: number | null;
  text: string;
}

const fileData = (content: string) => {
  const now = new Date().toISOString();
  return { content, mimeType: "text/markdown", created_at: now, modified_at: now };
};

function seedFiles(
  handle: DbHandle,
  sources: SourceRow[],
): Record<string, ReturnType<typeof fileData>> {
  const files: Record<string, ReturnType<typeof fileData>> = {};
  for (const s of sources) {
    const chunks = handle.sqlite
      .prepare(
        "SELECT id, heading_path, page_from, text FROM chunks WHERE source_id = ? ORDER BY ord",
      )
      .all(s.id) as ChunkRow[];
    const outline = (JSON.parse(s.outline_json ?? "[]") as { title: string; depth: number }[])
      .map((o) => `${"  ".repeat(o.depth - 1)}- ${o.title}`)
      .join("\n");
    files[`/sources/${s.id}/outline.md`] = fileData(
      `# ${s.title}\n\n## Headings\n${outline || "(none)"}\n\n## Chunks\n` +
        chunks
          .map(
            (c) =>
              `- ${c.id}: ${c.heading_path ?? "(no heading)"}${c.page_from ? ` (p.${c.page_from})` : ""}`,
          )
          .join("\n"),
    );
    files[`/sources/${s.id}/chunks.md`] = fileData(
      chunks.map((c) => `### [${c.id}] ${c.heading_path ?? ""}\n\n${c.text}`).join("\n\n"),
    );
  }
  return files;
}

/** Validates against the schema and the school's real chunk ids. Returns problems, or the cleaned curriculum. */
export function checkCurriculum(
  raw: string | undefined,
  validChunkIds: Set<string>,
): { ok: true; curriculum: Curriculum; warnings: string[] } | { ok: false; problems: string[] } {
  if (raw === undefined) return { ok: false, problems: ["/out/curriculum.json was not written"] };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      problems: [`/out/curriculum.json is not valid JSON: ${(err as Error).message}`],
    };
  }
  const parsed = CurriculumZ.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  const curriculum = normalizeCurriculum(parsed.data);
  const problems: string[] = [];
  const warnings: string[] = [];
  const titles = new Set(
    curriculum.modules.flatMap((m) => m.concepts.map((c) => c.title.toLowerCase())),
  );
  for (const m of curriculum.modules) {
    if (!m.goal) problems.push(`module "${m.title}" has an empty goal`);
    for (const c of m.concepts) {
      const bad = c.citations.filter((id) => !validChunkIds.has(id));
      c.citations = c.citations.filter((id) => validChunkIds.has(id));
      if (bad.length) warnings.push(`"${c.title}": dropped unknown citations ${bad.join(", ")}`);
      if (!c.citations.length) problems.push(`concept "${c.title}" has no valid chunk citation`);
      const missing = c.prerequisites.filter((p) => !titles.has(p.toLowerCase()));
      if (missing.length) {
        warnings.push(
          `"${c.title}": dropped prerequisites not in the curriculum: ${missing.join(", ")}`,
        );
        c.prerequisites = c.prerequisites.filter((p) => titles.has(p.toLowerCase()));
      }
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, curriculum, warnings };
}

export async function buildCurriculum(
  deps: ArchitectDeps,
  schoolId: string,
): Promise<ArchitectResult> {
  const { handle } = deps;
  const school = handle.sqlite
    .prepare("SELECT name, description FROM schools WHERE id = ?")
    .get(schoolId) as { name: string; description: string | null } | undefined;
  if (!school) throw new Error(`no school ${schoolId}`);
  const sources = handle.sqlite
    .prepare(
      "SELECT id, title, outline_json FROM sources WHERE school_id = ? AND status = 'ready' ORDER BY created_at",
    )
    .all(schoolId) as SourceRow[];
  if (!sources.length) throw new Error("this School has no indexed sources yet");
  const validChunkIds = new Set(
    (
      handle.sqlite
        .prepare(
          "SELECT c.id FROM chunks c JOIN sources s ON s.id = c.source_id WHERE s.school_id = ? AND s.status = 'ready'",
        )
        .all(schoolId) as { id: string }[]
    ).map((r) => r.id),
  );

  const { model } = deps.factory.getModel("curriculumArchitect");
  const tools = sourceTools({ handle, embedder: deps.embedder, schoolId }).all;
  const agent = createDeepAgent({
    model,
    tools,
    systemPrompt: loadPrompt("curriculumArchitect", {
      schoolName: school.name,
      schoolDescription: school.description ?? "",
      sources: sources.map((s) => ({ id: s.id, title: s.title })),
    }),
    subagents: [
      {
        name: "source-analyst",
        description:
          "Reads one source and writes candidate concepts with key facts, misconceptions and chunk citations to /work/candidates/<sourceId>.json.",
        systemPrompt: loadPrompt("sourceAnalyst"),
        tools,
      },
      {
        name: "curriculum-editor",
        description:
          "Merges /work/candidates/*.json into an ordered curriculum and writes /out/curriculum.json.",
        systemPrompt: loadPrompt("curriculumEditor"),
        tools,
      },
    ],
  });

  let messages: BaseMessage[] = [
    new HumanMessage(`Build the curriculum for "${school.name}" now.`),
  ];
  let files: Record<string, unknown> = seedFiles(handle, sources);
  const rejections: string[][] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = (await agent.invoke({ messages, files } as never, { recursionLimit: 150 })) as {
      messages: BaseMessage[];
      files?: Record<string, { content: string | string[] }>;
    };
    const file = out.files?.["/out/curriculum.json"];
    const raw = file
      ? Array.isArray(file.content)
        ? file.content.join("\n")
        : String(file.content)
      : undefined;
    const check = checkCurriculum(raw, validChunkIds);
    if (check.ok) {
      return {
        curriculum: check.curriculum,
        warnings: check.warnings,
        attempts: attempt,
        rejections,
      };
    }
    rejections.push(check.problems);
    if (attempt === 2)
      throw new Error(`curriculum invalid after re-ask: ${check.problems.join("; ")}`);
    messages = [
      ...out.messages,
      new HumanMessage(
        `The server rejected /out/curriculum.json:\n- ${check.problems.join("\n- ")}\nFix the file and finish.`,
      ),
    ];
    files = out.files ?? files;
  }
  throw new Error("unreachable");
}
