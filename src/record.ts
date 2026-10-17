/** The record, read and written from outside Obsidian.
 *
 * Other agents (Claude Code, Codex, Claudian, Copilot) reach the record through the
 * grill-mcp server in `mcp/`, which bundles this file. Nothing here imports
 * `obsidian`: it works on the plain JSON the plugin already keeps in the Grill folder.
 *
 * Reads are queries over concepts.json, mastery.json, misconceptions.json and
 * questions.json. Writes never touch those files while the plugin may be running:
 * an agent's result is one file in `<folder>/Inbox/`, and the plugin folds it in
 * (see `applyResults`) when no session is holding the record in memory. Outside a
 * vault (a code repo's `.grill/` folder) there is no plugin, so the server folds
 * the results itself with the same function.
 */

import { ConceptMap, ConceptMastery, conceptTested, lastAnswerMissed, noteAggregate, recordConceptAnswer } from "./concepts";
import { MisconceptionRegistry, mergeAssignments } from "./debrief";
import { MasteryMap, QDifficulty, Verdict, emptyMastery, isLeech, recordNoteStats, retrievability, statusOf } from "./mastery";
import type { QuestionBank } from "./store";

export const INBOX_DIR = "Inbox";
export const RESULT_VERSION = 1;

/** One answer an agent graded, as written to `<folder>/Inbox/<id>.json`. */
export interface AgentResult {
	v: number;
	id: string;
	/** ISO time the answer was graded. */
	at: string;
	/** Which agent graded it, e.g. "Claude Code". Shown in the session note. */
	via: string;
	/** Groups results into one session note. */
	session: string;
	/** A concept id from the record. Absent when the question was about a note as a whole. */
	conceptId?: string;
	note: string;
	/** For a concept that isn't in the record yet (code repos only). */
	label?: string;
	question: string;
	answer: string;
	verdict: Verdict;
	difficulty?: QDifficulty;
	feedback?: string;
	modelAnswer?: string;
	misconception?: { tag: string; label: string };
}

export interface RecordState {
	concepts: ConceptMap;
	mastery: MasteryMap;
	registry: MisconceptionRegistry;
}

const VERDICTS: ReadonlySet<string> = new Set(["correct", "partial", "incorrect"]);
const DIFFICULTIES: ReadonlySet<string> = new Set(["easy", "medium", "hard"]);

/** A result file's contents, checked; null when it isn't one. */
export function parseResult(raw: unknown): AgentResult | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : "");
	if (r.v !== RESULT_VERSION || !str("id") || !str("note") || !str("question") || !VERDICTS.has(str("verdict"))) return null;
	if (Number.isNaN(new Date(str("at")).getTime())) return null;
	const m = r.misconception as Record<string, unknown> | undefined;
	const tag = m && typeof m.tag === "string" ? toTag(m.tag) : "";
	return {
		v: RESULT_VERSION,
		id: str("id"),
		at: new Date(str("at")).toISOString(),
		via: str("via").slice(0, 60) || "Agent",
		session: str("session") || str("id"),
		...(str("conceptId") ? { conceptId: str("conceptId") } : {}),
		note: str("note"),
		...(str("label") ? { label: str("label").slice(0, 200) } : {}),
		question: str("question").slice(0, 4000),
		answer: str("answer").slice(0, 8000),
		verdict: str("verdict") as Verdict,
		...(DIFFICULTIES.has(str("difficulty")) ? { difficulty: str("difficulty") as QDifficulty } : {}),
		...(str("feedback") ? { feedback: str("feedback").slice(0, 4000) } : {}),
		...(str("modelAnswer") ? { modelAnswer: str("modelAnswer").slice(0, 4000) } : {}),
		...(tag ? { misconception: { tag, label: typeof m?.label === "string" ? m.label.slice(0, 200) : "" } } : {}),
	};
}

/** The snake_case form the registry keys misconceptions by. */
export function toTag(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
}

export function slug(s: string): string {
	return toTag(s).replace(/_/g, "-");
}

