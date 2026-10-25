/** Where a natural read-aloud voice comes from: Grill Cloud, or OpenAI with the user's own
 * key. Each gives the audio of some text, or throws with a sentence fit to show. */

import { requestUrl } from "obsidian";
import { cloudSpeech } from "./cloud";
import { API_BASE } from "./providers";

export type SpeechSource = "cloud" | "openai";

/** The audio of `text`, as MP3. */
export async function naturalSpeech(source: SpeechSource, key: string, text: string): Promise<ArrayBuffer> {
	if (source === "cloud") {
		const r = await cloudSpeech(key, text);
		if (!r.ok) throw new Error(r.message);
		return r.data;
	}
	const r = await Promise.race([
		requestUrl({
			url: `${API_BASE.openai}/audio/speech`,
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "sage", input: text, response_format: "mp3" }),
			throw: false,
		}),
		new Promise<never>((_, no) => window.setTimeout(() => no(new Error("The voice took too long.")), 45_000)),
	]);
	if (r.status !== 200) throw new Error(`The voice had a problem (${r.status}).`);
	return r.arrayBuffer;
}
