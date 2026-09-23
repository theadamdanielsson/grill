/** Stands in for tesseract.js / @huggingface/transformers in tests: both pull in
 * WASM runtimes that don't load under node, and no test exercises them. */
export function createWorker(): never {
	throw new Error("OCR is not available in tests");
}
export function pipeline(): never {
	throw new Error("embeddings are not available in tests");
}
export const env = {};
export default {};
