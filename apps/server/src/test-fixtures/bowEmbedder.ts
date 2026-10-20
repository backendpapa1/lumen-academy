import { EMBEDDING_DIMS, type Embedder } from "../ingest/embed.js";
import { seedFrom } from "../game/rng.js";

/** Deterministic bag-of-words embedder for offline retrieval tests. */
export class BowEmbedder implements Embedder {
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(EMBEDDING_DIMS);
      for (const w of t.toLowerCase().match(/[a-z]{3,}/g) ?? [])
        v[seedFrom(w) % EMBEDDING_DIMS]! += 1;
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}
