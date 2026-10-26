/** Chat: a conversation about a note, or about the notes as a whole. Nothing in it is
 * graded. Each reply can be put into the note or kept as one, a reply that changed files
 * says which and can undo them, and the chat can turn into a test on the note. Drawn by
 * the view, which keeps the conversation and sends the messages. */

import { Notice, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import { replyTitle } from "../learn";
import type { StudyOfferButton, ThreadTurn } from "../llm";
import { attachPicker, type PickSource } from "../mention";
import { safeMarkdown } from "../safemd";
import { selectionMessage } from "../selection";
import { turnFrame } from "../turn";

/** A conversation in progress. */
export interface LearnState {
	note: TFile;
	/** The other notes the answer may draw on, when the question was asked of the
	 * whole vault: shown as where it comes from, and tested with the note. */
	also: TFile[];
	/** Said under the strip when the whole vault, or as much as fits, is being read. */
	reading: string;
	/** Sent ahead of the note: the map of the vault, and for a question about the
	 * vault as a whole, its notes in full. */
	vault: string;
	/** True when the question is about the notes as a whole, not one of them. */
	whole: boolean;
	noteText: string;
	linkedText: string;
	/** What Grill has on record about this note: see `learnRecord`. */
	record: string;
	/** False when the note is too short to be tested on: see `enoughToTest`. */
	testable: boolean;
	/** A passage selected in the note that the next message is about: shown above
	 * the box, and sent with what is typed. */
	quote?: string;
	turns: ThreadTurn[];
	startedAt: Date;
	/** A past conversation carried on: the note it is kept in, and how many of the
	 * turns were already there, so leaving without a new one changes nothing. */
	file?: TFile;
	had?: number;
	/** A long conversation's start, summed up so it can go on (see `compactAt`): the
	 * summary, and how many turns it covers. The saved note keeps every turn. */
	summary?: string;
	summarized?: number;
	summaryFailures?: number;
	persona: string;
	instructions: string;
	/** The kinds of change the student has said to always allow in this chat. */
	allowed: Set<string>;
	/** Claude Code's own conversation, to go on with on the next message. */
	agentSession?: string;
	/** The engine that has been answering, to see when it is changed mid-chat. */
	engine?: "model" | "claudecode" | "codex" | "opencode";
}

/** What the screen needs of the pane. */
export interface ChatHost {
	app: App;
	md(markdown: string, el: HTMLElement, sourcePath: string): void;
	/** How a turn is read aloud, or null when no voice is available. */
	read: ((text: string) => Promise<void>) | null;
	diagram(parent: HTMLElement, diagram: string): Promise<void>;
	openNote(name: string): void;
	/** Leave the chat, into a test on the note when `test` is set. */
	end(test: boolean): void;
	ask(text: string): void;
	pickSource(): PickSource;
	/** The engine, level, model and prompt buttons under the box. */
	picks(el: HTMLElement, input: HTMLTextAreaElement): void;
	undo(turn: ThreadTurn): void;
	startOffer(b: StudyOfferButton): void;
}

/** Draws the screen into `wrap`. */
export function drawChat(wrap: HTMLElement, L: LearnState, host: ChatHost): void {
	const strip = wrap.createDiv({ cls: "grill-thread-strip" });
	strip.createSpan({ cls: "grill-thread-kind", text: "Chat" });
	if (L.whole) strip.createSpan({ cls: "grill-thread-count", text: "Your notes" });
	else {
		const name = strip.createSpan({ cls: "grill-thread-count grill-chip-link", text: L.note.basename });
		name.onclick = () => host.openNote(L.note.basename);
	}
	const end = strip.createEl("button", { cls: "grill-thread-end", text: "End" });
	end.onclick = () => host.end(false);
	if (L.reading) wrap.createDiv({ cls: "grill-learn-from grill-meta", text: L.reading });
	else if (L.also.length) {
		// Where the answers come from, each a way into that note.
		const from = wrap.createDiv({ cls: "grill-learn-from grill-meta" });
		from.createSpan({ text: "Also reading: " });
		L.also.forEach((f, i) => {
			if (i) from.createSpan({ text: ", " });
			const link = from.createSpan({ cls: "grill-chip-link", text: f.basename });
			link.onclick = () => host.openNote(f.basename);
		});
	}

	const card = wrap.createDiv({ cls: "grill-body grill-learn" });
	const turns = card.createDiv({ cls: "grill-thread-turns grill-learn-turns" });
	if (!L.turns.length) turns.createDiv({ cls: "grill-meta", text: "Ask anything about this note. Nothing here is graded." });
	for (const turn of L.turns) void chatTurn(turns, turn, L, host);

	if (L.quote) {
		const quote = card.createDiv({ cls: "grill-learn-quote" });
		quote.createDiv({ cls: "grill-learn-quote-text", text: L.quote.trim() });
		const off = quote.createEl("button", { cls: "grill-home-chip-off", text: "x", attr: { type: "button", "aria-label": "Leave the selected text out" } });
		off.onclick = () => {
			L.quote = undefined;
			quote.remove();
			input.focus();
		};
	}
	const box = card.createDiv({ cls: "grill-thread-ask grill-learn-box" });
	const input = box.createEl("textarea", {
		cls: "grill-thread-input",
		attr: { rows: "2", placeholder: L.quote ? "Ask about the selected text... (Enter to send)" : "Ask about this note... (Enter to send)", "aria-label": "Ask about this note" },
	});
	attachPicker(input, host.pickSource());
	const send = box.createEl("button", { text: "Send", cls: "mod-cta grill-submit-btn" });
	const go = (): void => {
		const text = input.value.trim();
		if (!text || send.disabled) return;
		const about = L.quote ? selectionMessage("ask", L.quote) : "";
		L.quote = undefined;
		host.ask(about + text);
	};
	send.onclick = go;
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			go();
		}
	});
	// The same buttons as under the home box, so a chat can change what answers it,
	// how much it may do, and with which model, without leaving it.
	host.picks(card.createDiv({ cls: "grill-home-picks grill-learn-picks" }), input);
	const foot = card.createDiv({ cls: "grill-thread-help" });
	// A note too short to test is only worth a word when it is the one open: a chat
	// begun with no note open is anchored on a note the student never picked, and
	// "too short to test" about it reads as nonsense.
	const open = host.app.workspace.getActiveFile() === L.note;
	if (!L.whole && (L.testable || open)) {
		const test = foot.createEl("button", { cls: "grill-hint-btn", text: "Test me on this" });
		test.disabled = !L.turns.length || !L.testable;
		test.onclick = () => host.end(true);
		if (!L.testable) foot.createSpan({ cls: "grill-meta", text: `${L.note.basename} is too short to test.` });
	}
	input.focus();
}

