/**
 * Pictures in Chat. One pasted or dropped into the box is saved in the vault as an
 * attachment and embedded in the message, the way Obsidian does it in a note; when
 * the message is sent, the pictures embedded in it go to the model with it.
 */

import { Notice, type App } from "obsidian";
import { encode, IMG_EXT, MEDIA, type ImageInput } from "./images";

const EXT_OF: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** The pictures a message embeds, as the links it writes them with, in order and once
 * each: `![[name.png]]`, `![[name.png|300]]` and `![alt](path.png)`. */
export function embeddedImageLinks(text: string): string[] {
	const out: string[] = [];
	const add = (link: string): void => {
		const clean = link.trim();
		const ext = clean.split(".").pop()?.toLowerCase() ?? "";
		if (clean && IMG_EXT.has(ext) && !out.includes(clean)) out.push(clean);
	};
	for (const m of text.matchAll(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]|!\[[^\]]*\]\(([^)\s]+)\)/g)) {
		if (m[1]) add(m[1]);
		else if (m[2] && !/^[a-z][a-z0-9+.-]*:/i.test(m[2])) add(decodeURIComponent(m[2].replace(/^<|>$/g, "")));
	}
	return out;
}

/** Where each picture a message embeds is in the vault. */
export function imagePaths(app: App, text: string, sourcePath: string): string[] {
	const out: string[] = [];
	for (const link of embeddedImageLinks(text)) {
		const dest = app.metadataCache.getFirstLinkpathDest(link, sourcePath);
		if (dest && !out.includes(dest.path)) out.push(dest.path);
	}
	return out;
}

/** The pictures the messages embed, read and made small enough to send: the latest
 * message's first, `cap` at most. */
export async function collectTextImages(app: App, texts: string[], sourcePath: string, cap: number): Promise<ImageInput[]> {
	const out: ImageInput[] = [];
	const seen = new Set<string>();
	for (const text of [...texts].reverse()) {
		for (const path of imagePaths(app, text, sourcePath)) {
			if (out.length >= cap) return out;
			if (seen.has(path)) continue;
			seen.add(path);
			try {
				const bytes = await app.vault.adapter.readBinary(path);
				if (bytes.byteLength > 12_000_000) continue;
				const ext = path.split(".").pop()?.toLowerCase() ?? "";
				out.push({ ...(await encode(bytes, MEDIA[ext] ?? "image/png")), path });
			} catch {
				// A picture that can't be read is left out; the message still goes.
			}
		}
	}
	return out;
}

/** Let pictures be pasted or dropped into a message box. Each is saved where the
 * vault keeps attachments and embedded where the cursor is. */
export function attachImagePaste(app: App, input: HTMLTextAreaElement, sourcePath: () => string): void {
	const insert = (text: string): void => {
		const at = input.selectionStart ?? input.value.length;
		const end = input.selectionEnd ?? at;
		const before = input.value.slice(0, at);
		const lead = before && !/\s$/.test(before) ? " " : "";
		input.value = `${before}${lead}${text} ${input.value.slice(end)}`;
		const pos = before.length + lead.length + text.length + 1;
		input.setSelectionRange(pos, pos);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.focus();
	};
	const take = async (files: File[]): Promise<void> => {
		for (const file of files) {
			const ext = EXT_OF[file.type];
			if (!ext) continue;
			try {
				const named = file.name && !/^image\.\w+$/i.test(file.name) ? file.name.replace(/\.\w+$/, "") : `Pasted image ${stamp()}`;
				const path = await app.fileManager.getAvailablePathForAttachment(`${named}.${ext}`, sourcePath());
				await app.vault.createBinary(path, await file.arrayBuffer());
				insert(`![[${path.split("/").pop()}]]`);
			} catch (e) {
				new Notice(`Grill: couldn't save the picture. ${(e as Error)?.message ?? ""}`.trim(), 8000);
			}
		}
	};
	const pictures = (list: DataTransfer | null): File[] => Array.from(list?.files ?? []).filter((f) => f.type in EXT_OF);
	input.addEventListener("paste", (e) => {
		const files = pictures(e.clipboardData);
		if (!files.length) return;
		e.preventDefault();
		void take(files);
	});
	input.addEventListener("dragover", (e) => {
		if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
	});
	input.addEventListener("drop", (e) => {
		const files = pictures(e.dataTransfer);
		if (!files.length) return;
		e.preventDefault();
		e.stopPropagation();
		void take(files);
	});
}

function stamp(): string {
	const d = new Date();
	const two = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}
