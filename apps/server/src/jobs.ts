import { ARCHETYPE_INFO, type Archetype, type CadetView } from "@lumen/shared";
import { emblemMotifs } from "./agents/artDirector.js";
import { buildCurriculum } from "./agents/deep/curriculumArchitect.js";
import { emblemPrompt, portraitPrompt, type PortraitSubject } from "./assets/prompts.js";
import type { AssetService } from "./assets/service.js";
import { saveCurriculum } from "./db/curriculum.js";
import type { DbHandle } from "./db/client.js";
import type { EventBus } from "./events.js";
import type { Embedder } from "./ingest/embed.js";
import type { SourceKind } from "./ingest/parse.js";
import { ingestSource } from "./ingest/pipeline.js";
import type { ModelFactory } from "./models/factory.js";
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
    () => "an abstract geometric seal of light",
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

/** S-2/S-3: index a source; status streams on the bus. */
export function addSource(
  deps: JobDeps,
  input: { schoolId: string; title: string; kind: SourceKind; data: Uint8Array | string },
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

/** C-1: Curriculum Architect, one run per school at a time. */
export async function generateCurriculum(deps: JobDeps, schoolId: string): Promise<boolean> {
  if (!deps.embedder)
    throw new Error("the Curriculum Architect needs an OpenAI key for embeddings");
  if (building.has(schoolId)) return false;
  building.add(schoolId);
  deps.bus.emit({ type: "curriculum.status", payload: { schoolId, status: "building" } });
  try {
    const result = await buildCurriculum(
      { factory: deps.factory, handle: deps.handle, embedder: deps.embedder },
      schoolId,
    );
    const saved = saveCurriculum(deps.handle, schoolId, result.curriculum);
    deps.bus.emit({
      type: "curriculum.status",
      payload: {
        schoolId,
        status: "ready",
        detail: `${saved.modules} modules, ${saved.concepts} concepts`,
      },
    });
    return true;
  } catch (err) {
    deps.bus.emit({
      type: "curriculum.status",
      payload: { schoolId, status: "error", detail: (err as Error).message },
    });
    return false;
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
}

/** Medium portrait price × count must fit the image budget; otherwise only the first few get one (docs/07 §6). */
function portraitAllowance(deps: JobDeps, total: number): number {
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
      .then(
        () =>
          created &&
          deps.bus.emit({
            type: "registration.done",
            payload: { classroomId: created.classroomId, status: "active" },
          }),
      )
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
  };
}