/** Folds graded answers into the record, oldest first. `allowNew` lets a result name a
 * concept the record doesn't have yet: right for a code repo, where no plugin extracts
 * concepts, wrong for a vault, where the plugin's extraction owns concept ids and a
 * made-up one would be counted as due but never asked. In a vault such a result still
 * counts for its note and is kept in the session note. */
export function applyResults(
	state: RecordState,
	results: AgentResult[],
	opts: { allowNew: boolean; desiredRetention?: number },
): { applied: AgentResult[]; unknownConcept: AgentResult[] } {
	const applied: AgentResult[] = [];
	const unknownConcept: AgentResult[] = [];
	for (const r of [...results].sort((a, b) => a.at.localeCompare(b.at))) {
		const at = new Date(r.at);
		let cid = r.conceptId && state.concepts[r.conceptId] ? r.conceptId : undefined;
		if (!cid && opts.allowNew) {
			cid = r.conceptId || `${r.note}::agent:${slug(r.label || r.question.slice(0, 60))}`;
			state.concepts[cid] ??= newConcept(r.note, r.label || r.question.slice(0, 80));
		}
		if (cid) recordConceptAnswer(state.concepts, cid, r.verdict, r.difficulty ?? "medium", at, opts.desiredRetention);
		else if (r.conceptId) unknownConcept.push(r);
		state.mastery[r.note] ??= emptyMastery();
		recordNoteStats(state.mastery, r.note, r.verdict, r.misconception?.tag);
		if (r.misconception) {
			mergeAssignments(
				state.registry,
				[{ rawTag: r.misconception.tag, canonTag: r.misconception.tag, canonLabel: r.misconception.label, note: r.note }],
				at,
			);
		}
		refreshNote(state, r.note);
		applied.push(r);
	}
	return { applied, unknownConcept };
}

function newConcept(note: string, label: string): ConceptMastery {
	return {
		note,
		label,
		kind: "note",
		sourceHash: null,
		correct: 0,
		partial: 0,
		incorrect: 0,
		streak: 0,
		stability: null,
		difficulty: null,
		lastSeen: null,
		dueAt: null,
	};
}

/** The note-level status and due date, worked out again from its live concepts, as
 * the plugin does after every answer (see recomputeAggregate in view.ts). */
function refreshNote(state: RecordState, note: string): void {
	const m = state.mastery[note];
	if (!m) return;
	const ids = Object.entries(state.concepts)
		.filter(([, c]) => c.note === note && live(c))
		.map(([id]) => id);
	const agg = noteAggregate(ids, state.concepts);
	m.aggStatus = agg.aggStatus;
	m.dueAt = agg.dueAt;
}

/** False for a concept its note no longer has: reconcileConcepts parks its due date
 * in `orphanedDueAt` and clears `dueAt`. */
function live(c: ConceptMastery): boolean {
	return c.dueAt !== null || !c.orphanedDueAt;
}

// ---------------------------------------------------------------- reads

export interface ConceptView {
	id: string;
	note: string;
	label: string;
	status: "untested" | "struggling" | "known";
	/** Chance of recalling it now, 0-100; null if never tested. */
	recallNow: number | null;
	answered: { correct: number; partial: number; incorrect: number };
	lastSeen: string | null;
	dueAt: string | null;
	lastAnswerMissed: boolean;
	leech: boolean;
}

export function recallNow(c: ConceptMastery, now = new Date()): number | null {
	if (!conceptTested(c) || !c.stability || !c.lastSeen) return null;
	const days = (now.getTime() - new Date(c.lastSeen).getTime()) / 86400_000;
	return Math.round(retrievability(c.stability, days) * 100);
}

export function viewConcept(id: string, c: ConceptMastery, now = new Date()): ConceptView {
	return {
		id,
		note: c.note,
		label: c.label,
		status: statusOf(c),
		recallNow: recallNow(c, now),
		answered: { correct: c.correct, partial: c.partial, incorrect: c.incorrect },
		lastSeen: c.lastSeen,
		dueAt: c.dueAt,
		lastAnswerMissed: lastAnswerMissed(c),
		leech: isLeech(c),
	};
}

/** Words of a query, lower-cased, without the short ones. */
function words(s: string): string[] {
	return s
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((w) => w.length > 2);
}

