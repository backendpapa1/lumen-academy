import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { closeOcr, ocrImage } from "./ocr.js";

// Runs the real OCR engine (first run fetches the English model into the cache),
// so it's opt-in: LUMEN_OCR_TEST=1 pnpm test.
const run = process.env.LUMEN_OCR_TEST === "1" ? describe : describe.skip;

run("photos of notes (V6-04, VD8)", () => {
  afterAll(() => closeOcr());
  it("reads printed notes from a photo, on this machine", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="260">
      <rect width="100%" height="100%" fill="white"/>
      <text x="30" y="90" font-family="Arial" font-size="44">The Merkle root is in the header.</text>
      <text x="30" y="170" font-family="Arial" font-size="44">Pairs of hashes are hashed again.</text>
    </svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const r = await ocrImage(new Uint8Array(png));
    expect(r.text).toMatch(/Merkle root is in the header/);
    expect(r.confidence).toBeGreaterThan(0.6);
  }, 120_000);
});
