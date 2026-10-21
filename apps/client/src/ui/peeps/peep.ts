import {
  voiceRegister,
  type Archetype,
  type ReactionState,
  type VoiceRegister,
} from "@lumen/shared";
import { PEEPS } from "./parts.generated";

// Students drawn as Open Peeps (ADR-009): a stable look per student from their
// id, a pose and a face per moment. Returns SVG markup; callers cache it.

type Body = keyof typeof PEEPS.bodies;
type Head = keyof typeof PEEPS.heads;
type Face = keyof typeof PEEPS.faces;
type Beard = keyof typeof PEEPS.beards;
type Accessory = keyof typeof PEEPS.accessories;

export interface Look {
  head: Head;
  body: Body;
  beard?: Beard;
  accessory?: Accessory;
  skin: string;
  top: string;
  jacket: string;
  headwear: string;
}

/** What the student is doing right now. */
export type Pose = "idle" | "hand" | "talk" | "notes" | "arms";

// Clothes and hair are the student's own; poses borrow the student's top colour.
const EVERYDAY: Body[] = [
  "ButtonShirt",
  "ButtonPocketShirt",
  "Hoodie",
  "Jacket",
  "PoloSweater",
  "SportyTee",
  "StripedTee",
  "Tee",
  "TeeSelena",
  "Turtleneck",
  "SweaterDots",
  "Dress",
  "ShirtCoat",
];
const POSE_BODY: Record<Exclude<Pose, "idle">, Body> = {
  hand: "PointingUp",
  talk: "Explaining",
  notes: "Paper",
  arms: "TeeArmsCrossed",
};
const HEADS = Object.keys(PEEPS.heads) as Head[];
/**
 * When the Registrar's hair description doesn't name a style, the head comes
 * from styles that read as fitting the voice, so a "Sofia" doesn't get a
 * buzz cut by chance (Paul's note: names, voices and looks should agree).
 */
const HEADS_BY_REGISTER: Record<VoiceRegister, Head[]> = {
  female: HEADS.filter((k) =>
    /^(Bangs|BangsTwo|BantuKnots|Bun|BunClip|BunKnots|BunTwo|ColorBun|ColorMedium|LongAfro|LongBangs|LongCurly|LongHair|Medium\w*|Wavy|Hijab|Twists|TwistsTwo|Afro)$/.test(
      k,
    ),
  ),
  male: HEADS.filter((k) =>
    /^(Afro|Bald|Cornrows|CornrowsLight|DreadsOne|DreadsTwo|FlatTop|FlatTopLong|GrayShort|Mohawk|NoHairThree|NoHairTwo|Pomp|Shaved|ShavedOne|ShavedThree|Short\w*|Turban|Twists)$/.test(
      k,
    ),
  ),
};
const BEARDS = Object.keys(PEEPS.beards) as Beard[];
const GLASSES = Object.keys(PEEPS.accessories) as Accessory[];

/** Real skin tones, light to deep. */
export const SKIN = ["#FCE3D0", "#F4C9A7", "#E0A97E", "#C08158", "#94593A", "#6B3E27", "#4A2A1B"];
/** Clothes stay inside the room's palette: paper, sky, cobalt, a little marigold and coral. */
export const CLOTHES = [
  "#FFFFFF",
  "#DCE4FF",
  "#A8B8FF",
  "#BFE8FF",
  "#FFC23D",
  "#FF8C7A",
  "#B8E6C9",
  "#FFE1DC",
];
const HEADWEAR = ["#2A40FF", "#FFC23D", "#FF8C7A", "#0F1A66", "#FFFFFF"];

/** Hair the Registrar described, matched to a hairstyle (else the id decides). */
const HAIR_WORDS: Array<[RegExp, Head[]]> = [
  [/afro/i, ["Afro", "LongAfro"]],
  [/bantu/i, ["BantuKnots"]],
  [/cornrow|braid/i, ["Cornrows", "CornrowsLight"]],
  [/dread|loc/i, ["DreadsOne", "DreadsTwo"]],
  [/twist/i, ["Twists", "TwistsTwo"]],
  [/bun|top.?knot/i, ["Bun", "BunClip", "BunKnots", "BunTwo", "ColorBun"]],
  [/curl/i, ["LongCurly", "Wavy"]],
  [/bald/i, ["Bald", "NoHairTwo", "NoHairThree"]],
  [/shaved|buzz/i, ["Shaved", "ShavedOne", "ShavedThree"]],
  [/mohawk/i, ["Mohawk"]],
  [/hijab/i, ["Hijab"]],
  [/turban/i, ["Turban"]],
  [/beanie/i, ["Beanie"]],
  [/bang|fringe/i, ["Bangs", "BangsTwo", "MediumBangs", "LongBangs"]],
  [/long/i, ["LongHair", "LongBangs", "LongCurly"]],
  [/flat.?top/i, ["FlatTop", "FlatTopLong"]],
  [/gr[ae]y|silver/i, ["GrayShort"]],
];

