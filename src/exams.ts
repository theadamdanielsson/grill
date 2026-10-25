/** Exams: a folder of notes with a date, set in Settings, Study. Inside an exam folder
 * the schedule works toward the date: reviews are kept inside the time that is left,
 * recall is held higher, and new material is introduced fast enough to be covered
 * before the exam. After the date the folder is scheduled as usual again.
 *
 * Pure: the view hands in paths and the clock. */

import type { ConceptMap } from "./concepts";
import { conceptTested } from "./concepts";
import { INTENSITY_PRESETS } from "./settingstools";
import type { Concept } from "./generate-local";

export interface Exam {
	/** The folders it covers, each with everything inside it. "" is the whole vault.
	 * Kept compact: a folder is listed only when its parent isn't (see tickFolder). */
	folders: string[];
	/** The exam day, YYYY-MM-DD. */
	date: string;
}

/** Recall held for an exam's concepts, at least: the Intense preset's figure. */
export const EXAM_RETENTION = INTENSITY_PRESETS.intense.desiredRetention / 100;

/** For notes outside an exam under "Keep what I read" (Settings, Study): recall held at
 * most this high, and at most this many new concepts a day. The Relaxed preset's figures. */
export const KEEP_RETENTION = INTENSITY_PRESETS.relaxed.desiredRetention / 100;
export const KEEP_NEW_PER_DAY = INTENSITY_PRESETS.relaxed.newConceptsPerDay;

const DAY = 86400_000;

/** Local midnight at the start of a YYYY-MM-DD day, or null for anything else. */
export function examDay(date: string): Date | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!m) return null;
	const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	return d.getDate() === Number(m[3]) ? d : null;
}

/** Whole days from today to the exam day: 0 on the day itself, negative after it. */
export function daysLeft(exam: Exam, now: Date): number {
	const day = examDay(exam.date);
	if (!day) return -1;
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	return Math.round((day.getTime() - today.getTime()) / DAY);
}

const under = (path: string, folder: string): boolean => folder === "" || path === folder || path.startsWith(`${folder}/`);

/** Whether a note path is in an exam: inside one of its folders. */
export function inExam(path: string, e: Exam): boolean {
	return e.folders.some((f) => under(path, f));
}

/** How deep an exam reaches for a path: the longest of its folders the path is in, so
 * a narrower exam wins over a broader one. -1 when it isn't in the exam. */
function reach(path: string, e: Exam): number {
	let best = -1;
	for (const f of e.folders) if (under(path, f)) best = Math.max(best, f === "" ? 0 : f.length);
	return best;
}

/** The exam a note path falls under, if one is still ahead (today counts). Where
 * exams overlap, the narrower one wins; between two as narrow, the sooner one. */
export function examFor(path: string, exams: readonly Exam[], now: Date): Exam | null {
	let best: Exam | null = null;
	let bestReach = -1;
	for (const e of exams) {
		const r = reach(path, e);
		if (r < 0 || daysLeft(e, now) < 0) continue;
		if (!best || r > bestReach || (r === bestReach && daysLeft(e, now) < daysLeft(best, now))) {
			best = e;
			bestReach = r;
		}
	}
	return best;
}

const parentOf = (folder: string): string => (folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "");

/** Every folder of `all` (plus "" for the whole vault) that a selection ticks: those
 * listed and everything inside them. */
function ticked(selected: readonly string[], all: readonly string[]): Set<string> {
	const out = new Set<string>();
	for (const f of ["", ...all]) if (selected.some((x) => under(f, x))) out.add(f);
	return out;
}

/** Tick or untick a folder (`""`, the whole vault) in a selection, over the vault's
 * folders `all`. Ticking takes in everything inside it; unticking takes it and its
 * insides out, and unticks the folders around it, since they no longer hold all of it.
 * Returns the selection compacted: each ticked folder whose parent isn't ticked. */
