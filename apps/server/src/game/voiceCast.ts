import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { VoiceCastZ } from "@lumen/shared";
import { callStructured } from "../agents/harness.js";
import { loadPrompt } from "../agents/prompts/load.js";
import type { DbHandle } from "../db/client.js";
import type { ModelFactory } from "../models/factory.js";

// Students registered before the Registrar noted a voice, whose presentation
// doesn't settle it either (androgynous): one small call casts a voice that
// fits each name, so "Sofia" never speaks in a man's voice. Runs once at
// start; feminine and masculine presentations need no call.

const BATCH = 20;

interface Row {
  id: string;
  name: string;
  homeworld: string;
  t: string;
}
interface Appearance {
  genderPresentation?: string;
  heritageHint?: string;
  hair?: string;
  voice?: string;
}

const appearanceOf = (t: string): Appearance => {
  try {
    return (JSON.parse(t) as { appearance?: Appearance }).appearance ?? {};
  } catch {
    return {};
  }
};

/** Students whose voice still comes from their id alone. */
export function uncast(handle: DbHandle): Row[] {
  return (
    handle.sqlite
      .prepare("SELECT id, name, homeworld, traits_json t FROM cadets ORDER BY enrolled_at")
      .all() as Row[]
  ).filter((r) => {
    const a = appearanceOf(r.t);
    return !a.voice && a.genderPresentation !== "feminine" && a.genderPresentation !== "masculine";
  });
}

/** Records each voice in the student's appearance; a changed voice is re-picked on next use. */
export function applyCast(handle: DbHandle, id: string, voice: "higher" | "lower") {
  const row = handle.sqlite.prepare("SELECT traits_json t FROM cadets WHERE id = ?").get(id) as
    { t: string } | undefined;
  if (!row) return;
  const traits = JSON.parse(row.t) as { appearance?: Appearance };
  traits.appearance = { ...traits.appearance, voice };
  handle.sqlite
    .prepare("UPDATE cadets SET traits_json = ? WHERE id = ?")
    .run(JSON.stringify(traits), id);
}

export async function castVoices(
  deps: { handle: DbHandle; factory: ModelFactory },
  log: (msg: string) => void = () => {},
): Promise<number> {
  const rows = uncast(deps.handle);
  let cast = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const students = batch
      .map((r, k) => {
        const a = appearanceOf(r.t);
        return `${k + 1}. ${r.name}: from ${r.homeworld}; ${a.genderPresentation ?? "unknown"} presentation; ${a.heritageHint ?? "unknown"} heritage; hair: ${a.hair || "unknown"}`;
      })
      .join("\n");
    try {
      const res = await callStructured(deps.factory, "voiceCaster", {
        schema: VoiceCastZ,
        name: "voice_cast",
        messages: [
          new SystemMessage(loadPrompt("voiceCaster", { students })),
          new HumanMessage("Cast the voices."),
        ],
      });
      for (const s of res.data.students) {
        const r = batch[s.index - 1];
        if (!r) continue;
        applyCast(deps.handle, r.id, s.voice);
        cast++;
      }
    } catch (e) {
      log(`voice casting skipped: ${(e as Error).message}`);
      break; // no key or over budget: the id fallback stands until next start
    }
  }
  return cast;
}
