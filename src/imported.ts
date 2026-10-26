/**
 * What the student already knew before Grill: their past conversations with other AI
 * tools (Claude Code and Codex on this computer, ChatGPT or Claude from an export file)
 * that are about one of their notes, read once, when they say so, into one line per note
 * for the model: were they quizzed on it and how did it go, where did they start. The
 * conversations themselves are not kept. Never counted as a test.
 */
import { contentTerms, type LearnNote, stripFrontmatter } from "./learn";

export type AskSource = "claude-code" | "codex" | "chatgpt" | "claude";

export interface Turn {
	role: "user" | "ai";
	text: string;
}

export interface Conversation {
	source: AskSource;
	turns: Turn[];
	/** When its first turn was, where the file says. */
	at: string;
}

/** What the past chats show about one note, as the model read them at import. */
export interface PriorKnowledge {
	text: string;
	at: string;
	source: AskSource;
}

export interface ImportedRecord {
	importedAt: string;
	/** How many conversations were read from each source, matched or not. */
	read: Partial<Record<AskSource, number>>;
	prior: Record<string, PriorKnowledge>;
}

export const SOURCE_NAMES: Record<AskSource, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	chatgpt: "ChatGPT",
	claude: "Claude",
};

/** A typed message longer than this is a pasted document or a prompt a program wrote. */
const MAX_ASK = 600;
/** How much of a conversation goes to the model per match, and how many matches a note. */
const EXCERPT_CHARS = 2500;
const AI_TURN_CHARS = 400;
const EXCERPTS_PER_NOTE = 3;

