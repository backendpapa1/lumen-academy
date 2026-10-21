import type { ServerMessage } from "@lumen/shared";
import { serverEvents } from "./bus";
import { encodeWav, nativeAudio } from "./nativeAudio";
import { store, type AppState } from "./store";

// Procedural sound (docs/02 §6, M6-03), with no samples and no library: Web
// Audio pads per place (campus, classroom, exam) and short synthesized cues.
// Quiet by default; M mutes (remembered). Starts on the first key or click,
// as browsers require. Hyperfocus drops the pads to a slow ~60 BPM pulse.
//
// In the desktop app the same graphs are rendered with an OfflineAudioContext
// and played by the shell (nativeAudio.ts): WebKitGTK's live output can be
// silent. Cues are rendered once and cached; pads and ambience become loops.

type Bed = "campus" | "classroom" | "exam" | null;
type Ambience = "room" | "rain" | "cafe" | "library" | null;
/** The study hall's background, my choice (kept per browser). */
export type StudyAmbience = "rain" | "cafe" | "library" | "quiet";
const STUDY_AMBIENCE_KEY = "lumen.studyAmbience";
type CueName = "hand" | "bell" | "xp" | "speak" | "arrive" | "right" | "wrong" | "tick" | "pulse";
/** Where a graph plays: the live context's master, or an offline render. */
interface Target {
  ctx: BaseAudioContext;
  dest: AudioNode;
}
const MUTE_KEY = "lumen.muted";
const LEVEL = 0.22;
/** Offline renders: rate, a pad loop (one breath of its LFO), an ambience loop. */
const RATE = 44100;
const PAD_LOOP = 20;
const AMBIENCE_LOOP = 8;
const AMBIENCE_GAIN: Record<Exclude<Ambience, null>, number> = {
  room: 0.18,
  rain: 0.55,
  cafe: 0.4,
  library: 0.12,
};
const CUE_SECONDS: Record<CueName, number> = {
  hand: 0.6,
  bell: 2.6,
  xp: 0.6,
  speak: 0.45,
  arrive: 1.6,
  right: 0.25,
  wrong: 0.3,
  tick: 0.1,
  pulse: 0.7,
};

// Chords as frequencies (Hz): calm, open voicings.
const CHORDS: Record<Exclude<Bed, null>, number[]> = {
  campus: [130.81, 196.0, 246.94, 293.66, 392.0], // C, G, B, D, G: Cmaj9 airy
  classroom: [110.0, 164.81, 196.0, 246.94, 329.63], // A, E, G, B, E: Am(add9)
  exam: [146.83, 220.0, 261.63, 311.13], // D, A, C, Eb: a little tension
};

