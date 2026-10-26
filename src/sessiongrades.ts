/** What one graded answer writes to the record, and how it is taken back. The last AI or
 * deterministic grade keeps a snapshot of the concept from before the answer, so "Mark
 * correct" can replay the normal correct-path scheduling from the real prior state, and
 * "That wasn't my answer" or a discarded question can put the record back as if the
 * answer had never been given. No hand-rolled FSRS undo. */

import type { CalPoint } from "./calibration";
import { type ConceptMap, type ConceptMastery, noteShape, recordConceptRating } from "./concepts";
import type { MisconceptionRegistry } from "./debrief";
import { fitDueToExam } from "./exams";
import { type DueDateHistogram, type MasteryMap, type QDifficulty, type Rating, recordNoteStats, type Verdict } from "./mastery";
import type { Question } from "./question";
import { applyAnswer } from "./record";

/** What the grades read and write, and the session's scheduling inputs. */
export interface GradeParts {
	concepts(): ConceptMap;
	mastery(): MasteryMap;
	registry(): MisconceptionRegistry;
	calibration(): CalPoint[];
	/** Save the plugin data the calibration record lives in. */
	persist(): void;
	/** Days to the exam the note is under, or null. */
	examLeft(note: string): number | null;
	/** The recall to schedule for, given the days to an exam. */
	recall(left: number | null): number;
	histogram(): DueDateHistogram;
	easyDays(): ReadonlySet<number>;
	/** Recompute the note's aggregate status from its concepts. */
	recompute(note: string): void;
}

/** The last grade, for taking it back. Single use, replaced on every answer. */
export interface LastGrade {
	conceptId: string;
	conceptSnapshot: ConceptMastery;
	note: string;
	originalVerdict: Verdict;
	originalMisconceptionTag: string | undefined;
	difficulty: QDifficulty;
	type: string;
	confidence: number | null;
	hintsUsed: number;
	/** Set when this answer also added a calibration point, so taking the answer back
	 * takes that with it. */
	calibrated?: boolean;
	/** Set when this answer marked a misconception resolved: what it was before. */
	resolved?: { tag: string; status: "active" | "resolved" | "dismissed"; lastSeen: string };
}

/** Put a concept back to a snapshot exactly. Object.assign alone restores what the
 * snapshot has but leaves behind what the answer added (a concept's first review-log
 * entry, its leech count), so those are cleared first. */
export function restoreConcept(cm: ConceptMastery, snapshot: ConceptMastery): void {
	for (const key of Object.keys(cm)) delete (cm as unknown as Record<string, unknown>)[key];
	Object.assign(cm, structuredClone(snapshot));
}

/** Take one verdict off a note's counters and its misconception tally. */
function uncount(m: MasteryMap[string], verdict: Verdict, tag: string | undefined): void {
	if (verdict === "correct") m.correct = Math.max(0, m.correct - 1);
	else if (verdict === "partial") m.partial = Math.max(0, m.partial - 1);
	else m.incorrect = Math.max(0, m.incorrect - 1);
	if (tag) {
		const remaining = (m.misconceptions[tag] ?? 0) - 1;
		if (remaining <= 0) delete m.misconceptions[tag];
		else m.misconceptions[tag] = remaining;
	}
}

export class SessionGrades {
	/** The last AI or deterministic grade, while it can still be taken back. Null after a
	 * self-grade (the student's own rating is the ground truth) and after a bridge question
	 * (no concept schedule to correct). */
	last: LastGrade | null = null;

	constructor(private parts: GradeParts) {}

	/** Record one graded answer: the concept's schedule and the note's stats and
	 * aggregate. `rating` is set for a self-grade (its Again/Hard/Good/Easy is the
	 * signal); null for AI grading, where verdict and difficulty decide the rating.
	 * `confidence` is the "how sure?" pick, if this question asked for one. */
	grade(
		q: Question,
		verdict: Verdict,
		rating: Rating | null,
		misconceptionTag: string | undefined,
		hintsUsed: number,
		said: { question?: string; answer: string; feedback?: string } | undefined,
		confidence: number | null,
	): void {
		this.last = null;
		const p = this.parts;
		const concepts = p.concepts();
		const cid = q.conceptId;
		if (cid && concepts[cid]) {
			const left = p.examLeft(q.node);
			const retention = p.recall(left);
			if (rating !== null) {
				recordConceptRating(concepts, cid, rating, new Date(), retention, p.histogram(), p.easyDays());
				noteShape(concepts[cid], { tier: q.difficulty, type: q.type });
				if (left !== null) fitDueToExam(concepts[cid], left, new Date());
			} else {
				// ConceptMastery is plain JSON data, so structuredClone is a faithful snapshot.
				this.last = {
					conceptId: cid,
					conceptSnapshot: structuredClone(concepts[cid]),
					note: q.node,
					originalVerdict: verdict,
					originalMisconceptionTag: misconceptionTag,
					difficulty: q.difficulty ?? "medium",
					type: q.type ?? "write",
					confidence,
					hintsUsed,
				};
				// A guessed correct answer lands as Hard, not Good or Easy.
				applyAnswer(
					concepts,
					cid,
					{ verdict, difficulty: q.difficulty ?? "medium", type: q.type ?? "write", said: said ?? {}, tag: misconceptionTag },
					{ retention, histogram: p.histogram(), easyDays: p.easyDays(), examLeft: left, confidence, hintsUsed },
				);
			}
		}
		recordNoteStats(p.mastery(), q.node, verdict, misconceptionTag);
		p.recompute(q.node);
	}

	/** "Mark correct": restore the concept to its snapshot and run the same scheduling
	 * with the verdict forced to correct; move the note's count to the right bucket and
	 * drop a misconception tallied off the wrong verdict. False when there is nothing to
	 * correct. */
	markCorrect(): boolean {
		const o = this.last;
		if (!o || o.originalVerdict === "correct") return false;
		const p = this.parts;
		const concepts = p.concepts();
		const cm = concepts[o.conceptId];
		if (cm) {
			restoreConcept(cm, o.conceptSnapshot);
			const left = p.examLeft(o.note);
			applyAnswer(
				concepts,
				o.conceptId,
				{ verdict: "correct", difficulty: o.difficulty, type: o.type },
				{ retention: p.recall(left), histogram: p.histogram(), easyDays: p.easyDays(), examLeft: left, confidence: o.confidence, hintsUsed: o.hintsUsed },
			);
		}
		const m = p.mastery()[o.note];
		if (m) {
			uncount(m, o.originalVerdict, o.originalMisconceptionTag);
			m.correct += 1;
		}
		p.recompute(o.note);
		this.last = null;
		return true;
	}

	/** Take the last grade out of the record: the concept goes back to its snapshot, the
	 * note's counters and misconception tally lose the verdict, and the calibration point
	 * and resolved misconception it wrote are undone. Returns what was taken back, or null
	 * when there is nothing to take back. */
	undo(): LastGrade | null {
		const o = this.last;
		if (!o) return null;
		const p = this.parts;
		const cm = p.concepts()[o.conceptId];
		if (cm) restoreConcept(cm, o.conceptSnapshot);
		const m = p.mastery()[o.note];
		if (m) uncount(m, o.originalVerdict, o.originalMisconceptionTag);
		p.recompute(o.note);
		if (o.calibrated) {
			p.calibration().pop();
			p.persist();
		}
		const was = o.resolved;
		const registry = p.registry();
		if (was && registry[was.tag]) {
			registry[was.tag].status = was.status;
			registry[was.tag].lastSeen = was.lastSeen;
		}
		this.last = null;
		return o;
	}
}
