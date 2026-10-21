import { SERVER_HTTP } from "./net";

// The guided tour's narrator (Paul's note: the guide should have a speaker).
// Lines come from the local Kokoro voice on the server (/api/speech/narrate);
// without it, the browser's own speech synthesis reads them. Nothing leaves
// the machine either way. Whether it speaks is remembered in this browser.

const KEY = "lumen.tourVoice";

export type NarratorState = "idle" | "loading" | "speaking" | "blocked";

class Narrator {
  private ctx: AudioContext | null = null;
  private src: AudioBufferSourceNode | null = null;
  private token = 0;
  private listeners = new Set<(s: NarratorState) => void>();
  /** Audio already asked for, so the next step starts without a wait. */
  private cache = new Map<string, Promise<ArrayBuffer>>();
  state: NarratorState = "idle";

  get on(): boolean {
    try {
      return localStorage.getItem(KEY) !== "off";
    } catch {
      return true;
    }
  }
  set on(v: boolean) {
    try {
      localStorage.setItem(KEY, v ? "on" : "off");
    } catch {
      /* fine: it just won't be remembered */
    }
    if (!v) this.stop();
  }

  onChange(fn: (s: NarratorState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(s: NarratorState) {
    this.state = s;
    for (const fn of this.listeners) fn(s);
  }

  /** Call from a click: browsers only allow sound after one. */
  unlock() {
    this.ctx ??= new AudioContext();
    void this.ctx.resume();
  }

  /** Reads a line, replacing whatever was being read. */
  async say(text: string): Promise<void> {
    this.stop();
    if (!this.on) return;
    const token = ++this.token;
    this.ctx ??= new AudioContext();
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => undefined);
    if (this.ctx.state === "suspended") {
      // No click yet (first launch): the speaker button asks for one.
      this.set("blocked");
      return;
    }
    this.set("loading");
    try {
      const buf = await this.ctx.decodeAudioData((await this.fetch(text)).slice(0));
      if (token !== this.token) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx.destination);
      src.onended = () => token === this.token && this.set("idle");
      src.start();
      this.src = src;
      this.set("speaking");
    } catch {
      if (token !== this.token) return;
      this.browserSay(text, token);
    }
  }

  /** Starts fetching a line's audio (the tour asks for the next step's). */
  prefetch(text: string) {
    if (this.on) void this.fetch(text).catch(() => undefined);
  }

  private fetch(text: string): Promise<ArrayBuffer> {
    let p = this.cache.get(text);
    if (!p) {
      p = fetch(`${SERVER_HTTP}/api/speech/narrate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      }).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))));
      // A failure isn't kept: the next try may find the voice ready.
      p.catch(() => this.cache.delete(text));
      this.cache.set(text, p);
    }
    return p;
  }

  /** The fallback: the browser's own voice (local on every desktop OS). */
  private browserSay(text: string, token: number) {
    const synth = typeof speechSynthesis === "undefined" ? null : speechSynthesis;
    if (!synth) return this.set("idle");
    const u = new SpeechSynthesisUtterance(text);
    const voices = synth.getVoices().filter((v) => v.lang.startsWith("en"));
    u.voice =
      voices.find((v) =>
        /female|samantha|serena|libby|sonia|zira|google uk english female/i.test(v.name),
      ) ??
      voices[0] ??
      null;
    u.rate = 1;
    u.onend = () => token === this.token && this.set("idle");
    synth.speak(u);
    this.set("speaking");
  }

  stop() {
    this.token++;
    try {
      this.src?.stop();
    } catch {
      /* already ended */
    }
    this.src = null;
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    if (this.state !== "idle") this.set("idle");
  }
}

export const narrator = new Narrator();
