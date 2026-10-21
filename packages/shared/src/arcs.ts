import type { Archetype } from "./agents.js";

// Growth arcs (V4-03, VD10): each of these archetypes changes over weeks, in
// stages, because of things I do. The server moves the stage by explicit
// rules (apps/server/src/game/arcs.ts); prompts are only told the stage.

export interface ArcStage {
  /** Shown on the roster ("Listens to your reasons"). */
  label: string;
  /** Told to the student and the crowd, so they act it. */
  prompt: string;
  /** The moment shown when they reach this stage ({first} is their first name). */
  moment: string;
}

export interface Arc {
  /** What moves them on, in my terms (shown on the roster as a hint). */
  trigger: string;
  stages: ArcStage[];
}

export const ARCS: Partial<Record<Archetype, Arc>> = {
  skeptic: {
    trigger: "Give reasons (because…, which means…) twice in a row.",
    stages: [
      {
        label: "Doubts everything",
        prompt: "You doubt claims until you hear a reason.",
        moment: "",
      },
      {
        label: "Listens to your reasons",
        prompt: "You've noticed the teacher gives reasons. You still ask why, but you listen.",
        moment: "{first} nodded at your reasoning. The Skeptic is listening.",
      },
      {
        label: "Trusts your reasons",
        prompt: "You've started to trust the teacher's reasons. Doubt only what really seems off.",
        moment: "{first} trusts your reasons now.",
      },
      {
        label: "Your sharpest ally",
        prompt: "You trust the teacher, and you use your doubt to test ideas on their side.",
        moment: "{first} is on your side: the class's sharpest ally.",
      },
    ],
  },
  quiet: {
    trigger: "Call on them (three times moves them on).",
    stages: [
      { label: "Silent", prompt: "You almost never speak unless called on.", moment: "" },
      {
        label: "Speaks when asked",
        prompt: "You answer when called on, a little more fully than before.",
        moment: "{first} answered with a whole sentence. The Quiet One is warming up.",
      },
      {
        label: "Raises a hand now and then",
        prompt: "Now and then you raise your hand yourself, when something matters to you.",
        moment: "{first} raised a hand for the first time!",
      },
      {
        label: "Joins in",
        prompt: "You join in like anyone else; you're still thoughtful and brief.",
        moment: "{first} joins in now, like everyone else.",
      },
    ],
  },
  lost_signal: {
    trigger: "Fix one of their misconceptions.",
    stages: [
      { label: "Lost", prompt: "You often feel lost and say so.", moment: "" },
      {
        label: "Finding the thread",
        prompt: "One of your mix-ups was cleared up. You're a little more confident.",
        moment: "{first} got it! One mix-up cleared, and a bit more confidence.",
      },
      {
        label: "Keeping up",
        prompt: "You keep up most of the time now. You still say when you're lost.",
        moment: "{first} is keeping up now.",
      },
      {
        label: "Confident",
        prompt: "You're confident. You help others who are lost, from what you were taught.",
        moment: "{first} is confident now, and helping others.",
      },
    ],
  },
  saboteur: {
    trigger: 'Correct them kindly ("I see why you\'d think that, but…").',
    stages: [
      {
        label: "Stirring things up",
        prompt: "You confidently state plausible wrong claims.",
        moment: "",
      },
      {
        label: "Second thoughts",
        prompt: "The teacher corrected you kindly. You still try wrong claims, but less often.",
        moment: "{first} took that well. The Saboteur is having second thoughts.",
      },
      {
        label: "Reformed",
        prompt: "You've reformed: you state claims as guesses and check them with the teacher.",
        moment: "{first} has reformed: guesses, not traps.",
      },
    ],
  },
};

export interface ArcState {
  stage: number;
  /** Progress toward the next stage (meaning depends on the arc). */
  count: number;
}