/** How well a concept matches a topic: 0 for no match. The note name counts more
 * than the concept's label. Plain word overlap, no model. */
export function topicScore(topic: string, c: { note: string; label: string }): number {
	const q = words(topic);
	if (!q.length) return 1;
	const noteW = new Set(words(c.note));
	const labelW = new Set(words(c.label));
	const whole = topic.trim().toLowerCase();
	let s = 0;
	if (whole && c.note.toLowerCase() === whole) s += 10;
	for (const w of q) {
		if (noteW.has(w)) s += 3;
		else if (labelW.has(w)) s += 2;
		else if ([...noteW, ...labelW].some((x) => x.startsWith(w) || w.startsWith(x))) s += 1;
	}
	return s;
}

function matching(state: RecordState, topic: string | undefined): Array<[string, ConceptMastery, number]> {
	return Object.entries(state.concepts)
		.filter(([, c]) => live(c))
		.map(([id, c]) => [id, c, topic ? topicScore(topic, c) : 1] as [string, ConceptMastery, number])
		.filter(([, , s]) => s > 0);
}

export interface Overview {
	notes: number;
	concepts: { total: number; tested: number; known: number; struggling: number };
	dueNow: number;
	fadingThisWeek: number;
	lastStudied: string | null;
	activeMisconceptions: Array<{ tag: string; label: string; notes: string[]; count: number }>;
	weakestNotes: Array<{ note: string; struggling: number; missedLast: number }>;
}

export function overview(state: RecordState, now = new Date()): Overview {
	const all = Object.values(state.concepts).filter(live);
	const tested = all.filter(conceptTested);
	const week = now.getTime() + 7 * 86400_000;
	const byNote = new Map<string, { struggling: number; missedLast: number }>();
	for (const c of tested) {
		const e = byNote.get(c.note) ?? { struggling: 0, missedLast: 0 };
		if (statusOf(c) === "struggling") e.struggling++;
		if (lastAnswerMissed(c)) e.missedLast++;
		byNote.set(c.note, e);
	}
	return {
		notes: new Set(all.map((c) => c.note)).size,
		concepts: {
			total: all.length,
			tested: tested.length,
			known: tested.filter((c) => statusOf(c) === "known").length,
			struggling: tested.filter((c) => statusOf(c) === "struggling").length,
		},
		dueNow: tested.filter((c) => c.dueAt && new Date(c.dueAt) <= now).length,
		fadingThisWeek: tested.filter((c) => c.dueAt && new Date(c.dueAt) > now && new Date(c.dueAt).getTime() <= week).length,
		lastStudied: tested.map((c) => c.lastSeen ?? "").sort().pop() || null,
		activeMisconceptions: activeMisconceptions(state, undefined, 8),
		weakestNotes: [...byNote.entries()]
			.map(([note, e]) => ({ note, ...e }))
			.filter((e) => e.struggling + e.missedLast > 0)
			.sort((a, b) => b.struggling + b.missedLast - (a.struggling + a.missedLast))
			.slice(0, 8),
	};
}

export function activeMisconceptions(state: RecordState, topic: string | undefined, limit: number) {
	return Object.values(state.registry)
		.filter((m) => m.status === "active")
		.filter((m) => !topic || m.notes.some((n) => topicScore(topic, { note: n, label: m.label }) > 0) || topicScore(topic, { note: "", label: m.label }) > 0)
		.sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen))
		.slice(0, limit)
		.map((m) => ({ tag: m.tag, label: m.label, notes: m.notes, count: m.count }));
}

/** How weak a tested concept is right now: a missed last answer first, then struggling,
 * then whatever is least likely to be recalled. */
function weakness(c: ConceptMastery, now: Date): number {
	const r = recallNow(c, now) ?? 100;
	return (lastAnswerMissed(c) ? 200 : 0) + (statusOf(c) === "struggling" ? 100 : 0) + (isLeech(c) ? 50 : 0) + (100 - r);
}

/** Below this chance of recall today, a concept counts as a weak spot even when nothing
 * else marks it. */
const WEAK_RECALL = 70;

function isWeak(c: ConceptMastery, now: Date): boolean {
	const r = recallNow(c, now);
	return lastAnswerMissed(c) || statusOf(c) === "struggling" || isLeech(c) || (r !== null && r < WEAK_RECALL);
}

