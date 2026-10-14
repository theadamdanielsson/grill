/**
 * The home screen as a chat: what Grill suggests doing, and a box to say what you
 * want instead.
 *
 * Draws only. What each suggestion starts, and what a typed message means, is decided
 * by the view that calls this; nothing here reads or changes the record.
 */

export interface HomeSuggestion {
	label: string;
	/** One line of fact under the name: where the misses are, how the note has gone. */
	detail?: string;
	/** Shown at the end of the row: how many questions or notes it covers. */
	count?: string;
	run(): void;
	/** Resolves to why this can't be started right now, or null when it can. Looked up
	 * after the row is drawn; a reason takes the count's place and the row goes dead. */
	check?(): Promise<string | null>;
}

export interface HomeRecent {
	title: string;
	open(): void;
}

export interface HomeCredits {
	/** Share of the last top-up still left, 0 to 1. */
	left: number;
	low: boolean;
	label: string;
}

export type HomeMode = "chat" | "test";

export interface HomeData {
	/** Chat: you ask or say what to do, nothing graded. Test: Grill asks and it counts. */
	mode: HomeMode;
	setMode(mode: HomeMode): void;
	suggestions: HomeSuggestion[];
	/** The conversation or session last had, to pick up from. */
	last: HomeRecent | null;
	/** The note open beside the pane, when it can be read. It rides along with what is
	 * typed, as a chip that can be taken off. */
	openNote: string | null;
	/** What answers: its name, and the way to change it. */
	engine: { name: string; open(): void };
	/** Claude Code's permission level, when it is what answers: its name, what it
	 * means, and a step to the next one. */
	level?: { name: string; says: string; next(): void } | null;
	/** Which model answers, when there is a choice: its name, and a list to pick from,
	 * opened at the button. */
	model?: { name: string; open(at: HTMLElement): void } | null;
	/** The prompts, Grill's own and the saved ones: a list opened at the button, and
	 * what to do with the one picked. */
	prompts?: { open(at: HTMLElement, use: (text: string) => void): void } | null;
	placeholder: string;
	sendLabel: string;
	/** What was typed, trimmed (empty when Send was pressed on an empty box), and
	 * whether the open note's chip was still on. */
	send(text: string, withOpenNote: boolean): void;
	showProgress: () => void;
	showQuestions: () => void;
}

/** How much is left, as a ring with no number on it: a balance that ticks down in
 * view while you study is a distraction, a ring that slowly empties is not. Drawn
 * small, as a mark inside Grill Cloud's button under the chat box, which does the
 * clicking. */
export function renderCreditsRing(parent: HTMLElement, c: HomeCredits): void {
	const btn = parent.createSpan({ cls: "grill-credits-ring", attr: { "aria-label": c.label, title: c.label, role: "img" } });
	btn.toggleClass("is-low", c.low);
	const svg = btn.createSvg("svg", { attr: { viewBox: "0 0 24 24", width: "15", height: "15", "aria-hidden": "true" } });
	const r = 8;
	const around = 2 * Math.PI * r;
	const ring = (cls: string): SVGElement =>
		svg.createSvg("circle", { cls, attr: { cx: "12", cy: "12", r: String(r), fill: "none", "stroke-width": "4" } });
	ring("grill-credits-track");
	const left = ring("grill-credits-left");
	const share = Math.max(0, Math.min(1, c.left));
	left.setAttribute("stroke-dasharray", `${(share * around).toFixed(2)} ${around.toFixed(2)}`);
	left.setAttribute("transform", "rotate(-90 12 12)");
}

/** Everything on the home screen under the tiles: one panel with the two modes as tabs
 * across its top, what the record suggests, and the box. The box is the screen: it takes
 * whatever height is left, at the foot, where a chat's box is. The rows above it are
 * suggestions, a few things the record has a reason to point at, not the way in. */
