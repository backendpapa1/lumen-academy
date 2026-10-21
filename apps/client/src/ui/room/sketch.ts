import type { Diagram } from "@lumen/shared";

// Rough shapes snap to real ones (V6-09, VD13): a closed, roughly rectangular
// pen stroke becomes a box; a stroke from one box to another becomes an arrow;
// anything else stays a freehand mark (decoration, never read).

export type Point = [number, number];
type Node = Diagram["nodes"][number];

export const GRID = 8;
export const snap = (v: number) => Math.round(v / GRID) * GRID;

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The box a point is in (or within `pad` of), topmost first. */
export function nodeAt(nodes: Node[], p: Point, pad = 12): Node | undefined {
  return [...nodes]
    .reverse()
    .find(
      (n) =>
        p[0] >= n.x - pad &&
        p[0] <= n.x + n.w + pad &&
        p[1] >= n.y - pad &&
        p[1] <= n.y + n.h + pad,
    );
}

export type Recognized =
  | { kind: "box"; x: number; y: number; w: number; h: number }
  | { kind: "arrow"; from: string; to: string }
  | { kind: "stroke" };

export function recognize(points: Point[], nodes: Node[]): Recognized {
  if (points.length < 4) return { kind: "stroke" };
  const first = points[0]!;
  const last = points.at(-1)!;
  const from = nodeAt(nodes, first);
  const to = nodeAt(nodes, last);
  if (from && to && from.id !== to.id) return { kind: "arrow", from: from.id, to: to.id };
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const w = Math.max(...xs) - x0;
  const h = Math.max(...ys) - y0;
  const diag = Math.hypot(w, h);
  const closed = dist(first, last) < Math.max(18, diag * 0.22);
  if (closed && w >= 28 && h >= 20) {
    // Rectangle-ish: most points hug the bounding box's edges (a circle doesn't).
    const edge = Math.max(6, Math.min(w, h) * 0.18);
    const near = points.filter(
      (p) =>
        Math.abs(p[0] - x0) < edge ||
        Math.abs(p[0] - (x0 + w)) < edge ||
        Math.abs(p[1] - y0) < edge ||
        Math.abs(p[1] - (y0 + h)) < edge,
    ).length;
    // ...and it reaches all four corners (a circle's nearest point stays ~0.4r away).
    const c = Math.max(6, Math.min(w, h) * 0.15);
    const corners: Point[] = [
      [x0, y0],
      [x0 + w, y0],
      [x0, y0 + h],
      [x0 + w, y0 + h],
    ];
    const cornered = corners.every((k) => points.some((p) => dist(p, k) < c));
    if (near / points.length > 0.7 && cornered)
      return {
        kind: "box",
        x: snap(x0),
        y: snap(y0),
        w: Math.max(GRID * 4, snap(w)),
        h: Math.max(GRID * 3, snap(h)),
      };
  }
  return { kind: "stroke" };
}

/** Where an arrow between two boxes starts and ends: on their edges, centre to centre. */
export function arrowEnds(a: Node, b: Node): [Point, Point] {
  const ca: Point = [a.x + a.w / 2, a.y + a.h / 2];
  const cb: Point = [b.x + b.w / 2, b.y + b.h / 2];
  const clip = (n: Node, from: Point, toward: Point): Point => {
    const dx = toward[0] - from[0];
    const dy = toward[1] - from[1];
    const tx = dx ? n.w / 2 / Math.abs(dx) : Infinity;
    const ty = dy ? n.h / 2 / Math.abs(dy) : Infinity;
    const t = Math.min(tx, ty, 1);
    return [from[0] + dx * t, from[1] + dy * t];
  };
  return [clip(a, ca, cb), clip(b, cb, ca)];
}
