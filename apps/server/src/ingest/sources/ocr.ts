import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Photos of notes (V6-04, VD8): OCR on this machine with tesseract.js. The image
// never leaves the computer; the English model is fetched once into the cache
// (like the voice models). Printed text is solid, handwriting best effort: the
// text always goes back to me to correct before anything is ingested.

const CACHE = join(homedir(), ".cache", "lumen", "tessdata");
let worker: Promise<import("tesseract.js").Worker> | null = null;

async function getWorker() {
  worker ??= (async () => {
    mkdirSync(CACHE, { recursive: true });
    const { createWorker } = await import("tesseract.js");
    return createWorker("eng", 1, { cachePath: CACHE, logger: () => undefined });
  })();
  return worker;
}

export interface OcrResult {
  text: string;
  /** Tesseract's mean confidence, 0..1: low means "check this carefully". */
  confidence: number;
}

export async function ocrImage(bytes: Uint8Array): Promise<OcrResult> {
  const w = await getWorker();
  const { data } = await w.recognize(Buffer.from(bytes));
  return {
    text: data.text
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    confidence: Math.max(0, Math.min(1, (data.confidence ?? 0) / 100)),
  };
}

/** Image types tesseract can read. HEIC needs a conversion first (phones can share as JPEG). */
export const OCR_TYPES = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"]);

export async function closeOcr(): Promise<void> {
  if (worker) await (await worker).terminate();
  worker = null;
}