function rng(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

// V4-07: the Registrar's hair description and the voice register per student,
// so every screen draws the same person. Filled from /api/looks at start and
// from each CadetView.
const HAIR = new Map<string, string>();
const REGISTER = new Map<string, VoiceRegister>();
/** Hair and register, from anything shaped like a CadetView. */
export function rememberLooks(
  list: Iterable<{ id: string; hair?: string; register?: VoiceRegister }>,
): void {
  for (const c of list) {
    if (c.hair) HAIR.set(c.id, c.hair);
    if (c.register) REGISTER.set(c.id, c.register);
  }
}

export function lookFor(
  id: string,
  hair = HAIR.get(id) ?? "",
  register: VoiceRegister = REGISTER.get(id) ?? voiceRegister(id),
): Look {
  const r = rng(id);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const matched = HAIR_WORDS.find(([re]) => re.test(hair))?.[1];
  const head = matched ? pick(matched) : pick(HEADS_BY_REGISTER[register]);
  const top = pick(CLOTHES);
  return {
    head,
    body: pick(register === "male" ? EVERYDAY.filter((b) => b !== "Dress") : EVERYDAY),
    // Beards only on students with a lower voice, so look and voice agree (V1-04).
    beard: r() < 0.3 && register === "male" ? pick(BEARDS) : undefined,
    accessory: r() < 0.24 ? pick(GLASSES) : undefined,
    skin: pick(SKIN),
    top,
    jacket: pick(CLOTHES.filter((c) => c !== top)),
    headwear: pick(HEADWEAR),
  };
}

/** The face for a reaction (docs/02 §3.2), so the room reads at a glance. */
export const FACE_FOR: Record<ReactionState, Face> = {
  attentive: "Calm",
  confused: "Concerned",
  excited: "BigSmile",
  bored: "Tired",
  skeptical: "Suspicious",
  notetaking: "Driven",
};

/** A resting face that suits the archetype, used when nothing is happening. */
const RESTING: Partial<Record<Archetype, Face>> = {
  skeptic: "Serious",
  overachiever: "Smile",
  quiet: "Solemn",
  saboteur: "Cheeky",
  connector: "Cute",
};
export const restingFace = (a: Archetype): Face => RESTING[a] ?? "Calm";

export const INK = "#2A40FF";

export interface DrawOpts {
  pose?: Pose;
  face?: Face;
  /** Outline colour; cobalt by default, like the rest of the room. */
  ink?: string;
}

/** SVG markup for a seated student's bust. viewBox fits the whole figure. */
export function peepSvg(look: Look, opts: DrawOpts = {}): string {
  const pose = opts.pose ?? "idle";
  const bodyKey = pose === "idle" ? look.body : POSE_BODY[pose];
  const body = PEEPS.bodies[bodyKey];
  const ink = opts.ink ?? INK;
  const g = PEEPS.groups;
  const inner =
    `<g transform="${g.Body}">${body.svg}</g>` +
    `<g transform="${body.head || "translate(0 0)"}">` +
    `<g transform="${g.Hair}">${PEEPS.heads[look.head]}</g>` +
    `<g transform="${g.Face}">${PEEPS.faces[opts.face ?? "Calm"]}</g>` +
    (look.beard ? `<g transform="${g.Beard}">${PEEPS.beards[look.beard]}</g>` : "") +
    (look.accessory
      ? `<g transform="${g.Accessories}">${PEEPS.accessories[look.accessory]}</g>`
      : "") +
    `</g>`;
  const colours: Record<string, string> = {
    "1": ink,
    "2": look.skin,
    "3": ink,
    "4": look.top,
    "5": look.jacket,
    "6": "#FFFFFF",
    "7": "#FFFFFF",
    "8": "#DCE4FF",
    "9": look.headwear,
  };
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${PEEPS.viewBox}" overflow="visible">` +
    inner.replace(/§(\d)/g, (_, k: string) => colours[k] ?? ink) +
    `</svg>`
  );
}
