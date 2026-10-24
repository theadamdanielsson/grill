import { test } from "node:test";
import assert from "node:assert/strict";
import { TFile } from "obsidian";
import { emptyMastery, type NoteMastery } from "../src/mastery";
import { applyProps, noteProps, notesBase, sessionFields, sessionsBase } from "../src/props";
import { GrillStore } from "../src/store";

const tested = (over: Partial<NoteMastery> = {}): NoteMastery => ({
	...emptyMastery(),
	correct: 1,
	incorrect: 2,
	stability: 1.2,
	lastSeen: new Date(2026, 9, 20, 9).toISOString(),
	dueAt: new Date(2026, 9, 23, 9).toISOString(),
	misconceptions: { confuses_real_and_nominal: 3, sign_error: 1, wrong_axis: 2, minor: 1 },
	...over,
});

test("a note never tested gets no properties", () => {
	assert.deepEqual(noteProps(undefined), {});
	assert.deepEqual(noteProps(emptyMastery()), {});
});

test("a tested note's properties use Grill's own words, local dates and its most-seen confusions", () => {
	assert.deepEqual(noteProps(tested()), {
		grill_status: "learning",
		grill_last_tested: "2026-10-20",
		grill_due: "2026-10-23",
		grill_confusions: ["confuses_real_and_nominal", "wrong_axis", "sign_error"],
	});
});

test("a known note lists no confusions: one put right would read as current", () => {
	const p = noteProps(tested({ stability: 12, correct: 5 }));
	assert.equal(p.grill_status, "known");
	assert.equal(p.grill_confusions, undefined);
});

test("applying properties leaves the user's own ones alone and reports no change when nothing changed", () => {
	const fm: Record<string, unknown> = { tags: ["econ"], aliases: ["IS-LM"] };
	const p = noteProps(tested());
	assert.equal(applyProps(fm, p), true);
	assert.deepEqual(fm.tags, ["econ"]);
	assert.equal(fm.grill_status, "learning");
	assert.equal(applyProps(fm, p), false);
	// Known now: the confusions come out, nothing else of the user's does.
	assert.equal(applyProps(fm, noteProps(tested({ stability: 12 }))), true);
	assert.equal("grill_confusions" in fm, false);
	assert.equal(applyProps(fm, {}), true);
	assert.deepEqual(fm, { tags: ["econ"], aliases: ["IS-LM"] });
});

test("the view files filter on Grill's folder and properties", () => {
	assert.match(sessionsBase("Study/Grill"), /file\.inFolder\("Study\/Grill\/Sessions"\)/);
	assert.match(sessionsBase("Grill"), /property: file\.name\n\s+direction: DESC/);
	assert.match(notesBase(), /file\.hasProperty\("grill_status"\)/);
});

/** A vault with markdown notes whose frontmatter lives in the metadata cache, the way
 * Obsidian's processFrontMatter and getFileCache see it. */
