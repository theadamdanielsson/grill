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

/** One line per finished question. Opening a line shows what was asked, what was
 * answered and what came back, as it was at the time. */
export function renderThreadHistory(parent: HTMLElement, segments: ThreadSegment[], host: ThreadHost): void {
	if (!segments.length) return;
	const list = parent.createDiv({ cls: "grill-thread-history" });
	for (const seg of segments) {
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
			if (seg.entry.feedback) host.md(seg.entry.feedback, body.createDiv({ cls: "grill-feedback" }), seg.entry.node);
			if (seg.entry.verdict !== "correct" && seg.entry.modelAnswer) {
				body.createDiv({ cls: "grill-block-label", text: "Expected answer" });
				host.md(seg.entry.modelAnswer, body.createDiv({ cls: "grill-model-answer" }), seg.entry.node);
			}
			const open = body.createEl("button", { cls: "grill-quiet-btn", text: "Open note" });
			open.onclick = () => host.openNote(seg.entry.node);
		});
	}
}
