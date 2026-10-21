import sharp from "sharp";
import type { DbHandle } from "../db/client.js";
import type { ImageGenerator } from "./images.js";

// What the configured image model really supports (docs/07 §3.1), learned with
// two cheap calls and cached in settings so the pipeline picks transparency or
// the chroma-key fallback without asking again.

export interface ImageProbe {
  model: string;
  /** background: "transparent" returned real alpha. */
  transparent: boolean;
  /** Fraction of fully transparent pixels in the transparent test. */
  alphaFraction: number;
  /** Sizes that came back at the requested dimensions. */
  sizes: string[];
  at: string;
}

const KEY = "imageProbe";

export function cachedProbe(handle: DbHandle, model: string): ImageProbe | null {
  const row = handle.sqlite.prepare("SELECT value_json FROM settings WHERE key = ?").get(KEY) as
    { value_json: string } | undefined;
  if (!row) return null;
  const probe = JSON.parse(row.value_json) as ImageProbe;
  return probe.model === model ? probe : null;
}

export function saveProbe(handle: DbHandle, probe: ImageProbe): void {
  handle.sqlite
    .prepare(
      "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
    )
    .run(KEY, JSON.stringify(probe));
}

/** Share of pixels with alpha 0. */
export async function transparentFraction(bytes: Buffer): Promise<number> {
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let clear = 0;
  for (let i = 3; i < data.length; i += info.channels) if (data[i] === 0) clear++;
  return clear / (info.width * info.height);
}

export async function probeImageModel(gen: ImageGenerator): Promise<ImageProbe> {
  const sizes: string[] = [];
  const square = await gen.generate({
    prompt:
      "A single small glowing cyan hexagon icon centered on a fully transparent background. No text.",
    size: "1024x1024",
    quality: "low",
    transparent: true,
    format: "png",
    agent: "image:probe",
  });
  const meta = await sharp(square.bytes).metadata();
  if (meta.width === 1024 && meta.height === 1024) sizes.push("1024x1024");
  const alphaFraction = meta.hasAlpha ? await transparentFraction(square.bytes) : 0;

  const wide = await gen.generate({
    prompt: "Soft deep-navy nebula with faint cyan wisps, minimal. No text.",
    size: "1536x1024",
    quality: "low",
    format: "webp",
    agent: "image:probe",
  });
  const wideMeta = await sharp(wide.bytes).metadata();
  if (wideMeta.width === 1536 && wideMeta.height === 1024) sizes.push("1536x1024");

  return {
    model: gen.model,
    // A real cut-out leaves most of a small icon's canvas clear.
    transparent: alphaFraction > 0.3,
    alphaFraction: Number(alphaFraction.toFixed(3)),
    sizes,
    at: new Date().toISOString(),
  };
}
