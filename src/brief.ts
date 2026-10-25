/**
 * The learner digest: what Grill knows about the student, as a few hundred tokens of
 * plain lines a model reads at the start of every chat. It is derived by code from the
 * record on every call and is never written by a model, so it can't drift from it.
 *
 * Its shape follows open-source learner models read for it: learning-tutor's learner.md
 * (evidence named, no decimals), tutor-mcp's rule that a misconception is open while it
 * shows in the last few answers on a concept, and Aider's repo map (rank toward what the
 * conversation is about, then fill a budget). Nothing here imports `obsidian`, so
 * grill-mcp can give other agents the same digest.
 */
import { conceptTested, lastAnswerMissed, type ConceptMap, type ConceptMastery } from "./concepts";
import type { PastAnswer } from "./learn";
import { isLeech, statusOf } from "./mastery";
import { isWeak, lastAnswerPartial, live, recallNow, weakness, type RecordState } from "./record";

/** A confusion stays open while it shows in this many of the latest answers on any
 * concept it was named on, and counts as fixed once it doesn't (tutor-mcp uses 3). */
export const CONFUSION_WINDOW = 3;
/** A fixed confusion is mentioned for this long after it was fixed. */
const FIXED_SHOWN_DAYS = 30;
/** About 800 tokens. */
export const BRIEF_CHARS = 3000;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "19 Oct": short, and the same on every machine. */
export function day(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "" : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

const quote = (s: string, most = 160): string => {
	const t = s.replace(/\s+/g, " ").trim();
	return `"${t.length > most ? `${t.slice(0, most - 1).trimEnd()}…` : t}"`;
};

export interface Confusion {
	tag: string;
	label: string;
	notes: string[];
	count: number;
	state: "open" | "fixed" | "dismissed";
	lastSeen: string;
	/** When the answers stopped showing it. */
	fixedAt?: string;
	/** What the student wrote the last time it was named, when that answer was kept. */
	said?: string;
}

/** Each confusion the grader has named, with its state read from the answers rather
 * than from a flag. A confusion named before answers carried their tag keeps the state
 * stored for it. Dismissed stays dismissed: the student said the tag was wrong. */
export function confusions(state: RecordState): Confusion[] {
	const out: Confusion[] = [];
	for (const m of Object.values(state.registry)) {
		const names = new Set([m.tag, ...m.aliases]);
		const base = { tag: m.tag, label: m.label, notes: m.notes, count: m.count, lastSeen: m.lastSeen };
		if (m.status === "dismissed") {
			out.push({ ...base, state: "dismissed" });
			continue;
		}
		let open = false;
		let latest: { t: string; c: ConceptMastery } | null = null;
		let fixedAt: string | undefined;
		for (const c of Object.values(state.concepts)) {
			const log = c.reviewLog ?? [];
			const lastTagged = log.map((e) => !!e.tag && names.has(e.tag)).lastIndexOf(true);
			if (lastTagged < 0) continue;
			const t = log[lastTagged].t;
			if (!latest || t > latest.t) latest = { t, c };
			if (lastTagged >= log.length - CONFUSION_WINDOW) open = true;
			else {
				const after = log.slice(lastTagged + 1).find((e) => e.rating >= 3);
				if (after && (!fixedAt || after.t > fixedAt)) fixedAt = after.t;
			}
		}
		if (!latest) {
			// Named before answers kept their tag: the stored state is all there is.
			out.push({ ...base, state: m.status === "active" ? "open" : "fixed", ...(m.status === "resolved" ? { fixedAt: m.lastSeen } : {}) });
			continue;
		}
		const miss = latest.c.lastMiss;
		// The kept answer is this one only if it was written at the same answer.
		const said = miss && Math.abs(new Date(miss.t).getTime() - new Date(latest.t).getTime()) < 10 * 60_000 ? miss.answer : undefined;
		out.push({ ...base, lastSeen: latest.t > m.lastSeen ? latest.t : m.lastSeen, state: open ? "open" : "fixed", ...(open ? {} : fixedAt ? { fixedAt } : {}), ...(said ? { said } : {}) });
	}
	return out.sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));
}

/** How likely it is to be recalled today, in words: the model is given evidence, not
 * a probability to over-read. */
function recallWords(r: number | null): string {
	if (r === null) return "";
	return r >= 85 ? "recall strong" : r >= 60 ? "recall fading" : "recall weak";
}

/** Record text goes inside a <record> block that the model is told is data. A student's
 * answer or a grader's words that spelled out that tag would end the block early, and
 * what followed would read as instructions, so the tag is taken out of the text. */
export function asRecordData(text: string): string {
	return text.replace(/<\s*\/?\s*record\b[^>]*>/gi, "");
}

/** A concept's label as a reader would say it. Extraction names some concepts after the
 * thing they were found in: a heading quoted from another note ("From: X"), or an
 * embedded picture ("Image: Screenshot ….png"), which says nothing to a model. */
