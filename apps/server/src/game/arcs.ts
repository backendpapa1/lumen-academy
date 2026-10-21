import { ARCS, type Archetype, type ArcState, type GameConfig } from "@lumen/shared";

// Growth arcs (V4-03, VD10): explicit, explainable rules. "Sora spoke up
// because you called on her three times", never LLM whim. The prompts are
// only told the stage the server settled on.

export type ArcSignal =
  /** I taught (or answered someone). */
  | { kind: "teach"; text: string; replyToCadetId?: string }
  /** I called on a student. */
  | { kind: "called"; cadetId: string }
  /** One of a student's misconceptions was cleared this turn. */
  | { kind: "resolved"; cadetId: string };

/** A reason, not just a claim: "because", "which means", "that's why"… */
export const hasReason = (text: string) =>
  /\b(because|since|so that|which means|that means|that's why|this is why|the reason|therefore|so the)\b/i.test(
    text,
  );

/** Correcting kindly: acknowledging the idea before fixing it, and nothing harsh. */
export const isKind = (text: string) =>
  /\b(i see why|i can see why|i get why|good (thought|try|question|point|guess)|nice try|fair (point|enough|guess)|close|great question|thanks for|interesting idea|common (idea|mix-up|mistake)|easy to think)\b/i.test(
    text,
  ) &&
  !/\b(nonsense|stupid|rubbish|ridiculous|obviously not|pay attention|not listening)\b/i.test(text);

export const INITIAL_ARC: ArcState = { stage: 0, count: 0 };

export function parseArc(json: string | null): ArcState {
  if (!json) return { ...INITIAL_ARC };
  try {
    const a = JSON.parse(json) as Partial<ArcState>;
    return { stage: Number(a.stage) || 0, count: Number(a.count) || 0 };
  } catch {
    return { ...INITIAL_ARC };
  }
}

/**
 * One signal for one student. Returns the next state and whether the stage
 * moved. Archetypes without an arc never change.
 */
export function arcStep(
  student: { id: string; archetype: Archetype },
  state: ArcState,
  signal: ArcSignal,
  cfg: GameConfig["arcs"],
): { state: ArcState; advanced: boolean } {
  const arc = ARCS[student.archetype];
  const last = (arc?.stages.length ?? 1) - 1;
  if (!cfg.enabled || !arc || state.stage >= last) return { state, advanced: false };
  let count = state.count;
  let need: number;
  switch (student.archetype) {
    case "skeptic":
      if (signal.kind !== "teach") return { state, advanced: false };
      // Reasons twice in a row: a turn without one starts the count again.
      count = hasReason(signal.text) ? count + 1 : 0;
      need = cfg.skepticReasons;
      break;
    case "quiet":
      if (signal.kind !== "called" || signal.cadetId !== student.id)
        return { state, advanced: false };
      count++;
      need = cfg.quietCalls;
      break;
    case "lost_signal":
      if (signal.kind !== "resolved" || signal.cadetId !== student.id)
        return { state, advanced: false };
      count++;
      need = cfg.lostFixes;
      break;
    case "saboteur":
      if (signal.kind !== "teach" || signal.replyToCadetId !== student.id || !isKind(signal.text))
        return { state, advanced: false };
      count++;
      need = cfg.saboteurKind;
      break;
    default:
      return { state, advanced: false };
  }
  if (count >= need) return { state: { stage: state.stage + 1, count: 0 }, advanced: true };
  return { state: { stage: state.stage, count }, advanced: false };
}

/** The line the student and the crowd are told about where this student is now. */
export function arcPrompt(archetype: Archetype, state: ArcState): string {
  return ARCS[archetype]?.stages[state.stage]?.prompt ?? "";
}

/** "Sora raised a hand for the first time!" */
export function arcMoment(archetype: Archetype, state: ArcState, name: string): string {
  const m = ARCS[archetype]?.stages[state.stage]?.moment ?? "";
  return m.replace("{first}", name.split(" ")[0]!);
}
