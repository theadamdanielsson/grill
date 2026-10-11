import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { SessionView } from "../src/view";

/** The record of what was answered, and how, is the part of Grill nothing else can
 * rebuild. These tests pin the three ways an answer is allowed to leave it: graded,
 * taken back, and corrected. A real SessionView over a stub plugin, renders off. */
function makeView() {
	const plugin = {
		data: {
			settings: { sounds: false, showProgress: false, desiredRetention: 90, easyDays: [] },
		},
		mastery: {} as Record<string, any>,
		concepts: {} as Record<string, any>,
		store: {
			saveConcepts: async () => undefined,
			saveMastery: async () => undefined,
			saveRegistry: async () => undefined,
			saveQuestionBank: async () => undefined,
			saveBridges: async () => undefined,
			saveEmbeddings: async () => undefined,
			loadInstructions: async () => ({ persona: "", preferences: "" }),
			hasReadProtected: () => false,
		},
		llmConfig: () => null,
		noteCloudSession: async () => 0,
		takeCloudSpend: () => 0,
		isExcluded: () => false,
		refreshStatusBar: () => undefined,
		persist: async () => undefined,
	};
	const app = { vault: { getMarkdownFiles: () => [], cachedRead: async () => "" } };
	const view = new SessionView({ app } as never, plugin as never) as any;
	view.renderStart = () => undefined;
	view.renderQuestion = () => undefined;
	view.renderLoading = () => undefined;
	view.renderFeedback = () => undefined;
	view.goToQuestion = async () => undefined;
	view.findWeakPrereq = () => undefined;
	return { view, plugin };
}

const ID = "N::a";

function seasoned(withLog: boolean): Record<string, unknown> {
	const cm: Record<string, unknown> = {
		note: "N",
		label: "a",
		kind: "term",
		sourceHash: null,
		correct: 2,
		partial: 0,
		incorrect: 0,
		streak: 2,
		stability: 6,
		difficulty: 5,
		lastSeen: "2026-09-20T10:00:00.000Z",
		dueAt: "2026-09-27T10:00:00.000Z",
	};
	if (withLog) cm.reviewLog = [{ t: "2026-09-20T10:00:00.000Z", elapsedDays: 3, rating: 3 }];
	return cm;
}

function question() {
	return {
		node: "N",
		question: "Q?",
		difficulty: "medium",
		modelAnswer: "A",
		acceptableAnswers: [],
		commonErrors: [],
		hints: { tier1: "", tier2: "", tier3: "" },
		conceptId: ID,
	};
}

function start(view: any, plugin: any, withLog = true) {
	view.concepts = plugin.concepts = { [ID]: seasoned(withLog) };
	view.liveState = true;
	const q = question();
	view.questions = [q];
	view.idx = 0;
	view.targetCount = 1;
	view.questionBank = {};
	return q;
}

/** A fixed clock, and a fixed pick where the scheduler breaks a tie between equally
 * free days at random, so two runs of the same answer land on the same due date. */
async function frozen(run: () => Promise<void>): Promise<void> {
	mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-10-10T12:00:00.000Z") });
	const random = mock.method(Math, "random", () => 0.5);
	try {
		await run();
	} finally {
		random.mock.restore();
		mock.timers.reset();
	}
}

for (const withLog of [true, false]) {
	test(`an answer taken back leaves the concept exactly as it was (${withLog ? "with" : "without"} a review log)`, () =>
		frozen(async () => {
			const { view, plugin } = makeView();
			const q = start(view, plugin, withLog);
			const before = structuredClone(view.concepts[ID]);

			await view.applyGrade(q, "incorrect", null, "mixes-up-x", 0);
			assert.notDeepEqual(view.concepts[ID], before);
			const r = { question: q.question, verdict: "incorrect" };
			view.results = [r];
			await view.discardAnsweredQuestion(r);

			assert.deepEqual(view.concepts[ID], before);
			assert.equal(plugin.mastery.N.incorrect, 0);
			assert.deepEqual(plugin.mastery.N.misconceptions, {});
			assert.equal(view.results.length, 0);
		}));
}

