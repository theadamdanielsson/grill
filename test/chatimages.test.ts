import { test } from "node:test";
import assert from "node:assert/strict";
import { embeddedImageLinks } from "../src/chatimages";
import { streamCall } from "../src/stream";
import type { LLMConfig } from "../src/providers";

test("the pictures a message embeds are found once each, in order, and nothing else is", () => {
	const text = "See ![[Pasted image 1.png]] and ![[chart.JPG|300]] and ![[Pasted image 1.png]], not ![[Note]] or ![[doc.pdf]].\n![alt](figs/a%20b.webp) ![x](https://example.com/y.png)";
	assert.deepEqual(embeddedImageLinks(text), ["Pasted image 1.png", "chart.JPG", "figs/a b.webp"]);
	assert.deepEqual(embeddedImageLinks("no pictures [[here.png]]"), []);
});

const pic = { mediaType: "image/png", dataBase64: "AAAA", path: "a.png" };
const prompt = { system: "S", cacheable: "C", rest: "R", maxTokens: 100, images: [pic] };

test("a picture in a chat message goes to Anthropic as an image block before the question", () => {
	const call = streamCall({ provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "k" } as LLMConfig, prompt);
	const content = (call?.body.messages as Array<{ content: Array<{ type: string }> }>)[0].content;
	assert.deepEqual(content.map((c) => c.type), ["text", "image", "text"]);
});

test("and to an OpenAI-shaped provider as a data URL after the text", () => {
	const call = streamCall({ provider: "openai", model: "gpt-4o", apiKey: "k" } as LLMConfig, prompt);
	const content = (call?.body.messages as Array<{ content: unknown }>)[1].content as Array<{ type: string; image_url?: { url: string } }>;
	assert.equal(content[content.length - 1].image_url?.url, "data:image/png;base64,AAAA");
});

test("a model that reads no pictures gets the message as plain text", () => {
	const call = streamCall({ provider: "deepseek", model: "deepseek-chat", apiKey: "k" } as LLMConfig, prompt);
	assert.equal(typeof (call?.body.messages as Array<{ content: unknown }>)[1].content, "string");
});

test("with no pictures the request is what it was", () => {
	const call = streamCall({ provider: "openai", model: "gpt-4o", apiKey: "k" } as LLMConfig, { ...prompt, images: [] });
	assert.equal((call?.body.messages as Array<{ content: unknown }>)[1].content, "C\n\nR");
});
