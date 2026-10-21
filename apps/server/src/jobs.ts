import type { Transcriber } from "./speech/stt.js";
import {
  ARCHETYPE_INFO,
  registerFor,
  type Archetype,
  type CadetView,
  type CurriculumBuild,
} from "@lumen/shared";
import { emblemMotifs } from "./agents/artDirector.js";
import { buildUnits, fillGaps } from "./agents/curriculum/build.js";
import { BuildTracker, explainBuildError } from "./agents/curriculum/progress.js";
import { emblemPrompt, portraitPrompt, type PortraitSubject } from "./assets/prompts.js";
import type { AssetService } from "./assets/service.js";
import type { DbHandle } from "./db/client.js";
import type { EventBus } from "./events.js";
import type { Embedder } from "./ingest/embed.js";
import type { SourceKind } from "./ingest/parse.js";
import { ingestSource } from "./ingest/pipeline.js";
import type { ModelFactory } from "./models/factory.js";
import { refreshTiers } from "./game/campus.js";
import { registerClassroom, type RegisteredCadet } from "./game/registrar.js";
import type { Difficulty } from "./game/registration.js";
import type { GameConfig, ArtPromptsConfig } from "@lumen/shared";
import type { UsageMeter } from "./usage/meter.js";

// Background jobs behind the School setup REST routes (docs/05 §6–7). Each
// returns as soon as the work is identifiable and reports progress on the bus.

export interface JobDeps {
  handle: DbHandle;
  factory: ModelFactory;
  meter: UsageMeter;
  game: GameConfig;
  art: ArtPromptsConfig;
  bus: EventBus;
  dataDir: string;
  embedder?: Embedder;
  assets?: AssetService;
  /** V6-01: local Whisper, for talks uploaded as audio. */
  speech?: { stt: Transcriber };
}

/** Emblem accents rotate through the archetype palette, so neighbouring schools differ. */
const ACCENTS = Object.values(ARCHETYPE_INFO).map((a) => a.accent);

export function schoolAccent(campusSlot: number): string {
  return ACCENTS[campusSlot % ACCENTS.length]!;
}

/** S-4: emblem in the background; the school works without it. */
export async function generateEmblem(deps: JobDeps, schoolId: string): Promise<void> {
  if (!deps.assets) return;
  const s = deps.handle.sqlite
    .prepare(
      "SELECT name, description, campus_slot AS slot, accent_color AS accent FROM schools WHERE id = ?",
    )
    .get(schoolId) as {
    name: string;
    description: string | null;
    slot: number;
    accent: string | null;
  };
  const accent = s.accent ?? schoolAccent(s.slot);
  const motifs = await emblemMotifs(deps.factory, s).catch(
    () => "an open book with a small star above it",
  );
  const asset = deps.assets.request({
    kind: "emblem",
    prompt: emblemPrompt(deps.art, { schoolName: s.name, motifs, accent }),
    size: "1024x1024",
    quality: "high",
    transparent: true,
    outPx: 512,
    ownerType: "school",
    ownerId: schoolId,
  });
  deps.handle.sqlite
    .prepare("UPDATE schools SET emblem_asset_id = ?, accent_color = ? WHERE id = ?")
    .run(asset.id, accent, schoolId);
}

/** Schools made before emblems existed (or whose emblem failed) get one, once each. */
export function backfillEmblems(deps: JobDeps): number {
  if (!deps.assets) return 0;
  const rows = deps.handle.sqlite
    .prepare(
      `SELECT s.id FROM schools s LEFT JOIN assets a ON a.id = s.emblem_asset_id
       WHERE s.archived = 0 AND (s.emblem_asset_id IS NULL OR a.status = 'error')`,
    )
    .all() as Array<{ id: string }>;
  for (const r of rows) void generateEmblem(deps, r.id).catch(() => undefined);
  return rows.length;
}

/** S-2/S-3: index a source; status streams on the bus. */
export function addSource(
  deps: JobDeps,
  input: {
    schoolId: string;
    title: string;
    kind: SourceKind;
    data: Uint8Array | string;
    url?: string;
  },
): Promise<{ sourceId: string; chunks: number } | null> {
  if (!deps.embedder) throw new Error("indexing needs an OpenAI key for embeddings");
  let sourceId: string | null = null;
  return ingestSource(
    {
      handle: deps.handle,
      embedder: deps.embedder,
      dataDir: deps.dataDir,
      onStatus: (status, detail, id) => {
        sourceId = id ?? sourceId;
        deps.bus.emit({
          type: "source.status",
          payload: {
            schoolId: input.schoolId,
            sourceId,
            title: input.title,
            status,
            ...(detail ? { detail } : {}),
          },
        });
      },
    },
    input,
  )
    .then((r) => ({ sourceId: r.sourceId, chunks: r.chunks }))
    .catch((err: unknown) => {
      deps.bus.emit({
        type: "source.status",
        payload: {
          schoolId: input.schoolId,
          sourceId,
          title: input.title,
          status: "error",
          detail: (err as Error).message,
        },
      });
      return null;
    });
}

