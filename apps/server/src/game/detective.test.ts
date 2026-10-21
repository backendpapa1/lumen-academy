import { describe, expect, it } from "vitest";
import { traceMiss } from "./detective.js";

// hashing → merkle → merkle path; blocks → merkle path
const graph = new Map(
  [
    { id: "hash", title: "Hashing", prereqs: [] },
    { id: "blocks", title: "Blocks", prereqs: [] },
    { id: "merkle", title: "Merkle trees", prereqs: ["hash"] },
    { id: "path", title: "Merkle paths", prereqs: ["merkle", "blocks"] },
  ].map((n) => [n.id, n]),
);

describe("prerequisite detective (V5-06)", () => {
  it("a miss on Merkle paths traces to hashing, which was never taught", () => {
    const levels = new Map<string, number | null>([
      ["merkle", 0.4],
      ["blocks", 0.8],
    ]);
    expect(traceMiss(graph, levels, 0.6, "path")).toEqual({
      id: "hash",
      path: ["hash", "merkle", "path"],
      level: null,
    });
  });

  it("the weakest taught prerequisite when everything was taught; null when all are solid", () => {
    const weak = new Map<string, number | null>([
      ["hash", 0.55],
      ["merkle", 0.3],
      ["blocks", 0.9],
    ]);
    expect(traceMiss(graph, weak, 0.6, "path")?.id).toBe("merkle");
    const solid = new Map<string, number | null>([
      ["hash", 0.9],
      ["merkle", 0.8],
      ["blocks", 0.9],
    ]);
    expect(traceMiss(graph, solid, 0.6, "path")).toBeNull();
  });
});
