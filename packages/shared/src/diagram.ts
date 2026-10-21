import { z } from "zod";

// Whiteboard diagrams (V6-09, VD13): boxes, arrows and labels as objects, in
// the board's own units (0..BOARD_W × 0..BOARD_H). No vision model: the
// server reads the structure as text, so the students can quote the labels.
// Freehand strokes are decoration and never read.

export const BOARD_W = 672;
export const BOARD_H = 272;

const coord = (max: number) =>
  z
    .number()
    .min(-20)
    .max(max + 20);
const label = z.string().max(60);

export const DiagramZ = z.strictObject({
  nodes: z
    .array(
      z.strictObject({
        id: z.string().max(20),
        x: coord(BOARD_W),
        y: coord(BOARD_H),
        w: z.number().min(10).max(BOARD_W),
        h: z.number().min(10).max(BOARD_H),
        label,
      }),
    )
    .max(20),
  edges: z
    .array(z.strictObject({ id: z.string().max(20), from: z.string(), to: z.string(), label }))
    .max(30),
  labels: z
    .array(
      z.strictObject({ id: z.string().max(20), x: coord(BOARD_W), y: coord(BOARD_H), text: label }),
    )
    .max(12),
  strokes: z
    .array(
      z.strictObject({
        id: z.string().max(20),
        points: z.array(z.tuple([coord(BOARD_W), coord(BOARD_H)])).max(400),
      }),
    )
    .max(30),
});
export type Diagram = z.infer<typeof DiagramZ>;

export const emptyDiagram = (): Diagram => ({ nodes: [], edges: [], labels: [], strokes: [] });

/**
 * The diagram as a sentence the crowd and the Director read: its boxes, the
 * arrows between them (with their labels), and any loose notes. Positions
 * become plain words (left/right, top/bottom) only where they carry meaning.
 */
export function diagramText(d: Diagram): string {
  const name = (id: string) => {
    const n = d.nodes.find((x) => x.id === id);
    return n ? `[${n.label.trim() || "an unlabelled box"}]` : "[?]";
  };
  const parts: string[] = [];
  if (d.nodes.length) {
    // Top-to-bottom, then left-to-right, as a reader scans a board.
    const ordered = [...d.nodes].sort((a, b) => a.y - b.y || a.x - b.x);
    parts.push(`Boxes: ${ordered.map((n) => name(n.id)).join(", ")}.`);
  }
  const edges = d.edges.filter(
    (e) => d.nodes.some((n) => n.id === e.from) && d.nodes.some((n) => n.id === e.to),
  );
  if (edges.length)
    parts.push(
      `Arrows: ${edges
        .map(
          (e) => `${name(e.from)} → ${name(e.to)}${e.label.trim() ? ` ("${e.label.trim()}")` : ""}`,
        )
        .join("; ")}.`,
    );
  const notes = d.labels.filter((l) => l.text.trim());
  if (notes.length) parts.push(`Notes: ${notes.map((l) => `"${l.text.trim()}"`).join(", ")}.`);
  return parts.length ? `(draws a diagram on the board) ${parts.join(" ")}` : "";
}
