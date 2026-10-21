import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, runMigrations, type DbHandle } from "../db/client.js";
import type { ImageGenerator, ImageRequest } from "./images.js";
import { cachedProbe, probeImageModel, saveProbe, transparentFraction } from "./probe.js";

let h: DbHandle | undefined;
afterEach(() => h?.close());

/** An icon on a clear canvas, or on solid green when the "model" can't do alpha. */
async function fakeImage(req: ImageRequest, alpha: boolean): Promise<Buffer> {
  const [w, hgt] = req.size.split("x").map(Number) as [number, number];
  const bg =
    alpha && req.transparent ? { r: 0, g: 0, b: 0, alpha: 0 } : { r: 0, g: 255, b: 0, alpha: 1 };
  const dot = await sharp({
    create: { width: 100, height: 100, channels: 4, background: "#5be7ff" },
  })
    .png()
    .toBuffer();
  return sharp({ create: { width: w, height: hgt, channels: 4, background: bg } })
    .composite([{ input: dot, gravity: "center" }])
    .png()
    .toBuffer();
}

const fakeGen = (alpha: boolean): ImageGenerator => ({
  model: "fake-image",
  generate: async (req) => ({
    bytes: await fakeImage(req, alpha),
    model: "fake-image",
    latencyMs: 1,
  }),
});

describe("image probe", () => {
  it("detects real transparency and the sizes that came back", async () => {
    const p = await probeImageModel(fakeGen(true));
    expect(p).toMatchObject({
      model: "fake-image",
      transparent: true,
      sizes: ["1024x1024", "1536x1024"],
    });
    expect(p.alphaFraction).toBeGreaterThan(0.95);
  });

  it("reports no transparency when the background comes back opaque", async () => {
    expect((await probeImageModel(fakeGen(false))).transparent).toBe(false);
  });

  it("caches per model id in settings", async () => {
    h = openDb(":memory:");
    runMigrations(h);
    const p = await probeImageModel(fakeGen(true));
    saveProbe(h, p);
    expect(cachedProbe(h, "fake-image")).toEqual(p);
    expect(cachedProbe(h, "another-model")).toBeNull();
    saveProbe(h, { ...p, transparent: false });
    expect(cachedProbe(h, "fake-image")!.transparent).toBe(false);
  });

  it("measures the clear share of pixels", async () => {
    const half = await sharp({
      create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: await sharp({ create: { width: 10, height: 5, channels: 4, background: "#fff" } })
            .png()
            .toBuffer(),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();
    expect(await transparentFraction(half)).toBeCloseTo(0.5);
  });
});
