import { nextChunkEnd } from "@lumen/shared";
import type { Speech } from "./classroom";
import { SERVER_HTTP } from "./net";
import { store } from "./store";

// Voice (V1, VD1–VD4): push-to-talk in, students' voices out, all on this
// machine. Recording → POST /api/speech/transcribe (Whisper with the School's
// glossary). A student's streaming line is cut into chunks (first clause, then
// sentences) and each chunk is spoken by /api/speech/say as soon as it's
// complete, so they start talking in about half a second. The speech bubble
// and the student's mouth follow the audio.

const PREFS_KEY = "lumen.voice";
const FIRST_CHUNK_WORDS = 6;

export interface VoicePrefs {
  /** Students speak their lines. */
  speak: boolean;
  /** Send what I said as soon as I let go (else it waits in the lectern for Enter). */
  autoSend: boolean;
  volume: number;
}

function readPrefs(): VoicePrefs {
  try {
    // Review first by default: on Paul's accent Whisper still slips (gates/V1-spikes.md).
    return {
      speak: true,
      autoSend: false,
      volume: 0.9,
      ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}"),
    };
  } catch {
    return { speak: true, autoSend: false, volume: 0.9 };
  }
}

type Listener = () => void;

/** What the lectern, the bubble and the room need to draw. */
export interface VoiceState {
  /** Server speech engines, from /api/speech/status. */
  stt: "ready" | "starting" | "missing" | "off" | "unknown";
  tts: "ready" | "loading" | "idle" | "missing" | "unknown";
  recording: boolean;
  /** 0..1 microphone level while recording. */
  level: number;
  transcribing: boolean;
  /** The student whose voice is playing, and whether their mouth is open right now. */
  speaking: string | null;
  mouthOpen: boolean;
}

