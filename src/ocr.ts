/** Local, offline text detection inside note-embedded images — what makes image
 * occlusion (see view.ts's appendOcclusionConcepts) possible without an AI key or a
 * vision model. tesseract.js runs the actual recognition entirely on-device (no image
 * or note content is ever sent anywhere); only the OCR engine itself (~10MB: a small
 * WASM binary plus an English language model) fetches from a CDN once per device on
 * first use, the same one-time-download shape as a spell-check dictionary, not a
 * per-question network call. Everything after that first fetch is offline.
 *
 * This replaced an earlier design where a vision-capable LLM was asked to *guess*
 * pixel coordinates worth redacting — dogfooding found that too imprecise to ship
 * (see the removed appendOcclusionConcepts comment in view.ts's history). OCR sidesteps
 * the guessing entirely: a detected word/line's bounding box is exactly where that text
 * sits, and the box's own recognized text doubles as a fully deterministic answer — no
 * model call needed to grade it either, unlike the vision-LLM version this replaces. */

import { createWorker, type Worker as TesseractWorker } from "tesseract.js";
import { ImageInput, loadImage } from "./images";

export interface OcclusionRegion {
	x: number;
	y: number;
	w: number;
	h: number;
	label: string;
}

/** Lines below this confidence are reliably the axis ticks, gridlines, and stray
 * OCR noise a rendered chart is full of, not real labels — see ocr-quality notes:
 * on real embedded graphs, genuine captions/labels scored 82-96 and every artifact
 * (tick marks, bare gridline glyphs, arrow shafts) scored under 70, with a clean gap
 * in between. 80 sits in that gap with margin on both sides. */
const MIN_LINE_CONFIDENCE = 80;
const MIN_LABEL_LENGTH = 4;
/** At most this many regions per image — mirrors the vision-LLM version's own
 * "1-3 regions" instruction; a chart with many high-confidence labels should still
 * only ask about its most legible ones, not turn into a transcription exercise. */
const MAX_REGIONS_PER_IMAGE = 3;

let worker: TesseractWorker | null = null;
let workerInit: Promise<TesseractWorker> | null = null;

function getWorker(): Promise<TesseractWorker> {
	if (worker) return Promise.resolve(worker);
	if (!workerInit) {
		workerInit = createWorker("eng").then((w) => {
			worker = w;
			return w;
		});
	}
	return workerInit;
}

/** Release the OCR worker's resources (its own WASM instance + Worker thread).
 * Safe to call even if OCR was never used. */
export async function terminateOcrWorker(): Promise<void> {
	const w = worker;
	worker = null;
	workerInit = null;
	if (w) await w.terminate();
}

function isRealLabel(text: string): boolean {
	const t = text.trim();
	if (t.length < MIN_LABEL_LENGTH) return false;
	// At least a couple of letters somewhere — filters out lines that are pure
	// axis numbers, operators, or a single-letter OCR artifact riding a real
	// confidence score by accident.
	return (t.match(/[A-Za-z]/g)?.length ?? 0) >= 2;
}

/** Detect the most legible text regions in a note-embedded image, for use as image
 * occlusion targets. Returns normalized (0-1) boxes so the caller doesn't need to know
 * the resolution `img` was captured/downscaled at — see renderOcclusionImage, which
 * draws these fractions over the image at whatever size it actually renders. */
export async function detectOcclusionRegions(img: ImageInput): Promise<OcclusionRegion[]> {
	const dataUrl = `data:${img.mediaType};base64,${img.dataBase64}`;
	const dims = await loadImage(dataUrl);
	const width = dims.naturalWidth;
	const height = dims.naturalHeight;
	if (!width || !height) return [];

	const w = await getWorker();
	const { data } = await w.recognize(dataUrl, {}, { blocks: true, text: false });

	const lines: { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[] = [];
	for (const block of data.blocks ?? []) {
		for (const para of block.paragraphs) {
			for (const line of para.lines) lines.push(line);
		}
	}

	return lines
		.filter((l) => l.confidence >= MIN_LINE_CONFIDENCE && isRealLabel(l.text))
		.sort((a, b) => b.confidence - a.confidence)
		.slice(0, MAX_REGIONS_PER_IMAGE)
		.map((l) => ({
			x: l.bbox.x0 / width,
			y: l.bbox.y0 / height,
			w: (l.bbox.x1 - l.bbox.x0) / width,
			h: (l.bbox.y1 - l.bbox.y0) / height,
			label: l.text.trim(),
		}));
}
