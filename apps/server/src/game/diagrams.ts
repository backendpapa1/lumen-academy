import { DiagramZ, type Diagram } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";

// V6-09: the board diagram, one per period, saved as objects so a reload (or
// the yearbook) gets exactly what I drew.

export function saveDiagram(handle: DbHandle, periodId: string, d: Diagram): void {
  handle.sqlite
    .prepare(
      `INSERT INTO diagrams (period_id, json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(period_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    )
    .run(periodId, JSON.stringify(d), new Date().toISOString());
}

export function loadDiagram(handle: DbHandle, periodId: string): Diagram | null {
  const row = handle.sqlite
    .prepare("SELECT json FROM diagrams WHERE period_id = ?")
    .get(periodId) as { json: string } | undefined;
  if (!row) return null;
  const parsed = DiagramZ.safeParse(JSON.parse(row.json));
  return parsed.success ? parsed.data : null;
}
