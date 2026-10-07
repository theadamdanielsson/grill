import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { notices } from "obsidian";
import { SessionView } from "../src/view";

/** A real SessionView over a stub plugin whose store records every save. Render
 * methods are replaced with counters: these tests are about what gets saved when,
 * not about the DOM. */
function makeView(opts: { failSaves?: number; readProtected?: boolean } = {}) {
	const saves: Array<{ what: string; data: unknown }> = [];
	let failuresLeft = opts.failSaves ?? 0;
	const save = (what: string) => async (data: unknown) => {
		if (failuresLeft > 0) {
			failuresLeft--;
			throw new Error("disk full");
		}
		saves.push({ what, data: JSON.parse(JSON.stringify(data)) });
	};
	const plugin = {
		data: { settings: { gradingMode: "self", questionSource: "local", sounds: false, showProgress: false } },
		mastery: {},
		concepts: {},
		store: {
			saveConcepts: save("concepts"),
			saveMastery: save("mastery"),
			saveRegistry: save("registry"),
			saveQuestionBank: save("bank"),
			saveBridges: save("bridges"),
			saveEmbeddings: save("embeddings"),
			loadInstructions: async () => ({ persona: "", preferences: "" }),
			hasReadProtected: () => opts.readProtected ?? false,
		},
		usesAI: () => true,
		llmConfig: () => null,
		noteCloudSession: async () => 0,
		takeCloudSpend: () => 0,
		isExcluded: () => false,
		refreshStatusBar: () => undefined,
		persist: async () => undefined,
	};
	const app = { vault: { getMarkdownFiles: () => [], cachedRead: async () => "" } };
	const view = new SessionView({ app } as never, plugin as never) as any;
	const renders = { start: 0, question: 0 };
	view.renderStart = () => void renders.start++;
	view.renderQuestion = () => void renders.question++;
	view.renderLoading = () => undefined;
	return { view, saves, renders, plugin };
}

const graded = { "N::a": { note: "N", label: "a", dueAt: "2026-10-01T00:00:00.000Z" } };

/** Put the view in the state a started session leaves it: concepts loaded from disk
 * and shared with the plugin. */
function live(view: any, plugin: any): void {
	view.concepts = plugin.concepts = graded;
	view.liveState = true;
}

test("state that isn't the loaded schedule is never written over it", async () => {
	const { view, saves } = makeView();
	view.concepts = {}; // before any session, or a redo's placeholder
	view.dirty = true;
	await view.flush();
	assert.equal(saves.some((s) => s.what === "concepts" || s.what === "registry"), false);
	assert.ok(saves.some((s) => s.what === "mastery"));
});

test("a second start while a session is still scanning notes is refused", async () => {
	const { view } = makeView();
	view.scanningEpoch = 1;
	view.scanningSince = Date.now();
	notices.length = 0;
	await view.startReplay([{ node: "N", question: "q", difficulty: "easy" }]);
	assert.equal(view.replayMode, false);
	assert.ok(notices.some((n) => /still preparing/.test(n)));
});

test("a failed save stops a new session from reloading over unsaved grades", async () => {
	const { view, plugin } = makeView({ failSaves: 99 });
	live(view, plugin);
	view.dirty = true;
	const epoch = view.sessionEpoch;
	await view.startReplay([{ node: "N", question: "q", difficulty: "easy" }]);
	assert.equal(view.sessionEpoch, epoch);
	assert.equal(view.concepts, graded);
});

test("starting a new session saves the one in progress first", async () => {
	const { view, saves, plugin } = makeView();
	live(view, plugin);
	view.dirty = true;
	await view.startSession(); // stops at the no-key notice, after flushing
	assert.deepEqual(saves.find((s) => s.what === "concepts")?.data, graded);
});

test("a start that bails early leaves the running session live and saveable", async () => {
	const { view, saves, plugin } = makeView();
	live(view, plugin);
	const epoch = view.sessionEpoch;
	await view.startSession(); // no key: returns with the old question still on screen
	assert.equal(view.sessionEpoch, epoch);
	assert.equal(view.liveState, true);
	view.dirty = true; // the user answers another question on the old screen
	saves.length = 0;
	await view.flush();
	assert.ok(saves.some((s) => s.what === "concepts"));
});

