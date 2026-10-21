import { app } from "./app";
import { store } from "./store";

// Hyperfocus (T-10, docs/08 §1): night lighting, bloom −40%, calmer motion in
// the room; on the server, sharper and more frequent questions. F or /focus.

export function toggleHyperfocus(): void {
  const c = store.getState().classroom;
  if (c.status !== "live") return;
  app.setHyperfocus(!c.hyperfocus);
}
