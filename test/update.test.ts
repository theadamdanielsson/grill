import { test } from "node:test";
import assert from "node:assert/strict";
import { isNewer } from "../src/update";

test("a newer release is told apart by number, not by text", () => {
	assert.equal(isNewer("8.10.0", "8.9.3"), true);
	assert.equal(isNewer("9.0.0", "8.4.0"), true);
	assert.equal(isNewer("8.4.1", "8.4.0"), true);
	assert.equal(isNewer("8.4.0", "8.4.0"), false);
	assert.equal(isNewer("8.3.9", "8.4.0"), false);
	// A tag that isn't a plain version is never taken for an update.
	assert.equal(isNewer("8.5.0-beta", "8.4.0"), false);
	assert.equal(isNewer("", "8.4.0"), false);
});