export function weakSpots(state: RecordState, topic: string | undefined, limit: number, now = new Date()) {
	const ranked = matching(state, topic)
		.filter(([, c]) => conceptTested(c) && isWeak(c, now))
		.sort((a, b) => weakness(b[1], now) - weakness(a[1], now) || b[2] - a[2])
		.slice(0, limit)
		.map(([id, c]) => viewConcept(id, c, now));
	return { concepts: ranked, misconceptions: activeMisconceptions(state, topic, 6) };
}

export function whatTheyKnow(state: RecordState, topic: string, limit: number, now = new Date()) {
	const found = matching(state, topic)
		.sort((a, b) => b[2] - a[2] || Number(conceptTested(b[1])) - Number(conceptTested(a[1])))
		.slice(0, limit);
	const notes = [...new Set(found.map(([, c]) => c.note))];
	return {
		concepts: found.map(([id, c]) => viewConcept(id, c, now)),
		notes: notes.map((n) => {
			const m = state.mastery[n];
			return { note: n, status: m ? statusOf(m) : "untested", answered: m ? { correct: m.correct, partial: m.partial, incorrect: m.incorrect } : null };
		}),
		misconceptions: activeMisconceptions(state, topic, 6),
	};
}

export interface StoredQuestion {
	conceptId: string;
	note: string;
	question: string;
	difficulty: QDifficulty;
	modelAnswer: string;
	acceptableAnswers: string[];
	commonErrors: Array<{ pattern: string; misconception: string }>;
}

/** Questions Grill already wrote, for the concepts most worth asking now: due or weak
 * first. Rejected ones are left out. */
export function questionsToAsk(state: RecordState, bank: QuestionBank, topic: string | undefined, limit: number, now = new Date()): StoredQuestion[] {
	const ranked = matching(state, topic)
		.map(([id, c, s]) => {
			const due = !!c.dueAt && new Date(c.dueAt) <= now;
			const w = conceptTested(c) ? weakness(c, now) + (due ? 150 : 0) : 60;
			return { id, c, s, w };
		})
		.sort((a, b) => b.s - a.s || b.w - a.w);
	const out: StoredQuestion[] = [];
	for (const { id, c } of ranked) {
		const q = (bank[id] ?? []).find((x) => !x.rejected && x.question);
		if (!q) continue;
		out.push({
			conceptId: id,
			note: c.note,
			question: q.question,
			difficulty: q.difficulty ?? "medium",
			modelAnswer: q.modelAnswer ?? "",
			acceptableAnswers: q.acceptableAnswers ?? [],
			commonErrors: q.commonErrors ?? [],
		});
		if (out.length >= limit) break;
	}
	return out;
}

/** Puts back note-level counts that were lost. Until 8.0, drawing the map before the
 * record had loaded saved every note with its counts at zero (see renderMap in
 * view.ts). Each concept kept its own history, so a note whose counts fall short of
 * its concepts' takes theirs, and a misconception seen on that note alone is given
 * back its count. Returns how many notes were changed. */
export function restoreNoteCounts(state: RecordState): number {
	const sums = new Map<string, { correct: number; partial: number; incorrect: number }>();
	for (const c of Object.values(state.concepts)) {
		const t = sums.get(c.note) ?? { correct: 0, partial: 0, incorrect: 0 };
		t.correct += c.correct;
		t.partial += c.partial;
		t.incorrect += c.incorrect;
		sums.set(c.note, t);
	}
	let changed = 0;
	for (const [note, t] of sums) {
		const m = state.mastery[note];
		if (!m || t.correct + t.partial + t.incorrect <= m.correct + m.partial + m.incorrect) continue;
		m.correct = Math.max(m.correct, t.correct);
		m.partial = Math.max(m.partial, t.partial);
		m.incorrect = Math.max(m.incorrect, t.incorrect);
		for (const r of Object.values(state.registry)) {
			if (r.notes.length === 1 && r.notes[0] === note && !m.misconceptions[r.tag]) m.misconceptions[r.tag] = r.count;
		}
		changed++;
	}
	return changed;
}
