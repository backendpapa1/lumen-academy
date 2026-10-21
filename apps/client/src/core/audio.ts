import type { ServerMessage } from "@lumen/shared";
import { serverEvents } from "./bus";
import { store, type AppState } from "./store";

// Procedural sound (docs/02 §6, M6-03), with no samples and no library: Web
// Audio pads per place (campus, classroom, exam) and short synthesized cues.
// Quiet by default; M mutes (remembered). Starts on the first key or click,
// as browsers require. Hyperfocus drops the pads to a slow ~60 BPM pulse.

type Bed = "campus" | "classroom" | "exam" | null;
type Ambience = "room" | "rain" | null;
const MUTE_KEY = "lumen.muted";
const LEVEL = 0.22;

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
  muted = readMuted();

  /** Browsers only allow audio after a gesture. */
  unlock() {
    if (this.ctx || this.muted) return;
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
      this.bed?.stop();
      this.bed = null;
      this.ambience = null; // the context closes under it
      void this.ctx?.close();
      this.ctx = null;
      this.master = null;
    } else this.unlock();
    return this.muted;
  }

  setBed(name: Bed) {
    this.wanted = name;
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
    filter.connect(gain).connect(this.master);
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
    this.bed = {
      name,
      gain,
      stop: () => {
        for (const o of [...oscs, lfo]) o.stop();
        gain.disconnect();
      },
    };
    this.applyHyperfocus(store.getState().classroom.hyperfocus);
  }

  applyHyperfocus(on: boolean) {
    const ctx = this.ctx;
    if (!ctx || !this.bed) return;
    this.bed.gain.gain.setTargetAtTime(on ? 0.35 : 1, ctx.currentTime, 1.2);
    if (this.pulse) clearInterval(this.pulse);
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
  ) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    o.connect(g).connect(this.master);
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
    const ctx = this.ctx;
    if (!ctx || !this.master || this.ambience?.name === name) return;
    this.ambience?.stop();
    this.ambience = null;
    if (!name) return;
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
    const g = ctx.createGain();
    g.gain.value = 0;
    if (name === "room") {
      f.type = "lowpass";
      f.frequency.value = 420;
      g.gain.setTargetAtTime(0.18, ctx.currentTime, 2);
    } else {
      // Rain: brighter, with a slow swell, plus droplets.
      f.type = "bandpass";
      f.frequency.value = 1400;
      f.Q.value = 0.5;
      g.gain.setTargetAtTime(0.55, ctx.currentTime, 2);
    }
    src.connect(f).connect(g).connect(this.master);
    src.start();
    const drops =
      name === "rain"
        ? setInterval(() => this.blip(2200 + Math.random() * 1800, 0.012, 0.002, "sine", 0.05), 140)
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

  /** A chair scraping back: someone's hand goes up. */
  private scrape() {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
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
    src.connect(f).connect(g).connect(this.master);
    src.start();
  }

  /** Filtered noise sweep (arrivals). */
  private whoosh() {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
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
    src.connect(f).connect(g).connect(this.master);
    src.start();
  }

  cue(name: "hand" | "bell" | "xp" | "speak" | "arrive" | "right" | "wrong" | "tick") {
    if (!this.ctx) return;
    switch (name) {
      case "hand":
        this.scrape();
        this.blip(659.25, 0.07, 0.01, "sine", 0.18, 0.12);
        this.blip(987.77, 0.06, 0.01, "sine", 0.25, 0.2);
        break;
      case "bell":
        for (const [f, p] of [
          [523.25, 0.2],
          [784.0, 0.12],
          [1046.5, 0.08],
          [1318.5, 0.05],
        ] as const)
          this.blip(f, p, 0.005, "sine", 2.4);
        break;
      case "xp":
        [784, 988, 1175, 1568].forEach((f, i) =>
          this.blip(f, 0.08, 0.005, "triangle", 0.25, i * 0.06),
        );
        break;
      case "speak":
        this.blip(440, 0.06, 0.02, "sine", 0.35);
        break;
      case "arrive":
        this.whoosh();
        this.blip(587.33, 0.08, 0.3, "sine", 0.8, 0.6);
        break;
      case "right":
        this.blip(880, 0.07, 0.005, "sine", 0.15);
        break;
      case "wrong":
        this.blip(196, 0.06, 0.005, "triangle", 0.2);
        break;
      case "tick": {
        // Reactions arrive in bursts: one soft tick per burst.
        const now = performance.now();
        if (now - this.lastTick < 400) return;
        this.lastTick = now;
        this.blip(1200, 0.025, 0.002, "sine", 0.05);
        break;
      }
    }
  }
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
  if (r === "gallery") return null;
  return "campus";
}

export function installSound() {
  const unlock = () => sound.unlock();
  window.addEventListener("pointerdown", unlock, { once: false, passive: true });
  window.addEventListener("keydown", unlock, { passive: true });
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
