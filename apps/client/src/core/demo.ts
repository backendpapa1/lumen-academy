import type { ServerMessage } from "@lumen/shared";
import { applyServerMessage } from "./classroom";
import { store } from "./store";

/** ?view=classroom-demo: a believable period without a server, for visual work. */
export function loadDemoClassroom(): void {
  const cadets: Array<[string, Parameters<typeof import("../ui/theme").accentOf>[0], number]> = [
    ["Ines Okoro-Vale", "skeptic", 0],
    ["Tomas Reyes", "lost_signal", 2],
    ["Adaeze Bello", "literalist", 4],
    ["Kai Nakamura", "overachiever", 5],
    ["Lena Petrov", "pragmatist", 6],
    ["Femi Adeyemi", "connector", 8],
    ["Sora Lin", "quiet", 9],
    ["Maya Haddad", "lost_signal", 11],
    ["Oskar Brandt", "skeptic", 12],
    ["Zuri Mwangi", "connector", 13],
    ["Ravi Iyer", "pragmatist", 14],
    // Seats 1, 3, 7, 10: a full house with ?cadets=15 (the perf gate).
    ["Noor Rahman", "quiet", 1],
    ["Teo Vasquez", "overachiever", 3],
    ["Hana Sato", "literalist", 7],
    ["Bram Visser", "connector", 10],
  ];
  const n = Number(new URLSearchParams(location.search).get("cadets") ?? 11);
  cadets.splice(Math.min(15, Math.max(4, n)));
  const msgs: ServerMessage[] = [
    {
      type: "period.started",
      payload: {
        periodId: "per_demo",
        school: { id: "sch_demo", name: "Blockchain" },
        classroom: { id: "cls_demo", name: "Class A" },
        concept: { id: "cpt_demo", title: "Merkle tree construction" },
        concepts: [{ id: "cpt_demo", title: "Merkle tree construction" }],
        cadets: cadets.map(([name, archetype, seat], i) => ({
          id: `cdt_${i}`,
          name,
          archetype,
          seat,
          homeworld: "Titan Shipyards",
          quirk: "",
          comprehension: 0,
          state: "attentive",
        })),
        plannedMinutes: 15,
        elapsedMs: 0,
        resumed: false,
        paused: false,
        xp: {
          total: 340,
          rank: "Cadet Instructor",
          next: { name: "Lecturer", minXp: 500 },
          progress: 0.68,
        },
        transcript: [],
      },
    },
    {
      type: "turn.started",
      payload: {
        turnId: "t1",
        text: "Picture a tournament bracket: each transaction is hashed, then neighbouring hashes are paired and hashed again.",
      },
    },
    {
      type: "ledger.update",
      payload: { turnId: "t1", conceptId: "cpt_demo", cadets: [], classAverage: 0.42 },
    },
    // A realistic mix of reactions, two hands, and one cadet speaking.
    ...(
      [
        "skeptical",
        "confused",
        "attentive",
        "excited",
        "notetaking",
        "attentive",
        "bored",
        "confused",
        "skeptical",
        "attentive",
        "notetaking",
        "attentive",
        "excited",
        "confused",
        "notetaking",
      ] as const
    )
      .slice(0, cadets.length)
      .map((state, i): ServerMessage => ({
        type: "crowd.reaction",
        payload: { turnId: "t1", cadetId: `cdt_${i}`, state },
      })),
    {
      type: "hands.update",
      payload: {
        queue: [
          {
            cadetId: "cdt_1",
            intent: "clarify",
            preview: "Wait, which hashes get paired first?",
            urgency: 0.8,
          },
          {
            cadetId: "cdt_8",
            intent: "challenge",
            preview: "Why does pairing make it tamper-proof?",
            urgency: 0.7,
          },
        ],
      },
    },
    {
      type: "cadet.stream",
      payload: {
        cadetId: "cdt_0",
        streamId: "s1",
        delta:
          "Headmaster, you said neighbouring hashes are paired. What if a level has an odd number?",
      },
    },
  ];
  store.setState((s) => ({
    classroom: msgs.reduce((acc, m) => applyServerMessage(acc, m), s.classroom),
  }));
}
