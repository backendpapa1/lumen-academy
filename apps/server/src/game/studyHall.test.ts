import { afterEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { smallWorld } from "../test-fixtures/world.js";
import { buddyQuestion, lookupsFor, markLookedUp } from "./studyHall.js";

const handles: DbHandle[] = [];
afterEach(() => handles.splice(0).forEach((h) => h.close()));

describe("study hall look-ups", () => {
  it("lists a question I left hanging until I mark it looked up", async () => {
    const w = await smallWorld([{ attention: 0.5, skepticism: 0.5 }]);
    handles.push(w.handle);
    const { sqlite } = w.handle;
    sqlite
      .prepare(
        "INSERT INTO periods (id, classroom_id, started_at, ended_at, planned_minutes) VALUES ('per_1', ?, '2026-10-01T10:00:00Z', '2026-10-01T10:15:00Z', 15)",
      )
      .run(w.classroomId);
    const msg = sqlite.prepare(
      "INSERT INTO messages (id, period_id, speaker, kind, text, concept_id, created_at) VALUES (?, 'per_1', ?, ?, ?, ?, ?)",
    );
    msg.run(
      "msg_a",
      "teacher",
      "lecture",
      "Merkle trees hash pairs.",
      null,
      "2026-10-01T10:01:00Z",
    );
    msg.run(
      "msg_b",
      w.cadets[0]!.id,
      "question",
      "Answered one?",
      w.conceptIds[0],
      "2026-10-01T10:02:00Z",
    );
    msg.run("msg_c", "teacher", "answer", "Yes.", null, "2026-10-01T10:03:00Z");
    msg.run(
      "msg_d",
      w.cadets[0]!.id,
      "question",
      "Why pairs, not triples?",
      w.conceptIds[0],
      "2026-10-01T10:14:00Z",
    );

    const items = lookupsFor(w.handle, w.schoolId);
    expect(items.map((i) => `${i.kind}:${i.text}`)).toEqual(["question:Why pairs, not triples?"]);
    expect(items[0]).toMatchObject({ who: "Cadet 0", conceptTitle: "Merkle Trees" });

    markLookedUp(w.handle, w.schoolId, "msg_d");
    expect(lookupsFor(w.handle, w.schoolId)).toEqual([]);
  });

  it("asks in the student's own way, naming the idea", () => {
    expect(buddyQuestion("pragmatist", "Merkle roots", 0)).toBe(
      "When would I actually use Merkle roots?",
    );
    expect(buddyQuestion("unknown", "Merkle roots", 1)).toContain("Merkle roots");
  });
});
