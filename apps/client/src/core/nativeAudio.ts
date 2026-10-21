import { android } from "./android";
import { desktop } from "./desktop";

// Sound in the desktop app goes through the Rust shell, not the page: on some
// Linux systems WebKitGTK's Web Audio plays but sends silence to the speakers,
// and <audio> only plays straight after a click. So the page makes the sound
// (a WAV from the server, or a cue rendered with an OfflineAudioContext, which
// does work there) and the shell plays it (src-tauri/src/audio.rs).
//
// The Android app (ADR-012) has none of this: its WebView is Chromium, where Web
// Audio works, and voices are the phone's own (android.ts).
//
// Channels: "narrator", "voice" (students), "sfx" (cues, mixed so they can
// overlap), "bed" (the pad) and "ambience" (room tone, rain).

export interface PlayOptions {
  /** After what's already playing on this channel, instead of replacing it. */
  queue?: boolean;
  loop?: boolean;
  /** Mixed in, overlapping anything else on the channel (sound cues). */
  mix?: boolean;
  volume?: number;
}

export const nativeAudio = {
  get available(): boolean {
    return desktop.present && !android.present;
  },
  play(channel: string, wav: ArrayBuffer, o: PlayOptions = {}): Promise<void> {
    return desktop
      .invokeBytes("audio_play", new Uint8Array(wav), {
        "x-channel": channel,
        "x-queue": o.queue ? "1" : "0",
        "x-loop": o.loop ? "1" : "0",
        "x-mix": o.mix ? "1" : "0",
        "x-volume": String(o.volume ?? 1),
      })
      .then(() => undefined);
  },
  stop(channel: string): void {
    void desktop.invoke("audio_stop", { channel }).catch(() => undefined);
  },
  volume(channel: string, volume: number): void {
    void desktop.invoke("audio_volume", { channel, volume }).catch(() => undefined);
  },
};

/** A WAV's length, and its loudness every 50 ms (0..1) for the students' mouths. */
export function wavInfo(wav: ArrayBuffer): { duration: number; envelope: number[] } {
  const v = new DataView(wav);
  let fmt = { format: 1, channels: 1, rate: 24000, bits: 16 };
  let data = { at: 44, len: Math.max(0, wav.byteLength - 44) };
  // Walk the RIFF chunks: "fmt " says how to read "data".
  for (let at = 12; at + 8 <= wav.byteLength;) {
    const id = String.fromCharCode(
      v.getUint8(at),
      v.getUint8(at + 1),
      v.getUint8(at + 2),
      v.getUint8(at + 3),
    );
    const size = v.getUint32(at + 4, true);
    if (id === "fmt ")
      fmt = {
        format: v.getUint16(at + 8, true),
        channels: v.getUint16(at + 10, true),
        rate: v.getUint32(at + 12, true),
        bits: v.getUint16(at + 22, true),
      };
    else if (id === "data") {
      data = { at: at + 8, len: Math.min(size, wav.byteLength - at - 8) };
      break;
    }
    at += 8 + size + (size % 2);
  }
  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.len / (bytes * fmt.channels));
  const sample = (i: number) => {
    const at = data.at + i * bytes * fmt.channels;
    return fmt.format === 3 ? v.getFloat32(at, true) : v.getInt16(at, true) / 32768;
  };
  const step = Math.max(1, Math.round(fmt.rate * 0.05));
  const envelope: number[] = [];
  for (let i = 0; i < frames; i += step) {
    let sum = 0;
    const end = Math.min(frames, i + step);
    for (let j = i; j < end; j += 4) sum += sample(j) ** 2;
    envelope.push(Math.min(1, Math.sqrt(sum / Math.max(1, (end - i) / 4)) * 4));
  }
  return { duration: frames / fmt.rate, envelope };
}

/** An AudioBuffer as a 16-bit PCM WAV (what the shell plays). */
export function encodeWav(buf: AudioBuffer): ArrayBuffer {
  const ch = buf.numberOfChannels;
  const n = buf.length;
  const out = new ArrayBuffer(44 + n * ch * 2);
  const v = new DataView(out);
  const w = (at: number, s: string) =>
    [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + n * ch * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, buf.sampleRate, true);
  v.setUint32(28, buf.sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, n * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let at = 44;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, chans[c]![i]!));
      v.setInt16(at, s < 0 ? s * 32768 : s * 32767, true);
      at += 2;
    }
  return out;
}
