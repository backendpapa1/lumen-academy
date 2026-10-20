import { ClientMessageZ, EnvelopeZ, type ClientMessage, type ServerMessage } from "@lumen/shared";

/**
 * Parses one raw frame into a validated client message, or the error to send
 * back. Pure so it can be tested without a socket.
 */
export function parseClientFrame(
  raw: string,
): { ok: true; msg: ClientMessage } | { ok: false; error: ServerMessage } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: wsError("bad_json", "frame is not valid JSON") };
  }
  const envelope = EnvelopeZ.safeParse(json);
  if (!envelope.success)
    return { ok: false, error: wsError("bad_envelope", "expected { type, sessionId?, payload }") };
  const msg = ClientMessageZ.safeParse(json);
  if (!msg.success) {
    const known = ClientMessageZ.options.some((o) => o.shape.type.value === envelope.data.type);
    return {
      ok: false,
      error: known
        ? wsError("bad_payload", `invalid payload for "${envelope.data.type}"`)
        : wsError("unknown_type", `unknown message type "${envelope.data.type}"`),
    };
  }
  return { ok: true, msg: msg.data };
}

export function handleClientMessage(msg: ClientMessage, now = () => new Date()): ServerMessage {
  switch (msg.type) {
    case "ping":
      return {
        type: "pong",
        sessionId: msg.sessionId,
        payload: { nonce: msg.payload.nonce, serverTime: now().toISOString() },
      };
  }
}

const wsError = (code: string, message: string): ServerMessage => ({
  type: "error",
  payload: { code, message },
});