const building = new Set<string>();

/** The latest build state per School, so a reload or a new window sees it. */
const builds = new Map<string, CurriculumBuild>();
const BUILD_ERROR_KEY = (schoolId: string) => `curriculumBuildError:${schoolId}`;

/** What's building (or last failed) for a School, for GET …/curriculum/build. */
export function curriculumBuildState(
  deps: Pick<JobDeps, "handle">,
  schoolId: string,
): CurriculumBuild | null {
  const live = builds.get(schoolId);
  if (live) return live;
  // A failure survives a restart, so the error is still there to read.
  const row = deps.handle.sqlite
    .prepare("SELECT value_json v FROM settings WHERE key = ?")
    .get(BUILD_ERROR_KEY(schoolId)) as { v: string } | undefined;
  return row ? (JSON.parse(row.v) as CurriculumBuild) : null;
}

/** Streams progress: every stage change at once, otherwise at most once a second. */
function progressEmitter(deps: JobDeps, schoolId: string) {
  let last = 0;
  let lastStage = "";
  let pending: ReturnType<typeof setTimeout> | undefined;
  const send = (s: CurriculumBuild) => {
    last = Date.now();
    lastStage = s.stage;
    builds.set(schoolId, structuredClone(s));
    deps.bus.emit({ type: "curriculum.progress", payload: structuredClone(s) });
  };
  return {
    emit(s: CurriculumBuild) {
      builds.set(schoolId, structuredClone(s));
      clearTimeout(pending);
      if (s.stage !== lastStage || Date.now() - last > 1000) send(s);
      else pending = setTimeout(() => send(s), 1000 - (Date.now() - last));
    },
    stop() {
      clearTimeout(pending);
    },
  };
}

/** Runs one build with live progress, the end state, and a plain-language error. */
async function runBuild(
  deps: JobDeps,
  schoolId: string,
  extending: boolean,
  work: (
    track: (books: Array<{ id: string; title: string; chapters: number }>) => BuildTracker,
  ) => Promise<string>,
): Promise<boolean> {
  const out = progressEmitter(deps, schoolId);
  let tracker: BuildTracker | null = null;
  const track = (books: Array<{ id: string; title: string; chapters: number }>) =>
    (tracker = new BuildTracker(schoolId, books, (s) => out.emit(s), extending));
  // A heartbeat while it builds: one model call can take minutes and say nothing.
  const beat = setInterval(() => {
    const t = tracker as BuildTracker | null;
    if (t) deps.bus.emit({ type: "curriculum.progress", payload: structuredClone(t.state) });
  }, 10_000);
  deps.handle.sqlite.prepare("DELETE FROM settings WHERE key = ?").run(BUILD_ERROR_KEY(schoolId));
  try {
    const detail = await work(track);
    clearInterval(beat);
    out.stop();
    const t = tracker as BuildTracker | null;
    const done: CurriculumBuild = {
      ...(t?.state ?? blankBuild(schoolId)),
      status: "ready",
      stage: "done",
      label: `Done: ${detail}`,
      fraction: 1,
      waitingSince: null,
      detail,
    };
    builds.delete(schoolId);
    deps.bus.emit({ type: "curriculum.progress", payload: done });
    deps.bus.emit({ type: "curriculum.status", payload: { schoolId, status: "ready", detail } });
    return true;
  } catch (err) {
    clearInterval(beat);
    out.stop();
    const reason = explainBuildError(err);
    console.error(`curriculum build failed for ${schoolId}:`, err);
    const t = tracker as BuildTracker | null;
    const failed: CurriculumBuild = {
      ...(t?.state ?? blankBuild(schoolId)),
      status: "error",
      stage: "failed",
      label: "The build stopped",
      waitingSince: null,
      error: reason,
    };
    builds.delete(schoolId);
    deps.handle.sqlite
      .prepare(
        "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
      )
      .run(BUILD_ERROR_KEY(schoolId), JSON.stringify(failed));
    deps.bus.emit({ type: "curriculum.progress", payload: failed });
    deps.bus.emit({
      type: "curriculum.status",
      payload: { schoolId, status: "error", detail: reason },
    });
    return false;
  }
}

