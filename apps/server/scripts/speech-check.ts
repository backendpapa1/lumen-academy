// pnpm speech:check — V1-11: is voice set up on this machine, and fast enough?
// Kokoro speaks a teaching sentence, whisper.cpp writes it down; prints the
// latencies against the v2 targets (gates/V1-spikes.md). Runs fully local.
import { findConfigDir, loadConfig } from "../src/config/load.js";
import { loadDotEnv } from "../src/config/paths.js";
import { dirname } from "node:path";
import { WhisperSidecar } from "../src/speech/stt.js";
import { KokoroSpeaker } from "../src/speech/tts.js";

loadDotEnv(dirname(findConfigDir()));
const cfg = loadConfig().models.speech;
if (!cfg) {
  console.log("✗ no `speech:` section in config/models.yaml");
  process.exit(1);
}
const line = "The Merkle root lives in the block header, so changing one transaction changes it.";
const rows: Array<[string, string, boolean]> = [];

const tts = new KokoroSpeaker(cfg.tts);
let t = performance.now();
await tts.load();
rows.push(["Kokoro load (first use only)", `${Math.round(performance.now() - t)} ms`, true]);
const first = await tts.say("The Merkle root,", cfg.tts.voices.female[0]!, 1);
rows.push(["Student voice: first clause", `${Math.round(first.ms)} ms`, first.ms <= 600]);
const whole = await tts.say(line, cfg.tts.voices.male[0]!, 1);
rows.push(["Student voice: whole sentence", `${Math.round(whole.ms)} ms`, true]);

const stt = new WhisperSidecar(cfg.stt);
if (stt.problem) {
  rows.push(["Hearing you (whisper.cpp)", stt.problem, false]);
} else {
  t = performance.now();
  await stt.start();
  rows.push(["whisper-server start", `${Math.round(performance.now() - t)} ms`, true]);
  const runs: number[] = [];
  let heard = "";
  for (let i = 0; i < 3; i++) {
    const r = await stt.transcribe(whole.wav, "audio/wav", "Glossary: Merkle root, block header.");
    runs.push(r.ms);
    heard = r.text;
  }
  const p50 = runs.sort((a, b) => a - b)[1]!;
  rows.push(["Hearing you: one sentence (p50 of 3)", `${Math.round(p50)} ms`, p50 <= 1000]);
  const ok = /merk\w* root/i.test(heard) && /header/i.test(heard);
  rows.push(["Heard right", `"${heard}"`, ok]);
  stt.close();
}

const w = Math.max(...rows.map((r) => r[0].length));
for (const [k, v, ok] of rows) console.log(`${ok ? "✓" : "✗"} ${k.padEnd(w)}  ${v}`);
process.exit(rows.every((r) => r[2]) ? 0 : 1);
