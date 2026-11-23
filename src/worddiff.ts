/**
 * What changed between two texts, by word and by line. Pure, so it can be tested.
 * Used to show an edit before it is taken (see inlineedit.ts) and what a reply did to a
 * file (see screens/chat.ts).
 */

export interface DiffPart {
	kind: "same" | "removed" | "added";
	text: string;
}

/** Past this many cell comparisons the two are shown whole, one removed and one added:
 * a table that size is slow to fill and nobody reads a diff that long word by word. */
const MAX_CELLS = 4_000_000;

/** The longest run of pieces the two share, as removed, added and unchanged pieces in
 * order. What both start and end with is set aside first, so an edit in the middle of a
 * long text costs only its own size. */
export function diffPieces(a: string[], b: string[]): Array<{ kind: DiffPart["kind"]; piece: string }> {
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
	const out: Array<{ kind: DiffPart["kind"]; piece: string }> = [];
	for (let i = 0; i < head; i++) out.push({ kind: "same", piece: a[i] });
	const x = a.slice(head, a.length - tail);
	const y = b.slice(head, b.length - tail);
	const n = x.length;
	const m = y.length;
	if (n * m > MAX_CELLS) {
		for (const piece of x) out.push({ kind: "removed", piece });
		for (const piece of y) out.push({ kind: "added", piece });
	} else if (n || m) {
		// table[i][j]: how much x from i and y from j share.
		const width = m + 1;
		const table = new Uint32Array((n + 1) * width);
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				table[i * width + j] = x[i] === y[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
			}
		}
		let i = 0;
		let j = 0;
		while (i < n && j < m) {
			if (x[i] === y[j]) {
				out.push({ kind: "same", piece: x[i] });
				i++;
				j++;
			} else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) out.push({ kind: "removed", piece: x[i++] });
			else out.push({ kind: "added", piece: y[j++] });
		}
		while (i < n) out.push({ kind: "removed", piece: x[i++] });
		while (j < m) out.push({ kind: "added", piece: y[j++] });
	}
	for (let i = a.length - tail; i < a.length; i++) out.push({ kind: "same", piece: a[i] });
	return out;
}

/** Pieces of the same kind that follow each other, joined. */
function joined(pieces: Array<{ kind: DiffPart["kind"]; piece: string }>): DiffPart[] {
	const out: DiffPart[] = [];
	for (const p of pieces) {
		const last = out[out.length - 1];
		if (last && last.kind === p.kind) last.text += p.piece;
		else out.push({ kind: p.kind, text: p.piece });
	}
	return out;
}

/** The change from `before` to `after`, word by word. Spaces and line breaks are pieces
 * of their own, so joining every part that isn't "added" gives `before` back exactly,
 * and every part that isn't "removed" gives `after`. */
export function wordDiff(before: string, after: string): DiffPart[] {
	const words = (s: string): string[] => s.split(/(\s+)/).filter((w) => w !== "");
	return joined(diffPieces(words(before), words(after)));
}

export interface DiffLine {
	kind: "same" | "removed" | "added" | "gap";
	text: string;
}

/** The change from `before` to `after`, line by line, with `context` unchanged lines
 * kept around each change and the rest left out: a "gap" line says how many. */
export function lineDiff(before: string, after: string, context = 2): DiffLine[] {
	const lines = (s: string): string[] => (s === "" ? [] : s.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n"));
	const all = diffPieces(lines(before), lines(after));
	const keep = new Array<boolean>(all.length).fill(false);
	all.forEach((p, i) => {
		if (p.kind === "same") return;
		for (let k = Math.max(0, i - context); k <= Math.min(all.length - 1, i + context); k++) keep[k] = true;
	});
	const out: DiffLine[] = [];
	let skipped = 0;
	const flush = (): void => {
		if (skipped) out.push({ kind: "gap", text: skipped === 1 ? "1 line the same" : `${skipped} lines the same` });
		skipped = 0;
	};
	all.forEach((p, i) => {
		if (!keep[i]) {
			skipped++;
			return;
		}
		flush();
		out.push({ kind: p.kind, text: p.piece });
	});
	flush();
	// Nothing changed: say nothing, not "40 lines the same".
	return out.some((l) => l.kind === "removed" || l.kind === "added") ? out : [];
}

/** How many lines a change added and took away. */
export function lineCounts(before: string, after: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const l of lineDiff(before, after, 0)) {
		if (l.kind === "added") added++;
		else if (l.kind === "removed") removed++;
	}
	return { added, removed };
}
