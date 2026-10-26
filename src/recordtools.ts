/**
 * Tools that let the model behind Chat read the student's record: what they get wrong,
 * what they know of a topic, how the whole record stands. Read only: testing is
 * Test's job, where answers are graded and scheduled, so Chat never quizzes through
 * these and never writes to the record.
 *
 * The same queries serve every engine. Model engines get them as tools run by the
 * plugin (see vaulttools.ts); Claude Code gets them as an in-process MCP server (see
 * agent.ts). Outside Grill, grill-mcp offers them too, with testing tools besides.
 */
import { conceptLine, confusions, day } from "./brief";
import { matchesTopic, overview, weakSpots, whatTheyKnow, type RecordState } from "./record";
import type { ToolCall, ToolSpec } from "./stream";

/** Studying Chat may offer: a button under its reply starts it in Test. */
export type StudyOffer = { kind: "due" } | { kind: "misses"; notes?: string[] } | { kind: "notes"; notes: string[] };

export interface RecordPort {
	/** The record as the plugin holds it now. */
	state(): Promise<RecordState>;
	/** Puts a button for this under the reply, or says why it can't. */
	offer?(o: StudyOffer): string;
}

const topic = { type: "string", description: "A topic, note name or concept, matched on note names and concept labels." };
const limit = { type: "integer", minimum: 1, maximum: 50 };

/** The record's tools by what they do. Reading changes nothing. Testing records answers:
 * grill-mcp offers it, and Grill keeps it out of its own Chat, where Test does that. */
export const RECORD_TOOL_NAMES = {
	readOnly: ["grill_overview", "grill_weak_spots", "grill_what_they_know"],
	testing: ["grill_questions", "grill_record_answer"],
} as const;

/** A call to a read-only record tool, named in a title or in the code that made it. */
export const RECORD_TOOL_RE = new RegExp(`grill_(${RECORD_TOOL_NAMES.readOnly.map((n) => n.replace(/^grill_/, "")).join("|")})`);

export const RECORD_TOOLS: ToolSpec[] = [
	{
		name: "grill_overview",
		description: "How the student's record stands: concepts tested, known and still being learned, what is due now or fading this week, the weakest notes, and the misconceptions they keep showing.",
		input: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "grill_weak_spots",
		description: "Concepts the student got wrong or only partly right last time, keeps missing, or is likely to have forgotten, weakest first, with their misconceptions. Optionally for one topic.",
		input: { type: "object", properties: { topic, limit }, additionalProperties: false },
	},
	{
		name: "grill_what_they_know",
		description: "Everything the record holds on a topic: each concept's status, chance of recall today, past answers and due date, and related misconceptions. Use it before explaining, to pitch the explanation at their level.",
		input: { type: "object", properties: { topic: { ...topic, minLength: 1 }, limit }, required: ["topic"], additionalProperties: false },
	},
	{
		name: "grill_offer_study",
		description:
			"Put a button under your reply that starts studying in Grill's Test: \"due\" for the reviews due now, \"misses\" to retry what they got wrong (optionally only on some notes), \"notes\" for a test on the notes named. Call it once for each thing you recommend.",
		input: {
			type: "object",
			properties: {
				kind: { type: "string", enum: ["due", "misses", "notes"] },
				notes: { type: "array", items: { type: "string" }, description: "Note names, as the record gives them." },
			},
			required: ["kind"],
			additionalProperties: false,
		},
	},
];

/** Said to the model with the tools. */
export const RECORD_RULES =
	"Grill keeps a record of what the student knows, per concept. A digest of it is already in what you were given: answer from that when it is enough. " +
	"Read more of it with grill_weak_spots, grill_what_they_know and grill_overview when the question needs what the digest leaves out, rather than from Grill's files, which only Grill reads correctly. " +
	"A status of learning means tested but not yet proven twice, not wrong: what they got wrong is what lastAnswer and the weak spots say. " +
	"Don't quiz the student in the chat, and don't offer to: testing is Grill's Test, where answers are graded and scheduled. " +
	"When you recommend studying something (the reviews due, a retry of what they missed, a test on particular notes), call grill_offer_study for it, and a button that starts it appears under your reply. Say what you recommend and why; don't describe the buttons or tell them where to click.";

export const isRecordTool = (name: string): boolean => RECORD_TOOLS.some((t) => t.name === name);

/** zod, passed in so it loads only where a tool is offered over MCP; only its types are
 * imported here. */
type Zod = typeof import("zod").z;
type ZodField = import("zod").ZodType;
type Prop = { type?: string; description?: string; enum?: [string, ...string[]]; minLength?: number; minimum?: number; maximum?: number; items?: Prop };

/** A tool's input as a zod shape, built from its JSON Schema above, for MCP servers that
 * take zod. Covers the schema features these tools use. */