function blankBuild(schoolId: string): CurriculumBuild {
  const now = new Date().toISOString();
  return {
    schoolId,
    status: "building",
    stage: "preparing",
    label: "",
    fraction: 0,
    sources: [],
    calls: 0,
    startedAt: now,
    lastActivityAt: now,
    waitingSince: null,
  };
}

const describeBuild = (s: {
  units: number;
  modules: number;
  concepts: number;
  skipped: number;
  failed: number;
}) =>
  `${s.units > 1 ? `${s.units} books, ` : ""}${s.modules} modules, ${s.concepts} concepts` +
  (s.failed
    ? ` · ${s.failed} chapter${s.failed === 1 ? "" : "s"} couldn't be read: Fill the gaps to retry`
    : "");

/** C-1: the curriculum, built book by book; one build per School at a time. */
export async function generateCurriculum(deps: JobDeps, schoolId: string): Promise<boolean> {
  if (building.has(schoolId)) return false;
  building.add(schoolId);
  deps.bus.emit({ type: "curriculum.status", payload: { schoolId, status: "building" } });
  try {
    return await runBuild(deps, schoolId, false, async (track) =>
      describeBuild(
        await buildUnits({ factory: deps.factory, handle: deps.handle }, schoolId, {
          rebuild: true,
          track,
        }),
      ),
    );
  } finally {
    building.delete(schoolId);
  }
}

/** Re-reads one book's chapters that failed, adding what they teach. */
export async function fillCurriculumGaps(
  deps: JobDeps,
  schoolId: string,
  sourceId: string,
): Promise<boolean> {
  if (building.has(schoolId)) return false;
  building.add(schoolId);
  deps.bus.emit({
    type: "curriculum.status",
    payload: { schoolId, status: "building", detail: "gaps" },
  });
  try {
    return await runBuild(deps, schoolId, true, async (track) => {
      const r = await fillGaps(
        { factory: deps.factory, handle: deps.handle },
        schoolId,
        sourceId,
        track,
      );
      return (
        `filled ${r.filled} chapters with ${r.concepts} concepts` +
        (r.stillFailed ? ` · ${r.stillFailed} still couldn't be read` : "")
      );
    });
  } finally {
    building.delete(schoolId);
  }
}

/** S-5: indexed sources none of whose passages any concept cites yet. */
export function sourcesOutsideCurriculum(
  handle: DbHandle,
  schoolId: string,
): Array<{ id: string; title: string }> {
  return handle.sqlite
    .prepare(
      `SELECT s.id, s.title FROM sources s WHERE s.school_id = ? AND s.status = 'ready'
         AND EXISTS (SELECT 1 FROM concepts c JOIN modules m ON m.id = c.module_id WHERE m.school_id = s.school_id)
         AND NOT EXISTS (SELECT 1 FROM concept_citations cc JOIN chunks ch ON ch.id = cc.chunk_id WHERE ch.source_id = s.id)
       ORDER BY s.created_at`,
    )
    .all(schoolId) as Array<{ id: string; title: string }>;
}

/**
 * S-5: extend the curriculum with sources added later. The Architect reads only
 * the new sources, knowing what's already taught; its modules are appended to
 * the current curriculum, so your edits stay as they are.
 */
export async function extendCurriculum(deps: JobDeps, schoolId: string): Promise<boolean> {
  const fresh = sourcesOutsideCurriculum(deps.handle, schoolId);
  if (!fresh.length) throw new Error("Every source is already in the curriculum.");
  if (building.has(schoolId)) return false;
  building.add(schoolId);
  deps.bus.emit({
    type: "curriculum.status",
    payload: { schoolId, status: "building", detail: "extending" },
  });
  try {
    return await runBuild(deps, schoolId, true, async (track) => {
      const sources = deps.handle.sqlite
        .prepare(
          `SELECT id, title, kind, file_path filePath FROM sources WHERE id IN (${fresh.map(() => "?").join(",")}) ORDER BY created_at`,
        )
        .all(...fresh.map((f) => f.id)) as Array<{
        id: string;
        title: string;
        kind: string;
        filePath: string | null;
      }>;
      const summary = await buildUnits({ factory: deps.factory, handle: deps.handle }, schoolId, {
        sources,
        track,
      });
      return `added ${describeBuild(summary)}`;
    });
  } finally {
    building.delete(schoolId);
  }
}