/** Whether a typed message reads as a question about something, not code or a command. */
export function isAsk(text: string): boolean {
	const t = text.trim();
	if (t.length < 8 || t.length > MAX_ASK) return false;
	if (t.startsWith("<") || t.startsWith("/") || t.startsWith("!")) return false;
	// Sent by Grill's own Chat, which already keeps it.
	if (t.startsWith("(Open in the editor now:")) return false;
	if (/```|\b[\w-]+\.(?:ts|js|py|json|tsx|css|html|sh|toml|yml|yaml)\b|[~.]?\/[\w.-]+\/[\w.-]+/.test(t)) return false;
	return contentTerms(t).length >= 2;
}

/** Grill's own messages to an agent open with what it was told about the student. */
function withoutBrief(text: string): string {
	return text.replace(/^<context>[\s\S]*?<\/context>\s*/, "").trim();
}

function blocksText(c: unknown): string {
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c.map((b: { type?: string; text?: string }) => (b?.type === "text" ? (b.text ?? "") : "")).join("\n");
}

/** One Claude Code conversation file (one JSON object a line): what was typed, and the
 * text of the replies. Tool calls and their results are left out. */
export function claudeCodeConversation(jsonl: string): Conversation {
	const turns: Turn[] = [];
	let at = "";
	for (const line of jsonl.split("\n")) {
		if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
		try {
			const d = JSON.parse(line) as { type?: string; isMeta?: boolean; timestamp?: string; message?: { content?: unknown } };
			if (d.isMeta) continue;
			const text = withoutBrief(blocksText(d.message?.content));
			if (!text) continue;
			if (d.type === "user" && !text.startsWith("<")) turns.push({ role: "user", text });
			else if (d.type === "assistant") turns.push({ role: "ai", text });
			else continue;
			at ||= d.timestamp ?? "";
		} catch {
			// A line cut short while it was written: skipped.
		}
	}
	return { source: "claude-code", turns, at };
}

/** One Codex session file: what was typed, and its replies. */
export function codexConversation(jsonl: string): Conversation {
	const turns: Turn[] = [];
	let at = "";
	for (const line of jsonl.split("\n")) {
		if (!line.includes('"user_message"') && !line.includes('"agent_message"')) continue;
		try {
			const d = JSON.parse(line) as { timestamp?: string; payload?: { type?: string; message?: unknown } };
			const m = d.payload?.message;
			if (typeof m !== "string") continue;
			const text = withoutBrief(m);
			if (!text) continue;
			if (d.payload?.type === "user_message") turns.push({ role: "user", text });
			else if (d.payload?.type === "agent_message") turns.push({ role: "ai", text });
			else continue;
			at ||= d.timestamp ?? "";
		} catch {
			// As above.
		}
	}
	return { source: "codex", turns, at };
}

/** The conversations in a ChatGPT or Claude data export (its conversations.json). */
export function exportConversations(json: string): Conversation[] {
	const data = JSON.parse(json) as unknown;
	if (!Array.isArray(data)) throw new Error("This is not a conversations.json from ChatGPT or Claude.");
	const out: Conversation[] = [];
	for (const conv of data as Array<Record<string, unknown>>) {
		// Claude: chat_messages, each with a sender and its text.
		if (Array.isArray(conv.chat_messages)) {
			const msgs = conv.chat_messages as Array<Record<string, unknown>>;
			const turns = msgs.flatMap((m): Turn[] => (typeof m.text === "string" && m.text.trim() ? [{ role: m.sender === "human" ? "user" : "ai", text: m.text.trim() }] : []));
			out.push({ source: "claude", turns, at: typeof msgs[0]?.created_at === "string" ? msgs[0].created_at : "" });
			continue;
		}
		// ChatGPT: a mapping of message nodes, each with its author, time and parts.
		if (conv.mapping && typeof conv.mapping === "object") {
			const msgs = Object.values(conv.mapping as Record<string, { message?: Record<string, unknown> | null }>)
				.map((n) => n?.message)
				.filter((m): m is Record<string, unknown> => !!m)
				.sort((a, b) => (Number(a.create_time) || 0) - (Number(b.create_time) || 0));
			const turns: Turn[] = [];
			let at = "";
			for (const m of msgs) {
				const role = (m.author as { role?: string } | undefined)?.role;
				if (role !== "user" && role !== "assistant") continue;
				const parts = (m.content as { parts?: unknown[] } | undefined)?.parts ?? [];
				const text = parts.filter((p): p is string => typeof p === "string").join("\n").trim();
				if (!text) continue;
				turns.push({ role: role === "user" ? "user" : "ai", text });
				if (!at && typeof m.create_time === "number") at = new Date(m.create_time * 1000).toISOString();
			}
			out.push({ source: "chatgpt", turns, at });
		}
	}
	return out;
}

/** A stretch of a past conversation about one note, ready for the model. */
export interface Excerpt {
	source: AskSource;
	at: string;
	text: string;
}

/** The conversations about each note, cut to the part that matters: from the first
 * message the student typed that names the note (every word of its title; a one-word
 * title must also share another distinctive word with the note), through the replies and
 * what they typed after, which is where a quiz's answers are. Sharing many words with a
 * long note is not enough: on real chats that matched talk about software to course notes. */
export function matchConversations(convs: Conversation[], notes: LearnNote[]): Record<string, Excerpt[]> {
	const bags = notes.map((n) => ({ name: n.name, terms: new Set(contentTerms(stripFrontmatter(n.text))), title: [...new Set(contentTerms(n.name))] }));
	const df = new Map<string, number>();
	for (const b of bags) for (const t of b.terms) df.set(t, (df.get(t) ?? 0) + 1);
	const rare = (t: string): boolean => (df.get(t) ?? 0) > 0 && (df.get(t) ?? 0) <= Math.max(2, notes.length * 0.1);
	const names = (text: string): string | null => {
		const terms = new Set(contentTerms(text));
		let best: { name: string; score: number } | null = null;
		for (const b of bags) {
			if (!b.title.length || !b.title.every((t) => terms.has(t))) continue;
			if (b.title.length === 1 && ![...terms].some((t) => t !== b.title[0] && b.terms.has(t) && rare(t))) continue;
			if (!best || b.title.length > best.score) best = { name: b.name, score: b.title.length };
		}
		return best?.name ?? null;
	};
	const out: Record<string, Excerpt[]> = {};
	for (const conv of convs) {
		const done = new Set<string>();
		conv.turns.forEach((turn, i) => {
			if (turn.role !== "user" || !isAsk(turn.text)) return;
			const note = names(turn.text);
			if (!note || done.has(note)) return;
			done.add(note);
			let text = "";
			for (const t of conv.turns.slice(i)) {
				const said = t.role === "ai" && t.text.length > AI_TURN_CHARS ? `${t.text.slice(0, AI_TURN_CHARS)} [...]` : t.text;
				const line = `${t.role === "user" ? "STUDENT" : "AI"}: ${said}\n`;
				if (text.length + line.length > EXCERPT_CHARS) break;
				text += line;
			}
			(out[note] ??= []).push({ source: conv.source, at: conv.at, text: text.trim() });
		});
	}
	for (const name of Object.keys(out)) out[name] = out[name].sort((a, b) => b.at.localeCompare(a.at)).slice(0, EXCERPTS_PER_NOTE);
	return out;
}

/** Without a model to read them: what can be said from the bare fact of the chats. */
export function plainPrior(excerpts: Excerpt[]): string {
	const first = excerpts[excerpts.length - 1];
	return `Asked ${SOURCE_NAMES[first.source]} about it${excerpts.length > 1 ? ` in ${excerpts.length} conversations` : ""} before using Grill.`;
}

/** Keeps the new lines with what was read before; a note read again gets the new line. */
export function mergeImported(
	before: ImportedRecord | null,
	read: Partial<Record<AskSource, number>>,
	prior: Record<string, PriorKnowledge>,
	now = new Date(),
): ImportedRecord {
	const sum = { ...(before?.read ?? {}) };
	for (const [k, v] of Object.entries(read) as Array<[AskSource, number]>) sum[k] = (sum[k] ?? 0) + v;
	return { importedAt: now.toISOString(), read: sum, prior: { ...(before?.prior ?? {}), ...prior } };
}

/** For the digest: what was known before Grill, the note in focus first. */
export function importedLines(rec: ImportedRecord | null, focus = "", most = 8): string[] {
	if (!rec?.prior) return [];
	const entries = Object.entries(rec.prior).filter(([, p]) => p.text.trim());
	entries.sort((a, b) => (b[0] === focus ? 1 : 0) - (a[0] === focus ? 1 : 0));
	return entries.slice(0, most).map(([name, p]) => `- ${name}: ${p.text.trim()} (${SOURCE_NAMES[p.source]}${p.at ? `, ${p.at.slice(0, 10)}` : ""})`);
}

/** "Deflation Spiral, Real Interest Rate and 3 more notes". */
export function importedNames(names: string[], most = 3): string {
	if (names.length <= most) return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
	return `${names.slice(0, most).join(", ")} and ${names.length - most} more note${names.length - most === 1 ? "" : "s"}`;
}

/** The text of conversations.json inside a ChatGPT or Claude data export, read straight
 * from the zip they send, so nobody has to unzip it first. `inflateRaw` is node's zlib
 * (desktop only). Null when the zip has no conversations.json. */
export function conversationsFromZip(zip: Uint8Array, inflateRaw: (data: Uint8Array) => Uint8Array): string | null {
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	// The end-of-directory record sits in the last 64 KB (its comment can run that long).
	let end = -1;
	for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
		if (view.getUint32(i, true) === 0x06054b50) {
			end = i;
			break;
		}
	}
	if (end < 0) throw new Error("This file is not a zip.");
	const count = view.getUint16(end + 10, true);
	let at = view.getUint32(end + 16, true);
	if (at === 0xffffffff) throw new Error("This export is too large to read zipped. Unzip it and choose conversations.json inside.");
	const names = new TextDecoder();
	for (let n = 0; n < count && view.getUint32(at, true) === 0x02014b50; n++) {
		const method = view.getUint16(at + 10, true);
		const size = view.getUint32(at + 20, true);
		const nameLen = view.getUint16(at + 28, true);
		const extraLen = view.getUint16(at + 30, true);
		const commentLen = view.getUint16(at + 32, true);
		const local = view.getUint32(at + 42, true);
		const name = names.decode(zip.subarray(at + 46, at + 46 + nameLen));
		at += 46 + nameLen + extraLen + commentLen;
		if (name.split("/").pop() !== "conversations.json") continue;
		const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
		const data = zip.subarray(start, start + size);
		if (method === 0) return names.decode(data);
		if (method === 8) return names.decode(inflateRaw(data));
		throw new Error("This zip is packed in a way Grill can't read. Unzip it and choose conversations.json inside.");
	}
	return null;
}
