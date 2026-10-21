import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import { openDb, runMigrations, type DbHandle } from "../db/client.js";
import type { ImageGenerator, ImageRequest } from "./images.js";
import { saveProbe } from "./probe.js";
import { portraitPrompt } from "./prompts.js";
import { AssetService, chromaKey, type AssetSpec } from "./service.js";

const cfg = loadConfig({ env: {} });
let h: DbHandle | undefined;
afterEach(() => h?.close());

function fakeGen(opts: { alpha?: boolean; fail?: boolean } = {}) {
  const calls: ImageRequest[] = [];
  const gen: ImageGenerator = {
    model: "fake-image",
    async generate(req) {
      calls.push(req);
      if (opts.fail) throw new Error("boom");
      const bg = req.transparent
        ? { r: 0, g: 0, b: 0, alpha: 0 }
        : { r: 0, g: 255, b: 0, alpha: 1 };
      const dot = await sharp({
        create: { width: 300, height: 300, channels: 4, background: "#5be7ff" },
      })
        .png()
        .toBuffer();
      const bytes = await sharp({
        create: { width: 1024, height: 1024, channels: 4, background: bg },
      })
        .composite([{ input: dot, gravity: "center" }])
        .png()
        .toBuffer();
      return { bytes, model: "fake-image", latencyMs: 1 };
    },
  };
  return { gen, calls };
}

function service(gen: ImageGenerator, transparent = true) {
  h = openDb(":memory:");
  runMigrations(h);
  saveProbe(h, { model: "fake-image", transparent, alphaFraction: 0.9, sizes: [], at: "" });
  const dir = mkdtempSync(join(tmpdir(), "lumen-assets-"));
  return {
    svc: new AssetService({ handle: h, gen, art: cfg.artPrompts, pricing: cfg.pricing, dir }),
    dir,
  };
}

const spec: AssetSpec = {
  kind: "portrait",
  prompt: "a cadet",
  size: "1024x1024",
  quality: "medium",
  transparent: true,
  outPx: 512,
  ownerType: "cadet",
  ownerId: "cdt_1",
};

describe("AssetService", () => {
  it("generates once, writes a 512px webp with alpha, and never bills the same request twice", async () => {
    const { gen, calls } = fakeGen();
    const { svc, dir } = service(gen);
    const ready: string[] = [];
    svc.onSettled((a) => ready.push(`${a.id}:${a.status}`));
    const first = svc.request(spec);
    expect(["queued", "generating"]).toContain(first.status);
    const again = svc.request(spec); // in flight: same row, no new call
    expect(again.id).toBe(first.id);
    await svc.drain();
    const row = svc.get(first.id)!;
    expect(row.status).toBe("ready");
    expect(ready).toEqual([`${first.id}:ready`]);
    const meta = await sharp(readFileSync(join(dir, row.filePath!))).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 512, height: 512, hasAlpha: true });

    expect(svc.request(spec).status).toBe("ready"); // cache hit
    await svc.drain();
    expect(calls).toHaveLength(1);
    // The fake model isn't in pricing.yaml, so its cost is unknown (null), not 0.
    expect(h!.sqlite.prepare("SELECT cost_usd FROM assets WHERE id = ?").get(first.id)).toEqual({
      cost_usd: null,
    });
  });

  it("a different prompt or quality is a different asset", async () => {
    const { gen, calls } = fakeGen();
    const { svc } = service(gen);
    const a = svc.request(spec);
    const b = svc.request({ ...spec, prompt: "another cadet" });
    const c = svc.request({ ...spec, quality: "low" });
    await svc.drain();
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it("falls back to chroma green + keying when the model can't do transparency", async () => {
    const { gen, calls } = fakeGen();
    const { svc, dir } = service(gen, false);
    const a = svc.request(spec);
    await svc.drain();
    expect(calls[0]!.transparent).toBe(false);
    expect(calls[0]!.prompt).toContain("#00FF00");
    const { data, info } = await sharp(readFileSync(join(dir, svc.get(a.id)!.filePath!)))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0); // corner keyed out
    const mid = ((info.height / 2) * info.width + info.width / 2) * 4;
    expect(data[mid + 3]).toBe(255); // subject kept
  });

  it("marks failures and retries them on the next request", async () => {
    const failing = fakeGen({ fail: true });
    const { svc } = service(failing.gen);
    const a = svc.request(spec);
    await svc.drain();
    expect(svc.get(a.id)!.status).toBe("error");
    expect(["queued", "generating"]).toContain(svc.request(spec).status);
    await svc.drain();
    expect(failing.calls).toHaveLength(2);
  });

  it("keys pure green to clear and keeps other colours", async () => {
    const img = await sharp({ create: { width: 2, height: 1, channels: 3, background: "#00ff00" } })
      .composite([
        {
          input: await sharp({
            create: { width: 1, height: 1, channels: 3, background: "#ff3366" },
          })
            .png()
            .toBuffer(),
          left: 1,
          top: 0,
        },
      ])
      .png()
      .toBuffer();
    const { data } = await sharp(await chromaKey(img))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([data[3], data[7]]).toEqual([0, 255]);
  });
});

describe("portraitPrompt", () => {
  it("fills style, subject, archetype visual and constraints from art-prompts.yaml", () => {
    const p = portraitPrompt(cfg.artPrompts, {
      archetype: "skeptic",
      homeworld: "Lagos Orbital",
      appearance: {
        ageRange: "late teens",
        genderPresentation: "feminine",
        heritageHint: "Yoruba",
        hair: "box braids",
      },
    });
    expect(p).toContain("Lagos Orbital");
    expect(p).toContain("Yoruba");
    expect(p).toContain("appraising gaze");
    expect(p).toContain("#FFB547");
    expect(p).toContain("No text.");
    expect(p).not.toMatch(/\{\{|\}\}/);
  });
});
