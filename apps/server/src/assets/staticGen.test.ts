import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import type { ImageGenerator } from "./images.js";
import {
  contactSheet,
  estimate,
  generate,
  ManifestZ,
  plan,
  promptFor,
  type Manifest,
} from "./staticGen.js";

const cfg = loadConfig({ env: {} });
const manifest: Manifest = ManifestZ.parse({
  version: 1,
  defaults: { quality: "medium" },
  assets: [
    {
      id: "badge_a",
      group: "badges",
      style: "emblem",
      size: "1024x1024",
      transparent: true,
      outPx: 128,
      vars: { accent: "#FFB547" },
      prompt: "A lens",
      out: "generated/badges/a.webp",
    },
    {
      id: "nebula_a",
      group: "nebula",
      style: "global",
      size: "1536x1024",
      outPx: 768,
      prompt: "A nebula",
      out: "generated/nebula/a.webp",
    },
  ],
});
const real = ManifestZ.parse(
  JSON.parse(
    readFileSync(new URL("../../../client/src/assets/manifest.json", import.meta.url), "utf8"),
  ),
);

const gen: ImageGenerator = {
  model: "gpt-image-1-mini",
  generate: async (req) => {
    const [w, h] = req.size.split("x").map(Number) as [number, number];
    const bytes = await sharp({
      create: {
        width: w,
        height: h,
        channels: 4,
        background: { r: 30, g: 40, b: 90, alpha: req.transparent ? 0 : 1 },
      },
    })
      .png()
      .toBuffer();
    return { bytes, model: "gpt-image-1-mini", latencyMs: 1 };
  },
};

describe("static asset generation", () => {
  it("the committed manifest is valid and every out path is unique", () => {
    expect(real.assets.length).toBeGreaterThan(20);
    expect(new Set(real.assets.map((a) => a.out)).size).toBe(real.assets.length);
  });

  it("builds prompts from style + subject + constraints", () => {
    const p = promptFor(cfg.artPrompts, manifest.assets[0]!);
    expect(p).toContain("A school badge");
    expect(p).toContain("#FFB547");
    expect(p).toContain("A lens");
    expect(p).toContain("No text.");
  });

  it("plans missing, changed and forced; skips unchanged; filters --only; draft = low", async () => {
    const root = mkdtempSync(join(tmpdir(), "lumen-static-"));
    const all = plan(manifest, cfg.artPrompts, gen.model, root, {});
    expect(all.map((p) => [p.asset.id, p.reason])).toEqual([
      ["badge_a", "missing"],
      ["nebula_a", "missing"],
    ]);
    for (const p of all) await generate(gen, root, p);
    const lock = Object.fromEntries(all.map((p) => [p.asset.id, p.hash]));
    expect(plan(manifest, cfg.artPrompts, gen.model, root, lock)).toEqual([]);
    expect(
      plan(manifest, cfg.artPrompts, gen.model, root, { ...lock, nebula_a: "old" }).map(
        (p) => p.reason,
      ),
    ).toEqual(["changed"]);
    expect(
      plan(manifest, cfg.artPrompts, gen.model, root, lock, { force: true, only: "badges" }).map(
        (p) => p.asset.id,
      ),
    ).toEqual(["badge_a"]);
    expect(
      plan(manifest, cfg.artPrompts, gen.model, root, {}, { quality: "draft", force: true }).every(
        (p) => p.quality === "low",
      ),
    ).toBe(true);

    const badge = await sharp(readFileSync(join(root, "generated/badges/a.webp"))).metadata();
    expect(badge).toMatchObject({ format: "webp", width: 128, height: 128, hasAlpha: true });
    const neb = await sharp(readFileSync(join(root, "generated/nebula/a.webp"))).metadata();
    expect([neb.width, neb.height]).toEqual([768, 512]);
  });

  it("estimates cost from pricing.yaml (landscape ≈ 1.5×)", () => {
    const root = mkdtempSync(join(tmpdir(), "lumen-static-"));
    const todo = plan(manifest, cfg.artPrompts, gen.model, root, {});
    const medium = cfg.pricing.openai.models["gpt-image-1-mini"];
    expect(medium && "perImage" in medium).toBe(true);
    const each = (medium as { perImage: { medium: number } }).perImage.medium;
    expect(estimate(cfg.pricing, gen.model, todo)).toBeCloseTo(each * 2.5);
  });

  it("writes a contact sheet that lists every asset", () => {
    const root = mkdtempSync(join(tmpdir(), "lumen-static-"));
    mkdirSync(join(root, "generated/badges"), { recursive: true });
    writeFileSync(join(root, "generated/badges/a.webp"), "x");
    const html = readFileSync(
      contactSheet(manifest, root, join(root, "generated/sheet.html")),
      "utf8",
    );
    expect(html).toContain('src="badges/a.webp"');
    expect(html).toContain("not generated");
  });
});