test("a message graded by mistake is taken back, and the question stays to be answered", () =>
	frozen(async () => {
		const { view, plugin } = makeView();
		const q = start(view, plugin, false);
		const before = structuredClone(view.concepts[ID]);
		view.questionBank = { [ID]: [{ question: q.question }] };

		await view.applyGrade(q, "incorrect", null, "mixes-up-x", 0);
		const r = { question: q.question, verdict: "incorrect" };
		view.results = [r];
		await view.takeBackAnswer(r);

		assert.deepEqual(view.concepts[ID], before);
		assert.equal(plugin.mastery.N.incorrect, 0);
		assert.deepEqual(plugin.mastery.N.misconceptions, {});
		assert.equal(view.results.length, 0);
		assert.equal(view.questions.length, 1);
		assert.equal(view.questionBank[ID][0].rejected, undefined);
		assert.equal(view.pendingOverride, null);
	}));

test("what was typed goes back in the box when it is taken back", () =>
	frozen(async () => {
		const { view, plugin } = makeView();
		const q = start(view, plugin);

		await view.applyGrade(q, "incorrect", null, undefined, 0);
		const answered = { question: q.question, verdict: "incorrect", answer: "what is this about?" };
		view.results = [answered];
		await view.takeBackAnswer(answered);
		assert.deepEqual(view.keptAnswer, { idx: 0, text: "what is this about?" });

		await view.applyGrade(q, "incorrect", null, undefined, 0);
		const asked = { question: q.question, verdict: "incorrect", answer: "", gaveUp: true, askedForHelp: true, discussion: [{ role: "student", text: "the multiplier?" }] };
		view.results = [asked];
		await view.takeBackAnswer(asked);
		assert.deepEqual(view.keptAnswer, { idx: 0, text: "the multiplier?" });
	}));

test("Mark correct ends where a correct answer would have", () =>
	frozen(async () => {
		const wrong = makeView();
		const q = start(wrong.view, wrong.plugin);
		await wrong.view.applyGrade(q, "incorrect", null, "mixes-up-x", 0);
		const r = { question: q.question, verdict: "incorrect", feedback: "", misconceptionTag: "mixes-up-x" };
		wrong.view.results = [r];
		await wrong.view.markCorrect(r);

		const right = makeView();
		const q2 = start(right.view, right.plugin);
		await right.view.applyGrade(q2, "correct", null, undefined, 0);

		assert.deepEqual(wrong.view.concepts[ID], right.view.concepts[ID]);
		assert.equal(wrong.plugin.mastery.N.correct, 1);
		assert.equal(wrong.plugin.mastery.N.incorrect, 0);
		assert.deepEqual(wrong.plugin.mastery.N.misconceptions, {});
		assert.equal(r.verdict, "correct");
	}));

test("a redo changes nothing in the record", () =>
	frozen(async () => {
		const { view, plugin } = makeView();
		const q = start(view, plugin);
		const before = structuredClone(view.concepts[ID]);
		view.replayMode = true;

		await view.applyGrade(q, "incorrect", null, "mixes-up-x", 0);

		assert.deepEqual(view.concepts[ID], before);
		assert.deepEqual(plugin.mastery, {});
	}));

test("taking an answer back takes its confidence point and its resolved misconception with it", () =>
	frozen(async () => {
		const { view, plugin } = makeView();
		const q = start(view, plugin);
		plugin.data.calibration = [{ c: 0.5, ok: 1 }];
		view.registry = { tag: { tag: "tag", label: "x", aliases: [], notes: ["N"], count: 2, firstSeen: "a", lastSeen: "b", status: "active" } };

		await view.applyGrade(q, "correct", null, undefined, 0);
		view.pendingConfidence = 1;
		view.captureConfidence("correct");
		view.pendingOverride.resolved = { tag: "tag", status: "active", lastSeen: "b" };
		view.registry.tag.status = "resolved";
		assert.equal(plugin.data.calibration.length, 2);

		const r = { question: q.question, verdict: "correct", answer: "" };
		view.results = [r];
		await view.takeBackAnswer(r);

		assert.deepEqual(plugin.data.calibration, [{ c: 0.5, ok: 1 }]);
		assert.deepEqual([view.registry.tag.status, view.registry.tag.lastSeen], ["active", "b"]);
	}));
