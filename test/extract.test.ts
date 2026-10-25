import { test } from "node:test";
import assert from "node:assert/strict";
import { extractConcepts } from "../src/generate-local";

const labels = (text: string) => extractConcepts("N", text, "mixed").map((c) => `${c.kind}:${c.label}`);

test("prices are not formulas, and real inline maths still is", () => {
	const money = labels("# Loss aversion\nPeople turn down a coin flip that wins $150 or loses $100, even though it pays on average.");
	assert.ok(!money.some((l) => l.startsWith("formula:")), money.join(", "));
	const maths = labels("# Okun\nThe law reads $u_t - u_{t-1} = -\\beta(g_t - \\bar g)$ in the course's notation.");
	assert.ok(maths.some((l) => l.startsWith("formula:")), maths.join(", "));
});

test("a line recording who was there or where a note came from is not a concept", () => {
	const got = labels("# Q4 planning\n**Attendees:** Sara, Marco, Lina and me\n**Source:** the shared planning doc from Monday\n**Decision:** we drop the mobile redesign from Q4 to fix checkout first.");
	assert.ok(!got.some((l) => /Attendees|Source/.test(l)), got.join(", "));
	assert.ok(got.some((l) => l.includes("Decision")), got.join(", "));
});

test("a heading over nothing but who was there is not a concept", () => {
	const got = labels("# Q4 planning, 14 Oct\nAttendees: Sara, Marco, Lina, me\n\n## Decisions\n- We drop the mobile redesign from Q4, because the checkout bugs cost more.");
	assert.ok(!got.includes("heading:Q4 planning, 14 Oct"), got.join(", "));
	assert.ok(got.includes("heading:Decisions"), got.join(", "));
});
