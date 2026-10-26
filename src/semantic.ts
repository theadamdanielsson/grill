/**
 * Search by meaning for Chat: each note cut into passages, each passage embedded on
 * this device (embed-local.ts, a small multilingual model), kept in a
 * cache and brought up to date as notes change. A question is embedded the same way and
 * the closest passages are the answer. Nothing leaves the device.
 */
import type { ToolCall, ToolSpec } from "./stream";

export interface Passage {
	heading: string;
	text: string;
}

interface IndexedNote {
	hash: string;
	passages: Array<{ heading: string; snippet: string; vec: string }>;
}

export interface SearchIndex {
	model: string;
	notes: Record<string, IndexedNote>;
}

export interface Hit {
	path: string;
	heading: string;
	snippet: string;
	score: number;
}

const PASSAGE_CHARS = 1200;
const SNIPPET_CHARS = 280;
const BATCH = 16;

/** A note cut where its headings are, and a long section again at its paragraphs. */
export function passages(text: string, most = PASSAGE_CHARS): Passage[] {
	const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
	const out: Passage[] = [];
	let heading = "";
	let buf: string[] = [];
	const flush = (): void => {
		const joined = buf.join("\n").trim();
		buf = [];
		if (!joined) return;
		let part = "";
		for (const para of joined.split(/\n\s*\n/)) {
			if (part && part.length + para.length > most) {
				out.push({ heading, text: part.trim() });
				part = "";
			}
			part += `${para}\n\n`;
			while (part.length > most * 1.5) {
				out.push({ heading, text: part.slice(0, most).trim() });
				part = part.slice(most);
			}
		}
		if (part.trim()) out.push({ heading, text: part.trim() });
	};
	for (const line of body.split(/\r?\n/)) {
		const h = /^#{1,6}\s+(.*)$/.exec(line);
		if (h) {
			flush();
			heading = h[1].trim();
		} else buf.push(line);
	}
	flush();
	return out;
}

function hashText(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
	return `${h.toString(16)}:${text.length}`;
}

/** A vector as base64 of its 32-bit floats: a quarter of the room JSON numbers take. */
export function packVec(v: number[]): string {
	const bytes = new Uint8Array(new Float32Array(v).buffer);
	let s = "";
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	return btoa(s);
}

export function unpackVec(s: string): Float32Array {
	const raw = atob(s);
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return new Float32Array(bytes.buffer);
}

/** Bring the index up to date with these notes: new and changed ones embedded, removed
 * ones dropped. Returns false when the model can't be had; what was done is kept. */
export async function updateIndex(
	index: SearchIndex,
	notes: Array<{ path: string; text: string }>,
	embed: (texts: string[]) => Promise<number[][] | null>,
	onProgress?: (done: number, total: number) => void,
): Promise<boolean> {
	const live = new Set(notes.map((n) => n.path));
	for (const path of Object.keys(index.notes)) if (!live.has(path)) delete index.notes[path];
	const todo = notes.filter((n) => index.notes[n.path]?.hash !== hashText(n.text));
	let done = 0;
	for (const n of todo) {
		const parts = passages(n.text);
		const indexed: IndexedNote = { hash: hashText(n.text), passages: [] };
		for (let i = 0; i < parts.length; i += BATCH) {
			const batch = parts.slice(i, i + BATCH);
			const vecs = await embed(batch.map((p) => (p.heading ? `${p.heading}\n${p.text}` : p.text)));
			if (!vecs) return false;
			batch.forEach((p, j) => indexed.passages.push({ heading: p.heading, snippet: p.text.slice(0, SNIPPET_CHARS), vec: packVec(vecs[j]) }));
			// Let the pane breathe between batches.
			await new Promise((ok) => window.setTimeout(ok, 0));
		}
		index.notes[n.path] = indexed;
		onProgress?.(++done, todo.length);
	}
	return true;
}

/** The passages closest in meaning to a question already embedded, best first, at most
 * a few from any one note. */
export function search(index: SearchIndex, query: number[], k = 8, perNote = 2): Hit[] {
	const hits: Hit[] = [];
	for (const [path, n] of Object.entries(index.notes)) {
		for (const p of n.passages) {
			const v = unpackVec(p.vec);
			let dot = 0;
			for (let i = 0; i < v.length && i < query.length; i++) dot += v[i] * query[i];
			hits.push({ path, heading: p.heading, snippet: p.snippet, score: dot });
		}
	}
	hits.sort((a, b) => b.score - a.score);
	const count = new Map<string, number>();
	const out: Hit[] = [];
	for (const h of hits) {
		const c = count.get(h.path) ?? 0;
		if (c >= perNote) continue;
		count.set(h.path, c + 1);
		out.push(h);
		if (out.length >= k) break;
	}
	return out;
}

export const MEANING_TOOL: ToolSpec = {
	name: "find_by_meaning",
	description:
		"Find the notes and passages most about something by meaning, not exact words: for when the notes may put it differently than the question does. Returns note paths, headings and the start of each passage; read_note gives the whole note.",
	input: {
		type: "object",
		properties: { query: { type: "string", description: "What to find, in a few words or a sentence." } },
		required: ["query"],
		additionalProperties: false,
	},
};

/** The answer to `find_by_meaning`, as the model reads it. */
export function hitsText(hits: Hit[], indexed: number, total: number): string {
	const lines = hits.map((h) => `${h.path}${h.heading ? ` > ${h.heading}` : ""} (${h.score.toFixed(2)})\n${h.snippet.replace(/\s+/g, " ")}`);
	const partial = indexed < total ? `\n\n[Still indexing: ${indexed} of ${total} notes searched so far.]` : "";
	return (lines.length ? lines.join("\n\n") : "Nothing found.") + partial;
}

/** What a call to `find_by_meaning` asked for. */
export const meaningQuery = (call: ToolCall): string => (typeof call.input.query === "string" ? call.input.query.trim() : "");
