import { ServerMessageZ, WS_PATH, type ClientMessage, type ServerMessage } from "@lumen/shared";

// WebSocket client: queues messages until open, reconnects with backoff,
// validates every frame. The server is the only thing that talks to providers.

type Status = "connecting" | "open" | "closed";
type Payload<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>["payload"];

/**
 * Dev: the Vite client on 5173 talks to the server on 5174. A built client is
 * served by the server itself (the desktop app, ADR-011), so it uses its own origin.
 */
export const SERVER_HTTP =
  (import.meta.env.VITE_SERVER as string | undefined) ??
  (import.meta.env.DEV ? "http://127.0.0.1:5174" : location.origin);

export class Net {
  private ws: WebSocket | null = null;
  private queue: string[] = [];
  private retry = 0;
  private stopped = false;
  status: Status = "closed";

  constructor(
    private readonly onMessage: (m: ServerMessage) => void,
    private readonly onStatus: (s: Status) => void = () => {},
    private readonly url = SERVER_HTTP.replace(/^http/, "ws") + WS_PATH,
  ) {}

  connect() {
    this.stopped = false;
    this.setStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus("open");
      for (const frame of this.queue.splice(0)) ws.send(frame);
    };
    ws.onmessage = (e) => {
      const parsed = ServerMessageZ.safeParse(JSON.parse(String(e.data)));
      if (parsed.success) this.onMessage(parsed.data);
      else console.warn("[net] dropped invalid server message", parsed.error.issues[0]);
    };
    ws.onclose = () => {
      this.setStatus("closed");
      if (this.stopped) return;
      const delay = Math.min(5000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  send<T extends ClientMessage["type"]>(type: T, payload: Payload<T>) {
    const frame = JSON.stringify({ type, payload });
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame);
    else this.queue.push(frame);
  }

  close() {
    this.stopped = true;
    this.ws?.close();
  }

  private setStatus(s: Status) {
    this.status = s;
    this.onStatus(s);
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(SERVER_HTTP + path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}