test("unsaveable state from an unreadable store doesn't wedge new sessions", async () => {
	const { view, plugin } = makeView({ failSaves: 99, readProtected: true });
	live(view, plugin);
	view.dirty = true;
	notices.length = 0;
	await view.startReplay([{ node: "N", question: "q", difficulty: "easy" }]);
	assert.equal(view.replayMode, true);
	assert.ok(notices.some((n) => /Starting fresh/.test(n)));
});

test("starting a redo saves the session in progress before wiping it", async () => {
	const { view, saves, renders, plugin } = makeView();
	live(view, plugin);
	view.dirty = true;
	await view.startReplay([{ node: "N", question: "What is a?", difficulty: "easy" }]);
	assert.deepEqual(saves.find((s) => s.what === "concepts")?.data, graded);
	assert.deepEqual(view.concepts, {}); // the replay's own (empty) state
	assert.equal(renders.question, 1);
});

test("a model error mid-session keeps the answers already given", async () => {
	const { view, saves, renders, plugin } = makeView();
	live(view, plugin);
	view.dirty = true;
	view.questions = [];
	view.targets = [{ note: "N", label: "a" }];
	view.targetCount = 3;
	view.results = [{ node: "N" }];
	view.loadNextBatch = () => Promise.reject(new Error("429 rate limited"));
	notices.length = 0;
	await view.goToQuestion(0);
	assert.deepEqual(saves.find((s) => s.what === "concepts")?.data, graded);
	assert.equal(renders.start, 1);
	assert.ok(notices.some((n) => /429/.test(n) && /saved/.test(n)), notices.join(" | "));
});

test("a failed save stays dirty and succeeds on the next flush", async () => {
	const { view, saves, plugin } = makeView({ failSaves: 1 });
	live(view, plugin);
	view.dirty = true;
	notices.length = 0;
	await view.flush();
	assert.equal(view.dirty, true);
	assert.ok(notices.some((n) => /couldn't save/.test(n)));
	await view.flush();
	assert.equal(view.dirty, false);
	assert.ok(saves.some((s) => s.what === "concepts"));
});

test("a grade is checkpointed to disk a few seconds later, without ending the session", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const { view, saves, plugin } = makeView();
		live(view, plugin);
		view.dirty = true;
		view.scheduleCheckpoint();
		assert.equal(saves.length, 0);
		mock.timers.tick(3000);
		await view.flushChain;
		assert.ok(saves.some((s) => s.what === "concepts"));
	} finally {
		mock.timers.reset();
	}
});

test("a redo never checkpoints (it's practice, not a review)", () => {
	const { view } = makeView();
	view.replayMode = true;
	view.scheduleCheckpoint();
	assert.equal(view.checkpointTimer, null);
});

test("Stop while waiting for a question goes home and ignores the late result", async () => {
	const { view, renders } = makeView();
	view.questions = [];
	view.targets = [{ note: "N", label: "a" }];
	view.targetCount = 2;
	let finish!: () => void;
	view.loadNextBatch = () =>
		new Promise<void>((r) => {
			finish = () => {
				view.questions.push({ node: "N", question: "late?" });
				r();
			};
		});
	const waiting = view.goToQuestion(0);
	view.cancelSession();
	finish();
	await waiting;
	assert.equal(renders.question, 0);
	assert.equal(renders.start, 1);
});

test("rename/delete sync: flush first, reload the shared stores after", async () => {
	const { view, saves, plugin } = makeView();
	view.questionBank = { stale: [] };
	view.bankDirty = true;
	(plugin.store as any).loadQuestionBank = async () => ({ fresh: [] });
	(plugin.store as any).loadBridges = async () => ({});
	(plugin.store as any).loadRegistry = async () => ({});
	await view.flushForExternalEdit();
	assert.deepEqual(saves.find((s) => s.what === "bank")?.data, { stale: [] });
	await view.reloadSharedStores();
	assert.deepEqual(view.questionBank, { fresh: [] });
});