function fakeVault(names: string[]) {
	const files = new Map<string, TFile>();
	const fm = new Map<string, Record<string, unknown>>();
	const written: string[] = [];
	const disk = new Map<string, string>();
	for (const path of names) {
		const f = new TFile(path);
		f.basename = path.replace(/^.*\//, "").replace(/\.md$/, "");
		f.extension = "md";
		files.set(f.basename, f);
		fm.set(path, { tags: ["mine"] });
	}
	const app = {
		vault: {
			adapter: {
				exists: async (p: string) => disk.has(p) || [...disk.keys()].some((k) => k.startsWith(`${p}/`)),
				write: async (p: string, d: string) => void disk.set(p, d),
				read: async (p: string) => disk.get(p) ?? "",
				rename: async () => undefined,
				remove: async () => undefined,
			},
			createFolder: async () => undefined,
			getAbstractFileByPath: (p: string) => (disk.has(p) ? new TFile(p) : null),
			create: async (p: string, d: string) => void disk.set(p, d),
		},
		metadataCache: {
			getFirstLinkpathDest: (name: string) => files.get(name) ?? null,
			getFileCache: (f: TFile) => ({ frontmatter: fm.get(f.path) }),
		},
		fileManager: {
			processFrontMatter: async (f: TFile, fn: (x: Record<string, unknown>) => void) => {
				const copy = { ...fm.get(f.path) };
				fn(copy);
				fm.set(f.path, copy);
				written.push(f.path);
			},
		},
	};
	return { app, fm, written, disk };
}

test("syncing writes only notes whose record changed, skips Grill's own folder, and turning off removes it all", async () => {
	const v = fakeVault(["Econ/IS-LM.md", "Grill/Instructions.md"]);
	const store = new GrillStore(v.app as never, () => "Grill");
	const map = { "IS-LM": tested(), Instructions: tested(), Gone: tested() };

	assert.equal(await store.syncNoteProps(map, true), 1);
	assert.deepEqual(v.written, ["Econ/IS-LM.md"]);
	assert.equal(v.fm.get("Econ/IS-LM.md")!.grill_status, "learning");
	assert.deepEqual(v.fm.get("Econ/IS-LM.md")!.tags, ["mine"]);

	// Same record again: nothing rewritten.
	assert.equal(await store.syncNoteProps(map, true), 0);
	assert.equal(v.written.length, 1);

	assert.equal(await store.syncNoteProps(map, false), 1);
	assert.deepEqual(v.fm.get("Econ/IS-LM.md"), { tags: ["mine"] });
});

test("saving the record writes properties only while the setting is on", async () => {
	const v = fakeVault(["IS-LM.md"]);
	const store = new GrillStore(v.app as never, () => "Grill");
	await store.saveMastery({ "IS-LM": tested() });
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(v.written.length, 0);
	store.notePropsOn = () => true;
	await store.saveMastery({ "IS-LM": tested() });
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(v.written, ["IS-LM.md"]);
});

test("a session note carries numeric correct and total and links its notes, and the first one brings the Sessions view", async () => {
	const v = fakeVault([]);
	const store = new GrillStore(v.app as never, () => "Grill");
	const entry = (node: string, verdict: "correct" | "incorrect") => ({
		node, question: "Q?", answer: "A", verdict, gaveUp: false, feedback: "ok", modelAnswer: "M",
	});
	await store.writeSessionNote(
		[entry("IS-LM", "correct"), entry("IS-LM", "incorrect"), entry("Inflation", "correct")],
		{ provider: "anthropic", model: "m", startedAt: new Date(2026, 9, 24, 10, 5) },
	);
	const note = [...v.disk.entries()].find(([p]) => p.startsWith("Grill/Sessions/2026-10/"))![1];
	assert.match(note, /\ncorrect: 2\ntotal: 3\nnotes:\n {2}- "\[\[IS-LM\]\]"\n {2}- "\[\[Inflation\]\]"\n/);
	assert.match(note, /\nscore: 2\/3\n/);
	assert.match(v.disk.get("Grill/Sessions.base") ?? "", /file\.inFolder\("Grill\/Sessions"\)/);
});

test("an older session note's fields are read from its score and its question headings", () => {
	const text = [
		"---", "date: 2026-10-17", "score: 1/3", "type: study session", "---", "",
		"# Grill session 2026-10-17 17.40", "", "## GDP", "Q", "## [[Inflation]]", "Q", "## GDP", "Q",
		"## Redo", "", "```grill-redo", "{}", "```",
	].join("\n");
	assert.deepEqual(sessionFields(text), { correct: 1, total: 3, notes: ["GDP", "Inflation"] });
	assert.equal(sessionFields("---\ndate: 2026-10-17\n---\n## GDP"), null);
});

test("with sessions not linked to notes, a session note lists its notes as plain names", async () => {
	const v = fakeVault([]);
	const store = new GrillStore(v.app as never, () => "Grill");
	await store.writeSessionNote(
		[{ node: "GDP", question: "Q?", answer: "A", verdict: "correct", gaveUp: false, feedback: "ok", modelAnswer: "M" }],
		{ provider: "anthropic", model: "m", startedAt: new Date(2026, 9, 24, 11, 0) },
		false,
	);
	const note = [...v.disk.entries()].find(([p]) => p.startsWith("Grill/Sessions/2026-10/"))![1];
	assert.match(note, /\nnotes:\n {2}- "GDP"\n/);
	assert.doesNotMatch(note, /\[\[GDP\]\]/);
});
