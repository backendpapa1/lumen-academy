import { describe, expect, it } from "vitest";
import { diagramText, type Diagram } from "@lumen/shared";
import { arrowEnds, recognize, type Point } from "./sketch";

const box = (id: string, x: number, y: number, label = id) => ({ id, x, y, w: 80, h: 40, label });

describe("rough shapes snap to real ones (V6-09)", () => {
  it("a closed wobbly rectangle becomes a snapped box", () => {
    const pts: Point[] = [];
    for (let x = 100; x <= 220; x += 10) pts.push([x, 50 + (x % 3)]);
    for (let y = 50; y <= 120; y += 10) pts.push([221, y]);
    for (let x = 220; x >= 100; x -= 10) pts.push([x, 121]);
    for (let y = 120; y >= 54; y -= 10) pts.push([99, y]);
    const r = recognize(pts, []);
    expect(r).toMatchObject({ kind: "box", x: 96, y: 48 });
  });

  it("a circle stays a freehand mark", () => {
    const pts: Point[] = Array.from({ length: 40 }, (_, i) => [
      200 + 50 * Math.cos((i / 39) * 2 * Math.PI),
      120 + 50 * Math.sin((i / 39) * 2 * Math.PI),
    ]);
    expect(recognize(pts, []).kind).toBe("stroke");
  });

  it("a stroke from one box to another becomes an arrow between them", () => {
    const nodes = [box("a", 20, 20), box("b", 300, 160)];
    const pts: Point[] = [
      [60, 40],
      [150, 90],
      [250, 150],
      [330, 180],
    ];
    expect(recognize(pts, nodes)).toEqual({ kind: "arrow", from: "a", to: "b" });
    const [s, e] = arrowEnds(nodes[0]!, nodes[1]!);
    expect(s[0]).toBeGreaterThanOrEqual(20);
    expect(e[0]).toBeLessThanOrEqual(380);
  });

  it("the server reads the structure as a sentence", () => {
    const d: Diagram = {
      nodes: [
        box("r", 200, 20, "Merkle root"),
        box("a", 100, 150, "Hash A"),
        box("b", 300, 150, "Hash B"),
      ],
      edges: [
        { id: "e1", from: "a", to: "r", label: "hashed together" },
        { id: "e2", from: "b", to: "r", label: "" },
      ],
      labels: [{ id: "l1", x: 500, y: 20, text: "in the header" }],
      strokes: [
        {
          id: "s1",
          points: [
            [1, 1],
            [2, 2],
          ],
        },
      ],
    };
    expect(diagramText(d)).toBe(
      '(draws a diagram on the board) Boxes: [Merkle root], [Hash A], [Hash B]. Arrows: [Hash A] → [Merkle root] ("hashed together"); [Hash B] → [Merkle root]. Notes: "in the header".',
    );
  });
});
