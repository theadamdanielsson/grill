/** Feedback: the verdict on one answer, under the question it answers. What was said
 * and how it was graded, the expected answer when it was missed, and what can be done
 * next: move on, have it explained, or overrule the grade. Drawn by the view, which it
 * reaches through its host. */

import { setIcon } from "obsidian";
import { renderFlameIcon } from "../icon";
import { toSpeechText } from "../tts";
import type { QuestionResult } from "../view";

/** What the screen shows. */
export interface FeedbackData {
	r: QuestionResult;
	/** The question's place in the session, from 0, and how many the session has. */
	idx: number;
	of: number;
	/** Drawn as a thread: the question stays where it was and the verdict goes under it. */
	thread: boolean;
	/** The question as it was drawn and filled in, carried over so nothing above the
	 * verdict is redrawn. Null when there is none to keep. */
	kept: HTMLElement | null;
	/** How the verdict reads. */
	label: { text: string; cls: string };
	/** The drawing graded, as PNG base64, in a draw-from-memory test. */
	drawing: string | null;
	occlusion: boolean;
	/** The last question, with an offer of one more drawn below by the host. */
	extension: boolean;
	canMark: boolean;
	canDiscard: boolean;
	/** "That wasn't my answer" / "That was my answer" can be offered. */
	canTakeBack: boolean;
	/** There is an explanation to give or a conversation to show. */
	showHelp: boolean;
}

/** What the screen needs of the pane. */
export interface FeedbackHost {
	md(markdown: string, el: HTMLElement, sourcePath: string): void;
	openNote(name: string): void;
	/** A speaker button, or nothing when no voice is available. */
	hear(parent: HTMLElement, text: string, label: string, cls?: string): void;
	endSessionLink(card: HTMLElement): void;
	occlusionImage(parent: HTMLElement): void;
	offerLink(card: HTMLElement): void;
	offerHelp(host: HTMLElement, actions: HTMLElement): void;
	routeConsent(card: HTMLElement): void;
	next(): void;
	markCorrect(): void;
	takeBack(): void;
	discard(): void;
}

