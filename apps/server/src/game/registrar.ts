import { defaultInterests } from "./interests.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ARCHETYPE_INFO, CadetFlavourZ, type CadetFlavour, type GameConfig } from "@lumen/shared";
import { eq, sql } from "drizzle-orm";
import { callStructured } from "../agents/harness.js";
import { loadPrompt } from "../agents/prompts/load.js";
import type { DbHandle } from "../db/client.js";
import { newId } from "../db/ids.js";
import { cadets, classrooms, schools } from "../db/schema.js";
import type { ModelFactory } from "../models/factory.js";
import { planCohort, type CadetPlan, type Difficulty } from "./registration.js";
import { seedFrom } from "./rng.js";

// R-2/R-4/R-5: open a Classroom and enrol a seeded cohort, flavoured by the
// Registrar LLM in batches so the first arrivals show up within seconds.

export interface RegisteredCadet extends CadetPlan {
  id: string;
  name: string;
  quirk: string;
  voiceNotes: string;
  backstory: string;
}

export interface RegisterDeps {
  handle: DbHandle;
  factory: ModelFactory;
  game: GameConfig;
}

export interface RegisterInput {
  schoolId: string;
  difficulty?: Difficulty;
  name?: string;
  seed?: number;
  /** Fires once the Classroom row exists and the cohort size is known. */
  onCreated?: (classroomId: string, name: string, total: number) => void;
  /** Fires as each cadet is enrolled (RegistrationScene in M3, CLI now). */
  onArrival?: (cadet: RegisteredCadet, index: number, total: number) => void;
}

const word = (x: number, lo: string, hi: string) =>
  x < 0.35 ? lo : x > 0.65 ? hi : `moderate ${hi}`;

function describePlan(p: CadetPlan, index: number): string {
  const t = p.traits;
  return [
    `${index}. ${ARCHETYPE_INFO[p.archetype].label} (${ARCHETYPE_INFO[p.archetype].brief})`,
    `   from ${p.homeworld}; ${p.appearance.ageRange}, ${p.appearance.genderPresentation}, ${p.appearance.heritageHint} heritage`,
    `   ${word(t.curiosity, "incurious", "curiosity")}, ${word(t.confidence, "unsure", "confidence")}, ${word(t.humor, "serious", "humour")}, ${word(t.verbosity, "terse", "chattiness")}; learns best ${p.learningStyle}`,
  ].join("\n");
}

export function nextClassroomName(handle: DbHandle, schoolId: string): string {
  const n =
    handle.db
      .select({ n: sql<number>`count(*)` })
      .from(classrooms)
      .where(eq(classrooms.schoolId, schoolId))
      .get()?.n ?? 0;
  return `Class ${String.fromCharCode(65 + n)}`;
}

export async function registerClassroom(deps: RegisterDeps, input: RegisterInput) {
  const { handle, game } = deps;
  const school = handle.db.select().from(schools).where(eq(schools.id, input.schoolId)).get();
  if (!school) throw new Error(`no school ${input.schoolId}`);
  const existing =
    handle.db
      .select({ n: sql<number>`count(*)` })
      .from(classrooms)
      .where(eq(classrooms.schoolId, school.id))
      .get()?.n ?? 0;
  if (existing >= game.classroomsPerSchool)
    throw new Error(`a School can have at most ${game.classroomsPerSchool} Classrooms`);

  const difficulty = input.difficulty ?? "standard";
  const seed = input.seed ?? seedFrom(school.id, existing, Date.now());
  const name = input.name ?? nextClassroomName(handle, school.id);
  const classroomId = newId("classroom");
  const now = () => new Date().toISOString();
  handle.db
    .insert(classrooms)
    .values({
      id: classroomId,
      schoolId: school.id,
      name,
      difficulty,
      status: "registering",
      seed,
      createdAt: now(),
    })
    .run();

  const plan = planCohort(seed, difficulty, game);
  const enrolled: RegisteredCadet[] = [];
  const taken = new Set<string>();
  input.onCreated?.(classroomId, name, plan.length);

  try {
    for (let start = 0; start < plan.length; start += game.registration.batchSize) {
      const batch = plan.slice(start, start + game.registration.batchSize);
      const usedQuirks = enrolled.map((c) => c.quirk);
      let flavour = await flavourBatch(deps, school, batch, start, taken, usedQuirks);
      const dupes = flavour.cadets.filter(
        (c) =>
          taken.has(c.name.toLowerCase()) ||
          flavour.cadets.filter((o) => o.name.toLowerCase() === c.name.toLowerCase()).length > 1,
      );
      if (dupes.length)
        flavour = await flavourBatch(
          deps,
          school,
          batch,
          start,
          new Set([...taken, ...flavour.cadets.map((c) => c.name.toLowerCase())]),
          usedQuirks,
        );

      batch.forEach((p, k) => {
        const index = start + k + 1;
        const f = flavour.cadets.find((c) => c.index === index) ?? flavour.cadets[k];
        if (!f) throw new Error(`Registrar returned no cadet for index ${index}`);
        if (taken.has(f.name.toLowerCase()))
          throw new Error(`Registrar repeated the name "${f.name}"`);
        taken.add(f.name.toLowerCase());
        const cadet: RegisteredCadet = {
          ...p,
          id: newId("cadet"),
          name: f.name,
          quirk: f.quirk,
          voiceNotes: f.voiceNotes,
          backstory: f.backstory,
        };
        handle.db
          .insert(cadets)
          .values({
            id: cadet.id,
            classroomId,
            seat: p.seat,
            name: f.name,
            homeworld: p.homeworld,
            archetype: p.archetype,
            traitsJson: JSON.stringify({
              ...p.traits,
              appearance: {
                ...p.appearance,
                visualQuirk: f.visualQuirk,
                hair: f.hair,
                ...(f.voice ? { voice: f.voice } : {}),
              },
            }),
            learningStyle: p.learningStyle,
            quirk: f.quirk,
            voiceNotes: f.voiceNotes,
            backstory: f.backstory || null,
            interestsJson: JSON.stringify(
              f.interests.length
                ? f.interests.slice(0, 2).map((x) => x.toLowerCase())
                : defaultInterests(cadet.id, game.interests),
            ),
            enrolledAt: now(),
          })
          .run();
        enrolled.push(cadet);
        input.onArrival?.(cadet, enrolled.length, plan.length);
      });
    }
  } catch (err) {
    // A half-registered class can't be taught: archive it so it never shows as active.
    handle.db
      .update(classrooms)
      .set({ status: "archived" })
      .where(eq(classrooms.id, classroomId))
      .run();
    throw err;
  }

  handle.db
    .update(classrooms)
    .set({ status: "active" })
    .where(eq(classrooms.id, classroomId))
    .run();
  return { classroomId, name, seed, difficulty, cadets: enrolled };
}

