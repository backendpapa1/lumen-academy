import type { ClientMessage, ServerMessage } from "@lumen/shared";
import { demoActive, injectServerMessage, setDemo } from "./app";
import { initialClassroom } from "./classroom";
import { store } from "./store";

// The guided tour's pretend class: the real classroom screen, fed with a
// script instead of the server. No server, no model calls, no cost; it's
// never remembered as a class to rejoin. The tour plays one scene per step.

const IDS = { period: "per_demo", school: "sch_demo", room: "cls_demo", concept: "cpt_demo" };
const KIDS = [
  {
    id: "cdt_demo_ivy",
    name: "Ivy Achebe",
    archetype: "connector",
    hair: "long braids",
    register: "female",
  },
  {
    id: "cdt_demo_ada",
    name: "Ada Quill",
    archetype: "lost_signal",
    hair: "afro",
    register: "female",
  },
  { id: "cdt_demo_sora", name: "Sora Lee", archetype: "quiet", hair: "bun", register: "female" },
  {
    id: "cdt_demo_kenji",
    name: "Kenji Arai",
    archetype: "skeptic",
    hair: "short",
    register: "male",
  },
  {
    id: "cdt_demo_noor",
    name: "Noor Haddad",
    archetype: "overachiever",
    hair: "hijab",
    register: "female",
  },
] as const;
const [IVY, ADA, SORA, KENJI, NOOR] = KIDS.map((k) => k.id) as [
  string,
  string,
  string,
  string,
  string,
];

let timers: Array<ReturnType<typeof setTimeout>> = [];
let turn = 0;
const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
const say = (m: ServerMessage) => {
  if (demoActive()) injectServerMessage(m);
};

/** A student's line, streamed in a few words at a time like the real thing. */
function speak(cadetId: string, text: string, kind: "question" | "claim" | "answer", from: number) {
  const streamId = `demo_s${++turn}`;
  const words = text.split(" ");
  words.forEach((w, i) =>
    at(from + i * 90, () =>
      say({ type: "cadet.stream", payload: { cadetId, streamId, delta: (i ? " " : "") + w } }),
    ),
  );
  at(from + words.length * 90 + 100, () =>
    say({
      type: "cadet.done",
      payload: { cadetId, streamId, messageId: `demo_m${turn}`, text, kind, mood: "curious" },
    }),
  );
  return from + words.length * 90 + 200;
}

/** I teach a line: it types itself into the lectern, then the room reacts. */
function teach(text: string, reactions: Record<string, string>, from = 0) {
  const lectern = document.querySelector<HTMLTextAreaElement>("#lectern");
  for (let i = 1; i <= text.length; i++)
    at(from + i * 28, () => lectern && (lectern.value = text.slice(0, i)));
  const sent = from + text.length * 28 + 350;
  const turnId = `demo_t${++turn}`;
  at(sent, () => {
    if (lectern) lectern.value = "";
    say({ type: "turn.started", payload: { turnId, text } });
  });
  Object.entries(reactions).forEach(([cadetId, state], i) =>
    at(sent + 400 + i * 220, () =>
      say({ type: "crowd.reaction", payload: { turnId, cadetId, state: state as never } }),
    ),
  );
  const done = sent + 400 + Object.keys(reactions).length * 220 + 200;
  at(done, () => {
    say({
      type: "ledger.update",
      payload: {
        turnId,
        conceptId: IDS.concept,
        cadets: KIDS.map((k, i) => ({ cadetId: k.id, comprehension: 0.25 + i * 0.07 })),
        classAverage: 0.39,
      },
    });
    say({ type: "crowd.done", payload: { turnId, firstReactionMs: 400 } });
  });
  return done;
}

export const demoClass = {
  get active() {
    return demoActive();
  },

  /** Opens the pretend class (the tour's "this is your classroom"). */
  start() {
    if (demoActive()) return;
    setDemo({ send: (type: ClientMessage["type"]) => void type });
    store.setState({
      route: { name: "classroom", classroomId: IDS.room },
      classroom: { ...initialClassroom(), status: "starting" },
    });
    say({
      type: "period.started",
      payload: {
        periodId: IDS.period,
        school: { id: IDS.school, name: "Cryptography" },
        classroom: { id: IDS.room, name: "Class A" },
        concept: { id: IDS.concept, title: "Hashing" },
        concepts: [{ id: IDS.concept, title: "Hashing" }],
        cadets: KIDS.map((k, seat) => ({
          id: k.id,
          name: k.name,
          archetype: k.archetype,
          seat,
          homeworld: "Leeds",
          quirk: "",
          comprehension: 0.1,
          state: "attentive",
          hair: k.hair,
          register: k.register,
        })),
        plannedMinutes: 15,
        elapsedMs: 0,
        resumed: false,
        paused: false,
        transcript: [],
        xp: { total: 0, rank: "Student Teacher", next: null, progress: 0 },
        stickers: [],
      },
    });
  },

  /** Scenes, one per tour step. Each replaces the last one's timers. */
  play(scene: "teach" | "hand" | "mirror" | "clock") {
    this.clear();
    if (scene === "teach")
      teach(
        "A hash is a fingerprint for data: short, and it changes completely if the data changes.",
        {
          [IVY]: "excited",
          [ADA]: "confused",
          [SORA]: "attentive",
          [KENJI]: "confused",
          [NOOR]: "attentive",
        },
      );
    if (scene === "hand") {
      at(300, () =>
        say({
          type: "hands.update",
          payload: {
            queue: [
              { cadetId: ADA, intent: "clarify", preview: "A fingerprint of what?", urgency: 0.8 },
            ],
          },
        }),
      );
      at(2600, () => say({ type: "hands.update", payload: { queue: [] } }));
      speak(
        ADA,
        "Wait, a fingerprint of what exactly? The whole file, or just its name?",
        "question",
        2700,
      );
    }
    if (scene === "mirror")
      speak(
        KENJI,
        "So if I change one letter, the hash only changes a little bit, right? That's what you said earlier.",
        "claim",
        400,
      );
    if (scene === "clock") {
      // Nothing to say: the tour points at the clock and the bell.
    }
  },

  clear() {
    for (const t of timers) clearTimeout(t);
    timers = [];
  },

  /** Leaves the pretend class for the lobby, as if it never happened. */
  stop() {
    if (!demoActive()) return;
    this.clear();
    setDemo(null);
    store.setState({ route: { name: "boot" }, classroom: initialClassroom() });
  },
};
