/**
 * Editing a passage where it stands. A box opens under the selected text (or at the
 * cursor) asking what should change; the answer comes back as a word-by-word diff in
 * the same place, to accept or reject. Nothing in the note changes until it is
 * accepted, and accepting is one step in the editor's own undo history.
 *
 * It lives in the editor as one state field: the passage's range, which follows the
 * text as the note is typed in around it, and a block under its last line.
 */

import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { wordDiff } from "./worddiff";

/** What the editor needs from the plugin: the text to put in the passage's place. It
 * throws with words fit to show when it can't. */
export interface InlineEditHost {
	rewrite(a: { note: string; text: string; from: number; to: number; ask: string; earlier?: string }): Promise<string>;
}

interface Edit {
	/** One edit from the box opening to its end. */
	id: number;
	/** Goes up each time what the box shows changes, so it is drawn again then and
	 * only then: typing elsewhere in the note leaves the box, and what is typed in
	 * it, alone. */
	rev: number;
	note: string;
	from: number;
	to: number;
	phase: "ask" | "working" | "review";
	ask: string;
	replacement?: string;
	failed?: string;
}

export interface InlineEdit {
	extension: Extension;
	/** Open the box on what is selected in this editor. With `ask`, it is sent at once. */
	start(view: EditorView, note: string, ask?: string): void;
}

let nextId = 1;

