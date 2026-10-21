import { describe, expect, it } from "vitest";
import type { CadetView, ServerMessage } from "@lumen/shared";
import { applySetupMessage, initialSetup } from "./setup";

const cadet = (id: string): CadetView => ({
  id,
  name: id,
  archetype: "skeptic",
  seat: 1,
  homeworld: "Titan",
  quirk: "",
  comprehension: 0,
  state: "attentive",
  portraitUrl: null,
});
const run = (msgs: ServerMessage[]) => msgs.reduce(applySetupMessage, initialSetup());

describe("applySetupMessage", () => {
  it("tracks indexing jobs by title", () => {
    const s = run([
      {
        type: "source.status",
        payload: { schoolId: "s", sourceId: null, title: "Ch 1", status: "parsing" },
      },
      {
        type: "source.status",
        payload: { schoolId: "s", sourceId: "src_1", title: "Ch 1", status: "ready" },
      },
    ]);
    expect(s.sourceJobs["Ch 1"]).toMatchObject({ status: "ready", sourceId: "src_1" });
  });

  it("collects arrivals in order, once each, then assembles; portraits attach as they land", () => {
    const s = run([
      {
        type: "registration.started",
        payload: { classroomId: "c", schoolId: "s", name: "Class B", total: 2 },
      },
      {
        type: "registration.arrival",
        payload: { classroomId: "c", cadet: cadet("a"), index: 1, total: 2 },
      },
      {
        type: "registration.arrival",
        payload: { classroomId: "c", cadet: cadet("a"), index: 1, total: 2 },
      },
      {
        type: "registration.arrival",
        payload: { classroomId: "other", cadet: cadet("x"), index: 1, total: 2 },
      },
      {
        type: "registration.arrival",
        payload: { classroomId: "c", cadet: cadet("b"), index: 2, total: 2 },
      },
      {
        type: "asset.ready",
        payload: {
          assetId: "ast",
          kind: "portrait",
          ownerType: "cadet",
          ownerId: "b",
          status: "ready",
          url: "/api/assets/ast",
        },
      },
      { type: "registration.done", payload: { classroomId: "c", status: "active" } },
    ]);
    expect(s.registration!.arrivals.map((c) => c.id)).toEqual(["a", "b"]);
    expect(s.registration!.arrivals[1]!.portraitUrl).toBe("/api/assets/ast");
    expect(s.registration!.status).toBe("assembled");
  });

  it("refreshes a School's emblem when it lands", () => {
    const s0 = {
      ...initialSetup(),
      schools: [
        {
          id: "s",
          name: "B",
          description: null,
          accent: null,
          emblemUrl: null,
          sources: 0,
          concepts: 0,
          classrooms: [],
        },
      ],
    };
    const s = applySetupMessage(s0, {
      type: "asset.ready",
      payload: {
        assetId: "e",
        kind: "emblem",
        ownerType: "school",
        ownerId: "s",
        status: "ready",
        url: "/api/assets/e",
      },
    });
    expect(s.schools![0]!.emblemUrl).toBe("/api/assets/e");
  });
});