class Voice {
  prefs = readPrefs();
  /** For the P overlay (V1-11): release → transcript, and line start → first audio. */
  readonly metrics: { sttMs: number | null; firstAudioMs: number | null } = {
    sttMs: null,
    firstAudioMs: null,
  };
  private lineStartedAt = 0;
  readonly state: VoiceState = {
    stt: "unknown",
    tts: "unknown",
    recording: false,
    level: 0,
    transcribing: false,
    speaking: null,
    mouthOpen: false,
  };
  private listeners = new Set<Listener>();
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  // Recording
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private micAnalyser: AnalyserNode | null = null;
  private levelRaf = 0;
  // Playback of the current line
  private line: {
    streamId: string;
    cadetId: string;
    spokenTo: number; // characters handed to the voice so far
    revealTo: number; // characters the bubble may show
    queue: Promise<void>;
    endsAt: number; // ctx time when the last scheduled chunk finishes
    sources: AudioBufferSourceNode[];
    aborted: boolean;
    rephrased?: number;
  } | null = null;
  private mouthRaf = 0;

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }

  setPrefs(p: Partial<VoicePrefs>) {
    this.prefs = { ...this.prefs, ...p };
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
    } catch {
      /* per-viewer convenience only */
    }
    if (this.out) this.out.gain.value = this.prefs.volume;
    if (!this.prefs.speak) this.stopSpeaking();
    this.emit();
  }

  /** Asks the server which engines are there (cheap; called when a class opens). */
  async refreshStatus() {
    try {
      const r = (await (await fetch(`${SERVER_HTTP}/api/speech/status`)).json()) as {
        stt: VoiceState["stt"];
        tts: VoiceState["tts"];
      };
      this.state.stt = r.stt;
      this.state.tts = r.tts;
    } catch {
      this.state.stt = "off";
      this.state.tts = "missing";
    }
    this.emit();
  }

  get canListen() {
    return this.state.stt !== "missing" && this.state.stt !== "off";
  }

  private audio(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.out = this.ctx.createGain();
      this.out.gain.value = this.prefs.volume;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.out.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  // --- push-to-talk ----------------------------------------------------------

  async startRecording(): Promise<void> {
    if (this.state.recording || !this.canListen) return;
    this.stopSpeaking(); // talking over a student interrupts them
    try {
      this.stream ??= await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
    } catch {
      throw new Error("The microphone isn't available. Check the browser's permission.");
    }
    const ctx = this.audio();
    const src = ctx.createMediaStreamSource(this.stream);
    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = 256;
    src.connect(this.micAnalyser);
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, { mimeType: "audio/webm;codecs=opus" });
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.start();
    this.state.recording = true;
    const buf = new Uint8Array(this.micAnalyser.fftSize);
    const tick = () => {
      if (!this.micAnalyser) return;
      this.micAnalyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      this.state.level = Math.min(1, peak / 64);
      this.emit();
      this.levelRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  /** Stops recording; resolves with what I said ("" if nothing was heard). */
  async stopRecording(cancel = false): Promise<string> {
    const rec = this.recorder;
    if (!rec || !this.state.recording) return "";
    cancelAnimationFrame(this.levelRaf);
    this.micAnalyser = null;
    this.recorder = null;
    this.state.recording = false;
    this.state.level = 0;
    const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
    rec.stop();
    await stopped;
    if (cancel) return (this.emit(), "");
    this.state.transcribing = true;
    this.emit();
    const sentAt = performance.now();
    try {
      const blob = new Blob(this.chunks, { type: "audio/webm" });
      const form = new FormData();
      form.append("file", blob, "speech.webm");
      const room = store.getState().classroom.classroom?.id;
      const res = await fetch(
        `${SERVER_HTTP}/api/speech/transcribe?fix=0${room ? `&classroomId=${room}` : ""}`,
        { method: "POST", body: form },
      );
      const body = (await res.json()) as { text?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? "I couldn't hear that.");
      this.metrics.sttMs = Math.round(performance.now() - sentAt);
      return body.text ?? "";
    } finally {
      this.state.transcribing = false;
      this.emit();
    }
  }

  /**
   * Fix clear mishearings with the School's terms (a second, short step, so the
   * raw words can show first). Falls back to what was heard.
   */
  async fix(text: string): Promise<string> {
    const room = store.getState().classroom.classroom?.id;
    if (!room || !text) return text;
    this.state.transcribing = true;
    this.emit();
    try {
      const res = await fetch(`${SERVER_HTTP}/api/speech/fix`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ classroomId: room, text }),
      });
      if (!res.ok) return text;
      return ((await res.json()) as { text?: string }).text ?? text;
    } catch {
      return text;
    } finally {
      this.state.transcribing = false;
      this.emit();
    }
  }

  // --- students speaking -----------------------------------------------------

  /** Called as a student's line streams in (and again when it's rephrased). */
  follow(speech: Speech | null) {
    if (!this.prefs.speak || this.state.tts === "missing") return;
    if (!speech) return;
    let line = this.line;
    if (!line || line.streamId !== speech.streamId) {
      this.stopSpeaking();
      this.lineStartedAt = performance.now();
      line = this.line = {
        streamId: speech.streamId,
        cadetId: speech.cadetId,
        spokenTo: 0,
        revealTo: 0,
        queue: Promise.resolve(),
        endsAt: 0,
        sources: [],
        aborted: false,
      };
    }
    // The Leak Guard rewrote a line: say it again, the way a student would.
    if (speech.rephrasedAt && speech.rephrasedAt !== line.rephrased && line.spokenTo > 0) {
      line.rephrased = speech.rephrasedAt;
      this.enqueue(line, "Sorry, let me put that differently.", null);
      this.enqueue(line, speech.text, speech.text.length);
      line.spokenTo = speech.text.length;
      return;
    }
    for (;;) {
      const end = nextChunkEnd(speech.text, line.spokenTo, speech.done, {
        firstChunkWords: FIRST_CHUNK_WORDS,
      });
      if (end === null) break;
      const piece = speech.text.slice(line.spokenTo, end).trim();
      line.spokenTo = end;
      if (piece) this.enqueue(line, piece, end);
    }
  }

  /** Fetches a chunk's audio now (in parallel) and plays it after the previous one. */
  private enqueue(line: NonNullable<Voice["line"]>, text: string, revealTo: number | null) {
    const audio = fetch(`${SERVER_HTTP}/api/speech/say`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Markdown emphasis reads as nothing (or worse, "asterisk"): speak the words only.
      body: JSON.stringify({ cadetId: line.cadetId, text: text.replace(/[*_`#~]+/g, "") }),
    })
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((b) => this.audio().decodeAudioData(b))
      .catch(() => null);
    line.queue = line.queue.then(async () => {
      const buf = await audio;
      if (line.aborted || this.line !== line) return;
      if (!buf) {
        // No voice for this chunk: let the bubble carry on without it.
        if (revealTo !== null) line.revealTo = Math.max(line.revealTo, revealTo);
        return;
      }
      const ctx = this.audio();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.out!);
      const startAt = Math.max(ctx.currentTime + 0.02, line.endsAt);
      src.start(startAt);
      line.endsAt = startAt + buf.duration;
      line.sources.push(src);
      // The bubble reveals this chunk as it's spoken.
      const delay = Math.max(0, (startAt - ctx.currentTime) * 1000);
      setTimeout(() => {
        if (this.line !== line || line.aborted) return;
        if (revealTo !== null) line.revealTo = Math.max(line.revealTo, revealTo);
        if (!this.state.speaking && line.revealTo === revealTo && this.lineStartedAt)
          this.metrics.firstAudioMs = Math.round(performance.now() - this.lineStartedAt);
        this.state.speaking = line.cadetId;
        this.watchMouth(line);
        this.emit();
      }, delay);
      src.onended = () => {
        if (this.line === line && this.audio().currentTime >= line.endsAt - 0.05) {
          this.state.speaking = null;
          this.state.mouthOpen = false;
          cancelAnimationFrame(this.mouthRaf);
          this.emit();
        }
      };
    });
  }

  /** Mouth open/closed from the output level, about 10 times a second. */
  private watchMouth(line: NonNullable<Voice["line"]>) {
    cancelAnimationFrame(this.mouthRaf);
    const buf = new Uint8Array(this.analyser!.fftSize);
    let last = 0;
    const tick = (t: number) => {
      if (this.line !== line || line.aborted || !this.state.speaking) return;
      if (t - last > 95) {
        last = t;
        this.analyser!.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        const open = peak > 10;
        if (open !== this.state.mouthOpen) {
          this.state.mouthOpen = open;
          this.emit();
        }
      }
      this.mouthRaf = requestAnimationFrame(tick);
    };
    this.mouthRaf = requestAnimationFrame(tick);
  }

  /** How much of this line the bubble may show, or null if voice isn't driving it. */
  revealCap(streamId: string): number | null {
    const line = this.line;
    if (!line || line.streamId !== streamId || line.aborted || !this.prefs.speak) return null;
    return line.revealTo;
  }

  /** Still speaking this line (the bubble stays up until the voice is done). */
  isSpeaking(streamId: string): boolean {
    return (
      !!this.line &&
      this.line.streamId === streamId &&
      !this.line.aborted &&
      (this.state.speaking !== null || this.line.spokenTo > this.line.revealTo)
    );
  }

  stopSpeaking() {
    const line = this.line;
    if (line) {
      line.aborted = true;
      for (const s of line.sources) {
        try {
          s.stop();
        } catch {
          /* already ended */
        }
      }
    }
    this.line = null;
    cancelAnimationFrame(this.mouthRaf);
    if (this.state.speaking || this.state.mouthOpen) {
      this.state.speaking = null;
      this.state.mouthOpen = false;
      this.emit();
    }
  }
}

export const voice = new Voice();

// Follow the classroom: speak students' lines, stop when the class ends or I leave.
store.subscribe((s, p) => {
  if (s.route.name !== "classroom") {
    if (p.route.name === "classroom") voice.stopSpeaking();
    return;
  }
  if (s.classroom.speech !== p.classroom.speech) voice.follow(s.classroom.speech);
  if (s.classroom.status === "live" && p.classroom.status !== "live") void voice.refreshStatus();
  if (s.classroom.status === "ended" && p.classroom.status !== "ended") voice.stopSpeaking();
});