export interface CadetAppearance {
  ageRange: string;
  genderPresentation: string;
  heritageHint: string;
  visualQuirk?: string;
  hair?: string;
  /** The Registrar's (or the voice caster's) "higher"/"lower" for the name. */
  voice?: string;
}

/** Medium portrait price × count must fit the image budget; otherwise only the first few get one (docs/07 §6). */
function portraitAllowance(deps: JobDeps, total: number): number {
  if (!deps.game.registration.portraits) return 0;
  const price = deps.meter.imagePrice?.("medium") ?? 0.015;
  const left = deps.meter.imageBudgetLeft();
  return Math.min(total, Math.floor(left / Math.max(price, 0.001)), total);
}

/**
 * R-2/R-3: registers a Classroom. Resolves once the Classroom exists (with
 * its id and cohort size); cadets then arrive on the bus, each with a
 * portrait requested in the background.
 */
export function startRegistration(
  deps: JobDeps,
  input: { schoolId: string; difficulty?: Difficulty },
): Promise<{ classroomId: string; name: string; total: number }> {
  return new Promise((resolve, reject) => {
    let created: { classroomId: string; name: string; total: number } | null = null;
    let allowance = 0;
    registerClassroom(
      { handle: deps.handle, factory: deps.factory, game: deps.game },
      {
        schoolId: input.schoolId,
        difficulty: input.difficulty,
        onCreated: (classroomId, name, total) => {
          created = { classroomId, name, total };
          allowance = deps.assets ? portraitAllowance(deps, total) : 0;
          deps.bus.emit({
            type: "registration.started",
            payload: { classroomId, schoolId: input.schoolId, name, total },
          });
          resolve(created);
        },
        onArrival: (cadet, index, total) => {
          const portraitAssetId = index <= allowance ? requestPortrait(deps, cadet) : null;
          deps.bus.emit({
            type: "registration.arrival",
            payload: {
              classroomId: created!.classroomId,
              cadet: cadetView(deps, cadet, portraitAssetId),
              index,
              total,
            },
          });
        },
      },
    )
      .then(() => {
        if (!created) return;
        refreshTiers(deps.handle, deps.game, deps.assets); // first class: Blueprint → Frame
        deps.bus.emit({
          type: "registration.done",
          payload: { classroomId: created.classroomId, status: "active" },
        });
      })
      .catch((err: unknown) => {
        if (!created) return reject(err as Error);
        deps.bus.emit({
          type: "registration.done",
          payload: {
            classroomId: created.classroomId,
            status: "error",
            detail: (err as Error).message,
          },
        });
      });
  });
}

function requestPortrait(deps: JobDeps, cadet: RegisteredCadet): string | null {
  const subject: PortraitSubject = {
    archetype: cadet.archetype as Archetype,
    homeworld: cadet.homeworld,
    appearance: appearanceOf(deps, cadet.id),
  };
  const asset = deps.assets!.request({
    kind: "portrait",
    prompt: portraitPrompt(deps.art, subject),
    size: "1024x1024",
    quality: "medium",
    transparent: true,
    outPx: 512,
    ownerType: "cadet",
    ownerId: cadet.id,
  });
  deps.handle.sqlite
    .prepare("UPDATE cadets SET portrait_asset_id = ? WHERE id = ?")
    .run(asset.id, cadet.id);
  return asset.id;
}

function appearanceOf(deps: JobDeps, cadetId: string): CadetAppearance {
  const row = deps.handle.sqlite
    .prepare("SELECT traits_json FROM cadets WHERE id = ?")
    .get(cadetId) as { traits_json: string };
  return (JSON.parse(row.traits_json) as { appearance: CadetAppearance }).appearance;
}

function cadetView(deps: JobDeps, c: RegisteredCadet, portraitAssetId: string | null): CadetView {
  const appearance = appearanceOf(deps, c.id);
  const ready =
    portraitAssetId &&
    (
      deps.handle.sqlite.prepare("SELECT status FROM assets WHERE id = ?").get(portraitAssetId) as
        { status: string } | undefined
    )?.status === "ready";
  return {
    id: c.id,
    name: c.name,
    archetype: c.archetype as Archetype,
    seat: c.seat,
    homeworld: c.homeworld,
    quirk: c.quirk,
    comprehension: 0,
    state: "attentive",
    portraitUrl: ready ? `/api/assets/${portraitAssetId}` : null,
    hair: appearance.hair ?? "",
    register: registerFor(c.id, appearance),
  };
}
