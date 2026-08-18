/** Client-side FSRS parameter personalization.
 *
 * mastery.ts runs FSRS-6 at the library's global default weights (`default_w`,
 * fit by open-spaced-repetition across a huge pooled dataset of many people's
 * reviews). Anki's own FSRS support closes that gap with an optimizer: given
 * enough of *your* review history, it refits the ~21-weight vector to your own
 * forgetting curve, which is measurably more accurate than the population
 * default once there's enough data. concepts.ts has been logging exactly the
 * review history that needs (`ConceptMastery.reviewLog`) since it was added,
 * unused until now.
 *
 * This is a from-scratch, dependency-free reimplementation of that idea, not a
 * port of Anki's own optimizer (which needs PyTorch and a training pipeline
 * that has no place in a client-side Obsidian plugin). The maths only needs
 * `ts-fsrs`'s own `next_state`/`forgetting_curve` (already a dependency) plus
 * plain finite-difference gradient descent — small enough to run on the main
 * thread in short chunks, yielding between iterations so a big vault's fit
 * doesn't freeze the UI.
 *
 * Loss: binary cross-entropy between each review's predicted recall
 * probability (from the state carried in from the review before it) and
 * whether it was actually recalled (any rating but Again). This is the same
 * objective FSRS4Anki's optimizer trains against.
 */

import { clipParameters, default_w, FSRSAlgorithm, generatorParameters, Rating, type FSRSState, type Grade } from "ts-fsrs";
import { ConceptMap } from "./concepts";

/** Below this many prediction-eligible reviews, a fit is too noisy to trust —
 * matches the floor FSRS4Anki's own optimizer warns under (real reviews, not
 * concept count: a vault with thousands of concepts but few repeat visits
 * still isn't ready). */
export const MIN_REVIEWS_FOR_OPTIMIZATION = 400;

/** Hard cap on how many reviews one optimization run will train against, by
 * randomly dropping whole concept sequences (never partial ones — a sequence's
 * predictive value comes from replaying it start to end) once the vault has
 * far more history than a fit needs. Bounds worst-case run time on a large,
 * long-used vault; 8000 reviews is already an order of magnitude past
 * MIN_REVIEWS_FOR_OPTIMIZATION, so accuracy isn't meaningfully left on the table. */
const MAX_TRAINING_REVIEWS = 8000;

const MAX_ITERATIONS = 150;
const PATIENCE = 10;
const LEARNING_RATE = 0.02;
const ADAM_BETA1 = 0.9;
const ADAM_BETA2 = 0.999;
const ADAM_EPS = 1e-8;
/** Finite-difference step for the numeric gradient. */
const GRAD_EPS = 1e-4;
/** ts-fsrs's own relearning-step count and short-term flag, matching the
 * defaults mastery.ts's shared engine runs at (see its own comment) — clipParameters
 * needs both to compute the correct w17/w18 ceiling. */
const RELEARNING_STEPS = 1;
const ENABLE_SHORT_TERM = true;

interface TrainingReview {
	/** Whole days elapsed since the previous review in this sequence (0 for the first). */
	t: number;
	rating: Grade;
}

/** One concept's full review history, chronological. Index 0 is the initial
 * exposure (no prior state to predict against); indices 1+ are each a real
 * prediction target. */
type TrainingSequence = TrainingReview[];

function clampGrade(r: number): Grade {
	return Math.min(4, Math.max(1, Math.round(r)));
}

function clamp01(x: number): number {
	return Math.min(1 - 1e-6, Math.max(1e-6, x));
}

/** Count of real (index >= 1) prediction-eligible reviews across the whole
 * vault — the number `MIN_REVIEWS_FOR_OPTIMIZATION` is measured against, and
 * what the settings UI shows progress toward. */
export function countTrainableReviews(concepts: ConceptMap): number {
	let n = 0;
	for (const cm of Object.values(concepts)) {
		const log = cm.reviewLog;
		if (log && log.length >= 2) n += log.length - 1;
	}
	return n;
}

function buildSequences(concepts: ConceptMap): TrainingSequence[] {
	const seqs: TrainingSequence[] = [];
	for (const cm of Object.values(concepts)) {
		const log = cm.reviewLog;
		if (!log || log.length < 2) continue;
		seqs.push(log.map((e) => ({ t: Math.max(0, Math.round(e.elapsedDays)), rating: clampGrade(e.rating) })));
	}
	return seqs;
}

/** Deterministic-enough random sample of whole sequences down to
 * `MAX_TRAINING_REVIEWS` reviews' worth, preserving each sequence intact. */
function capTrainingSet(sequences: TrainingSequence[]): TrainingSequence[] {
	const total = sequences.reduce((n, s) => n + s.length - 1, 0);
	if (total <= MAX_TRAINING_REVIEWS) return sequences;
	const shuffled = [...sequences].sort(() => Math.random() - 0.5);
	const out: TrainingSequence[] = [];
	let n = 0;
	for (const s of shuffled) {
		if (n >= MAX_TRAINING_REVIEWS) break;
		out.push(s);
		n += s.length - 1;
	}
	return out;
}

/** Mean binary cross-entropy over every prediction-eligible review, for one
 * candidate weight vector. */
