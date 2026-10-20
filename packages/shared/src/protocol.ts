import { z } from "zod";

// WebSocket protocol (docs/05 §5). Every message is { type, sessionId?, payload }.
// M0 defines the envelope and the ping/error plumbing; M2-01 adds the full set.

export const EnvelopeZ = z.strictObject({
  type: z.string().min(1),
  sessionId: z.string().optional(),
  payload: z.unknown(),
});
export type Envelope = z.infer<typeof EnvelopeZ>;

const msg = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.strictObject({ type: z.literal(type), sessionId: z.string().optional(), payload });

export const ClientMessageZ = z.discriminatedUnion("type", [
  msg("ping", z.strictObject({ nonce: z.string().max(64) })),
]);
export type ClientMessage = z.infer<typeof ClientMessageZ>;

export const ServerMessageZ = z.discriminatedUnion("type", [
  msg("pong", z.strictObject({ nonce: z.string(), serverTime: z.string() })),
  msg("error", z.strictObject({ code: z.string(), message: z.string() })),
]);
export type ServerMessage = z.infer<typeof ServerMessageZ>;

export const WS_PATH = "/ws";