class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bed: { name: Bed; gain: GainNode; stop: () => void } | null = null;
  private pulse: ReturnType<typeof setInterval> | null = null;
  private wanted: Bed = null;
  private lastTick = 0;
  /** Desktop app: sound is on (no gesture needed), and what's looping now. */
  private native = false;
  private nativeBed: Bed = null;
  private nativeAmbience: Ambience = null;
  private rendered = new Map<string, Promise<ArrayBuffer>>();
  muted = readMuted();

  /** Browsers only allow audio after a gesture. */
  unlock() {
    if (this.muted) return;
    if (nativeAudio.available) {
      if (this.native) return;
      this.native = true;
      this.setBed(this.wanted);
      this.setAmbience(this.wantedAmbience);
      return;
    }
    if (this.ctx) return;
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = LEVEL;
    this.master.connect(this.ctx.destination);
    this.setBed(this.wanted);
    this.setAmbience(this.wantedAmbience);
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? "1" : "0");
    } catch {
      /* fine */
    }
    if (this.muted) {
      if (this.native) {
        for (const ch of ["bed", "ambience"]) nativeAudio.stop(ch);
        this.native = false;
        this.nativeBed = null;
        this.nativeAmbience = null;
      }
      this.bed?.stop();
      this.bed = null;
      this.ambience = null; // the context closes under it
      void this.ctx?.close();
      this.ctx = null;
      this.master = null;
    } else this.unlock();
    return this.muted;
  }

  private live(): Target | null {
    return this.ctx && this.master ? { ctx: this.ctx, dest: this.master } : null;
  }

  /** Renders a graph offline once (cached by key) as a WAV for the shell. */
  private render(
    key: string,
    seconds: number,
    build: (t: Target) => void,
    fade = 0,
  ): Promise<ArrayBuffer> {
    let p = this.rendered.get(key);
    if (!p) {
      const off = new OfflineAudioContext(1, Math.ceil(RATE * seconds), RATE);
      const out = off.createGain();
      out.connect(off.destination);
      if (fade) {
        // Soft edges, so a loop breathes rather than clicks.
        out.gain.setValueAtTime(0, 0);
        out.gain.linearRampToValueAtTime(1, fade);
        out.gain.setValueAtTime(1, seconds - fade);
        out.gain.linearRampToValueAtTime(0, seconds);
      }
      build({ ctx: off, dest: out });
      p = off.startRendering().then(encodeWav);
      p.catch(() => this.rendered.delete(key));
      this.rendered.set(key, p);
    }
    return p;
  }

  setBed(name: Bed) {
    this.wanted = name;
    if (this.native) return this.setBedNative(name);
    const ctx = this.ctx;
    if (!ctx || !this.master || this.bed?.name === name) return;
    const old = this.bed;
    if (old) {
      old.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.8);
      setTimeout(() => old.stop(), 4000);
    }
    this.bed = null;
    if (!name) return;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(1, ctx.currentTime, 1.5);
    gain.connect(this.master);
    const stop = padGraph(ctx, name, gain);
    this.bed = {
      name,
      gain,
      stop: () => {
        stop();
        gain.disconnect();
      },
    };
    this.applyHyperfocus(store.getState().classroom.hyperfocus);
  }

  private setBedNative(name: Bed) {
    if (this.nativeBed === name) return;
    this.nativeBed = name;
    if (!name) return nativeAudio.stop("bed");
    void this.render(`bed:${name}`, PAD_LOOP, (t) => padGraph(t.ctx, name, t.dest), 0.4).then(
      (wav) => {
        if (this.nativeBed !== name || !this.native) return;
        void nativeAudio.play("bed", wav, { loop: true, volume: this.bedLevel() });
      },
    );
  }

  private bedLevel(): number {
    return LEVEL * (store.getState().classroom.hyperfocus ? 0.35 : 1);
  }

  applyHyperfocus(on: boolean) {
    if (this.pulse) clearInterval(this.pulse);
    this.pulse = null;
    if (this.native) {
      nativeAudio.volume("bed", this.bedLevel());
      if (on) this.pulse = setInterval(() => this.cue("pulse"), 1000); // ~60 BPM
      return;
    }
    const ctx = this.ctx;
    if (!ctx || !this.bed) return;
    this.bed.gain.gain.setTargetAtTime(on ? 0.35 : 1, ctx.currentTime, 1.2);
    this.pulse = on ? setInterval(() => this.blip(82.41, 0.18, 0.05, "sine", 0.6), 1000) : null; // ~60 BPM
  }

  /** One enveloped tone. */
  private blip(
    freq: number,
    peak: number,
    attack: number,
    type: OscillatorType,
    decay: number,
    at = 0,
    target: Target | null = this.live(),
  ) {
    if (!target) return;
    const { ctx, dest } = target;
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + attack + decay + 0.05);
  }

  private ambience: { name: Ambience; stop: () => void } | null = null;
  private wantedAmbience: Ambience = null;

  /**
   * A layer under the pad (V1-08): room tone in class, rain on the campus when
   * the streak weather says so. Noise, shaped; no samples.
   */
  setAmbience(name: Ambience) {
    this.wantedAmbience = name;
    if (this.native) return this.setAmbienceNative(name);
    const ctx = this.ctx;
    if (!ctx || !this.master || this.ambience?.name === name) return;
    this.ambience?.stop();
    this.ambience = null;
    if (!name) return;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setTargetAtTime(AMBIENCE_GAIN[name], ctx.currentTime, 2);
    g.connect(this.master);
    const src = noiseGraph(ctx, name, g);
    const drops =
      name === "rain"
        ? setInterval(() => this.blip(2200 + Math.random() * 1800, 0.012, 0.002, "sine", 0.05), 140)
        : name === "cafe"
          ? setInterval(() => Math.random() < 0.3 && this.clink(), 900)
          : null;
    this.ambience = {
      name,
      stop: () => {
        g.gain.setTargetAtTime(0, ctx.currentTime, 0.6);
        if (drops) clearInterval(drops);
        setTimeout(() => src.stop(), 2500);
      },
    };
  }

  private setAmbienceNative(name: Ambience) {
    if (this.nativeAmbience === name) return;
    this.nativeAmbience = name;
    if (!name) return nativeAudio.stop("ambience");
    const build = (t: Target) => {
      const g = t.ctx.createGain();
      g.gain.value = AMBIENCE_GAIN[name];
      g.connect(t.dest);
      noiseGraph(t.ctx, name, g);
      if (name === "rain")
        for (let at = 0.1; at < AMBIENCE_LOOP - 0.1; at += 0.14)
          this.blip(2200 + Math.random() * 1800, 0.012, 0.002, "sine", 0.05, at, t);
      if (name === "cafe") for (const at of [1.3, 4.6, 6.2]) this.clink(at, t);
    };
    void this.render(`ambience:${name}`, AMBIENCE_LOOP, build, 0.3).then((wav) => {
      if (this.nativeAmbience !== name || !this.native) return;
      void nativeAudio.play("ambience", wav, { loop: true, volume: LEVEL });
    });
  }

  /** A cup set down on a saucer, somewhere across the café. */
  private clink(at = 0, target: Target | null = this.live()) {
    const f = 2600 + Math.random() * 900;
    this.blip(f, 0.02, 0.002, "sine", 0.18, at, target);
    this.blip(f * 1.5, 0.008, 0.002, "sine", 0.12, at + 0.01, target);
  }

  /** The study hall's background: rain, a café, a library hush, or nothing. */
  get studyAmbience(): StudyAmbience {
    try {
      const v = localStorage.getItem(STUDY_AMBIENCE_KEY);
      if (v === "rain" || v === "cafe" || v === "library" || v === "quiet") return v;
    } catch {
      /* per-viewer convenience */
    }
    return "rain";
  }
  setStudyAmbience(name: StudyAmbience) {
    try {
      localStorage.setItem(STUDY_AMBIENCE_KEY, name);
    } catch {
      /* fine */
    }
    if (store.getState().route.name === "studyhall")
      this.setAmbience(name === "quiet" ? null : name);
  }

  /** A chair scraping back: someone's hand goes up. */
  private scrape(target: Target) {
    const { ctx, dest } = target;
    const len = ctx.sampleRate * 0.28;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.sin((Math.PI * i) / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = 6;
    f.frequency.setValueAtTime(700, ctx.currentTime);
    f.frequency.exponentialRampToValueAtTime(260, ctx.currentTime + 0.26);
    const g = ctx.createGain();
    g.gain.value = 0.16;
    src.connect(f).connect(g).connect(dest);
    src.start();
  }

  /** Filtered noise sweep (arrivals). */
  private whoosh(target: Target) {
    const { ctx, dest } = target;
    const len = ctx.sampleRate * 1.2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = 2;
    f.frequency.setValueAtTime(300, ctx.currentTime);
    f.frequency.exponentialRampToValueAtTime(2400, ctx.currentTime + 0.9);
    const g = ctx.createGain();
    g.gain.value = 0.25;
    src.connect(f).connect(g).connect(dest);
    src.start();
  }

  cue(name: CueName) {
    if (name === "tick") {
      // Reactions arrive in bursts: one soft tick per burst.
      const now = performance.now();
      if (now - this.lastTick < 400) return;
      this.lastTick = now;
    }
    if (this.native) {
      void this.render(`cue:${name}`, CUE_SECONDS[name], (t) => this.playCue(name, t)).then(
        (wav) => {
          if (this.native) void nativeAudio.play("sfx", wav, { mix: true, volume: LEVEL });
        },
      );
      return;
    }
    const t = this.live();
    if (t) this.playCue(name, t);
  }

  private playCue(name: CueName, t: Target) {
    switch (name) {
      case "hand":
        this.scrape(t);
        this.blip(659.25, 0.07, 0.01, "sine", 0.18, 0.12, t);
        this.blip(987.77, 0.06, 0.01, "sine", 0.25, 0.2, t);
        break;
      case "bell":
        for (const [f, p] of [
          [523.25, 0.2],
          [784.0, 0.12],
          [1046.5, 0.08],
          [1318.5, 0.05],
        ] as const)
          this.blip(f, p, 0.005, "sine", 2.4, 0, t);
        break;
      case "xp":
        [784, 988, 1175, 1568].forEach((f, i) =>
          this.blip(f, 0.08, 0.005, "triangle", 0.25, i * 0.06, t),
        );
        break;
      case "speak":
        this.blip(440, 0.06, 0.02, "sine", 0.35, 0, t);
        break;
      case "arrive":
        this.whoosh(t);
        this.blip(587.33, 0.08, 0.3, "sine", 0.8, 0.6, t);
        break;
      case "right":
        this.blip(880, 0.07, 0.005, "sine", 0.15, 0, t);
        break;
      case "wrong":
        this.blip(196, 0.06, 0.005, "triangle", 0.2, 0, t);
        break;
      case "tick":
        this.blip(1200, 0.025, 0.002, "sine", 0.05, 0, t);
        break;
      case "pulse": // hyperfocus, ~60 BPM
        this.blip(82.41, 0.18, 0.05, "sine", 0.6, 0, t);
        break;
    }
  }
}