export function inlineEdit(host: InlineEditHost): InlineEdit {
	const set = StateEffect.define<Edit | null>();
	/** The box that was last given the keyboard, so one drawn again as it scrolls back
	 * into view does not take it from wherever it is now. */
	let focused = "";

	const current = (view: EditorView): Edit | null => view.state.field(field, false) ?? null;
	const put = (view: EditorView, e: Edit | null): void => {
		if (view.dom.isConnected) view.dispatch({ effects: set.of(e) });
	};

	const run = async (view: EditorView, ask: string): Promise<void> => {
		const e = current(view);
		if (!e || e.phase === "working" || !ask.trim()) return;
		const working: Edit = { ...e, phase: "working", ask: ask.trim(), rev: e.rev + 1, failed: undefined };
		put(view, working);
		// Still this edit, still waiting on this request: not cancelled, not asked again.
		const mine = (): Edit | null => {
			const now = current(view);
			return now && now.id === working.id && now.rev === working.rev ? now : null;
		};
		try {
			const replacement = await host.rewrite({
				note: e.note,
				text: view.state.doc.toString(),
				from: working.from,
				to: working.to,
				ask: working.ask,
				earlier: e.replacement,
			});
			const now = mine();
			if (now) put(view, { ...now, phase: "review", replacement, rev: now.rev + 1 });
		} catch (err) {
			const now = mine();
			if (now) put(view, { ...now, phase: e.replacement === undefined ? "ask" : "review", failed: (err as Error)?.message || "Something went wrong.", rev: now.rev + 1 });
		}
	};

	const close = (view: EditorView): void => {
		put(view, null);
		view.focus();
	};

	const accept = (view: EditorView): void => {
		const e = current(view);
		if (!e || e.replacement === undefined) return;
		view.dispatch({
			changes: { from: e.from, to: e.to, insert: e.replacement },
			selection: { anchor: e.from + e.replacement.length },
			effects: set.of(null),
			userEvent: "input",
		});
		view.focus();
	};

	class Box extends WidgetType {
		constructor(readonly edit: Edit) {
			super();
		}
		eq(other: Box): boolean {
			return other.edit.id === this.edit.id && other.edit.rev === this.edit.rev;
		}
		// What is typed and clicked in the box is the box's own business.
		ignoreEvent(): boolean {
			return true;
		}
		toDOM(view: EditorView): HTMLElement {
			const e = this.edit;
			const wrap = createDiv({ cls: "grill-inline" });
			if (e.phase === "working") {
				const row = wrap.createDiv({ cls: "grill-inline-row" });
				row.createSpan({ cls: "grill-inline-working", text: "Working..." });
				row.createSpan({ cls: "grill-inline-asked", text: e.ask });
				const stop = row.createEl("button", { text: "Stop", attr: { type: "button" } });
				stop.onclick = () => {
					const now = current(view);
					if (!now || now.id !== e.id) return;
					// Back to where it was: the last version if there is one, the question if not.
					put(view, { ...now, phase: now.replacement === undefined ? "ask" : "review", rev: now.rev + 1 });
				};
				return wrap;
			}
			if (e.phase === "review" && e.replacement !== undefined) {
				const passage = view.state.doc.sliceString(e.from, e.to);
				const diff = wrap.createDiv({ cls: "grill-inline-diff" });
				const parts = wordDiff(passage, e.replacement);
				if (!parts.some((p) => p.kind !== "same")) diff.createSpan({ cls: "grill-inline-none", text: "Nothing to change." });
				else for (const p of parts) diff.createSpan({ cls: p.kind === "same" ? "" : `grill-inline-${p.kind}`, text: p.text });
			}
			if (e.failed) wrap.createDiv({ cls: "grill-inline-failed", text: e.failed });
			const row = wrap.createDiv({ cls: "grill-inline-row" });
			const reviewing = e.phase === "review" && e.replacement !== undefined;
			const input = row.createEl("input", {
				cls: "grill-inline-input",
				attr: {
					type: "text",
					placeholder: reviewing ? "Ask for another change, or press Enter to accept" : e.from === e.to ? "What should be written here?" : "What should change?",
					"aria-label": reviewing ? "Ask for another change" : "What should change",
				},
			});
			if (!reviewing && e.failed) input.value = e.ask;
			if (reviewing) {
				const yes = row.createEl("button", { cls: "mod-cta", text: "Accept", attr: { type: "button" } });
				yes.onclick = () => accept(view);
				const no = row.createEl("button", { text: "Reject", attr: { type: "button" } });
				no.onclick = () => close(view);
			} else {
				const go = row.createEl("button", { cls: "mod-cta", text: "Edit", attr: { type: "button" } });
				go.onclick = () => void run(view, input.value);
				const no = row.createEl("button", { text: "Cancel", attr: { type: "button" } });
				no.onclick = () => close(view);
			}
			input.addEventListener("keydown", (ev) => {
				if (ev.isComposing) return;
				if (ev.key === "Enter") {
					ev.preventDefault();
					ev.stopPropagation();
					if (input.value.trim()) void run(view, input.value);
					else if (reviewing) accept(view);
				} else if (ev.key === "Escape") {
					ev.preventDefault();
					ev.stopPropagation();
					close(view);
				}
			});
			const key = `${e.id}:${e.rev}`;
			if (focused !== key) {
				focused = key;
				window.setTimeout(() => input.isConnected && input.focus(), 0);
			}
			return wrap;
		}
	}

	const marked = Decoration.mark({ class: "grill-inline-target" });

	const field: StateField<Edit | null> = StateField.define<Edit | null>({
		create: () => null,
		update(value, tr) {
			let v = value;
			if (v && tr.docChanged) {
				const from = tr.changes.mapPos(v.from, 1);
				v = { ...v, from, to: Math.max(from, tr.changes.mapPos(v.to, -1)) };
			}
			for (const effect of tr.effects) if (effect.is(set)) v = effect.value;
			return v;
		},
		provide: (f) =>
			EditorView.decorations.compute([f], (state): DecorationSet => {
				const e = state.field(f);
				if (!e) return Decoration.none;
				return Decoration.set(
					[
						...(e.from < e.to ? [marked.range(e.from, e.to)] : []),
						// Under the line the passage ends on: a block in the middle of a line
						// would break the line in two.
						Decoration.widget({ widget: new Box(e), block: true, side: 1 }).range(state.doc.lineAt(e.to).to),
					],
					true,
				);
			}),
	});

	return {
		extension: field,
		start(view, note, ask) {
			const sel = view.state.selection.main;
			// A selection that ends at the start of a line ends, for this, on the line before.
			let to = sel.to;
			if (sel.from < to && view.state.doc.lineAt(to).from === to) to -= 1;
			const edit: Edit = { id: nextId++, rev: 0, note, from: sel.from, to: Math.max(sel.from, to), phase: "ask", ask: "" };
			put(view, edit);
			if (ask) void run(view, ask);
		},
	};
}
