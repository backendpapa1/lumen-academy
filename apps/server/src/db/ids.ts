import { ulid } from "ulidx";

// Prefixed ULIDs (CLAUDE.md conventions). Sortable by creation time.
export const ID_PREFIXES = {
  school: "sch",
  source: "src",
  chunk: "chk",
  module: "mod",
  concept: "cpt",
  classroom: "cls",
  cadet: "cdt",
  period: "per",
  turn: "trn",
  message: "msg",
  exitTicket: "ext",
  assignment: "asg",
  submission: "sub",
  exam: "exm",
  examQuestion: "exq",
  debrief: "dbf",
  teacherError: "ter",
  asset: "ast",
  parked: "prk",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind, now?: number): string {
  return `${ID_PREFIXES[kind]}_${ulid(now).toLowerCase()}`;
}

export function idKind(id: string): IdKind | undefined {
  const prefix = id.split("_", 1)[0];
  return (Object.keys(ID_PREFIXES) as IdKind[]).find((k) => ID_PREFIXES[k] === prefix);
}
