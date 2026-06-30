// Local semantic similarity using sentence embeddings (all-MiniLM-L6-v2).
// Runs fully in-process via @xenova/transformers — no API key, no network at call time
// after the first model download. Lazy-loaded so it never slows server startup, and
// degrades gracefully (returns null) if the optional dependency or model is unavailable.

let extractorPromise: Promise<any> | null | undefined;

async function getExtractor(): Promise<any | null> {
  if (extractorPromise === null) return null; // previously failed
  if (extractorPromise) return extractorPromise;
  extractorPromise = (async () => {
    try {
      // @ts-ignore - optional dependency, types not required
      const { pipeline, env } = await import("@xenova/transformers");
      env.allowLocalModels = false;
      return await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    } catch (e) {
      extractorPromise = null;
      return null;
    }
  })();
  return extractorPromise;
}

async function embed(texts: string[]): Promise<number[][] | null> {
  const extractor = await getExtractor();
  if (!extractor) return null;
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  // out.tolist() -> number[][] for a batch
  return out.tolist() as number[][];
}

function cosine(a: number[], b: number[]): number {
  // vectors are already L2-normalised, so dot product == cosine similarity
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export interface Ranked<T> {
  item: T;
  score: number;
}

/**
 * Rank `candidates` by semantic similarity to `seedText`.
 * Returns null if the embedding model is unavailable (caller should fall back
 * to returning candidates in their original catalogue order).
 */
export async function rankBySimilarity<T>(
  seedText: string,
  candidates: T[],
  toText: (c: T) => string,
): Promise<Ranked<T>[] | null> {
  if (candidates.length === 0) return [];
  const vectors = await embed([seedText, ...candidates.map(toText)]);
  if (!vectors) return null;
  const [seedVec, ...candVecs] = vectors;
  return candidates
    .map((item, i) => ({ item, score: cosine(seedVec, candVecs[i]) }))
    .sort((a, b) => b.score - a.score);
}

export { cosine };