export function renderChatHome(screen: HTMLElement, d: HomeData): void {
	const panel = screen.createDiv({ cls: "grill-home-panel" });
	const modes = panel.createDiv({ cls: "grill-home-modes", attr: { role: "group", "aria-label": "Mode" } });
	for (const [mode, label] of [["chat", "Chat"], ["test", "Test"]] as const) {
		const b = modes.createEl("button", { cls: "grill-home-mode", text: label, attr: { type: "button", "aria-pressed": String(d.mode === mode) } });
		b.toggleClass("is-on", d.mode === mode);
		b.onclick = () => {
			if (d.mode !== mode) d.setMode(mode);
		};
	}
	const body = panel.createDiv({ cls: "grill-home-body" });

	if (d.suggestions.length) {
		const list = body.createDiv({ cls: "grill-home-suggestions" });
		list.createDiv({ cls: "grill-home-label", text: "Suggestions" });
		for (const s of d.suggestions) {
			const row = list.createEl("button", { cls: "grill-home-suggestion", attr: { type: "button" } });
			const words = row.createSpan({ cls: "grill-home-suggestion-words" });
			words.createSpan({ cls: "grill-home-suggestion-label", text: s.label });
			if (s.detail) words.createSpan({ cls: "grill-home-suggestion-detail", text: s.detail });
			if (s.count) row.createSpan({ cls: "grill-home-suggestion-count", text: s.count });
			void s.check?.().then((reason) => {
				if (!reason || !row.isConnected) return;
				row.disabled = true;
				row.createSpan({ cls: "grill-meta grill-home-suggestion-why", text: reason });
			});
			row.onclick = () => {
				list.querySelectorAll("button").forEach((b) => (b.disabled = true));
				s.run();
			};
		}
	}

	if (d.last) {
		const last = d.last;
		const row = body.createEl("button", { cls: "grill-home-last", attr: { type: "button" } });
		const what = row.createSpan();
		what.createSpan({ cls: "grill-meta", text: "Last: " });
		what.createSpan({ text: last.title });
		row.onclick = () => last.open();
	}

	const box = body.createDiv({ cls: "grill-home-box" });
	let withOpenNote = !!d.openNote;
	if (d.openNote) {
		const chips = box.createDiv({ cls: "grill-home-chips" });
		const chip = chips.createSpan({ cls: "grill-home-chip" });
		chip.createSpan({ text: d.openNote });
		const off = chip.createEl("button", { cls: "grill-home-chip-off", text: "x", attr: { type: "button", "aria-label": `Leave ${d.openNote} out of this message` } });
		off.onclick = () => {
			withOpenNote = false;
			chips.remove();
		};
	}
	const input = box.createEl("textarea", {
		cls: "grill-home-input",
		attr: { placeholder: d.placeholder, "aria-label": d.mode === "chat" ? "Message" : "What to be tested on" },
	});
	const bar = box.createDiv({ cls: "grill-home-bar" });
	const picks = bar.createDiv({ cls: "grill-home-picks" });
	const engine = picks.createEl("button", { cls: "grill-home-engine", attr: { type: "button", "aria-label": `Answered by ${d.engine.name}. Change in settings` } });
	engine.createSpan({ cls: "grill-home-engine-dot" });
	engine.createSpan({ text: d.engine.name });
	engine.onclick = () => d.engine.open();
	if (d.level) {
		const level = d.level;
		const b = picks.createEl("button", { cls: "grill-home-engine grill-home-level", text: level.name, attr: { type: "button", "aria-label": `Permission level: ${level.name}. ${level.says}` } });
		b.onclick = () => level.next();
	}
	if (d.model) {
		const model = d.model;
		const b = picks.createEl("button", { cls: "grill-home-engine grill-home-model", attr: { type: "button", "aria-label": `Model: ${model.name}. Change` } });
		b.createSpan({ cls: "grill-home-model-name", text: model.name });
		b.onclick = () => model.open(b);
	}
	if (d.prompts) {
		const prompts = d.prompts;
		const b = picks.createEl("button", { cls: "grill-home-engine", text: "Prompts", attr: { type: "button", "aria-label": "Use a saved prompt" } });
		b.onclick = () =>
			prompts.open(b, (text) => {
				input.value = text;
				input.focus();
				input.setSelectionRange(text.length, text.length);
			});
	}
	const send = bar.createEl("button", { text: d.sendLabel, cls: "mod-cta grill-primary-cta grill-home-send", attr: { type: "button" } });
	const go = (): void => {
		if (send.disabled) return;
		send.disabled = true;
		d.send(input.value.trim(), withOpenNote);
		// A message that matched nothing leaves the screen up: let them try again.
		window.setTimeout(() => {
			if (send.isConnected) send.disabled = false;
		}, 600);
	};
	send.onclick = go;
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			go();
		}
	});

	const foot = screen.createDiv({ cls: "grill-home-foot" });
	const link = (text: string, run: () => void): void => {
		const b = foot.createEl("button", { cls: "grill-home-nav", text, attr: { type: "button" } });
		b.onclick = run;
	};
	link("Progress", d.showProgress);
	link("Questions", d.showQuestions);
}
