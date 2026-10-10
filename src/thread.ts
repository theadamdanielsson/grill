/**
 * The session as a thread: what has been answered stays on the page, folded to one
 * line each, above the question in hand.
 *
 * Nothing here reads or changes the record. It draws from results the session
 * already holds, so the thread can be switched off without anything else moving.
 */
import type { SessionEntry } from "./store";

/** A finished question, as the thread shows it. */
export interface ThreadSegment {
	/** Position in the session, from 1. */
	n: number;
	entry: SessionEntry;
	/** The verdict in words, and the class that colours it. */
	label: { text: string; cls: string };
}

export interface ThreadHost {
	/** Render Markdown made safe, relative to a note. */
	md(markdown: string, el: HTMLElement, sourcePath: string): void;
	openNote(name: string): void;
}

/** How many finished questions keep a line of their own. Past this, the older ones
 * fold into a single line, so a long session doesn't push the question in hand down
 * the page a row at a time. */
const KEPT_IN_VIEW = 3;

/** The finished questions above the one in hand: the last few a line each, and
 * everything before them behind one line that opens to show them. Opening a question's
 * line shows what was asked, what was answered and what came back, as it was. */
export function renderThreadHistory(parent: HTMLElement, segments: ThreadSegment[], host: ThreadHost): void {
	if (!segments.length) return;
	const list = parent.createDiv({ cls: "grill-thread-history" });
	const older = segments.length > KEPT_IN_VIEW ? segments.slice(0, -KEPT_IN_VIEW) : [];
	if (older.length) {
		const fold = list.createEl("details", { cls: "grill-thread-segment grill-thread-earlier" });
		const summary = fold.createEl("summary", { cls: "grill-thread-summary" });
		summary.createSpan({ cls: "grill-thread-note", text: `${older.length} earlier` });
		const right = older.filter((seg) => seg.entry.verdict === "correct").length;
		summary.createSpan({ cls: "grill-thread-verdict", text: `${right} correct, ${older.length - right} not` });
		let built = false;
		fold.addEventListener("toggle", () => {
			if (!fold.open || built) return;
			built = true;
			const inner = fold.createDiv({ cls: "grill-thread-history grill-thread-earlier-list" });
			for (const seg of older) segmentRow(inner, seg, host);
		});
	}
	for (const seg of segments.slice(older.length)) segmentRow(list, seg, host);
}

/** One finished question as a line that opens. */
function segmentRow(list: HTMLElement, seg: ThreadSegment, host: ThreadHost): void {
	const row = list.createEl("details", { cls: "grill-thread-segment" });
	const summary = row.createEl("summary", { cls: "grill-thread-summary" });
	summary.createSpan({ cls: "grill-thread-n", text: `${seg.n}.` });
	summary.createSpan({ cls: "grill-thread-note", text: seg.entry.node });
	summary.createSpan({ cls: `grill-thread-verdict ${seg.label.cls}`, text: seg.label.text });

	// Built on first open: a long session would otherwise render every past
	// question's Markdown on each new one.
	let built = false;
	row.addEventListener("toggle", () => {
		if (!row.open || built) return;
		built = true;
		const body = row.createDiv({ cls: "grill-thread-body" });
		host.md(seg.entry.question, body.createDiv({ cls: "grill-thread-question" }), seg.entry.node);
		if (!seg.entry.gaveUp && seg.entry.answer) {
			body.createDiv({ cls: "grill-block-label", text: "Your answer" });
			host.md(`> ${seg.entry.answer.split("\n").join("\n> ")}`, body.createDiv({ cls: "grill-your-answer" }), seg.entry.node);
		}
		if (seg.entry.feedback) {
			// One block per line the grader wrote, as on the feedback screen.
			const fb = body.createDiv({ cls: "grill-feedback" });
			for (const line of seg.entry.feedback.split("\n").map((l) => l.trim()).filter(Boolean)) {
				host.md(line, fb.createDiv({ cls: "grill-feedback-line" }), seg.entry.node);
			}
		}
		if (seg.entry.verdict !== "correct" && seg.entry.modelAnswer) {
			body.createDiv({ cls: "grill-block-label", text: "Expected answer" });
			host.md(seg.entry.modelAnswer, body.createDiv({ cls: "grill-model-answer" }), seg.entry.node);
		}
		const open = body.createEl("button", { cls: "grill-thread-open", text: "Open note" });
		open.onclick = () => host.openNote(seg.entry.node);
	});
}
