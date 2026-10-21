import { mkdirSync } from "node:fs";
import type { SpeechConfig } from "@lumen/shared";
import { machinePath } from "./paths.js";

// Text to speech (V1-04/05, VD1): Kokoro-82M through kokoro-js, in this
// process, on the CPU. Loaded on first use; one line at a time so speech
// never competes with itself for the CPU.

export interface Speaker {
  status(): "ready" | "loading" | "idle" | "missing";
  readonly problem: string | null;
  /** WAV bytes (24 kHz mono). */
  say(text: string, voice: string, speed: number): Promise<{ wav: Buffer; ms: number }>;
}

type Kokoro = {
  generate(text: string, o: { voice: string; speed: number }): Promise<{ toWav(): ArrayBuffer }>;
};

export class KokoroSpeaker implements Speaker {
  private tts: Promise<Kokoro> | null = null;
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  problem: string | null = null;

  constructor(private readonly cfg: SpeechConfig["tts"]) {}

  status() {
    if (this.problem) return "missing" as const;
    return this.loaded ? ("ready" as const) : this.tts ? ("loading" as const) : ("idle" as const);
  }

  load(): Promise<Kokoro> {
    this.tts ??= (async () => {
      const { env } = await import("@huggingface/transformers");
      const dir = machinePath(this.cfg.cacheDir);
      mkdirSync(dir, { recursive: true });
      env.cacheDir = dir;
      const { KokoroTTS } = await import("kokoro-js");
      const tts = (await KokoroTTS.from_pretrained(this.cfg.model, {
        dtype: this.cfg.dtype,
        device: "cpu",
      })) as unknown as Kokoro;
      await tts.generate("Ready.", { voice: this.cfg.voices.female[0]!, speed: 1 }); // warm up
      this.loaded = true;
      return tts;
    })().catch((e: unknown) => {
      this.problem = `Kokoro didn't load: ${(e as Error).message}`;
      this.tts = null;
      throw e;
    });
    return this.tts;
  }

  say(text: string, voice: string, speed: number) {
    const job = this.queue.then(async () => {
      const tts = await this.load();
      const t = performance.now();
      const audio = await tts.generate(text, { voice, speed });
      return { wav: Buffer.from(audio.toWav()), ms: performance.now() - t };
    });
    this.queue = job.catch(() => undefined);
    return job;
  }
}
