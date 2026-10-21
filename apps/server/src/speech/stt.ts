import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { SpeechConfig } from "@lumen/shared";
import { machinePath } from "./paths.js";

// Speech to text (V1-01, VD2): whisper.cpp's whisper-server, started by us on
// first use and bound to 127.0.0.1. It keeps the model loaded; --convert lets
// it take the browser's webm/opus directly (ffmpeg). Audio never leaves the
// machine, and nothing is written to disk by us.

export interface Transcriber {
  status(): "ready" | "starting" | "missing" | "off" | "native";
  /** Why it's missing, in plain words (shown in Settings). */
  readonly problem: string | null;
  transcribe(audio: Buffer, mime: string, prompt: string): Promise<{ text: string; ms: number }>;
  /** V6-01 fallback: a whole talk, with timestamps (start ms per segment). */
  transcribeLong?(
    audio: Buffer,
    filename: string,
    prompt?: string,
  ): Promise<Array<[number, string]>>;
  close(): void;
}

export class WhisperSidecar implements Transcriber {
  private proc: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private up = false;
  readonly problem: string | null;
  private readonly binary: string;
  private readonly model: string;

  constructor(
    private readonly cfg: SpeechConfig["stt"],
    env: Record<string, string | undefined> = process.env,
  ) {
    this.binary = machinePath(cfg.binary, env.LUMEN_WHISPER_BIN);
    this.model = machinePath(cfg.model, env.LUMEN_WHISPER_MODEL);
    this.problem = !existsSync(this.binary)
      ? `whisper-server isn't at ${this.binary} (see v2-dev-plan/gates/V1-spikes.md)`
      : !existsSync(this.model)
        ? `the Whisper model isn't at ${this.model}`
        : null;
  }

  private get url() {
    return `http://127.0.0.1:${this.cfg.port}`;
  }

  status() {
    if (this.problem) return "missing" as const;
    return this.up ? ("ready" as const) : ("starting" as const);
  }

  /** Starts the sidecar (once) and waits until it answers. */
  start(): Promise<void> {
    if (this.problem) return Promise.reject(new Error(this.problem));
    this.ready ??= (async () => {
      const already = await fetch(`${this.url}/`).then(
        () => true,
        () => false,
      );
      if (!already) {
        this.proc = spawn(
          this.binary,
          [
            "-m",
            this.model,
            "--host",
            "127.0.0.1",
            "--port",
            String(this.cfg.port),
            "-t",
            String(this.cfg.threads),
            "-l",
            this.cfg.language,
            "--convert",
          ],
          { stdio: "ignore" },
        );
        this.proc.once("exit", () => {
          this.up = false;
          this.ready = null;
          this.proc = null;
        });
        for (let i = 0; i < 120; i++) {
          const ok = await fetch(`${this.url}/`).then(
            () => true,
            () => false,
          );
          if (ok) break;
          await new Promise((r) => setTimeout(r, 250));
          if (i === 119) throw new Error("whisper-server didn't start");
        }
      }
      this.up = true;
    })();
    return this.ready;
  }

  async transcribe(audio: Buffer, mime: string, prompt: string) {
    await this.start();
    const form = new FormData();
    const ext = mime.includes("wav") ? "wav" : mime.includes("ogg") ? "ogg" : "webm";
    form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `speech.${ext}`);
    form.append("response_format", "json");
    form.append("temperature", "0");
    if (prompt) form.append("prompt", prompt);
    const t = performance.now();
    const res = await fetch(`${this.url}/inference`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    if (!res.ok) throw new Error(`whisper-server: HTTP ${res.status}`);
    const body = (await res.json()) as { text?: string; error?: string };
    if (body.error) throw new Error(`whisper-server: ${body.error}`);
    return { text: cleanTranscript(body.text ?? ""), ms: performance.now() - t };
  }

  /**
   * V6-01: a recorded talk or lecture, transcribed on this machine with segment
   * timestamps, so it becomes a source with "12:40" anchors like YouTube captions.
   */
  async transcribeLong(
    audio: Buffer,
    filename: string,
    prompt = "",
  ): Promise<Array<[number, string]>> {
    await this.start();
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)]), filename);
    form.append("response_format", "verbose_json");
    form.append("temperature", "0");
    // The School's own terms, so "nonce" isn't heard as "non-c" (as in class).
    if (prompt) form.append("prompt", prompt);
    const res = await fetch(`${this.url}/inference`, {
      method: "POST",
      body: form,
      // About real time at worst on a laptop GPU; an hour of audio is the cap.
      signal: AbortSignal.timeout(60 * 60_000),
    });
    if (!res.ok) throw new Error(`whisper-server: HTTP ${res.status}`);
    const body = (await res.json()) as {
      text?: string;
      error?: string;
      segments?: Array<{ start?: number; t0?: number; text?: string }>;
    };
    if (body.error) throw new Error(`whisper-server: ${body.error}`);
    const segs = (body.segments ?? [])
      .map((s): [number, string] => [
        Math.round((s.start ?? (s.t0 ?? 0) / 100) * 1000),
        cleanTranscript(s.text ?? ""),
      ])
      .filter(([, t]) => t);
    return segs.length ? segs : [[0, cleanTranscript(body.text ?? "")]];
  }

  close() {
    this.proc?.kill();
    this.proc = null;
  }
}

/** Whisper marks silence and noise as "[BLANK_AUDIO]", "(music)" and similar; drop those. */
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
