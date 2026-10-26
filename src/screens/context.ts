/** "Add context" on the question screen: a note on how the rest of this test's questions
 * should be written, given without leaving it. The faint button that opens it, the line
 * that says queued questions are being rewritten, and the panel itself. */

/** The button beside "I don't know", or, while `rewriting` queued questions are being
 * written again, a line saying so. */
export function drawContextSlot(slot: HTMLElement, rewriting: number, open: () => void): void {
	slot.empty();
	if (rewriting > 0) {
		slot.createSpan({ cls: "grill-context-status", text: `Rewriting next ${rewriting === 1 ? "question" : `${rewriting} questions`}…`, attr: { role: "status" } });
		return;
	}
	const b = slot.createEl("button", { cls: "grill-quiet-btn grill-context-btn", text: "Add context", attr: { type: "button" } });
	b.onclick = () => open();
}

export interface ContextPanel {
	/** The note in force now, to edit. */
	current: string;
	/** The question on screen can be written again with it (not an authored one). */
	canRewrite: boolean;
	/** The question has already been answered or deleted: nothing more may be applied. */
	done(): boolean;
	/** Applied: the new note, and whether the question on screen goes too. Called with
	 * `again` set only after the card's controls are disabled, since that counts as the
	 * action on this question. */
	apply(text: string, again: boolean): void;
}

/** Opens the panel at the foot of `card`. */
export function openContextPanel(card: HTMLElement, p: ContextPanel): void {
	const panel = card.createDiv({ cls: "grill-context-panel" });
	panel.createEl("label", { cls: "grill-home-label", text: "Add context", attr: { for: "grill-context-input" } });
	const input = panel.createEl("textarea", {
		cls: "grill-context-input",
		attr: { id: "grill-context-input", rows: "4", placeholder: "For example: change the formatting, ask a different type of question, make them shorter or harder, focus on one part of the note" },
	});
	input.value = p.current;
	// An authored question is the user's own, verbatim: there is nothing to rewrite.
	let rewrite: HTMLInputElement | null = null;
	if (p.canRewrite) {
		const check = panel.createEl("label", { cls: "grill-context-check" });
		rewrite = check.createEl("input", { attr: { type: "checkbox" } });
		rewrite.checked = true;
		check.appendText("Rewrite this question too");
	}
	panel.createDiv({ cls: "grill-meta", text: "Applies to the rest of this test. Instructions.md stays as it is." });
	const actions = panel.createDiv({ cls: "grill-context-actions" });
	const cancel = actions.createEl("button", { text: "Cancel", attr: { type: "button" } });
	const apply = actions.createEl("button", { text: "Apply", cls: "mod-cta", attr: { type: "button" } });
	cancel.onclick = () => panel.remove();
	apply.onclick = () => {
		const text = input.value.trim();
		const again = !!rewrite?.checked;
		if (p.done() || (text === p.current && !again)) {
			panel.remove();
			return;
		}
		if (again) card.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement | HTMLInputElement>("button, textarea, input").forEach((b) => (b.disabled = true));
		else panel.remove();
		p.apply(text, again);
	};
	input.focus();
}
