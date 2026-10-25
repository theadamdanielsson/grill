/** On-device sentence embeddings via transformers.js — no API key, no note content
 * ever leaves the machine. Used to upgrade the lexical relevance ranking in
 * generate-local.ts's selectRelevantText from exact-substring matching to actual
 * semantic similarity (a section titled "how verbs change form" now matches a concept
 * labeled "verb conjugation" even though they share no words), and for Chat's search
 * by meaning (semantic.ts).
 *
 * Model weights (Xenova/multilingual-e5-small, ~130MB quantized) replace
 * TaylorAI/bge-micro-v2 (~25MB), which is English-only: on Swedish and Italian notes
 * it matched little better than keywords (top-1 3/8 and 2/8 on a small retrieval set,
 * against 8/8 and 6/8 for e5-small, with English unchanged at 5/8). Both callers are
 * desktop-only, so the bigger download never lands on a phone. e5 expects "query: "
 * and "passage: " prefixes, so callers say which side of the comparison a text is on.
 *
 * Weights are fetched from Hugging Face's CDN on first use and cached by the browser
 * afterward, the same one-time-network-then-local pattern ocr.ts's tesseract.js
 * already uses for its own core/language assets.
 *
 * Every failure mode — offline, blocked host, unsupported platform, a transformers.js
 * bug — is caught here and turned into `null`, never a throw: this is an optional
 * quality upgrade, and the lexical ranking it's layered over must keep working exactly
 * as it did before whenever this can't. */
type Embedder = (texts: string[], opts: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }[]>;

const EMBED_MODEL = "Xenova/multilingual-e5-small";
const PREFIX = { query: "query: ", passage: "passage: " };

/** The model embedLocal uses. Stored vectors from another model can't
 * be compared with its vectors, so a saved index keyed to a different id is rebuilt. */
export function localEmbedModel(): string {
	return EMBED_MODEL;
}

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
				return (await pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8" })) as unknown as Embedder;
			} catch (e) {
				console.warn("Grill: local embedding model failed to load, falling back to lexical ranking", e);
				return null;
			}
		})();
	}
	return embedderPromise;
}

/** Embed a batch of texts on-device, or null if the local model isn't available right
 * now (never throws — see the module doc comment). Order matches input order. `kind`
 * is "query" for what is being looked for (a question, a concept label) and "passage"
 * for what is searched (note text). */
export async function embedLocal(texts: string[], kind: "query" | "passage" = "passage"): Promise<number[][] | null> {
	if (!texts.length) return [];
	try {
		const embedder = await loadEmbedder();
		if (!embedder) return null;
		const out = await embedder(texts.map((t) => PREFIX[kind] + t), { pooling: "mean", normalize: true });
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
