import { EventEmitter } from "node:events";
import type { ServerMessage } from "@lumen/shared";

// Server-wide broadcast for background jobs started over REST (ingest,
// curriculum, registration). Every open WebSocket forwards these.

export type Broadcast = Extract<
  ServerMessage,
  {
    type:
      | "source.status"
      | "curriculum.status"
      | "registration.started"
      | "registration.arrival"
      | "registration.done"
      | "assignment.status"
      | "exam.status"
      | "exam.answer";
  }
>;

export class EventBus {
  private readonly ee = new EventEmitter().setMaxListeners(50);

  emit(m: Broadcast): void {
    this.ee.emit("msg", m);
  }

  on(fn: (m: Broadcast) => void): () => void {
    this.ee.on("msg", fn);
    return () => this.ee.off("msg", fn);
  }
}