export function spokenLabel(label: string): string {
	if (/^image:/i.test(label.trim())) return "a figure in the note";
	return label.replace(/^from:\s*/i, "").trim() || label;
}

/** One concept as a line of evidence: how the answers went, how the last one went,
 * and what was said when it was missed. */
export function conceptLine(c: ConceptMastery, now = new Date()): string {
	const bits: string[] = [];
	if (conceptTested(c)) {
		bits.push(`${c.correct} right, ${c.partial} partly, ${c.incorrect} wrong`);
		const last = lastAnswerMissed(c) ? "wrong" : lastAnswerPartial(c) ? "partly right" : "right";
		bits.push(`last answer ${last}${c.lastSeen ? ` on ${day(c.lastSeen)}` : ""}`);
		const r = recallWords(recallNow(c, now));
		if (r) bits.push(r);
		if (isLeech(c)) bits.push("keeps slipping");
	} else bits.push("not tested");
	let line = `- ${spokenLabel(c.label)} [${c.note}]: ${bits.join("; ")}`;
	const missedLast = conceptTested(c) && (lastAnswerMissed(c) || lastAnswerPartial(c));
	if (missedLast && c.lastMiss) {
		// "True" or "B" says nothing without what was asked.
		if (c.lastMiss.question && c.lastMiss.answer.length < 30) line += `. Asked: ${quote(c.lastMiss.question, 140)}`;
		line += `. Wrote: ${quote(c.lastMiss.answer)}`;
		if (c.lastMiss.feedback) line += `. Marked down: ${quote(c.lastMiss.feedback)}`;
	}
	return line;
}

/** Where a chat is: the note it is about and the notes near it (its links). A concept
 * there ranks ahead of an equally weak one elsewhere, the way Aider's map ranks code
 * toward the files a chat mentions. */
export interface Focus {
	note: string;
	near: string[];
}

/** A line the student wrote in their own section of Grill's learner note (phase two). */
export interface Conclusion {
	kind: string;
	text: string;
}

export interface BriefInput {
	state: RecordState;
	focus?: Focus;
	conclusions?: Conclusion[];
	/** What the student pasted from another AI tool about themselves. */
	about?: string;
	/** What their past chats with other AI tools show they knew (see importedLines in imported.ts). */
	asked?: string[];
	/** The student's exams still ahead, one line each (see examLines in exams.ts). */
	exams?: string[];
	budget?: number;
	now?: Date;
}

