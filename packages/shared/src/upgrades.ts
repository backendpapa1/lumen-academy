// Room upgrades (V7-01): each rank unlocks more slots; I choose what goes in
// them, per classroom. Every item has a fixed spot in the drawn room. The
// class reacts the first time they see it.

export const UPGRADES = [
  {
    item: "plant",
    label: "A second plant",
    blurb: "A tall fern by the door.",
    react: "Ooh, a new plant!",
  },
  {
    item: "poster",
    label: "Subject poster",
    blurb: "The School's emblem and a word from your glossary wall.",
    react: "Is that our subject on the wall?",
  },
  {
    item: "goldfish",
    label: "Goldfish bowl",
    blurb: "A goldfish on the windowsill.",
    react: "A fish! Does it have a name?",
  },
  {
    item: "cat",
    label: "Classroom cat",
    blurb: "A cat asleep in the window.",
    react: "There's a cat in the window!",
  },
  {
    item: "reading_corner",
    label: "Reading corner",
    blurb: "A beanbag and a little shelf of books.",
    react: "Can we read in the corner later?",
  },
  {
    item: "string_lights",
    label: "String lights",
    blurb: "Warm lights along the top of the wall.",
    react: "The lights are so cosy.",
  },
  {
    item: "globe",
    label: "Globe",
    blurb: "A globe on your desk.",
    react: "Where's my hometown on the globe?",
  },
  {
    item: "rug",
    label: "Rug",
    blurb: "A big striped rug under the desks.",
    react: "New rug! It's so soft.",
  },
] as const;

export type UpgradeItem = (typeof UPGRADES)[number]["item"];

/** Upgrade slots at each rank, in ranks order (Student Teacher … Chancellor). */
export const SLOTS_BY_RANK = [1, 2, 3, 5, 7, 8];

export function upgradeSlots(rankIndex: number): number {
  return SLOTS_BY_RANK[Math.max(0, Math.min(SLOTS_BY_RANK.length - 1, rankIndex))]!;
}
