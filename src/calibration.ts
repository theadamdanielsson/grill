/** Metacognitive calibration (single-user): how well the student's stated
 * confidence tracks whether they were actually right. A rolling Brier score plus a
 * directional bias surface "you tend to be overconfident" once there is enough data.
 * Opt-in: points are only collected when the confidence check setting is on.
 */

/** One graded answer's calibration point: stated confidence 0..1 and outcome
 * (1 correct, 0.5 partial, 0 incorrect). */
export interface CalPoint {
	c: number;
	ok: number;
}

/** Confidence levels offered in the UI, each mapped to a probability. */
export const CONFIDENCE_LEVELS: { label: string; value: number }[] = [
	{ label: "Sure", value: 0.9 },
	{ label: "Think so", value: 0.6 },
	{ label: "Guessing", value: 0.3 },
];

/** True when a stored value is a usable calibration point (guards loaded data).
 * Requires finite, in-range numbers so a hand-corrupted data.json can't poison the
 * Brier/bias arithmetic with NaN or out-of-range values. */
export function isCalPoint(v: unknown): v is CalPoint {
	const p = v as CalPoint | null;
	if (!p || typeof p.c !== "number" || typeof p.ok !== "number") return false;
	return Number.isFinite(p.c) && Number.isFinite(p.ok) && p.c >= 0 && p.c <= 1 && p.ok >= 0 && p.ok <= 1;
}

/** Append a point to the buffer. Unbounded: a couple thousand {c,ok} pairs is
 * nothing byte-wise, and a hard cap made the summary's "last N" freeze at the cap
 * forever for any regular user, which read as calibration "stopping" once you'd
 * answered enough confidence-tracked questions. */
export function pushCalibration(buf: CalPoint[], c: number, ok: number): void {
	buf.push({ c, ok });
}

export interface CalibrationSummary {
	n: number;
	brier: number;
	/** + = overconfident (confidence ran ahead of accuracy), - = underconfident. */
	bias: number;
	signal: "overconfident" | "underconfident" | "well-calibrated";
}

/** Brier score (mean squared error of confidence vs outcome) and directional bias.
 * Returns null until there are at least `minN` points, so a couple of answers can't
 * label you. */
export function calibrationSummary(buf: CalPoint[], minN = 10): CalibrationSummary | null {
	if (buf.length < minN) return null;
	let se = 0;
	let sumC = 0;
	let sumOk = 0;
	for (const p of buf) {
		se += (p.c - p.ok) ** 2;
		sumC += p.c;
		sumOk += p.ok;
	}
	const n = buf.length;
	const bias = (sumC - sumOk) / n;
	const signal = bias > 0.1 ? "overconfident" : bias < -0.1 ? "underconfident" : "well-calibrated";
	return { n, brier: se / n, bias, signal };
}

/** One-line human summary for the session debrief, or "" when there's not enough
 * data yet (fewer than the minimum points). */
export function calibrationLine(buf: CalPoint[]): string {
	const s = calibrationSummary(buf);
	if (!s) return "";
	const pct = Math.round(Math.abs(s.bias) * 100);
	if (s.signal === "overconfident")
		return `Calibration: across your last ${s.n} answers you lean overconfident, by about ${pct} points. Trust a shaky "sure" less.`;
	if (s.signal === "underconfident")
		return `Calibration: across your last ${s.n} answers you lean underconfident, by about ${pct} points. You know more than you credit.`;
	return `Calibration: across your last ${s.n} answers your confidence matches your accuracy well.`;
}
