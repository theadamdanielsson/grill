/** Resolve the images a note embeds into inputs a vision model can read.
 *
 * A text model only sees `![[chart.png]]` as a link, so anything that lives in
 * the picture is invisible to it. This pulls the actual image out of the vault,
 * downscales it to keep token cost down, and hands it back base64-encoded. */

import { App, TFile } from "obsidian";

export interface ImageInput {
	mediaType: string;
	dataBase64: string;
}

const IMG_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const MEDIA: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
};

function toBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let bin = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(bin);
}

function loadImage(url: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("image decode failed"));
		img.src = url;
	});
}

/** Downscale to a sane edge length and re-encode, so a 4000px screenshot doesn't
 * cost a fortune in image tokens. Falls back to the raw bytes on any failure. */
async function encode(bytes: ArrayBuffer, mediaType: string, maxEdge = 1400): Promise<ImageInput> {
	try {
		const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
		try {
			const img = await loadImage(url);
			const longest = Math.max(img.width, img.height);
			if (longest <= maxEdge && bytes.byteLength < 700_000) {
				return { mediaType, dataBase64: toBase64(bytes) };
			}
			const scale = Math.min(1, maxEdge / longest);
			const w = Math.max(1, Math.round(img.width * scale));
			const h = Math.max(1, Math.round(img.height * scale));
			const canvas = document.createElement("canvas");
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext("2d");
			if (!ctx) return { mediaType, dataBase64: toBase64(bytes) };
			ctx.drawImage(img, 0, 0, w, h);
			const data = canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
			return data ? { mediaType: "image/jpeg", dataBase64: data } : { mediaType, dataBase64: toBase64(bytes) };
		} finally {
			URL.revokeObjectURL(url);
		}
	} catch {
		return { mediaType, dataBase64: toBase64(bytes) };
	}
}

/** Raster images a note embeds, resolved to vault files and encoded. Capped by count. */
export async function collectNoteImages(app: App, file: TFile, cap: number): Promise<ImageInput[]> {
	if (cap <= 0) return [];
	const embeds = app.metadataCache.getFileCache(file)?.embeds ?? [];
	const out: ImageInput[] = [];
	const seen = new Set<string>();
	for (const e of embeds) {
		if (out.length >= cap) break;
		const dest = app.metadataCache.getFirstLinkpathDest(e.link, file.path);
		if (!dest) continue;
		const ext = dest.extension.toLowerCase();
		if (!IMG_EXT.has(ext) || seen.has(dest.path)) continue;
		seen.add(dest.path);
		try {
			const bytes = await app.vault.readBinary(dest);
			if (bytes.byteLength > 12_000_000) continue; // skip enormous originals
			out.push(await encode(bytes, MEDIA[ext] ?? "image/png"));
		} catch {
			/* unreadable attachment; skip */
		}
	}
	return out;
}
