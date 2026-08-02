/** Extract text from PDFs a note embeds, so a `![[worksheet.pdf]]` isn't invisible
 * to Grill the way it is to a plain text reader — the PDF's real content becomes
 * part of the note's text, feeding the same structural parser and AI prompt as
 * anything typed directly into the note. A bonus feature: any failure (a corrupt
 * or password-protected PDF, an unresolvable embed) is swallowed per-file so it
 * never breaks a session — the note just falls back to whatever text it already had.
 *
 * Reads via Obsidian's own `loadPdfJs()` (docs.obsidian.md/Reference/TypeScript+API/
 * loadPdfJs) — the same pdf.js instance its native PDF viewer uses, lazy-loaded and
 * fully worker/cmap/font-configured by Obsidian itself. No bundled pdfjs-dist copy,
 * no worker to inline: this plugin never ships pdf.js at all. Precedent: PDF++
 * (github.com/RyotaUshio/obsidian-pdf-plus) reads Obsidian's copy the same way. */

import { App, loadPdfJs, TFile } from "obsidian";

/** Ceiling on pages read per PDF — a safety valve against someone embedding an
 * entire textbook, not a token-budget cap (that's NOTE_CHAR_CAP in view.ts, applied
 * uniformly to a note's combined text after this runs). Parsing is local/CPU-only,
 * so this is generous. */
const MAX_PAGES_PER_PDF = 40;
/** A note embedding more than a couple of PDFs is rare and each one is a real
 * parse cost; bound it defensively. */
const MAX_PDFS_PER_NOTE = 2;

async function extractPdfText(bytes: ArrayBuffer, label: string): Promise<string> {
	try {
		const pdfjsLib = await loadPdfJs();
		const doc = await pdfjsLib.getDocument({
			data: new Uint8Array(bytes),
			cMapPacked: true,
			cMapUrl: "/lib/pdfjs/cmaps/",
			standardFontDataUrl: "/lib/pdfjs/standard_fonts/",
		}).promise;
		const pages: string[] = [];
		const pageCount = Math.min(doc.numPages, MAX_PAGES_PER_PDF);
		for (let i = 1; i <= pageCount; i++) {
			const page = await doc.getPage(i);
			const content = await page.getTextContent();
			// hasEOL is pdf.js's own line-break signal from the PDF's layout — joining on
			// it recovers real paragraph/line structure (so downstream chunking can find
			// a sane per-chunk label) instead of flattening a whole page into one line.
			const text = content.items
				.map((it: { str?: string; hasEOL?: boolean }) => (it.str ?? "") + (it.hasEOL ? "\n" : " "))
				.join("")
				.trim();
			if (text) pages.push(text);
		}
		// An HTML comment, not a plain line: extractConcepts already strips comments
		// before parsing (same convention itemsForNote uses), so this attribution stays
		// readable in the raw text but can never get picked up as a chunk's label the
		// way a plain leading line would.
		return pages.length ? `<!-- From the PDF "${label}" -->\n\n${pages.join("\n\n")}` : "";
	} catch (e) {
		console.error(`Grill: couldn't extract text from PDF "${label}"`, e);
		return ""; // corrupt, encrypted, or unparseable; the note falls back to its own text
	}
}

/** Text extracted from the PDFs a note embeds, concatenated, or "" if it embeds
 * none (or none could be read). Meant to be appended to the note's own markdown
 * text before that combined text goes through extraction/truncation, so PDF
 * content is genuinely just more text to Grill, not a separate special case. */
export async function collectNotePdfText(app: App, file: TFile): Promise<string> {
	const embeds = app.metadataCache.getFileCache(file)?.embeds ?? [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const e of embeds) {
		if (out.length >= MAX_PDFS_PER_NOTE) break;
		const dest = app.metadataCache.getFirstLinkpathDest(e.link, file.path);
		if (!dest || dest.extension.toLowerCase() !== "pdf" || seen.has(dest.path)) continue;
		seen.add(dest.path);
		try {
			const bytes = await app.vault.readBinary(dest);
			const text = await extractPdfText(bytes, dest.basename);
			if (text) out.push(text);
		} catch (e) {
			console.error(`Grill: couldn't read PDF attachment "${dest.basename}"`, e);
		}
	}
	return out.join("\n\n");
}
