/** Grading the answers that have one right answer by construction: multiple choice,
 * true/false, several to pick, pairs to match. No model, and nothing else. */

import type { Verdict } from "./mastery";
import type { Question } from "./question";

/** The verdict and feedback for a structured answer, or null for a written one, which
 * the model grades. `multiPicks` are the boxes ticked, `matchPicks` the pairs made. */
export function gradeStructured(
	q: Question,
	answer: string,
	multiPicks?: string[],
	matchPicks?: Record<string, string>,
): { verdict: Verdict; feedback: string } | null {
	let verdict: Verdict;
	let feedback: string;
	if (q.type === "mc" || q.type === "tf") {
		// Unambiguous, structured formats: grade instantly, no LLM round-trip needed.
		verdict = answer.trim().toLowerCase() === q.modelAnswer.trim().toLowerCase() ? "correct" : "incorrect";
		feedback = verdict === "correct" ? "Correct." : `Not quite. The answer is "${q.modelAnswer}".`;
	} else if (q.type === "multi") {
		// Name the specific misses/extras instead of just dumping the model answer a
		// second time — the "Expected answer" block below already shows that string
		// verbatim, so repeating it here added nothing and read as two systems
		// disagreeing rather than one giving you the actual diagnosis.
		const norm = (s: string) => s.trim().toLowerCase();
		const correctChoices = q.correctChoices ?? [];
		const chosenChoices = multiPicks ?? [];
		const correct = new Set(correctChoices.map(norm));
		const chosen = new Set(chosenChoices.map(norm));
		if (correct.size < 2) {
			// Defensive: isMulti's render check (renderQuestion in view.ts) already requires
			// correctChoices.length >= 2 before showing checkboxes at all — this can
			// only be reached if a 'multi' question ever slips past that with fewer
			// than 2 correct choices (currently prevented upstream by questionDefect
			// in question.ts and the local callout parser, but this branch has no guard of
			// its own). Without this, `wrong === 0` below is vacuously true when
			// correct.size is 0, silently grading "Correct" no matter what the student
			// typed. Fail closed instead of trusting two distant files to stay in sync.
			verdict = "incorrect";
			feedback = "This question couldn't be graded as written, so it was marked incorrect rather than automatically correct.";
		} else {
			let hits = 0;
			for (const c of correct) if (chosen.has(c)) hits++;
			const misses = correct.size - hits;
			const extraItems = chosenChoices.filter((c) => !correct.has(norm(c)));
			const missedItems = correctChoices.filter((c) => !chosen.has(norm(c)));
			const wrong = misses + extraItems.length;
			if (wrong === 0) verdict = "correct";
			else if (hits > 0 && wrong <= Math.max(1, Math.ceil(correct.size / 2))) verdict = "partial";
			else verdict = "incorrect";
			if (verdict === "correct") {
				feedback = "Correct, every one.";
			} else {
				const lines: string[] = [];
				if (extraItems.length) {
					lines.push(`"${extraItems.join('", "')}" ${extraItems.length > 1 ? "don't" : "doesn't"} belong.`);
				}
				if (missedItems.length) lines.push(`Missing: ${missedItems.join(", ")}.`);
				feedback = lines.join(" ");
			}
		}
	} else if (q.type === "match") {
		const pairs = q.pairs ?? [];
		const wrongPairs = pairs.filter(
			(p) => (matchPicks?.[p.left] ?? "").trim().toLowerCase() !== p.right.trim().toLowerCase(),
		);
		const hits = pairs.length - wrongPairs.length;
		verdict = hits === pairs.length ? "correct" : hits > 0 ? "partial" : "incorrect";
		feedback =
			verdict === "correct"
				? "Every pair correct."
				: wrongPairs
						.map((p) => `"${p.left}" should match "${p.right}", not "${matchPicks?.[p.left] || "(unmatched)"}".`)
						.join(" ");
	} else {
		return null;
	}
	return { verdict, feedback };
}