export function tickFolder(selected: readonly string[], folder: string, on: boolean, all: readonly string[]): string[] {
	const t = ticked(selected, all);
	const inside = ["", ...all].filter((f) => f === folder || folder === "" || f.startsWith(`${folder}/`));
	if (on) for (const f of inside) t.add(f);
	else {
		for (const f of inside) t.delete(f);
		for (let p = folder; p !== ""; ) {
			p = parentOf(p);
			t.delete(p);
		}
	}
	if (t.has("")) return [""];
	return [...t].filter((f) => f !== "" && !t.has(parentOf(f))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** How a folder shows in the picker: ticked, partly (something inside is), or not. */
export function folderState(selected: readonly string[], folder: string, all: readonly string[]): "on" | "partial" | "off" {
	const t = ticked(selected, all);
	if (t.has(folder)) return "on";
	return [...t].some((f) => folder === "" || f.startsWith(`${folder}/`)) ? "partial" : "off";
}

/** A short name for an exam's folders: "Whole vault", or the last part of each. */
export function examName(e: Exam): string {
	if (e.folders.includes("")) return "Whole vault";
	const names = e.folders.map((f) => f.slice(f.lastIndexOf("/") + 1));
	return names.length <= 3 ? names.join(", ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/** "in 17 days", "tomorrow", "today". */
export function whenWords(left: number): string {
	return left === 0 ? "today" : left === 1 ? "tomorrow" : `in ${left} days`;
}

/** Exams still ahead, soonest first, as one line each for the home screen and the
 * digest: what it covers, the date and how long is left. */
export function examLines(exams: readonly Exam[], now: Date): string[] {
	return exams
		.map((e) => ({ e, left: daysLeft(e, now) }))
		.filter((x) => x.left >= 0)
		.sort((a, b) => a.left - b.left)
		.map(({ e, left }) => `${examName(e)}: ${e.date}, ${whenWords(left)}`);
}

/** The longest a review may wait with `left` days to go: half the time left, so each
 * concept comes back more often as the date nears. Null from the day before on, when
 * the usual schedule takes over again: capping then would bring a concept straight
 * back in the same sitting. */
export function examCapDays(left: number): number | null {
	return left >= 2 ? Math.floor(left / 2) : null;
}

/** Keep a just-scheduled review inside the time left. A review set to come back in
 * minutes (a miss) is left alone. */
export function fitDueToExam(cm: { dueAt: string | null }, left: number, now: Date): void {
	const cap = examCapDays(left);
	if (cap === null || !cm.dueAt) return;
	const latest = now.getTime() + cap * DAY;
	if (new Date(cm.dueAt).getTime() > latest) cm.dueAt = new Date(latest).toISOString();
}

/** A small stable number from a string, to spread pulled-in reviews over days. */
function spread(id: string, days: number): number {
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
	return Math.abs(h) % Math.max(1, days);
}

/** Before a session: an exam concept already scheduled after the last day before the
 * exam is brought in. They land spread over the second half of the time left rather
 * than all on the eve. Returns how many moved. */
export function pullInForExams(map: ConceptMap, leftFor: (note: string) => number | null, now: Date): number {
	let moved = 0;
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	for (const [id, cm] of Object.entries(map)) {
		if (!conceptTested(cm) || !cm.dueAt) continue;
		const left = leftFor(cm.note);
		const cap = left === null ? null : examCapDays(left);
		if (left === null || cap === null) continue;
		const eve = today + (left - 1) * DAY;
		if (new Date(cm.dueAt).getTime() <= eve) continue;
		cm.dueAt = new Date(Math.max(now.getTime(), eve - spread(id, cap) * DAY)).toISOString();
		moved++;
	}
	return moved;
}

/** New concepts an exam's folder should take today to be covered a day before the
 * exam, so the last day is for review. */
export function examNewPerDay(untested: number, left: number): number {
	if (untested <= 0 || left < 0) return 0;
	return Math.ceil(untested / Math.max(1, left - 1));
}

/** Today's extra room for new material across every exam, for pickConcepts: which
 * concepts are in an exam, and how many new ones the exams need today in all. */
export function examNewQuota(
	concepts: readonly Concept[],
	map: ConceptMap,
	leftFor: (note: string) => number | null,
): { inExam: Set<string>; perDay: number } {
	const inExam = new Set<string>();
	const untestedByLeft = new Map<number, number>();
	for (const c of concepts) {
		const left = leftFor(c.note);
		if (left === null) continue;
		inExam.add(c.id);
		const cm = map[c.id];
		if (!cm || !conceptTested(cm)) untestedByLeft.set(left, (untestedByLeft.get(left) ?? 0) + 1);
	}
	let perDay = 0;
	for (const [left, n] of untestedByLeft) perDay += examNewPerDay(n, left);
	return { inExam, perDay };
}