/** Draws the screen into `wrap`, below what the view has already drawn there. */
export function drawFeedback(wrap: HTMLElement, d: FeedbackData, host: FeedbackHost): void {
	const r = d.r;
	const card = wrap.createDiv({ cls: "grill-body" });
	const meta = card.createDiv({ cls: "grill-meta-row" });
	meta.createSpan({ cls: "grill-meta", text: d.thread ? `${d.idx + 1}.` : `Question ${d.idx + 1} of ${d.of}` });
	const chip = meta.createSpan({ cls: "grill-chip grill-chip-link", text: r.node });
	chip.onclick = () => host.openNote(r.node);
	chip.setAttr("aria-label", "Open note");
	// Not on the route-consent screen (the last question only): its own "No" already
	// ends the session the same way.
	if (!d.extension && !d.thread) host.endSessionLink(card);

	if (d.kept) {
		card.appendChild(d.kept);
		d.kept.querySelectorAll("input").forEach((el) => (el.disabled = true));
	} else {
		const qEl = card.createDiv({ cls: d.thread ? "grill-question" : "grill-question grill-question-small" });
		if (d.thread) qEl.dataset.grillQ = String(d.idx);
		host.md(r.question, qEl, r.node);
	}

	// The verdict card: badge + your answer + grader feedback — "what happened".
	const verdictCard = card.createDiv({ cls: "grill-flow-card grill-verdict-card" });
	if (d.kept) window.setTimeout(() => verdictCard.isConnected && verdictCard.scrollIntoView({ block: "nearest" }), 0);
	const v = d.label;
	const badgeRow = verdictCard.createDiv({ cls: "grill-verdict-row" });
	const badge = badgeRow.createDiv({ cls: `grill-verdict-badge ${v.cls}` });
	renderFlameIcon(badge.createSpan({ cls: "grill-verdict-icon" }));
	badge.createSpan({ text: v.text });
	// Hear what the card says: the verdict, your answer, the feedback, and the expected
	// answer when there is one. (A verdict the feedback only repeats is said once.)
	const sameAsVerdict = r.feedback.trim().replace(/[.!]+$/, "").toLowerCase() === v.text.toLowerCase();
	const spoken = toSpeechText(
		[
			`${v.text}.`,
			!r.gaveUp && r.answer ? `Your answer: ${r.answer}` : "",
			sameAsVerdict ? "" : r.feedback,
			r.verdict !== "correct" && r.modelAnswer ? `The expected answer: ${r.modelAnswer}` : "",
		]
			.filter(Boolean)
			.join("\n\n"),
	);
	host.hear(badgeRow, spoken, "Read this aloud", "grill-tts-feedback");
	// Overruling a grade saves before it redraws. Until it has, nothing else on this
	// screen may be pressed: Next in that gap would redraw this result on the next
	// question.
	const lock = (): void => card.querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.disabled = true));
	if (!r.gaveUp && d.drawing) {
		verdictCard.createDiv({ cls: "grill-block-label", text: "Your drawing" });
		verdictCard.createEl("img", { cls: "grill-draw-answer", attr: { src: `data:image/png;base64,${d.drawing}`, alt: "Your drawing" } });
	} else if (!r.gaveUp && r.answer) {
		verdictCard.createDiv({ cls: "grill-block-label", text: "Your answer" });
		const ans = verdictCard.createDiv({ cls: "grill-your-answer" });
		host.md(`> ${r.answer.split("\n").join("\n> ")}`, ans, r.node);
	}
	if (r.feedback) {
		const fb = verdictCard.createDiv({ cls: "grill-feedback" });
		// Display-only split on the grader's own "line 1 / line 2" convention (see
		// GRADER_RULES): each line its own block when the model included the break.
		for (const line of r.feedback.split("\n").map((l) => l.trim()).filter(Boolean)) {
			host.md(line, fb.createDiv({ cls: "grill-feedback-line" }), r.node);
		}
	}

	// The review card: expected answer — "what to study". Only when it has something in it.
	if (r.verdict !== "correct" && !!r.modelAnswer) {
		const reviewCard = card.createDiv({ cls: "grill-flow-card grill-review-card" });
		const reviewHead = reviewCard.createDiv({ cls: "grill-review-head" });
		reviewHead.createDiv({ cls: "grill-block-label", text: "Expected answer" });
		// Its own button: the one on the verdict reads everything, and after asking
		// for help the expected answer is the one thing left to hear.
		const expected = toSpeechText(r.modelAnswer);
		if (expected) host.hear(reviewHead, expected, "Read the expected answer aloud");
		host.md(r.modelAnswer, reviewCard.createDiv({ cls: "grill-model-answer" }), r.node);
		if (d.occlusion) host.occlusionImage(reviewCard);
	}
	// The explanation and whatever is asked after it flow down from here.
	const helpAt = d.showHelp ? card.createDiv({ cls: "grill-thread-host" }) : null;

	if (r.missingLink && r.connectTo) host.offerLink(card);

	if (d.extension) {
		// The last question, with an offer of one more below: the grade can still be
		// overruled here, which is when it matters most.
		if (d.canMark) {
			const mark = card.createEl("button", { text: "Mark correct", cls: "grill-quiet-btn grill-mark-alone" });
			mark.onclick = () => {
				lock();
				host.markCorrect();
			};
		}
		host.routeConsent(card);
		return;
	}
	// What next, on one line: move on, or understand it better first. Overruling the
	// grade and throwing the question out are rare, so they sit quietly at the end,
	// the flag being the same one the question itself carries.
	const actions = card.createDiv({ cls: "grill-btn-row grill-next-bar" });
	const btn = actions.createEl("button", {
		text: d.idx + 1 < d.of ? "Next question" : "Finish session",
		cls: "mod-cta grill-submit-btn",
	});
	btn.onclick = () => {
		btn.disabled = true; // instant ack, independent of whether a wait follows; also blocks a double-click
		host.next();
	};
	if (helpAt) host.offerHelp(helpAt, actions);
	const quiet = actions.createDiv({ cls: "grill-next-quiet" });
	if (d.canTakeBack) {
		const back = quiet.createEl("button", { text: r.askedForHelp ? "That was my answer" : "That wasn't my answer", cls: "grill-quiet-btn" });
		back.onclick = () => {
			lock();
			host.takeBack();
		};
	}
	if (d.canMark) {
		const mark = quiet.createEl("button", { text: "Mark correct", cls: "grill-quiet-btn" });
		mark.onclick = () => {
			lock();
			host.markCorrect();
		};
	}
	if (d.canDiscard) {
		const bad = quiet.createEl("button", { cls: "clickable-icon grill-bad-question-btn", attr: { "aria-label": "Bad question: wrong, broken or nonsensical. Deletes it and moves on, no penalty.", type: "button" } });
		setIcon(bad, "flag");
		bad.onclick = () => {
			lock();
			host.discard();
		};
	}
	btn.focus();
}
