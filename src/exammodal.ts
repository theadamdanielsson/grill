/** The window for one exam: its date, and the folders it covers as a tree of
 * checkboxes. Whole vault sits at the top; a folder ticks with everything inside it,
 * and unticking a folder inside a ticked one leaves it out. */

import { App, Modal, Notice } from "obsidian";
import { daysLeft, examDay, folderState, tickFolder, type Exam } from "./exams";

export class ExamModal extends Modal {
	private folders: string[];
	private date: string;

	constructor(
		app: App,
		/** The vault's folders Grill can study, by path. */
		private all: string[],
		exam: Exam | null,
		private onSave: (exam: Exam) => void,
	) {
		super(app);
		this.folders = exam ? [...exam.folders] : [];
		this.date = exam?.date ?? "";
	}

	onOpen(): void {
		this.modalEl.addClass("grill-exam-modal");
		this.titleEl.setText("Exam");
		const when = this.contentEl.createDiv({ cls: "grill-exam-date" });
		when.createSpan({ text: "Date" });
		const input = when.createEl("input", { type: "date" });
		const now = new Date();
		const pad = (n: number): string => String(n).padStart(2, "0");
		// The picker offers nothing before today; Save checks it too, for a typed date.
		input.min = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
		input.value = this.date;
		input.oninput = () => (this.date = input.value);
		this.contentEl.createDiv({ cls: "grill-exam-hint", text: "What it covers" });
		const tree = this.contentEl.createDiv({ cls: "grill-exam-tree" });
		const draw = (): void => {
			tree.empty();
			for (const f of ["", ...this.all]) {
				const row = tree.createEl("label", { cls: "grill-exam-folder" });
				row.setCssProps({ "--grill-depth": String(f === "" ? 0 : f.split("/").length) });
				const box = row.createEl("input", { type: "checkbox" });
				const state = folderState(this.folders, f, this.all);
				box.checked = state === "on";
				box.indeterminate = state === "partial";
				box.onchange = () => {
					this.folders = tickFolder(this.folders, f, box.checked, this.all);
					draw();
				};
				row.createSpan({ text: f === "" ? "Whole vault" : f.slice(f.lastIndexOf("/") + 1) });
			}
		};
		draw();
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { cls: "mod-cta", text: "Save" }).onclick = () => {
			if (!examDay(this.date)) return void new Notice("Grill: pick the exam date.");
			if (daysLeft({ folders: [], date: this.date }, new Date()) < 0) return void new Notice("Grill: the exam date has passed. Pick today or a later day.");
			if (!this.folders.length) return void new Notice("Grill: tick what the exam covers.");
			this.onSave({ folders: this.folders, date: this.date });
			this.close();
		};
		buttons.createEl("button", { text: "Cancel" }).onclick = () => this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
