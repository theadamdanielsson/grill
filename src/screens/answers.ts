/** The ways a question is answered: typing, filling blanks, picking one choice or
 * several, matching pairs, or drawing. Each is drawn into the question card and read
 * back the same way, so the question screen doesn't need to know which it has. */

import type { Question } from "../question";

/** Uniform (Fisher-Yates) shuffle for MC/multi choice order and match-pair pool order.
 * `.sort(() => Math.random() - 0.5)` is a well-known anti-pattern here: a sort
 * comparator has to be consistent across calls to produce a fair result, and a random
 * one isn't — V8's TimSort-derived sort is non-uniform on it, systematically favoring
 * some positions over others (and differently on different engines, so desktop and
 * mobile Obsidian wouldn't even be biased the same way). Doesn't mutate the input. */
export function shuffled<T>(arr: readonly T[]): T[] {
	const out = arr.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/** Which way a question is answered. A question whose own data doesn't support its
 * type (an mc with one choice, a blank with no blank) is answered by typing. */
export type AnswerKind = "blank" | "mc" | "tf" | "multi" | "match" | "draw" | "write";

export function answerKind(q: Question): AnswerKind {
	if (q.type === "blank" && /_{3,}/.test(q.question)) return "blank";
	if (q.type === "mc" && !!q.choices && q.choices.length >= 2) return "mc";
	if (q.type === "tf") return "tf";
	if (q.type === "multi" && !!q.choices && q.choices.length >= 2 && !!q.correctChoices?.length) return "multi";
	if (q.type === "match" && !!q.pairs && q.pairs.length >= 2) return "match";
	if (q.type === "draw" && !!q.drawing) return "draw";
	return "write";
}

/** What the widgets need of the pane. */
export interface AnswerHost {
	md(markdown: string, el: HTMLElement, sourcePath: string): void;
	/** A choice was picked on a one-click question: the answer is in. */
	picked(): void;
	showDrawing(path: string): void;
}

/** A drawn answer widget. */
export interface Answer {
	kind: AnswerKind;
	/** The answer as text for the grader. */
	read(): string;
	/** The choices picked on a select-all question. */
	multi?: ReadonlySet<string>;
	/** The pairs made on a matching question, left to right. */
	match?: Record<string, string>;
	/** The free-text box, when the question is answered by typing. */
	box: HTMLTextAreaElement | null;
	/** The blanks' inputs, in order, when the question is a fill-in. */
	blanks: HTMLInputElement[];
}

/** Draws the question text into `qEl`. A fill-in's blanks become inputs in the text, and
 * are returned in order; any other question is drawn as written. */
export function drawPrompt(qEl: HTMLElement, q: Question, md: AnswerHost["md"]): HTMLInputElement[] {
	// Loose match (3+ underscores): the same tolerance questionDefect already validates
	// against, in case a model writes ___ or _____ instead of ____. Up to three per
	// question (questionDefect caps it); each gets its own input.
	const blankMatches = answerKind(q) === "blank" ? [...q.question.matchAll(/_{3,}/g)] : [];
	if (!blankMatches.length) {
		md(q.question, qEl, q.node);
		return [];
	}
	// Each blank splits the text around a live input. A stretch with a formula or other
	// markup in it is rendered, kept inline (see .grill-blank-text); a plain stretch stays
	// plain text, which keeps its spacing against the input exactly.
	const inputs: HTMLInputElement[] = [];
	const stretch = (text: string): void => {
		if (!text) return;
		if (/[$*`[]/.test(text)) md(text, qEl.createSpan({ cls: "grill-blank-text" }), q.node);
		else qEl.createSpan({ text });
	};
	let cursor = 0;
	for (const m of blankMatches) {
		stretch(q.question.slice(cursor, m.index));
		inputs.push(qEl.createEl("input", { cls: "grill-blank-input", attr: { type: "text" } }));
		cursor = (m.index ?? 0) + m[0].length;
	}
	stretch(q.question.slice(cursor));
	return inputs;
}

/** Draws the way to answer into `card`, below the question. `blanks` are the inputs
 * `drawPrompt` put in the text; `box` is how the typing box is made, when one is needed. */
export function drawAnswer(card: HTMLElement, q: Question, blanks: HTMLInputElement[], host: AnswerHost, box: () => HTMLTextAreaElement): Answer {
	const kind = answerKind(q);
	if (kind === "mc" || kind === "tf") {
		const isTf = kind === "tf";
		let picked = "";
		const mcRow = card.createDiv({ cls: isTf ? "grill-mc-row grill-mc-row-tf" : "grill-mc-row" });
		const options = isTf ? ["True", "False"] : shuffled(q.choices as string[]);
		for (const choice of options) {
			const b = mcRow.createEl("button", { cls: isTf ? "grill-mc-btn grill-tf-btn" : "grill-mc-btn" });
			// Rendered, not plain text: a choice can carry the same inline LaTeX/markdown
			// the question stem does (a formula among the options, not just in the prompt),
			// and createEl's `text:` option would show it as raw, unrendered `$...$` source.
			host.md(choice, b, q.node);
			b.onclick = () => {
				mcRow.querySelectorAll("button").forEach((other) => (other.disabled = true));
				picked = choice;
				host.picked();
			};
		}
		return { kind, read: () => picked, box: null, blanks };
	}
	if (kind === "multi") {
		// Select all that apply: togglable options, an explicit Submit gathers them
		// (unlike mc/tf, a single click can't be "the answer" here).
		const selected = new Set<string>();
		const multiRow = card.createDiv({ cls: "grill-multi-row" });
		for (const choice of shuffled(q.choices as string[])) {
			const b = multiRow.createEl("button", { cls: "grill-multi-btn" });
			host.md(choice, b, q.node); // see the mc/tf branch above for why this isn't `text:`
			b.onclick = () => {
				if (selected.has(choice)) {
					selected.delete(choice);
					b.removeClass("is-selected");
				} else {
					selected.add(choice);
					b.addClass("is-selected");
				}
			};
		}
		return { kind, read: () => [...selected].join(", "), multi: selected, box: null, blanks };
	}
	if (kind === "match") return drawMatch(card, q, host, blanks);
	if (kind === "draw") {
		const el = card.createDiv({ cls: "grill-draw-box" });
		el.createDiv({ cls: "grill-draw-text", text: "Draw it in the Excalidraw tab, then press Submit." });
		const open = el.createEl("button", { text: "Show my drawing", cls: "grill-quiet-btn", attr: { type: "button" } });
		open.onclick = () => host.showDrawing(q.drawing as string);
		return { kind, read: () => "", box: null, blanks };
	}
	if (kind === "blank") return { kind, read: () => blanks.map((el) => el.value.trim()).join(" / "), box: null, blanks };
	const ta = box();
	return { kind, read: () => ta.value.trim(), box: ta, blanks };
}

/** Matching: fixed-order left column of prompts, shuffled right-column pool. Tap a left
 * row to arm it, then tap a right option to assign the pair; tapping an already-assigned
 * left row lets you reassign it before Submit. The ✕ on a filled slot clears it back to
 * unmatched without picking a replacement — needed on its own (not just reassignment)
 * for working a match by elimination: undo a guess and leave it open while you fill in
 * the ones you're sure of first. */
function drawMatch(card: HTMLElement, q: Question, host: AnswerHost, blanks: HTMLInputElement[]): Answer {
	const matchPicks: Record<string, string> = {};
	const pairs = q.pairs as { left: string; right: string }[];
	const matchWrap = card.createDiv({ cls: "grill-match-wrap" });
	const leftCol = matchWrap.createDiv({ cls: "grill-match-col" });
	const rightCol = matchWrap.createDiv({ cls: "grill-match-col grill-match-pool" });
	const slots = new Map<string, { text: HTMLElement; clear: HTMLButtonElement }>();
	const leftRows = new Map<string, HTMLElement>();
	const rightBtns = new Map<string, HTMLButtonElement>();
	let armed: string | null = null;
	const setArmed = (left: string | null) => {
		armed = left;
		for (const [l, lrow] of leftRows) lrow.toggleClass("is-armed", l === left);
	};
	const clearAssignment = (leftKey: string) => {
		const prev = matchPicks[leftKey];
		if (!prev) return;
		rightBtns.get(prev)?.removeClass("is-used");
		delete matchPicks[leftKey];
		const slot = slots.get(leftKey)!;
		slot.text.setText("Tap a match →");
		slot.clear.hide();
	};
	for (const p of pairs) {
		const lrow = leftCol.createDiv({ cls: "grill-match-row" });
		// createDiv, not createSpan: MarkdownRenderer wraps its output in a block-level
		// <p>, which browsers won't nest cleanly inside an inline <span> — a flex child
		// (this row is `display: flex`) behaves the same either way, so div is the safe
		// choice here regardless.
		host.md(p.left, lrow.createDiv({ cls: "grill-match-label" }), q.node);
		const slot = lrow.createDiv({ cls: "grill-match-slot" });
		const slotText = slot.createSpan({ cls: "grill-match-slot-text", text: "Tap a match →" });
		const clearBtn = slot.createEl("button", {
			cls: "grill-match-clear clickable-icon",
			attr: { "aria-label": "Clear this match" },
		});
		clearBtn.setText("✕");
		clearBtn.hide();
		clearBtn.onclick = (e) => {
			e.stopPropagation(); // don't also arm/disarm the row underneath
			clearAssignment(p.left);
		};
		slots.set(p.left, { text: slotText, clear: clearBtn });
		leftRows.set(p.left, lrow);
		lrow.onclick = () => setArmed(armed === p.left ? null : p.left);
	}
	const assignTo = (leftKey: string, right: string, btn: HTMLButtonElement) => {
		const prev = matchPicks[leftKey];
		if (prev) rightBtns.get(prev)?.removeClass("is-used");
		matchPicks[leftKey] = right;
		btn.addClass("is-used");
		const slot = slots.get(leftKey)!;
		slot.text.setText(right);
		slot.clear.show();
		setArmed(null);
	};
	for (const right of shuffled(pairs.map((p) => p.right))) {
		const b = rightCol.createEl("button", { cls: "grill-match-btn" });
		host.md(right, b, q.node); // see the mc/tf branch above for why this isn't `text:`
		b.onclick = () => {
			if (b.hasClass("is-used") || !armed) return;
			assignTo(armed, right, b);
		};
		rightBtns.set(right, b);
	}
	return {
		kind: "match",
		read: () => pairs.map((p) => `${p.left} → ${matchPicks[p.left] ?? "(unmatched)"}`).join("; "),
		match: matchPicks,
		box: null,
		blanks,
	};
}