/** A place's pad: detuned chord tones through a slowly breathing low-pass. */
function padGraph(ctx: BaseAudioContext, name: Exclude<Bed, null>, out: AudioNode): () => void {
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 900;
  filter.Q.value = 0.4;
  // A slow breath on the filter: the pad never sits still.
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.frequency.value = 0.05;
  lfoGain.gain.value = 380;
  lfo.connect(lfoGain).connect(filter.frequency);
  filter.connect(out);
  const oscs = CHORDS[name].flatMap((f, i) =>
    [-4, 4].map((detune) => {
      const o = ctx.createOscillator();
      o.type = i === 0 ? "sine" : "triangle";
      o.frequency.value = f;
      o.detune.value = detune + i * 1.5;
      const g = ctx.createGain();
      g.gain.value = (i === 0 ? 0.16 : 0.07) / 2;
      o.connect(g).connect(filter);
      o.start();
      return o;
    }),
  );
  lfo.start();
  return () => {
    for (const o of [...oscs, lfo]) o.stop();
  };
}

/** Room tone or rain: brownish noise, filtered. Returns the looping source. */
function noiseGraph(
  ctx: BaseAudioContext,
  name: Exclude<Ambience, null>,
  out: AudioNode,
): AudioBufferSourceNode {
  const len = ctx.sampleRate * 4;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  // Brownish noise: each sample drifts from the last (soft, low).
  let last = 0;
  for (let i = 0; i < len; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    d[i] = last * 3.5;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  if (name === "room" || name === "library") {
    // A library is the room's hush, lower and softer.
    f.type = "lowpass";
    f.frequency.value = name === "room" ? 420 : 260;
  } else if (name === "cafe") {
    // Murmur: voices across the room are a band of low-mid noise.
    f.type = "bandpass";
    f.frequency.value = 520;
    f.Q.value = 0.8;
  } else {
    // Rain: brighter, with droplets on top (added by the caller).
    f.type = "bandpass";
    f.frequency.value = 1400;
    f.Q.value = 0.5;
  }
  src.connect(f).connect(out);
  src.start();
  return src;
}

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export const sound = new Sound();

function bedFor(s: AppState): Bed {
  const r = s.route.name;
  if (r === "exam") return "exam";
  if (r === "classroom" || r === "registration") return "classroom";
  if (r === "gallery" || r === "studyhall") return null;
  return "campus";
}

export function installSound() {
  const unlock = () => sound.unlock();
  window.addEventListener("pointerdown", unlock, { once: false, passive: true });
  window.addEventListener("keydown", unlock, { passive: true });
  // The desktop app's shell plays sound without waiting for a gesture.
  if (nativeAudio.available) unlock();
  // M mutes on every screen; the classroom's own key map handles it there.
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    const typing =
      t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable;
    if (
      typing ||
      e.key.toLowerCase() !== "m" ||
      e.metaKey ||
      e.ctrlKey ||
      store.getState().route.name === "classroom"
    )
      return;
    sound.toggleMute();
  });
  const ambienceFor = (s: AppState): Ambience => {
    const bed = bedFor(s);
    if (bed === "classroom") return "room";
    if (s.route.name === "studyhall") {
      const a = sound.studyAmbience; // V3-06: a soft bed, my choice of which
      return a === "quiet" ? null : a;
    }
    if (bed === "campus" && (s.setup.campus?.streak.missedDays ?? 0) >= 3) return "rain";
    return null;
  };
  sound.setBed(bedFor(store.getState()));
  sound.setAmbience(ambienceFor(store.getState()));
  store.subscribe((s, p) => {
    if (s.route !== p.route) sound.setBed(bedFor(s));
    if (s.route !== p.route || s.setup.campus !== p.setup.campus) sound.setAmbience(ambienceFor(s));
    if (s.classroom.hyperfocus !== p.classroom.hyperfocus)
      sound.applyHyperfocus(s.classroom.hyperfocus);
    if (s.classroom.hands.length > p.classroom.hands.length) sound.cue("hand");
    if (
      s.setup.registration &&
      s.setup.registration.arrivals.length > (p.setup.registration?.arrivals.length ?? 0)
    )
      sound.cue("arrive");
  });
  serverEvents.on("message", (m: ServerMessage) => {
    if (m.type === "crowd.reaction") sound.cue("tick");
    else if (m.type === "xp.update") sound.cue("xp");
    else if (m.type === "period.ended" || m.type === "exit.tickets") sound.cue("bell");
    else if (m.type === "exam.answer") sound.cue(m.payload.score >= 0.6 ? "right" : "wrong");
    else if (m.type === "cadet.stream" && m.payload.delta && !speaking.has(m.payload.streamId)) {
      speaking.add(m.payload.streamId);
      sound.cue("speak");
    }
  });
}
const speaking = new Set<string>();