/** The digest. Empty when nothing has been tested and the student wrote nothing. */
export function learnerBrief(i: BriefInput): string {
	const now = i.now ?? new Date();
	const budget = i.budget ?? BRIEF_CHARS;
	const all = Object.entries(i.state.concepts).filter(([, c]) => live(c));
	const tested = all.filter(([, c]) => conceptTested(c));
	const own = (i.conclusions ?? []).filter((c) => c.text.trim());
	const about = (i.about ?? "").trim();
	const asked = i.asked ?? [];
	const exams = i.exams ?? [];
	if (!tested.length && !own.length && !about && !asked.length && !exams.length) return "";

	const sections: Array<{ head: string; lines: string[] }> = [];
	let used = 0;
	const fits = (s: string): boolean => used + s.length + 1 <= budget;
	const add = (sec: { head: string; lines: string[] }, line: string): boolean => {
		const cost = line.length + 1 + (sec.lines.length ? 0 : sec.head.length + 2);
		if (used + cost > budget) return false;
		used += cost;
		sec.lines.push(line);
		return true;
	};
	const section = (head: string) => {
		const s = { head, lines: [] as string[] };
		sections.push(s);
		return s;
	};

	// The student's own word comes first: it is the one part a model may not second-guess.
	if (own.length) {
		const s = section("The student's own conclusions, in their words (weigh these first):");
		for (const c of own) if (!add(s, `- [${c.kind}] ${c.text.trim()}`)) break;
	}

	if (about) {
		const s = section("What the student's other AI tools know about them, as they pasted it:");
		add(s, about.length > 800 ? `${about.slice(0, 800)}…` : about);
	}

	if (tested.length) {
		const notes = new Set(all.map(([, c]) => c.note)).size;
		const known = tested.filter(([, c]) => statusOf(c) === "known").length;
		const week = now.getTime() + 7 * 86400_000;
		const due = tested.filter(([, c]) => c.dueAt && new Date(c.dueAt) <= now).length;
		const soon = tested.filter(([, c]) => c.dueAt && new Date(c.dueAt) > now && new Date(c.dueAt).getTime() <= week).length;
		const last = tested.map(([, c]) => c.lastSeen ?? "").sort().pop();
		const head = `${tested.length} of ${all.length} concepts tested, across ${notes} notes: ${known} known, ${tested.length - known} still being learned. ${due} due now, ${soon} more this week.${last ? ` Last studied ${day(last)}.` : ""}`;
		const s = section(`Grill's record on ${day(now.toISOString())}:`);
		if (fits(head)) add(s, head);
	}

	if (exams.length) {
		const s = section("Exams the student has coming up (Grill schedules those notes to be ready by then):");
		for (const line of exams) if (!add(s, `- ${line}`)) break;
	}

	const cs = confusions(i.state);
	const open = cs.filter((c) => c.state === "open").slice(0, 5);
	if (open.length) {
		const s = section("Confusions the grader named that still show in recent answers:");
		for (const c of open) {
			const where = c.notes.length ? `, in ${c.notes.slice(0, 3).join(", ")}${c.notes.length > 3 ? ` and ${c.notes.length - 3} more` : ""}` : "";
			if (!add(s, `- ${quote(c.label, 120)}: named ${c.count} time${c.count === 1 ? "" : "s"}${where}; last ${day(c.lastSeen)}.${c.said ? ` Last time wrote: ${quote(c.said)}` : ""}`)) break;
		}
	}

	const weight = (note: string): number => (!i.focus ? 1 : note === i.focus.note ? 3 : i.focus.near.includes(note) ? 2 : 1);
	const weak = tested
		.filter(([, c]) => isWeak(c, now))
		.sort((a, b) => weakness(b[1], now) * weight(b[1].note) - weakness(a[1], now) * weight(a[1].note));
	if (weak.length) {
		const s = section(i.focus ? `Weakest concepts, nearest ${i.focus.note} first:` : "Weakest concepts:");
		for (const [, c] of weak.slice(0, 15)) if (!add(s, conceptLine(c, now))) break;
	}

	const recent = now.getTime() - FIXED_SHOWN_DAYS * 86400_000;
	const fixed = cs.filter((c) => c.state === "fixed" && c.fixedAt && new Date(c.fixedAt).getTime() >= recent).slice(0, 3);
	if (fixed.length) {
		const s = section("Confusions fixed lately (answers no longer show them):");
		for (const c of fixed) if (!add(s, `- ${quote(c.label, 120)}: fixed ${day(c.fixedAt!)}.`)) break;
	}

	// Notes whose tested concepts are all known, most first, as one line.
	const byNote = new Map<string, { known: number; all: number }>();
	for (const [, c] of tested) {
		const e = byNote.get(c.note) ?? { known: 0, all: 0 };
		e.all++;
		if (statusOf(c) === "known") e.known++;
		byNote.set(c.note, e);
	}
	const solid = [...byNote.entries()].filter(([, e]) => e.known === e.all).sort((a, b) => b[1].known - a[1].known);
	if (solid.length) {
		const shown = solid.slice(0, 6).map(([n, e]) => `${n} (${e.known})`);
		const s = section("Notes where every tested concept is known:");
		add(s, `- ${shown.join(", ")}${solid.length > 6 ? `, and ${solid.length - 6} more notes` : ""}`);
	}

	if (asked.length) {
		const s = section("What the student knew before Grill, from their past chats with other AI tools (not test results):");
		for (const line of asked) if (!add(s, line)) break;
	}

	return sections
		.filter((s) => s.lines.length)
		.map((s) => `${s.head}\n${s.lines.join("\n")}`)
		.join("\n\n");
}

/** A session note, read back: when it was, and its answers (see parseSessionNote). */
export interface PastSession {
	at: string;
	answers: PastAnswer[];
}

const plain = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Fill in each concept's last miss from the session notes, for answers given before
 * Grill kept them with the concept. An answer is matched to its concept through the
 * question Grill wrote for it, word for word; one that doesn't match is left out.
 * A miss already kept, or one newer, is never replaced. Returns how many were filled. */
export function missesFromSessions(concepts: ConceptMap, bank: Record<string, Array<{ conceptId?: string; question: string }>>, sessions: PastSession[]): number {
	const byQuestion = new Map<string, string>();
	for (const [key, qs] of Object.entries(bank)) for (const q of qs) if (q.question) byQuestion.set(plain(q.question), q.conceptId ?? key);
	let filled = 0;
	for (const s of [...sessions].sort((a, b) => a.at.localeCompare(b.at))) {
		for (const a of s.answers) {
			if ((a.result !== "incorrect" && a.result !== "partial") || !a.answer.trim()) continue;
			const id = byQuestion.get(plain(a.question));
			const c = id ? concepts[id] : undefined;
			if (!c || (c.lastMiss && c.lastMiss.t >= s.at)) continue;
			if (!c.lastMiss) filled++;
			const cut = (x: string) => {
				const t = x.replace(/\s+/g, " ").trim();
				return t.length > 240 ? `${t.slice(0, 239).trimEnd()}…` : t;
			};
			c.lastMiss = { t: s.at, question: cut(a.question), answer: cut(a.answer), ...(a.feedback.trim() ? { feedback: cut(a.feedback) } : {}) };
		}
	}
	return filled;
}
