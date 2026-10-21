// Teaching modes (V5, VD11): each is a period kind plus prompts inside the
// same ClassSession. "class" is v1's lecture; "micro" is V3's micro-lesson.

export const PERIOD_KINDS = [
  "class",
  "micro",
  "socratic",
  "teach_back",
  "analogy_lab",
  "eli_ladder",
  "substitute",
] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

export interface ModeInfo {
  kind: PeriodKind;
  label: string;
  /** One line on the picker: what I do in this mode. */
  blurb: string;
  /** Planned minutes (null: the usual period length). */
  minutes: number | null;
  /** Shown on the picker as what it trains. */
  trains: string;
}

export const MODES: ModeInfo[] = [
  {
    kind: "class",
    label: "Lecture",
    blurb: "Teach the class as usual: explain, answer hands.",
    minutes: null,
    trains: "Explaining",
  },
  {
    kind: "socratic",
    label: "Socratic",
    blurb: "You may only ask questions. Find what a student believes and lead them out of it.",
    minutes: 12,
    trains: "Diagnosing",
  },
  {
    kind: "teach_back",
    label: "Teach-back",
    blurb: "A student explains it back. Mark every sentence that's wrong, and only those.",
    minutes: 8,
    trains: "Spotting errors",
  },
  {
    kind: "analogy_lab",
    label: "Analogy lab",
    blurb: "The Connector offers analogies. Judge each, and say where it breaks down.",
    minutes: 8,
    trains: "Precision",
  },
  {
    kind: "eli_ladder",
    label: "ELI ladder",
    blurb: "Explain it three times: to 5-year-olds, to 15-year-olds, then to an expert panel.",
    minutes: 12,
    trains: "Range",
  },
  {
    kind: "substitute",
    label: "Substitute teacher",
    blurb:
      "A substitute teaches with planted mistakes. Sit at the back and object when you hear one.",
    minutes: 8,
    trains: "Listening critically",
  },
  {
    kind: "micro",
    label: "Micro-lesson",
    blurb: "One idea, one student, one question. Three minutes.",
    minutes: 3,
    trains: "Showing up",
  },
];

export const modeInfo = (kind: PeriodKind): ModeInfo => MODES.find((m) => m.kind === kind)!;
