/** The grill-documents block in the Instructions note: the attached reference documents,
 * listed with a remove button each, under a drop zone that adds more. */

import { Notice } from "obsidian";
import { GrillStore } from "./store";

/** Draws the block into `el`, from the list on disk: the block's own text is not trusted,
 * since it is redrawn after every add and remove. */
export function renderDocumentsBlock(el: HTMLElement, store: GrillStore): void {
	const root = el.createDiv({ cls: "grill-doc-area" });
	const listEl = root.createDiv({ cls: "grill-doc-list" });

	const renderList = (files: string[]) => {
		listEl.empty();
		if (!files.length) {
			listEl.createEl("p", { cls: "grill-meta grill-doc-empty", text: "No documents attached yet." });
			return;
		}
		for (const name of files) {
			const row = listEl.createDiv({ cls: "grill-doc-row" });
			row.createSpan({ cls: "grill-doc-name", text: name });
			const remove = row.createEl("button", { cls: "grill-doc-remove clickable-icon", attr: { "aria-label": `Remove ${name}` } });
			remove.setText("✕");
			remove.onclick = () => {
				void (async () => {
					remove.disabled = true;
					const files2 = await store.removeReferenceDoc(name, true);
					new Notice(`Grill: removed "${name}".`);
					renderList(files2);
				})();
			};
		}
	};

	const handleFiles = (picked: FileList | null) => {
		if (!picked || !picked.length) return;
		void (async () => {
			dropzone.addClass("is-busy");
			status.setText("Adding…");
			let files: string[] = await store.listReferenceDocNames();
			let added = 0;
			const errors: string[] = [];
			for (let i = 0; i < picked.length; i++) {
				const f = picked[i];
				// Client-side size/count checks fail fast, before spending time reading the
				// file into memory — addReferenceDoc enforces the same two limits itself
				// (that's the real gate; this is just so a big or extra file doesn't sit
				// there "adding" for a few seconds before being rejected).
				if (files.length >= GrillStore.MAX_REFERENCE_DOCS) {
					errors.push(`stopped at the ${GrillStore.MAX_REFERENCE_DOCS}-document limit (${picked.length - i} not added)`);
					break;
				}
				if (f.size > GrillStore.MAX_REFERENCE_DOC_BYTES) {
					errors.push(`"${f.name}" is over the ${(GrillStore.MAX_REFERENCE_DOC_BYTES / (1024 * 1024)).toFixed(0)} MB limit`);
					continue;
				}
				try {
					const bytes = await f.arrayBuffer();
					const result = await store.addReferenceDoc(bytes, f.name);
					files = result.files;
					added++;
				} catch (e) {
					console.error(`Grill: couldn't add reference document "${f.name}"`, e);
					errors.push(e instanceof Error ? e.message : `"${f.name}" couldn't be added`);
				}
			}
			dropzone.removeClass("is-busy");
			status.setText("Drop PDFs here, or click to browse");
			renderList(files);
			if (added === 1 && !errors.length) new Notice(`Grill: added "${picked[0].name}".`);
			else if (added) new Notice(`Grill: added ${added} document${added === 1 ? "" : "s"}.`);
			for (const msg of errors) new Notice(`Grill: ${msg}.`, 8000);
		})();
	};

	const dropzone = root.createDiv({ cls: "grill-doc-dropzone", attr: { tabindex: "0", role: "button" } });
	dropzone.createSpan({ cls: "grill-doc-dropzone-icon", text: "+" });
	const status = dropzone.createSpan({ cls: "grill-doc-dropzone-text", text: "Drop PDFs here, or click to browse" });
	dropzone.createSpan({
		cls: "grill-doc-dropzone-caption",
		text: `PDF only · up to ${(GrillStore.MAX_REFERENCE_DOC_BYTES / (1024 * 1024)).toFixed(0)} MB each · ${GrillStore.MAX_REFERENCE_DOCS} documents max`,
	});
	const input = dropzone.createEl("input", {
		cls: "grill-doc-input",
		attr: { type: "file", accept: ".pdf", multiple: true },
	});
	dropzone.onclick = () => input.click();
	dropzone.onkeydown = (e) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			input.click();
		}
	};
	input.onclick = (e) => e.stopPropagation();
	input.onchange = () => handleFiles(input.files);
	dropzone.ondragover = (e) => {
		e.preventDefault();
		dropzone.addClass("is-dragover");
	};
	dropzone.ondragleave = () => dropzone.removeClass("is-dragover");
	dropzone.ondrop = (e) => {
		e.preventDefault();
		dropzone.removeClass("is-dragover");
		handleFiles(e.dataTransfer?.files ?? null);
	};

	void store.listReferenceDocNames().then(renderList);
}
