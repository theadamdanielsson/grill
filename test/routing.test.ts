import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CONTAGION, MAX_ROUTES, SessionRouting, type RouteLookup } from "../src/routing";

/** Where a wrong answer sends the session next, and how often it may. */
function lookup(weak: Record<string, number>, links: Record<string, string[]>, planned: string[] = []): RouteLookup {
	return {
		prereqsOf: (n) => links[n] ?? [],
		inSession: (n) => n in weak,
		weakness: (n) => weak[n],
		conceptsOf: (n) => [{ id: `${n}::c`, note: n, label: "c" } as any],
		known: () => false,
		planned: new Set(planned),
	};
}

test("routes to the weakest prerequisite, then the one more of the session builds on", () => {
	const r = new SessionRouting();
	r.setGraph(["B", "C"], {});
	const look = lookup({ A: 0, B: 1, C: 1, D: 0 }, { A: ["C", "B", "D", "X"] });
	assert.equal(r.findPrerequisite("A", look)?.prereqNote, "D");
	const tie = lookup({ A: 0, B: 1, C: 1 }, { A: ["C", "B"] });
	assert.equal(r.findPrerequisite("A", tie)?.prereqNote, "B");
});

test("never a known, planned or already-routed prerequisite", () => {
	const r = new SessionRouting();
	assert.equal(r.findPrerequisite("A", lookup({ A: 0, K: 2 }, { A: ["K"] })), null);
	assert.equal(r.findPrerequisite("A", lookup({ A: 0, B: 0 }, { A: ["B"] }, ["B::c"])), null);
	const look = lookup({ A: 0, B: 0 }, { A: ["B"] });
	r.tookPrerequisite(r.findPrerequisite("A", look)!);
	assert.equal(r.findPrerequisite("A", look), null);
});

test("budgets run out, and a new session refills them", () => {
	const r = new SessionRouting();
	const notes = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`N${i}`, 0]));
	const look = lookup({ A: 0, ...notes }, { A: Object.keys(notes) });
	for (let i = 0; i < MAX_ROUTES; i++) r.tookPrerequisite(r.findPrerequisite("A", look)!);
	assert.equal(r.findPrerequisite("A", look), null);
	r.setGraph([], { A: { linksTo: Object.keys(notes), linkedFrom: [] } });
	for (let i = 0; i < MAX_CONTAGION; i++) r.tookContagion(r.findContagion("A", "tag", look)!);
	assert.equal(r.findContagion("A", "tag", look), null);
	r.resetBudget();
	assert.notEqual(r.findPrerequisite("A", look), null);
	assert.notEqual(r.findContagion("A", "tag", look), null);
	r.reset();
	assert.equal(r.findContagion("A", "tag", look), null); // no graph, no neighbours
});
