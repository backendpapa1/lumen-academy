import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import sharp from "sharp";
import type { ArtPromptsConfig, PricingConfig } from "@lumen/shared";
import type { DbHandle } from "../db/client.js";
import { newId } from "../db/ids.js";
import { estimateUsd } from "../usage/pricing.js";
import type { ImageGenerator, ImageQuality, ImageSize } from "./images.js";
import { cachedProbe, probeImageModel, saveProbe, type ImageProbe } from "./probe.js";

// Runtime asset pipeline (docs/07 §3): hash → cache → budget → queue →
// generate → sharp → file → row → asset.ready. The same request is never
// billed twice: prompt_hash is unique and a ready row is reused as is.

export type AssetKind = "portrait" | "emblem" | "building_skin" | "background" | "card" | "ui";

export interface AssetSpec {
  kind: AssetKind;
  prompt: string;
  size: ImageSize;
  quality: ImageQuality;
  transparent: boolean;
  /** Longest edge of the stored webp. */
  outPx: number;
  ownerType?: string;
  ownerId?: string;
}

export interface AssetRow {
  id: string;
  kind: AssetKind;
  status: "queued" | "generating" | "ready" | "error";
  filePath: string | null;
  ownerType: string | null;
  ownerId: string | null;
}

export interface AssetServiceDeps {
  handle: DbHandle;
  gen: ImageGenerator;
  art: ArtPromptsConfig;
  pricing: PricingConfig;
  /** Where files go: <dataDir>/generated. */
  dir: string;
  concurrency?: number;
}

type Listener = (asset: AssetRow) => void;

export class AssetService {
  private readonly queue: Array<{ id: string; spec: AssetSpec }> = [];
  private running = 0;
  private readonly listeners = new Set<Listener>();
  private probe: Promise<ImageProbe> | null = null;
  private readonly idle = new Set<() => void>();

  constructor(private readonly deps: AssetServiceDeps) {}

  /** Fires when an asset is ready (or failed: status "error"). */
  onSettled(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  hashOf(spec: AssetSpec): string {
    const params = {
      model: this.deps.gen.model,
      size: spec.size,
      quality: spec.quality,
      transparent: spec.transparent,
      outPx: spec.outPx,
    };
    return createHash("sha256")
      .update(JSON.stringify(params))
      .update("\n")
      .update(spec.prompt)
      .digest("hex");
  }

  /**
   * Returns the asset for this request at once: a ready cached one (no API
   * call), one already in flight, or a newly queued one. Failed ones retry.
   */
  request(spec: AssetSpec): AssetRow {
    const { sqlite } = this.deps.handle;
    const hash = this.hashOf(spec);
    const existing = this.row(
      sqlite.prepare("SELECT id FROM assets WHERE prompt_hash = ?").get(hash) as
        { id: string } | undefined,
    );
    if (existing && existing.status !== "error") return existing;
    const id = existing?.id ?? newId("asset");
    if (existing) sqlite.prepare("UPDATE assets SET status = 'queued' WHERE id = ?").run(id);
    else
      sqlite
        .prepare(
          `INSERT INTO assets (id, kind, owner_type, owner_id, prompt, prompt_hash, model, params_json, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        )
        .run(
          id,
          spec.kind,
          spec.ownerType ?? null,
          spec.ownerId ?? null,
          spec.prompt,
          hash,
          this.deps.gen.model,
          JSON.stringify({
            size: spec.size,
            quality: spec.quality,
            transparent: spec.transparent,
            outPx: spec.outPx,
          }),
          new Date().toISOString(),
        );
    this.queue.push({ id, spec });
    this.pump();
    return this.get(id)!;
  }

  get(id: string): AssetRow | null {
    return this.row({ id });
  }

  /** Resolves when nothing is queued or generating (tests, CLI). */
  drain(): Promise<void> {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise((r) => this.idle.add(r));
  }

  // --- internals -------------------------------------------------------------

  private row(ref: { id: string } | undefined): AssetRow | null {
    if (!ref) return null;
    const r = this.deps.handle.sqlite
      .prepare(
        "SELECT id, kind, status, file_path AS filePath, owner_type AS ownerType, owner_id AS ownerId FROM assets WHERE id = ?",
      )
      .get(ref.id) as AssetRow | undefined;
    return r ?? null;
  }

  private pump() {
    // Three at a time: a class of 9–15 portraits lands within ~1.5 min, under image rate limits.
    const max = this.deps.concurrency ?? 3;
    while (this.running < max && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      void this.run(job.id, job.spec).finally(() => {
        this.running--;
        this.pump();
        if (!this.running && !this.queue.length) {
          for (const r of this.idle) r();
          this.idle.clear();
        }
      });
    }
  }

  private async transparency(): Promise<ImageProbe> {
    const cached = cachedProbe(this.deps.handle, this.deps.gen.model);
    if (cached) return cached;
    this.probe ??= probeImageModel(this.deps.gen).then((p) => {
      saveProbe(this.deps.handle, p);
      return p;
    });
    return this.probe;
  }

  private async run(id: string, spec: AssetSpec) {
    const { sqlite } = this.deps.handle;
    const set = sqlite.prepare(
      "UPDATE assets SET status = ?, file_path = ?, cost_usd = ? WHERE id = ?",
    );
    set.run("generating", null, null, id);
    try {
      // Without real alpha, ask for chroma green and key it out (docs/07 §3.1).
      const keyed = spec.transparent && !(await this.transparency()).transparent;
      const image = await this.deps.gen.generate({
        prompt: keyed
          ? `${spec.prompt} ${this.deps.art.constraints.transparent_fallback ?? ""}`
          : spec.prompt,
        size: spec.size,
        quality: spec.quality,
        transparent: spec.transparent && !keyed,
        format: "png",
        agent: `image:${spec.kind}`,
      });
      let img = sharp(keyed ? await chromaKey(image.bytes) : image.bytes).resize({
        width: spec.outPx,
        height: spec.outPx,
        fit: "inside",
      });
      if (spec.transparent) img = img.ensureAlpha();
      const webp = await img.webp({ quality: 88, alphaQuality: 90 }).toBuffer();
      const rel = join(spec.kind, `${this.hashOf(spec).slice(0, 24)}.webp`);
      const abs = join(this.deps.dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, webp);
      const cost = estimateUsd(this.deps.pricing, {
        provider: "openai",
        model: image.model,
        images: 1,
        imageQuality: spec.quality,
        at: new Date(),
      });
      set.run("ready", rel, cost, id);
    } catch (err) {
      set.run("error", null, null, id);
      console.warn(`[assets] ${spec.kind} ${id} failed: ${(err as Error).message}`);
    }
    const row = this.get(id)!;
    for (const fn of this.listeners) fn(row);
  }
}

/** Removes near-#00FF00 pixels, feathers the edge and despills green (docs/07 §3.1). */
export async function chromaKey(bytes: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const greenness = g - Math.max(r, b);
    if (greenness > 90) data[i + 3] = 0;
    else if (greenness > 40) {
      data[i + 3] = Math.round(255 * (1 - (greenness - 40) / 50)); // feathered edge
      data[i + 1] = Math.max(r, b); // despill
    } else if (greenness > 0) data[i + 1] = Math.max(r, b);
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}
