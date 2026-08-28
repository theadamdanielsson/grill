/** On-device sentence embeddings via transformers.js — no API key, no note content
 * ever leaves the machine. Used to upgrade the lexical relevance ranking in
 * generate-local.ts's selectRelevantText from exact-substring matching to actual
 * semantic similarity (a section titled "how verbs change form" now matches a concept
 * labeled "verb conjugation" even though they share no words).
 *
 * Model weights (TaylorAI/bge-micro-v2, ~25MB quantized — the same default Obsidian's
 * Smart Connections plugin ships to production, chosen here for the same reason: small
 * enough to fetch once and forget, proven to run inside Obsidian's renderer on both
 * desktop and mobile) are fetched from Hugging Face's CDN on first use and cached by
 * the browser afterward, the same one-time-network-then-local pattern ocr.ts's
 * tesseract.js already uses for its own core/language assets.
 *
 * Every failure mode — offline, blocked host, unsupported platform, a transformers.js
 * bug — is caught here and turned into `null`, never a throw: this is an optional
 * quality upgrade, and the lexical ranking it's layered over must keep working exactly
 * as it did before whenever this can't. */

type Embedder = (texts: string[], opts: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }[]>;

const EMBED_MODEL = "TaylorAI/bge-micro-v2";

let embedderPromise: Promise<Embedder | null> | null = null;

async function loadEmbedder(): Promise<Embedder | null> {
	if (!embedderPromise) {
		embedderPromise = (async () => {
			try {
				const mod: { pipeline: typeof import("@huggingface/transformers").pipeline; env: typeof import("@huggingface/transformers").env } =
					await import("@huggingface/transformers");
				const { pipeline, env } = mod;
				env.allowLocalModels = false;
				if (typeof env.useBrowserCache !== "undefined") env.useBrowserCache = true;
				return (await pipeline("feature-extraction", EMBED_MODEL)) as unknown as Embedder;
			} catch (e) {
				console.warn("Grill: local embedding model failed to load, falling back to lexical ranking", e);
				return null;
			}
		})();
	}
	return embedderPromise;
}

/** Embed a batch of texts on-device, or null if the local model isn't available right
 * now (never throws — see the module doc comment). Order matches input order. */
export async function embedLocal(texts: string[]): Promise<number[][] | null> {
	if (!texts.length) return [];
	try {
		const embedder = await loadEmbedder();
		if (!embedder) return null;
		const out = await embedder(texts, { pooling: "mean", normalize: true });
		return texts.map((_, i) => Array.from(out[i].data));
	} catch (e) {
		console.warn("Grill: local embedding failed, falling back to lexical ranking", e);
		return null;
	}
}

/** Cosine similarity for two vectors already L2-normalized (embedLocal always asks for
 * normalize: true), where it reduces to a plain dot product. */
export function cosineSim(a: number[], b: number[]): number {
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
	return dot;
}
