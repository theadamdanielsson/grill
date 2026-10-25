import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilities, supportsEmbeddings, supportsVision, type ProviderId } from "../src/providers";

test("each provider's capabilities, as the table gives them", () => {
	const row = (provider: ProviderId, model = "m") => {
		const c = capabilities({ provider, apiKey: "k", model });
		return [c.tools, c.vision, c.embeddings, c.local, c.metered];
	};
	assert.deepEqual(row("anthropic"), [true, true, false, false, false]);
	assert.deepEqual(row("openai", "gpt-5.6-terra"), [true, true, true, false, false]);
	assert.deepEqual(row("openai", "text-davinci"), [true, false, true, false, false]);
	assert.deepEqual(row("gemini"), [false, true, true, false, false]);
	assert.deepEqual(row("deepseek"), [true, false, false, false, false]);
	assert.deepEqual(row("ollama", "llava:7b"), [false, true, true, true, false]);
	assert.deepEqual(row("custom"), [true, false, true, true, false]);
	assert.deepEqual(row("grillcloud"), [false, true, false, false, true], "tools wait for the server to say");
	assert.equal(supportsVision("ollama", "qwen3:8b"), false);
	assert.equal(supportsEmbeddings("anthropic"), false);
	const agent = capabilities({ engine: "codex", model: "Codex", agent: async () => ({}), agentImages: true });
	assert.deepEqual([agent.tools, agent.vision, agent.local, agent.metered], [false, true, false, false]);
});
