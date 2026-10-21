import { ARCHETYPE_INFO, type ArtPromptsConfig, type Archetype } from "@lumen/shared";

// Prompt assembly (docs/07 §2): style prefix + subject + constraints, all from
// config/art-prompts.yaml. Code only fills variables.

export function fill(
  template: string,
  art: ArtPromptsConfig,
  vars: Record<string, string>,
): string {
  const lookup = (key: string): string => {
    const [scope, name] = key.split(".");
    if (name && scope === "style") return art.style[name] ?? "";
    if (name && scope === "constraints") return art.constraints[name] ?? "";
    return vars[key] ?? "";
  };
  // Two passes: style prefixes themselves contain {{accent}}.
  let out = template;
  for (let i = 0; i < 2; i++)
    out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => lookup(k));
  return out.replace(/\s+/g, " ").trim();
}

export interface PortraitSubject {
  archetype: Archetype;
  homeworld: string;
  appearance: {
    ageRange: string;
    genderPresentation: string;
    heritageHint: string;
    visualQuirk?: string;
    hair?: string;
  };
}

export function portraitPrompt(art: ArtPromptsConfig, c: PortraitSubject): string {
  return fill(art.templates.portrait, art, {
    ageRange: c.appearance.ageRange,
    genderPresentation: c.appearance.genderPresentation,
    heritageHint: c.appearance.heritageHint,
    homeworld: c.homeworld,
    archetypeVisual: art.archetypeVisual[c.archetype] ?? "calm and attentive",
    visualQuirk: c.appearance.visualQuirk || "a small holographic pin on the collar",
    hair: c.appearance.hair || "neatly styled",
    accent: ARCHETYPE_INFO[c.archetype].accent,
  });
}

export function emblemPrompt(
  art: ArtPromptsConfig,
  s: { schoolName: string; motifs: string; accent: string },
): string {
  return fill(art.templates.emblem, art, {
    schoolName: s.schoolName,
    emblemMotifs: s.motifs,
    accent: s.accent,
  });
}