function computeLoss(weights: number[], sequences: TrainingSequence[]): number {
	const algo = new FSRSAlgorithm(generatorParameters({ w: weights }));
	let totalLoss = 0;
	let n = 0;
	for (const seq of sequences) {
		let state: FSRSState | null = null;
		for (let i = 0; i < seq.length; i++) {
			const { t, rating } = seq[i];
			if (i > 0 && state) {
				const r = clamp01(algo.forgetting_curve(t, state.stability));
				const y = rating === Rating.Again ? 0 : 1;
				totalLoss += -(y * Math.log(r) + (1 - y) * Math.log(1 - r));
				n++;
			}
			state = algo.next_state(state, t, rating);
		}
	}
	return n > 0 ? totalLoss / n : 0;
}

export interface OptimizeResult {
	/** Fitted weights, or null when there wasn't enough data or the fit didn't
	 * beat the library defaults. */
	weights: number[] | null;
	baselineLoss: number;
	finalLoss: number;
	reviewsUsed: number;
	iterations: number;
}

/** Fit a personalized FSRS-6 weight vector against this vault's own logged
 * review history. Runs on the main thread but yields to the event loop between
 * iterations. Resolves with `weights: null` (and the counts a caller can
 * report) when there isn't enough data yet, or when the fit failed to beat the
 * library defaults on this vault's own data — never worse than doing nothing. */
export async function optimizeFSRSWeights(concepts: ConceptMap): Promise<OptimizeResult> {
	const allSequences = buildSequences(concepts);
	const reviewsUsed = allSequences.reduce((n, s) => n + s.length - 1, 0);
	const baseline = default_w.slice();
	if (reviewsUsed < MIN_REVIEWS_FOR_OPTIMIZATION) {
		const baselineLoss = computeLoss(baseline, allSequences);
		return { weights: null, baselineLoss, finalLoss: baselineLoss, reviewsUsed, iterations: 0 };
	}

	const sequences = capTrainingSet(allSequences);
	// The count actually trained on, not `reviewsUsed` above: capTrainingSet can drop
	// whole sequences once the vault has far more history than MAX_TRAINING_REVIEWS
	// needs, so reporting the pre-cap count back to the user overstates what the fit
	// actually saw (e.g. "personalized from 9,500 reviews" when only 8,000 were used).
	const trainingReviewsUsed = sequences.reduce((n, s) => n + s.length - 1, 0);
	const baselineLoss = computeLoss(baseline, sequences);

	let w = baseline.slice();
	const n = w.length;
	const m = new Array(n).fill(0);
	const v = new Array(n).fill(0);
	let bestLoss = baselineLoss;
	let bestW = baseline.slice();
	let patience = 0;
	let iterations = 0;

	for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
		iterations = iter;
		const currentLoss = computeLoss(w, sequences);
		const grad = new Array(n).fill(0);
		for (let k = 0; k < n; k++) {
			// Clip the probe point itself, not just the weight update below (line ~188)
			// — `w` is already valid every time this loop runs, but a dimension sitting
			// right at its ceiling (several FSRS-6 weights have tight ones, see clipParameters)
			// can still get nudged just outside the valid domain by GRAD_EPS alone, and an
			// invalid parameter can make computeLoss return NaN. That NaN would then
			// permanently poison this dimension's Adam moments for the rest of the run
			// (no reset exists), wasting the remaining iteration budget on one dead
			// dimension with no visible signal. Clipping the probe keeps every loss
			// evaluation inside the domain FSRS itself is defined on.
			const wPlus = w.slice();
			wPlus[k] += GRAD_EPS;
			const clippedPlus = clipParameters(wPlus, RELEARNING_STEPS, ENABLE_SHORT_TERM);
			grad[k] = (computeLoss(clippedPlus, sequences) - currentLoss) / GRAD_EPS;
		}
		for (let k = 0; k < n; k++) {
			m[k] = ADAM_BETA1 * m[k] + (1 - ADAM_BETA1) * grad[k];
			v[k] = ADAM_BETA2 * v[k] + (1 - ADAM_BETA2) * grad[k] * grad[k];
			const mHat = m[k] / (1 - Math.pow(ADAM_BETA1, iter));
			const vHat = v[k] / (1 - Math.pow(ADAM_BETA2, iter));
			w[k] -= (LEARNING_RATE * mHat) / (Math.sqrt(vHat) + ADAM_EPS);
		}
		w = clipParameters(w, RELEARNING_STEPS, ENABLE_SHORT_TERM);
		const newLoss = computeLoss(w, sequences);
		if (newLoss < bestLoss - 1e-5) {
			bestLoss = newLoss;
			bestW = w.slice();
			patience = 0;
		} else {
			patience++;
		}
		if (patience >= PATIENCE) break;
		// One dataset pass here can run tens of milliseconds on a large vault;
		// yielding every iteration (not every gradient probe) keeps the UI responsive
		// without fragmenting a single fit into hundreds of scheduler round-trips.
		await new Promise((resolve) => window.setTimeout(resolve, 0));
	}

	// A fit that doesn't clear the library defaults on this vault's own data isn't
	// a personalization worth keeping — report it as "no improvement" rather than
	// silently installing weights that are, by this vault's own measure, worse.
	const weights = bestLoss < baselineLoss - 1e-4 ? bestW : null;
	return { weights, baselineLoss, finalLoss: bestLoss, reviewsUsed: trainingReviewsUsed, iterations };
}
