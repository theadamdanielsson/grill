import { test } from "node:test";
import assert from "node:assert/strict";
import { optimalInterval, retrievability } from "../src/mastery";

test("optimalInterval is the day recall reaches the target on the FSRS-6 curve", () => {
	for (const target of [0.7, 0.8, 0.85, 0.9, 0.95]) {
		for (const s of [2, 10, 40]) {
			const days = optimalInterval(s, target);
			// Rounded to whole days: recall on that day is within a day's worth of the target.
			assert.ok(Math.abs(retrievability(s, days) - target) < 0.02, `S=${s} R=${target} -> ${days}d`);
		}
	}
	// 90% is where stability is defined, so the interval is the stability itself.
	assert.equal(optimalInterval(10, 0.9), 10);
	// A lower target waits longer than the old FSRS-4.5 formula did.
	assert.ok(optimalInterval(10, 0.85) > Math.round(9 * 10 * (1 / 0.85 - 1)));
});

import { trueRetentionLine, type ConceptMap } from "../src/concepts";

function vault(ratings: Array<[number, number]>): ConceptMap {
	// One concept per review: a first exposure, then the review being counted.
	const out: Record<string, unknown> = {};
	ratings.forEach(([elapsedDays, rating], i) => {
		out[`c${i}`] = { reviewLog: [{ t: "2026-11-01T00:00:00Z", elapsedDays: 0, rating: 3 }, { t: "2026-11-05T00:00:00Z", elapsedDays, rating }] };
	});
	return out as ConceptMap;
}

test("true retention points the right way and ignores same-day relearns", () => {
	const under = vault([...Array(14).fill([4, 3]), ...Array(6).fill([4, 1])]); // 70%
	assert.match(trueRetentionLine(under, 90), /under your 90% target.*more intense/);
	const over = vault(Array(20).fill([4, 3])); // 100%
	assert.match(trueRetentionLine(over, 85), /above your 85% target.*more relaxed/);
	// 20 due reviews all passed, plus 10 same-day relearn misses: still 100%.
	const withRelearns = vault([...Array(20).fill([4, 3]), ...Array(10).fill([0.01, 1])]);
	assert.match(trueRetentionLine(withRelearns, 90), /100% across your last 20 reviews/);
});