export function zodShape(z: Zod, spec: ToolSpec): Record<string, ZodField> {
	const field = (p: Prop): ZodField => {
		let s: ZodField = p.enum
			? z.enum(p.enum)
			: p.type === "integer"
				? z.number().int().min(p.minimum ?? -Infinity).max(p.maximum ?? Infinity)
				: p.type === "array"
					? z.array(field(p.items ?? {}))
					: p.minLength
						? z.string().min(p.minLength)
						: z.string();
		if (p.description) s = s.describe(p.description);
		return s;
	};
	const props = (spec.input.properties ?? {}) as Record<string, Prop>;
	const required = new Set((spec.input.required ?? []) as string[]);
	return Object.fromEntries(Object.entries(props).map(([k, p]) => [k, required.has(k) ? field(p) : field(p).optional()]));
}

export const recordTool = (name: string): ToolSpec => {
	const t = RECORD_TOOLS.find((x) => x.name === name);
	if (!t) throw new Error(`No record tool ${name}`);
	return t;
};

/** The line shown above the reply for a call. */
export function recordToolLine(name: string, input: Record<string, unknown>): string {
	const t = typeof input.topic === "string" && input.topic.trim() ? ` on ${input.topic.trim().slice(0, 50)}` : "";
	if (name === "grill_weak_spots") return `Read your weak spots${t}`;
	if (name === "grill_what_they_know") return `Read what you know${t}`;
	if (name === "grill_offer_study") return "Offered something to study";
	return "Read your record";
}

export async function runRecordQuery(port: RecordPort | undefined, name: string, input: Record<string, unknown>): Promise<{ content: string; failed?: boolean }> {
	if (!port) return { content: "The record can't be reached from here.", failed: true };
	if (name === "grill_offer_study") {
		if (!port.offer) return { content: "Buttons can't be shown here.", failed: true };
		const kind = input.kind;
		const notes = Array.isArray(input.notes) ? input.notes.filter((n): n is string => typeof n === "string" && !!n.trim()).slice(0, 20) : [];
		if (kind === "due") return { content: port.offer({ kind: "due" }) };
		if (kind === "misses") return { content: port.offer({ kind: "misses", ...(notes.length ? { notes } : {}) }) };
		if (kind === "notes" && notes.length) return { content: port.offer({ kind: "notes", notes }) };
		return { content: 'Give kind "due", "misses", or "notes" with the note names.', failed: true };
	}
	const s = await port.state();
	const t = typeof input.topic === "string" && input.topic.trim() ? input.topic.trim() : undefined;
	const n = typeof input.limit === "number" && input.limit >= 1 ? Math.min(50, Math.floor(input.limit)) : undefined;
	if (!Object.keys(s.concepts).length) return { content: "The record is empty: the student has not been tested in Grill yet." };
	switch (name) {
		case "grill_overview":
			return { content: JSON.stringify(overview(s)) };
		case "grill_weak_spots": {
			const w = weakSpots(s, t, n ?? 15);
			const lines = w.concepts.map((v) => conceptLine(s.concepts[v.id]));
			return { content: [lines.length ? `Weak spots${t ? ` on ${t}` : ""}, weakest first:\n${lines.join("\n")}` : `No weak spots${t ? ` on ${t}` : ""}.`, openConfusions(s, t)].filter(Boolean).join("\n\n") };
		}
		case "grill_what_they_know": {
			if (!t) return { content: "Name a topic.", failed: true };
			const k = whatTheyKnow(s, t, n ?? 25);
			if (!k.concepts.length) return { content: `Nothing in the record matches ${t}.` };
			const notes = k.notes.map((x) => `- ${x.note}: ${x.status}${x.answered ? ` (${x.answered.correct} right, ${x.answered.partial} partly, ${x.answered.incorrect} wrong)` : ""}`);
			return { content: [`Notes:\n${notes.join("\n")}`, `Concepts:\n${k.concepts.map((v) => conceptLine(s.concepts[v.id])).join("\n")}`, openConfusions(s, t)].filter(Boolean).join("\n\n") };
		}
		default:
			return { content: `There is no tool called ${name}.`, failed: true };
	}
}

/** The confusions still showing in answers, optionally on a topic, as lines. */
function openConfusions(s: RecordState, topic: string | undefined): string {
	const open = confusions(s)
		.filter((c) => c.state === "open")
		.filter((c) => !topic || matchesTopic(topic, c.notes, c.label))
		.slice(0, 6);
	if (!open.length) return "";
	return `Confusions still showing in their answers:\n${open.map((c) => `- "${c.label}": named ${c.count} time${c.count === 1 ? "" : "s"}, in ${c.notes.join(", ")}; last ${day(c.lastSeen)}${c.said ? `. Last time wrote: "${c.said}"` : ""}`).join("\n")}`;
}

export const runRecordTool = (port: RecordPort | undefined, call: ToolCall) => runRecordQuery(port, call.name, call.input);
