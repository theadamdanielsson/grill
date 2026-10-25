/** Chats: every saved conversation, newest first, searchable, each to open and carry on
 * with, rename or delete. */

import type { App, TFile } from "obsidian";
import { shortDate } from "../suggest";

export interface ChatsHost {
	app: App;
	/** The Learn folder, with a trailing slash: where the chats are kept. */
	dir: string;
	back(): void;
	open(file: TFile): void;
	rename(file: TFile, name: string): Promise<void>;
}

/** Draws the screen into `wrap`. */
export function drawChats(wrap: HTMLElement, host: ChatsHost): void {
	const screen = wrap.createDiv({ cls: "grill-body" });
	const header = screen.createDiv({ cls: "grill-meta-row grill-mgmt-header" });
	header.createSpan({ cls: "grill-score", text: "Chats" });
	const back = header.createSpan({ cls: "grill-chip-link", text: "Back" });
	back.onclick = () => host.back();
	const all = host.app.vault
		.getMarkdownFiles()
		.filter((f) => f.path.startsWith(host.dir))
		.sort((a, b) => b.stat.ctime - a.stat.ctime);
	const search = screen.createEl("input", { cls: "grill-mgmt-search", attr: { type: "search", placeholder: "Search chats...", "aria-label": "Search chats" } });
	const list = screen.createDiv({ cls: "grill-home-suggestions grill-chats" });
	const draw = (): void => {
		list.empty();
		const q = search.value.trim().toLowerCase();
		const shown = all
			.map((f) => {
				const fm = host.app.metadataCache.getFileCache(f)?.frontmatter;
				return { f, title: String(fm?.title ?? f.basename), note: String(fm?.note ?? ""), date: String(fm?.date ?? "") };
			})
			.filter((c) => !q || `${c.title} ${c.note}`.toLowerCase().includes(q))
			.slice(0, 100);
		if (!shown.length) {
			list.createDiv({ cls: "grill-meta", text: all.length ? "No chat matches that." : "No chats yet. What you talk about in Chat is kept here." });
			return;
		}
		for (const c of shown) {
			const item = list.createDiv({ cls: "grill-chat-item" });
			const row = item.createEl("button", { cls: "grill-home-suggestion", attr: { type: "button" } });
			const words = row.createSpan({ cls: "grill-home-suggestion-words" });
			words.createSpan({ cls: "grill-home-suggestion-label", text: c.title });
			words.createSpan({ cls: "grill-home-suggestion-detail", text: [c.note && c.note !== "Your notes" ? c.note : "Your notes", shortDate(c.date)].filter(Boolean).join(" · ") });
			row.onclick = () => host.open(c.f);
			const acts = item.createDiv({ cls: "grill-chat-actions" });
			const rename = acts.createEl("button", { cls: "grill-chip-link", text: "Rename", attr: { type: "button" } });
			const remove = acts.createEl("button", { cls: "grill-chip-link", text: "Delete", attr: { type: "button" } });
			rename.onclick = () => {
				row.hide();
				acts.hide();
				const input = item.createEl("input", { cls: "grill-mgmt-search", attr: { type: "text", "aria-label": "New name" } });
				input.value = c.title;
				input.focus();
				input.select();
				let done = false;
				const finish = async (keep: boolean): Promise<void> => {
					if (done) return;
					done = true;
					const name = input.value.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
					if (keep && name && name !== c.title) {
						await host.rename(c.f, name);
						// Obsidian reads the new title back a moment later.
						window.setTimeout(draw, 300);
					} else draw();
				};
				input.addEventListener("keydown", (e) => {
					if (e.key === "Enter") void finish(true);
					if (e.key === "Escape") void finish(false);
				});
				input.addEventListener("blur", () => void finish(true));
			};
			remove.onclick = () => {
				acts.empty();
				acts.createSpan({ cls: "grill-meta", text: "Delete this chat? " });
				const yes = acts.createEl("button", { cls: "grill-chip-link grill-chat-delete", text: "Delete", attr: { type: "button" } });
				const no = acts.createEl("button", { cls: "grill-chip-link", text: "Keep", attr: { type: "button" } });
				yes.onclick = async () => {
					await host.app.fileManager.trashFile(c.f);
					all.splice(all.indexOf(c.f), 1);
					draw();
				};
				no.onclick = () => draw();
			};
		}
	};
	search.addEventListener("input", draw);
	draw();
}
