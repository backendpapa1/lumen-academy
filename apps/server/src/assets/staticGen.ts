import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import type { ArtPromptsConfig, PricingConfig } from "@lumen/shared";
import { estimateUsd } from "../usage/pricing.js";
import type { ImageGenerator, ImageQuality } from "./images.js";
import { fill } from "./prompts.js";

// Build-time art (docs/07 §1.1, §4): apps/client/src/assets/manifest.json →
// committed webp files. A lock file maps id → prompt hash so unchanged assets
// are never regenerated (or billed) unless --force.

const SizeZ = z.enum(["1024x1024", "1536x1024", "1024x1536"]);
const QualityZ = z.enum(["low", "medium", "high"]);

export const StaticAssetZ = z.strictObject({
  id: z.string(),
  group: z.string(),
  style: z.string(),
  /** Prepend style.global (default). Off for space backdrops: it pulls toward interiors. */
  globalStyle: z.boolean().optional(),
  size: SizeZ,
  quality: QualityZ.optional(),
  transparent: z.boolean().optional(),
  outPx: z.number().int().positive(),
  vars: z.record(z.string(), z.string()).optional(),
  prompt: z.string().min(1),
  out: z.string(),
});
export type StaticAsset = z.infer<typeof StaticAssetZ>;

export const ManifestZ = z.strictObject({
  version: z.literal(1),
  defaults: z.strictObject({ quality: QualityZ }),
  assets: z.array(StaticAssetZ),
});
export type Manifest = z.infer<typeof ManifestZ>;

export interface GenOptions {
  only?: string;
  force?: boolean;
  /** "draft" = low quality, for layout work. */
  quality?: "draft";
}

export interface PlannedAsset {
  asset: StaticAsset;
  prompt: string;
  quality: ImageQuality;
  hash: string;
  reason: "missing" | "changed" | "forced";
}

export function promptFor(art: ArtPromptsConfig, a: StaticAsset): string {
  const prefix = a.globalStyle === false ? "" : "{{style.global}} ";
  return fill(
    `${prefix}{{style.${a.style}}} ${a.prompt}. {{constraints.default}}`,
    art,
    a.vars ?? {},
  );
}

export function hashFor(
  model: string,
  a: StaticAsset,
  prompt: string,
  quality: ImageQuality,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        model,
        size: a.size,
        quality,
        transparent: !!a.transparent,
        outPx: a.outPx,
      }),
    )
    .update("\n")
    .update(prompt)
    .digest("hex");
}

/** What needs generating, and why. */
export function plan(
  manifest: Manifest,
  art: ArtPromptsConfig,
  model: string,
  root: string,
  lock: Record<string, string>,
  opts: GenOptions = {},
): PlannedAsset[] {
  const out: PlannedAsset[] = [];
  for (const asset of manifest.assets) {
    if (opts.only && asset.group !== opts.only && asset.id !== opts.only) continue;
    const quality: ImageQuality =
      opts.quality === "draft" ? "low" : (asset.quality ?? manifest.defaults.quality);
    const prompt = promptFor(art, asset);
    const hash = hashFor(model, asset, prompt, quality);
    const exists = existsSync(join(root, asset.out));
    const reason = opts.force
      ? "forced"
      : !exists
        ? "missing"
        : lock[asset.id] !== hash
          ? "changed"
          : null;
    if (reason) out.push({ asset, prompt, quality, hash, reason });
  }
  return out;
}

export function estimate(
  pricing: PricingConfig,
  model: string,
  planned: PlannedAsset[],
): number | null {
  let total = 0;
  for (const p of planned) {
    const usd = estimateUsd(pricing, {
      provider: "openai",
      model,
      images: 1,
      imageQuality: p.quality,
      at: new Date(),
    });
    if (usd == null) return null;
    // Landscape/portrait canvases cost about 1.5× a square one.
    total += usd * (p.asset.size === "1024x1024" ? 1 : 1.5);
  }
  return total;
}

export async function generate(
  gen: ImageGenerator,
  root: string,
  p: PlannedAsset,
): Promise<string> {
  const img = await gen.generate({
    prompt: p.prompt,
    size: p.asset.size,
    quality: p.quality,
    transparent: p.asset.transparent,
    format: "png",
    agent: `image:static:${p.asset.group}`,
  });
  const file = join(root, p.asset.out);
  mkdirSync(dirname(file), { recursive: true });
  let s = sharp(img.bytes).resize({ width: p.asset.outPx, height: p.asset.outPx, fit: "inside" });
  if (p.asset.transparent) s = s.ensureAlpha();
  writeFileSync(file, await s.webp({ quality: 88, alphaQuality: 90 }).toBuffer());
  return file;
}

export const readLock = (path: string): Record<string, string> =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>) : {};

/** A one-page HTML grid of every generated asset, for eyeballing (docs/07 §5). */
export function contactSheet(manifest: Manifest, root: string, sheetPath: string): string {
  const cards = manifest.assets
    .map((a) => {
      const file = join(root, a.out);
      const src = relative(dirname(sheetPath), file);
      const body = existsSync(file)
        ? `<img src="${src}" alt="${a.id}" loading="lazy">`
        : `<div class="missing">not generated</div>`;
      return `<figure class="${a.transparent ? "alpha" : ""}">${body}<figcaption><b>${a.id}</b><span>${a.group} · ${a.size} → ${a.outPx}px</span></figcaption></figure>`;
    })
    .join("\n");
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lumen art contact sheet</title>
<style>
:root{--void:#05070d;--hull:#0b1020;--line:#22304d;--ink:#e6edf7;--dim:#8a96ad}
body{margin:0;padding:24px;background:var(--void);color:var(--ink);font:14px/1.4 Inter,system-ui,sans-serif}
h1{font:600 20px "Space Grotesk",system-ui;margin:0 0 16px}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
figure{margin:0;background:var(--hull);border:1px solid var(--line);border-radius:12px;overflow:hidden}
img,.missing{display:block;width:100%;aspect-ratio:3/2;object-fit:contain}
.alpha img{background:repeating-conic-gradient(#1a2238 0 25%,#121a2c 0 50%) 0 0/16px 16px}
.missing{display:grid;place-items:center;color:var(--dim)}
figcaption{display:flex;flex-direction:column;padding:8px 12px}figcaption span{color:var(--dim);font-size:12px}
</style><h1>Lumen Academy · generated art (${manifest.assets.length})</h1><main>
${cards}
</main></html>`;
  writeFileSync(sheetPath, html);
  return sheetPath;
}