async function flavourBatch(
  deps: RegisterDeps,
  school: { name: string; description: string | null },
  batch: CadetPlan[],
  start: number,
  taken: Set<string>,
  usedQuirks: string[],
): Promise<CadetFlavour> {
  const system = loadPrompt("registrar", {
    schoolName: school.name,
    schoolDescription: school.description ?? "",
    takenNames: taken.size ? [...taken].join(", ") : "(none yet)",
    usedQuirks: usedQuirks.length ? usedQuirks.map((q) => `- ${q}`).join("\n") : "(none yet)",
    cadetList: batch.map((p, k) => describePlan(p, start + k + 1)).join("\n"),
  });
  const res = await callStructured(deps.factory, "registrar", {
    schema: CadetFlavourZ,
    name: "cadet_flavour",
    messages: [
      new SystemMessage(system),
      new HumanMessage(`Write flavour for cadets ${start + 1}–${start + batch.length}.`),
    ],
  });
  return res.data;
}

/**
 * V5-11 transfer student: one new student joins an active class mid-module,
 * with a gap (no ledger yet). Same Registrar flavour as at registration.
 * Returns null when the class is full.
 */
export async function enrollTransfer(
  deps: RegisterDeps,
  classroomId: string,
): Promise<RegisteredCadet | null> {
  const { handle, game } = deps;
  const room = handle.db.select().from(classrooms).where(eq(classrooms.id, classroomId)).get();
  if (!room) return null;
  const school = handle.db.select().from(schools).where(eq(schools.id, room.schoolId)).get()!;
  const roster = handle.db.select().from(cadets).where(eq(cadets.classroomId, classroomId)).all();
  const active = roster.filter((c) => c.status === "enrolled" || c.status === "transferred_in");
  if (active.length >= game.cohort.max) return null;
  const used = new Set(roster.map((c) => c.seat));
  const seat = [...Array(15).keys()].find((s) => !used.has(s));
  if (seat === undefined) return null;
  const [p] = planCohort(
    seedFrom(classroomId, "transfer", roster.length),
    room.difficulty ?? "standard",
    game,
  );
  const plan = { ...p!, seat };
  const taken = new Set(roster.map((c) => c.name.toLowerCase()));
  const flavour = await flavourBatch(
    deps,
    school,
    [plan],
    roster.length,
    taken,
    roster.map((c) => c.quirk),
  );
  const f = flavour.cadets[0];
  if (!f || taken.has(f.name.toLowerCase())) return null;
  const cadet: RegisteredCadet = {
    ...plan,
    id: newId("cadet"),
    name: f.name,
    quirk: f.quirk,
    voiceNotes: f.voiceNotes,
    backstory: f.backstory,
  };
  handle.db
    .insert(cadets)
    .values({
      id: cadet.id,
      classroomId,
      seat,
      name: f.name,
      homeworld: plan.homeworld,
      archetype: plan.archetype,
      traitsJson: JSON.stringify({
        ...plan.traits,
        appearance: {
          ...plan.appearance,
          visualQuirk: f.visualQuirk,
          hair: f.hair,
          ...(f.voice ? { voice: f.voice } : {}),
        },
      }),
      learningStyle: plan.learningStyle,
      quirk: f.quirk,
      voiceNotes: f.voiceNotes,
      backstory: f.backstory || null,
      interestsJson: JSON.stringify(
        f.interests.length ? f.interests.slice(0, 2) : defaultInterests(cadet.id, game.interests),
      ),
      status: "transferred_in",
      enrolledAt: new Date().toISOString(),
    })
    .run();
  return cadet;
}
