/** The pieces a conversation is drawn from, shared by follow-ups under a question and by
 * Chat: one turn's frame, the turn that says a reply is on its way, and a speaker
 * button. */

import { setIcon } from "obsidian";
import { toSpeechText } from "./tts";

/** A speaker button that reads `text` aloud. A natural voice has to be fetched first,
 * which takes a few seconds for a long passage, so the button shows it is working from
 * the moment it is pressed until the voice starts. */
export function hearButton(parent: HTMLElement, text: string, label: string, read: (text: string) => Promise<void>, cls = ""): HTMLButtonElement {
	const hear = parent.createEl("button", { cls: `clickable-icon grill-tts-btn ${cls}`.trim(), attr: { "aria-label": label, type: "button" } });
	setIcon(hear, "volume-2");
	hear.onclick = async () => {
		hear.addClass("is-loading");
		try {
			await read(text);
		} finally {
			hear.removeClass("is-loading");
		}
	};
	return hear;
}

/** One turn's frame: who is speaking, a button to hear a tutor's turn when speech is
 * available (`read` is null when it isn't), and the body to draw the turn into. */
export function turnFrame(
	turns: HTMLElement,
	role: "student" | "tutor",
	who: string,
	spoken: string,
	read: ((text: string) => Promise<void>) | null,
): { el: HTMLElement; body: HTMLElement } {
	const el = turns.createDiv({ cls: `grill-thread-turn is-${role}` });
	const head = el.createDiv({ cls: "grill-thread-who" });
	head.createSpan({ text: role === "student" ? "You" : who });
	const text = toSpeechText(spoken);
	if (role === "tutor" && text && read) hearButton(head, text, "Read this aloud", read);
	return { el, body: el.createDiv({ cls: "grill-thread-text" }) };
}

/** The turn that stands in for a reply being written. Its status line is returned so
 * it can say what stage the reply is at, or be replaced by the reply as it arrives. */
export function waitingTurn(turns: HTMLElement, who: string, status: string): { el: HTMLElement; status: HTMLElement } {
	const el = turns.createDiv({ cls: "grill-thread-turn is-tutor is-waiting" });
	el.createDiv({ cls: "grill-thread-who", text: who });
	const line = el.createDiv({ cls: "grill-thread-text grill-meta", text: status });
	return { el, status: line };
}