/** One turn of the conversation, drawn the way follow-ups under a question are. */
async function chatTurn(turns: HTMLElement, turn: ThreadTurn, L: LearnState, host: ChatHost): Promise<void> {
	const { el, body } = turnFrame(turns, turn.role, "Grill", turn.text, host.read);
	if (turn.activity) el.insertBefore(el.createDiv({ cls: "grill-meta grill-agent-summary", text: turn.activity }), body);
	host.md(turn.text, body, L.note.path);
	if (turn.diagram) await host.diagram(body, turn.diagram);
	if (turn.role !== "tutor" || !turn.text) return;
	// What can be done with a reply: put it in the note, or keep it as one.
	const acts = el.createDiv({ cls: "grill-reply-acts" });
	const act = (label: string, run: () => void | Promise<void>): void => {
		const b = acts.createEl("button", { cls: "grill-home-link", text: label, attr: { type: "button" } });
		b.onclick = () => void run();
	};
	// What the turn changed, each a way into the file, and one Undo for all of it.
	if (turn.changes?.length) {
		const card = el.createDiv({ cls: "grill-reply-changes" });
		card.createDiv({ cls: "grill-meta", text: turn.undone ? "Changes undone" : turn.changes.length === 1 ? "File changed" : `${turn.changes.length} files changed` });
		for (const c of turn.changes) {
			const name = c.path.split("/").pop() ?? c.path;
			const row = card.createDiv({ cls: "grill-reply-change" });
			const link = row.createSpan({ cls: "grill-chip-link", text: name.replace(/\.md$/, "") });
			link.onclick = () => void host.app.workspace.openLinkText(c.path, "", false);
			if (c.before === null) row.createSpan({ cls: "grill-meta", text: " (new)" });
			else if (c.after === null) row.createSpan({ cls: "grill-meta", text: " (removed)" });
		}
		if (!turn.undone) {
			const undo = card.createEl("button", { cls: "grill-hint-btn", text: "Undo", attr: { type: "button" } });
			undo.onclick = () => host.undo(turn);
		}
		acts.before(card);
	}
	// Studying the reply recommends, ready to start.
	if (turn.offers?.length) {
		const go = el.createDiv({ cls: "grill-reply-offers" });
		for (const b of turn.offers) {
			const btn = go.createEl("button", { cls: "grill-hint-btn", text: b.label, attr: { type: "button" } });
			btn.onclick = () => host.startOffer(b);
		}
		acts.before(go);
	}
	act("Insert at cursor", () => insertInNote(host.app, turn.text));
	act("Save as note", () => saveReplyAsNote(host.app, turn.text, L.note));
}

/** Put a reply into the note being written: at the cursor of the Markdown note last
 * worked in, which is the one beside this pane. */
function insertInNote(app: App, text: string): void {
	const leaf = app.workspace
		.getLeavesOfType("markdown")
		.map((l) => l as WorkspaceLeaf & { activeTime?: number })
		.sort((a, b) => (b.activeTime ?? 0) - (a.activeTime ?? 0))[0];
	const editor = (leaf?.view as { editor?: { replaceSelection(text: string): void } } | undefined)?.editor;
	if (!editor) {
		new Notice("Grill: open the note you want it in, in editing view, and try again.", 6000);
		return;
	}
	// A model wrote it: made inert before it is part of a note (see safemd.ts).
	editor.replaceSelection(safeMarkdown(text));
	new Notice("Grill: inserted.", 2500);
}

/** Keep a reply as a note of its own, beside the note it was about, and open it. */
async function saveReplyAsNote(app: App, text: string, beside: TFile): Promise<void> {
	const first = text.split("\n").find((l) => l.trim()) ?? "";
	const title = replyTitle(first) || `About ${beside.basename}`;
	const folder = beside.parent && beside.parent.path !== "/" ? `${beside.parent.path}/` : "";
	let path = `${folder}${title}.md`;
	for (let n = 2; app.vault.getAbstractFileByPath(path); n++) path = `${folder}${title} ${n}.md`;
	try {
		const file = await app.vault.create(path, `${safeMarkdown(text)}\n\nFrom a chat about [[${beside.basename}]].\n`);
		await app.workspace.getLeaf("tab").openFile(file);
	} catch (e) {
		new Notice(`Grill: couldn't save that as a note (${(e as Error).message}).`, 6000);
	}
}
