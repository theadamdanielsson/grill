/** The plugin's two small pop-ups: picking a saved prompt, and agreeing to use a model. */

import type GrillPlugin from "./main";
import { App, FuzzySuggestModal, Modal, TFile } from "obsidian";

/** The saved prompts by name, to pick one from. */
export class SavedPromptModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private prompts: TFile[],
		private picked: (prompt: TFile) => void | Promise<void>,
	) {
		super(app);
		this.setPlaceholder("Saved prompt");
	}
	getItems(): TFile[] {
		return this.prompts;
	}
	getItemText(prompt: TFile): string {
		return prompt.basename;
	}
	onChooseItem(prompt: TFile): void {
		void this.picked(prompt);
	}
}

/** Asked once of someone who used Grill without AI before 8.0 and has a key saved:
 * whether that model may now be used. Until they say yes, nothing is sent. */
export class ModelAgreeModal extends Modal {
	private static up: ModelAgreeModal | null = null;

	static show(plugin: GrillPlugin, provider: string): void {
		if (ModelAgreeModal.up) return;
		new ModelAgreeModal(plugin, provider).open();
	}

	private constructor(
		private plugin: GrillPlugin,
		private provider: string,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		ModelAgreeModal.up = this;
		this.titleEl.setText("Grill 8 uses a model");
		this.contentEl.createEl("p", { text: `The mode without AI was removed in 8.0. From here on, Chat and tests send your notes to ${this.provider}.` });
		this.contentEl.createEl("p", { text: "Your schedule and your questions are kept." });
		const row = this.contentEl.createDiv({ cls: "modal-button-container" });
		const yes = row.createEl("button", { cls: "mod-cta", text: `Use ${this.provider}` });
		yes.onclick = () => {
			this.plugin.data.settings.modelAgreed = true;
			void this.plugin.persist();
			this.close();
		};
		row.createEl("button", { text: "Not now" }).onclick = () => this.close();
	}

	onClose(): void {
		ModelAgreeModal.up = null;
		this.contentEl.empty();
	}
}
