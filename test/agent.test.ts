import test from "node:test";
import assert from "node:assert/strict";
import { activityLine, activitySummary, AgentEvent, levelMode, permissionAsk, programPlaces, TurnReader } from "../src/agent";

test("the three levels are Claude Code's own modes", () => {
	assert.equal(levelMode("safe"), "default");
	assert.equal(levelMode("plan"), "plan");
	assert.equal(levelMode("auto"), "acceptEdits");
});

test("what it did is said in a line, and summed up in one", () => {
	assert.equal(activityLine("Read", { file_path: "/vault/Macro/Multiplier.md" }), "Read Multiplier.md");
	assert.equal(activityLine("Edit", { file_path: "C:\\vault\\IS.md" }), "Edit IS.md");
	assert.equal(activityLine("Grep", { pattern: "slope" }), 'Search for "slope"');
	assert.equal(activityLine("Bash", { command: "ls -la\nrm x" }), "Run ls -la");
	assert.equal(activityLine("mcp__docs__search", {}), "Use docs search");
	assert.equal(activitySummary(["Read", "Read", "Read", "Read", "Grep"], 9.2), "Read 4 files, searched the vault once, worked for 9s");
	assert.equal(activitySummary(["Edit"], 38), "Edited 1 file, worked for 38s");
	assert.equal(activitySummary([], 0.2), "");
});

test("a permission card shows the lines that go and the lines that come", () => {
	const edit = permissionAsk("Edit", { file_path: "/v/IS.md", old_string: "slope greater than 1.", new_string: "slope below 1.\n\nExample." });
	assert.equal(edit.title, "Edit IS.md");
	assert.deepEqual(edit.removed, ["slope greater than 1."]);
	assert.deepEqual(edit.added, ["slope below 1.", "Example."]);
	assert.equal(edit.always, "Always allow edits in this chat");
	const long = permissionAsk("Write", { file_path: "/v/New.md", content: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") });
	assert.equal(long.added.length, 13);
	assert.equal(long.added.at(-1), "… 18 more lines");
	const bash = permissionAsk("Bash", { command: "git status" }, "Claude wants to run git status");
	assert.equal(bash.title, "Claude wants to run git status");
	assert.equal(bash.detail, "git status");
	assert.deepEqual(bash.added, []);
});

test("a turn is followed as it is written: prose, the work between, and the result", () => {
	const events: AgentEvent[] = [];
	const r = new TurnReader((e) => events.push(e));
	const delta = (text: string, parent: string | null = null) => ({ type: "stream_event", session_id: "s1", parent_tool_use_id: parent, event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
	const starts = { type: "stream_event", session_id: "s1", parent_tool_use_id: null, event: { type: "content_block_start", content_block: { type: "text" } } };
	r.take(starts);
	r.take(delta("Let me look."));
	r.take({ type: "assistant", session_id: "s1", parent_tool_use_id: null, message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/v/A.md" } }] } });
	// A helper's words are not the reply.
	r.take(delta("helper chatter", "tool-1"));
	r.take(starts);
	r.take(delta("Your note says two things."));
	r.take({ type: "result", subtype: "success", is_error: false, result: "Your note says two things.", session_id: "s1" });
	assert.equal(r.reply(), "Let me look.\n\nYour note says two things.");
	assert.deepEqual(r.tools, ["Read"]);
	assert.equal(r.sessionId, "s1");
	assert.equal(r.failed, "");
	assert.deepEqual(events.map((e) => e.kind), ["text", "activity", "text"]);
	assert.deepEqual(events[1], { kind: "activity", tool: "Read", line: "Read A.md" });
});

test("a turn that fails says so, and one with no streamed prose falls back on its result", () => {
	const failed = new TurnReader(() => undefined);
	failed.take({ type: "result", subtype: "error_max_turns", is_error: true });
	assert.match(failed.failed, /too many steps/);
	const quiet = new TurnReader(() => undefined);
	quiet.take({ type: "result", subtype: "success", is_error: false, result: "Done." });
	assert.equal(quiet.reply(), "Done.");
});

test("Claude Code is looked for where it is usually installed", () => {
	assert.ok(programPlaces("/Users/a", "darwin", {}).includes("/opt/homebrew/bin/claude"));
	assert.equal(programPlaces("/Users/a", "darwin", {})[0], "/Users/a/.local/bin/claude");
	assert.ok(programPlaces("C:\\Users\\a", "win32", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }).includes("C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd"));
});
