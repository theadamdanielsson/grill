/** Picking from a list while typing in a message box: `@` for a note, which goes in as
 * a [[link]], and `/` at the start for a prompt. The list sits under the box and is
 * worked with the arrow keys, Enter or Tab, Escape, or the mouse. */

export interface Typed {
	kind: "note" | "prompt";
	/** Where the `@` or `/` is. */
	start: number;
	query: string;
}

/** What is being typed at the caret, if it is a mention or a prompt: an `@` at the
 * start or after a space, or a `/` at the very start, with no line break since. */
export function typedAt(text: string, caret: number): Typed | null {
	const before = text.slice(0, caret);
	if (/^\/[^\n]{0,40}$/.test(before)) return { kind: "prompt", start: 0, query: before.slice(1) };
	const at = before.lastIndexOf("@");
	if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]))) return null;
	const query = before.slice(at + 1);
	if (query.length > 40 || /[\n[\]]/.test(query)) return null;
	return { kind: "note", start: at, query };
}

/** Names that match a query, best first: those starting with it, then those with a
 * word starting with it, then those containing it. */
export function rankNames(names: string[], query: string, most = 8): string[] {
	const q = query.trim().toLowerCase();
	if (!q) return names.slice(0, most);
	const scored: Array<[number, string]> = [];
	for (const n of names) {
		const l = n.toLowerCase();
		const s = l.startsWith(q) ? 0 : l.split(/[\s_\-()/]+/).some((w) => w.startsWith(q)) ? 1 : l.includes(q) ? 2 : -1;
		if (s >= 0) scored.push([s, n]);
	}
	return scored
		.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || a[1].localeCompare(b[1]))
		.slice(0, most)
		.map(([, n]) => n);
}

/** The text with what was typed replaced by the pick, and where the caret goes. */
export function applyPick(text: string, t: Typed, caret: number, insert: string): { text: string; caret: number } {
	const out = text.slice(0, t.start) + insert + text.slice(caret);
	return { text: out, caret: t.start + insert.length };
}

/** Notes linked in a message, by name. */
export function linkedNames(text: string): string[] {
	return [...new Set([...text.matchAll(/\[\[([^\]|#^]+)/g)].map((m) => m[1].trim()))];
}

export interface PickSource {
	notes(): string[];
	prompts(): Array<{ name: string; text: () => Promise<string> }>;
}

/** Watches a box and shows the list when `@` or `/` is typed. */
export function attachPicker(input: HTMLTextAreaElement, source: PickSource): void {
	const list = createDiv({ cls: "grill-pick-list" });
	list.hide();
	input.insertAdjacentElement("afterend", list);
	let items: Array<{ label: string; pick: () => Promise<string> }> = [];
	let at = 0;
	let typed: Typed | null = null;

	const close = (): void => {
		list.hide();
		items = [];
		typed = null;
	};
	const draw = (): void => {
		list.empty();
		items.forEach((it, i) => {
			const row = list.createDiv({ cls: `grill-pick-item${i === at ? " is-selected" : ""}`, text: it.label });
			row.onmousedown = (e) => {
				e.preventDefault();
				at = i;
				void choose();
			};
		});
		list.toggle(items.length > 0);
	};
	const update = (): void => {
		typed = typedAt(input.value, input.selectionStart ?? input.value.length);
		if (!typed) return close();
		if (typed.kind === "note") {
			items = rankNames(source.notes(), typed.query).map((n) => ({ label: n, pick: async () => `[[${n}]] ` }));
		} else {
			const all = source.prompts();
			const names = rankNames(all.map((p) => p.name), typed.query);
			items = names.map((n) => ({ label: n, pick: () => all.find((p) => p.name === n)!.text() }));
		}
		at = Math.min(at, Math.max(0, items.length - 1));
		draw();
	};
	const choose = async (): Promise<void> => {
		const t = typed;
		const it = items[at];
		if (!t || !it) return;
		const caret = input.selectionStart ?? input.value.length;
		const insert = await it.pick();
		close();
		if (!insert) return;
		const done = t.kind === "prompt" ? { text: insert, caret: insert.length } : applyPick(input.value, t, caret, insert);
		input.value = done.text;
		input.focus();
		input.setSelectionRange(done.caret, done.caret);
	};

	input.addEventListener("input", () => {
		at = 0;
		update();
	});
	input.addEventListener("click", update);
	input.addEventListener("blur", () => window.setTimeout(close, 100));
	// Ahead of the box's own Enter-to-send, while the list is open.
	input.addEventListener(
		"keydown",
		(e) => {
			if (!items.length || list.style.display === "none") return;
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				at = (at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
				draw();
			} else if ((e.key === "Enter" && !e.shiftKey && !e.isComposing) || e.key === "Tab") {
				e.preventDefault();
				e.stopImmediatePropagation();
				void choose();
			} else if (e.key === "Escape") {
				e.preventDefault();
				close();
			}
		},
		true,
	);
}
