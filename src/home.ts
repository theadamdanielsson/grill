/**
 * The home screen as a chat: what Grill suggests doing, and a box to say what you
 * want instead.
 *
 * Draws only. What each suggestion starts, and what a typed message means, is decided
 * by the view that calls this; nothing here reads or changes the record.
 */

export interface HomeSuggestion {
	label: string;
	/** Shown at the end of the row: how many questions or notes it covers. */
	count?: string;
	run(): void;
}

export interface HomeRecent {
	title: string;
	meta: string;
	open(): void;
}

export interface HomeCredits {
	/** Share of the last top-up still left, 0 to 1. */
	left: number;
	low: boolean;
	label: string;
	open(): void;
}

export type HomeMode = "learn" | "test";

export interface HomeData {
	/** Learn: you ask and Grill explains, nothing graded. Test: Grill asks and it counts. */
	mode: HomeMode;
	setMode(mode: HomeMode): void;
	suggestions: HomeSuggestion[];
	recent: HomeRecent[];
	/** The note open beside the pane, when it can be studied. */
	openNote: string | null;
	/** Draws into the room left between the recent list and the suggestions. */
	fill?(host: HTMLElement): void;
	placeholder: string;
	sendLabel: string;
	/** What was typed, trimmed; empty when Send was pressed on an empty box. */
	send(text: string): void;
	showProgress(): void;
	showQuestions(): void;
}

const SVG = "http://www.w3.org/2000/svg";

/** How much is left, as a ring with no number on it: a balance that ticks down in
 * view while you study is a distraction, a ring that slowly empties is not. */
export function renderCreditsRing(parent: HTMLElement, c: HomeCredits): void {
	const btn = parent.createEl("button", { cls: "grill-credits-ring", attr: { "aria-label": c.label, type: "button" } });
	btn.toggleClass("is-low", c.low);
	btn.onclick = () => c.open();
	const r = 8;
	const around = 2 * Math.PI * r;
	const svg = btn.createSvg("svg", { attr: { viewBox: "0 0 24 24", width: "22", height: "22", "aria-hidden": "true" } });
	const ring = (cls: string): SVGElement => {
		const el = document.createElementNS(SVG, "circle");
		el.setAttribute("cx", "12");
		el.setAttribute("cy", "12");
		el.setAttribute("r", String(r));
		el.setAttribute("fill", "none");
		el.setAttribute("stroke-width", "4");
		el.setAttribute("class", cls);
		svg.appendChild(el);
		return el;
	};
	ring("grill-credits-track");
	const left = ring("grill-credits-left");
	const share = Math.max(0, Math.min(1, c.left));
	left.setAttribute("stroke-dasharray", `${(share * around).toFixed(2)} ${around.toFixed(2)}`);
	left.setAttribute("transform", "rotate(-90 12 12)");
}

/** Everything on the home screen under the four tiles. */
export function renderChatHome(screen: HTMLElement, d: HomeData): void {
	if (d.recent.length) {
		screen.createDiv({ cls: "grill-section-label", text: "Recent" });
		const list = screen.createDiv({ cls: "grill-recent" });
		for (const item of d.recent) {
			const row = list.createDiv({ cls: "grill-recent-row" });
			row.createSpan({ text: item.title });
			if (item.meta) row.createSpan({ cls: "grill-meta", text: item.meta });
			row.onclick = () => item.open();
		}
	}

	// Whatever height is left goes here, so the suggestions and the box sit at the foot
	// of the pane.
	const space = screen.createDiv({ cls: "grill-home-space" });
	d.fill?.(space);

	const modes = screen.createDiv({ cls: "grill-home-modes", attr: { role: "group", "aria-label": "Mode" } });
	for (const [mode, label] of [["learn", "Learn"], ["test", "Test"]] as const) {
		const b = modes.createEl("button", { cls: "grill-home-mode", text: label, attr: { type: "button", "aria-pressed": String(d.mode === mode) } });
		b.toggleClass("is-on", d.mode === mode);
		b.onclick = () => {
			if (d.mode !== mode) d.setMode(mode);
		};
	}

	if (d.suggestions.length) {
		const list = screen.createDiv({ cls: "grill-home-suggestions" });
		for (const s of d.suggestions) {
			const row = list.createEl("button", { cls: "grill-home-suggestion", attr: { type: "button" } });
			row.createSpan({ cls: "grill-home-suggestion-label", text: s.label });
			if (s.count) row.createSpan({ cls: "grill-home-suggestion-count", text: s.count });
			row.onclick = () => {
				list.querySelectorAll("button").forEach((b) => (b.disabled = true));
				s.run();
			};
		}
	}

	const box = screen.createDiv({ cls: "grill-home-box" });
	const input = box.createEl("textarea", {
		cls: "grill-home-input",
		attr: { rows: "2", placeholder: d.placeholder, "aria-label": d.mode === "learn" ? "What to ask about" : "What to be tested on" },
	});
	const bar = box.createDiv({ cls: "grill-home-bar" });
	bar.createSpan({ cls: "grill-meta grill-home-open", text: d.openNote ? `Open note: ${d.openNote}` : "" });
	const send = bar.createEl("button", { text: d.sendLabel, cls: "mod-cta grill-primary-cta grill-home-send", attr: { type: "button" } });
	const go = (): void => {
		if (send.disabled) return;
		send.disabled = true;
		d.send(input.value.trim());
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
		const b = foot.createEl("button", { cls: "grill-home-link", text, attr: { type: "button" } });
		b.onclick = run;
	};
	link("Progress", d.showProgress);
	link("Questions", d.showQuestions);
}
