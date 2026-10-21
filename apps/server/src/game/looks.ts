import { registerFor, type VoiceRegister } from "@lumen/shared";

/** V4-07: the Registrar's hair description, from a cadet's traits_json ("" if none). */
export function hairOf(traitsJson: string): string {
  try {
    const t = JSON.parse(traitsJson) as { appearance?: { hair?: unknown } };
    return typeof t.appearance?.hair === "string" ? t.appearance.hair : "";
  } catch {
    return "";
  }
}

/** The student's voice register (name, voice and drawing agree), from traits_json. */
export function registerOf(id: string, traitsJson: string): VoiceRegister {
  try {
    const t = JSON.parse(traitsJson) as {
      appearance?: { voice?: unknown; genderPresentation?: unknown };
    };
    return registerFor(id, t.appearance);
  } catch {
    return registerFor(id);
  }
}
