import mitt from "mitt";
import type { ServerMessage } from "@lumen/shared";

/** Every server message, for screens that follow background jobs (assignments, exams). */
export const serverEvents = mitt<{ message: ServerMessage }>();
