import { nativeAudio, wavInfo } from "./nativeAudio";
import { SERVER_HTTP } from "./net";

// The guided tour's narrator (Paul's note: the guide should have a speaker).
// Lines come from the local Kokoro voice on the server (/api/speech/narrate);
// where the browser has its own speech synthesis it's the fallback (the
// desktop app's WebKitGTK has none). Nothing leaves the machine either way.
//
// In the desktop app the shell plays the audio (nativeAudio.ts): no click
// needed, and it works where WebKitGTK's own audio is silent. In a browser:
// - Audio starts locked and `AudioContext.resume()` never settles without a
//   click, so we never wait on it: the line waits for the first click or key
//   press anywhere, and the speaker button says "Tap to hear me".
// - A long line takes Kokoro seconds to make, so it's spoken sentence by
//   sentence: the first one plays as soon as it's ready, the rest follow.

const KEY = "lumen.tourVoice";

export type NarratorState = "idle" | "loading" | "speaking" | "blocked" | "unavailable";

/** A line split into sentences, short ones joined so the voice doesn't stutter. */
export function sentences(text: string): string[] {
  const parts = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text];
  const out: string[] = [];
  for (const p of parts.map((s) => s.trim()).filter(Boolean)) {
    const last = out.at(-1);
    if (last && last.split(/\s+/).length < 4) out[out.length - 1] = `${last} ${p}`;
    else out.push(p);
  }
  return out;
}

class Narrator {
  private ctx: AudioContext | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private token = 0;
  private listeners = new Set<(s: NarratorState) => void>();
  /** Audio already asked for, per sentence, so the next step starts without a wait. */
  private cache = new Map<string, Promise<ArrayBuffer>>();
  /** The line waiting for the first click (audio is locked until then). */
  private waiting: string | null = null;
  /** Desktop app: when the shell finishes the current line. */
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  state: NarratorState = "idle";

  constructor() {
    // Any click or key press unlocks audio and speaks the line that was waiting.
    const unlock = () => {
      this.unlock();
      if (this.waiting && this.on) void this.say(this.waiting);
    };
    if (typeof window !== "undefined") {
      window.addEventListener("pointerdown", unlock, true);
      window.addEventListener("keydown", unlock, true);
    }
  }

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

  /** Call from a click or key press: browsers only allow sound after one. */
  unlock() {
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state !== "running") void this.ctx.resume().catch(() => undefined);
    } catch {
      /* no Web Audio: say() falls back */
    }
  }

  /** True once audio runs; false if it's still locked after a moment. */
  private async running(): Promise<boolean> {
    const ctx = this.ctx;
    if (!ctx) return false;
    // Read fresh each time: the state changes while we wait.
    const live = (): AudioContextState => ctx.state;
    if (live() === "running") return true;
    void ctx.resume().catch(() => undefined);
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (live() === "running") return true;
    }
    return false;
  }

  /** Reads a line, replacing whatever was being read. */
  async say(text: string): Promise<void> {
    this.stop();
    if (!this.on) return;
    const token = ++this.token;
    if (nativeAudio.available) return this.sayNative(text, token);
    try {
      this.ctx ??= new AudioContext();
    } catch {
      return this.browserSay(text, token);
    }
    if (!(await this.running())) {
      if (token !== this.token) return;
      this.waiting = text;
      this.set("blocked");
      return;
    }
    if (token !== this.token) return;
    this.waiting = null;
    this.set("loading");
    const ctx = this.ctx;
    const parts = sentences(text);
    // Ask for every sentence now; the server makes them in order, so the first is ready first.
    const audio = parts.map((p) => this.fetch(p));
    let endsAt = 0;
    let played = 0;
    for (const [i, a] of audio.entries()) {
      let buf: AudioBuffer;
      try {
        buf = await ctx.decodeAudioData((await a).slice(0));
      } catch {
        if (token !== this.token) return;
        // No voice at all: say so (or let the browser read it, where it can).
        if (played === 0) return this.browserSay(parts.slice(i).join(" "), token);
        continue;
      }
      if (token !== this.token) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const at = Math.max(ctx.currentTime + 0.03, endsAt);
      src.start(at);
      endsAt = at + buf.duration;
      this.sources.push(src);
      played++;
      if (played === 1) this.set("speaking");
      if (i === audio.length - 1) src.onended = () => token === this.token && this.set("idle");
    }
  }

  /** The desktop app: each sentence goes to the shell as soon as it's made. */
  private async sayNative(text: string, token: number): Promise<void> {
    this.set("loading");
    const parts = sentences(text);
    const audio = parts.map((p) => this.fetch(p));
    let endsAt = 0;
    let played = 0;
    for (const a of audio) {
      let wav: ArrayBuffer;
      try {
        wav = await a;
      } catch {
        if (token !== this.token) return;
        if (played === 0) return this.set("unavailable");
        continue;
      }
      if (token !== this.token) return;
      const { duration } = wavInfo(wav);
      await nativeAudio.play("narrator", wav, { queue: played > 0 }).catch(() => undefined);
      endsAt = Math.max(performance.now(), endsAt) + duration * 1000;
      played++;
      if (played === 1) this.set("speaking");
    }
    if (token !== this.token) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => token === this.token && this.set("idle"),
      Math.max(0, endsAt - performance.now()),
    );
  }

  /** Starts fetching a line's audio (the tour asks for the next step's). */
  prefetch(text: string) {
    if (!this.on) return;
    for (const p of sentences(text)) void this.fetch(p).catch(() => undefined);
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

  /** The fallback: the browser's own voice, where there is one. */
  private browserSay(text: string, token: number) {
    const synth = typeof speechSynthesis === "undefined" ? null : speechSynthesis;
    if (!synth) return this.set("unavailable");
    const u = new SpeechSynthesisUtterance(text);
    const voices = synth.getVoices().filter((v) => v.lang.startsWith("en"));
    u.voice =
      voices.find((v) =>
        /female|samantha|serena|libby|sonia|zira|google uk english female/i.test(v.name),
      ) ??
      voices[0] ??
      null;
    u.onend = () => token === this.token && this.set("idle");
    synth.speak(u);
    this.set("speaking");
  }

  stop() {
    this.token++;
    this.waiting = null;
    clearTimeout(this.idleTimer);
    if (nativeAudio.available) nativeAudio.stop("narrator");
    for (const s of this.sources)
      try {
        s.stop();
      } catch {
        /* already ended */
      }
    this.sources = [];
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    if (this.state !== "idle") this.set("idle");
  }
}

export const narrator = new Narrator();
