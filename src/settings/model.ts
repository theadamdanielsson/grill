/** The Own key tab: the provider, its key or server, and the model. Also the row for
 * the persona and instructions note, which the page shows on the Basic tab. */

import { Notice, Setting } from "obsidian";
import { OLLAMA_DEFAULT_URL, offeredProviders, type ProviderId, PROVIDERS } from "../providers";
import { testModel } from "../llm";
import { cloudEnabled } from "../cloud";
import { CUSTOM, type Row, type SettingsCtx } from "./ctx";

export function modelRows(ctx: SettingsCtx, all: boolean): Row[] {
	const s = ctx.plugin.data.settings;
	const p = s.provider;
	const info = PROVIDERS[p];
	const inKeychain = ctx.plugin.keys.available;

	// ------------------------------------------------------------ AI
	const ai: Row[] = [
		{
			name: "Provider",
			desc: (cloudEnabled() && p === "grillcloud" ? "Grill Cloud is in use. " : "") + "Whose model to use with your own key. Ollama runs on your machine.",
			aliases: ["anthropic", "claude", "openai", "chatgpt", "gemini", "deepseek", "ollama", "openrouter", "local", ...(cloudEnabled() ? ["grill cloud", "credits"] : [])],
			build: (setting) =>
				setting.addDropdown((d) => {
					for (const [id, pi] of offeredProviders()) d.addOption(id, pi.label);
					d.setValue(p).onChange(async (v) => {
						s.provider = v as ProviderId;
						ctx.showCustomModel = false;
						ctx.cloudKeyConfirm = false;
						ctx.cloudDeleteConfirm = false;
						await ctx.plugin.persist();
						ctx.rerender();
						void ctx.refreshModels(v as ProviderId);
					});
				}),
		},
	];

	const keyField = (setting: Setting): void => {
		setting.addText((t) => {
			t.setPlaceholder(info.keyPlaceholder)
				.setValue(s.apiKeys[p])
				.onChange(async (v) => {
					s.apiKeys[p] = v.trim();
					delete ctx.modelLists[p];
					delete ctx.modelProblems[p];
					await ctx.plugin.persist();
				});
			t.inputEl.type = "password";
		});
	};
	const keyHome = inKeychain
		? "Kept in Obsidian's keychain. Each device needs it once."
		: "Stored in this vault's plugin data.";

	const baseUrlRow: Row = {
		name: "Base URL",
		desc: "Any OpenAI-compatible endpoint, e.g. https://openrouter.ai/api/v1.",
		build: (setting) =>
			setting.addText((t) =>
				t
					.setPlaceholder("https://openrouter.ai/api/v1")
					.setValue(s.customBaseUrl)
					.onChange(async (v) => {
						s.customBaseUrl = v.trim();
						delete ctx.modelLists.custom;
						delete ctx.modelProblems.custom;
						await ctx.plugin.persist();
					}),
			),
	};
	const keyRow: Row = {
		name: "API key",
		desc:
			p === "custom"
				? `Optional for local servers. ${keyHome}`
				: `${keyHome} Get one at ${info.keyUrl}.`,
		aliases: ["token", "secret"],
		build: keyField,
	};
	const ollamaRow: Row = {
		name: "Ollama server",
		desc: "Needs Ollama running locally. 8B+ models recommended.",
		build: (setting) =>
			setting.addText((t) =>
				t
					.setPlaceholder(OLLAMA_DEFAULT_URL)
					.setValue(s.ollamaUrl)
					.onChange(async (v) => {
						s.ollamaUrl = v.trim() || OLLAMA_DEFAULT_URL;
						delete ctx.modelLists.ollama;
						delete ctx.modelProblems.ollama;
						await ctx.plugin.persist();
					}),
			),
	};
	if (!cloudEnabled() && p === "grillcloud") {
		ai.push({
			name: "Grill Cloud",
			desc: "Grill Cloud isn't available in this version of Grill. Pick another provider above.",
			build: () => undefined,
		});
	}
	if (all || p === "custom") ai.push(baseUrlRow);
	if (all || p === "custom" || (info.needsKey && p !== "grillcloud")) ai.push(keyRow);
	if (all || (p !== "custom" && !info.needsKey)) ai.push(ollamaRow);

	const list = ctx.modelLists[p] ?? [];
	const options = list.length ? list : info.fallbackModels;
	const current = s.models[p] || info.defaultModel;
	const staleCurrent = list.length > 0 && !list.includes(current);
	// The list couldn't be fetched, and the reason is known: a rejected key, a server
	// that isn't running. Said here, where the key and the model are chosen.
	const listProblem = list.length ? undefined : ctx.modelProblems[p];
	ai.push({
		name: "Model",
		desc: staleCurrent
			? `'${current}' isn't on your account. Pick another.`
			: list.length
				? `${list.length} models on your account.`
				: (listProblem ??
					(p === "ollama" ? "Refresh to list your installed models." : "Common models. Refresh to list yours.")),
		build: (setting) => {
			setting.descEl.toggleClass("mod-warning", staleCurrent || !!listProblem);
			setting.addDropdown((d) => {
				for (const m of options) d.addOption(m, m);
				if (current && !options.includes(current) && !ctx.showCustomModel)
					d.addOption(current, `${current} (not found)`);
				d.addOption(CUSTOM, "Custom model ID...");
				d.setValue(ctx.showCustomModel ? CUSTOM : current);
				d.onChange(async (v) => {
					if (v === CUSTOM) {
						ctx.showCustomModel = true;
						ctx.rerender();
						return;
					}
					ctx.showCustomModel = false;
					s.models[p] = v;
					await ctx.plugin.persist();
				});
			});
			setting.addExtraButton((b) =>
				b
					.setIcon("refresh-cw")
					.setTooltip("Fetch model list")
					.onClick(() => void ctx.refreshModels(p)),
			);
			setting.addExtraButton((b) =>
				b
					.setIcon("zap")
					.setTooltip("Test this model with a tiny request")
					.onClick(async () => {
						const cfg = ctx.plugin.modelConfig();
						if (!cfg) {
							new Notice("Grill: set an API key first.");
							return;
						}
						new Notice(`Grill: testing ${cfg.model}...`);
						const err = await testModel(cfg);
						new Notice(err ? `Grill: ${cfg.model} failed. ${err}` : `Grill: ${cfg.model} works.`, 8000);
					}),
			);
			// Kick off a background model-list fetch the first time the row is shown.
			// Not again after a failure that was said: the refresh button is the retry.
			if (!ctx.modelLists[p] && !ctx.modelProblems[p] && (s.apiKeys[p] || p === "ollama" || (p === "custom" && s.customBaseUrl)))
				void ctx.refreshModels(p);
		},
	});

	if (all || ctx.showCustomModel) {
		ai.push({
			name: "Custom model ID",
			build: (setting) =>
				setting.addText((t) =>
					t
						.setPlaceholder(info.defaultModel)
						.setValue(s.models[p])
						.onChange(async (v) => {
							s.models[p] = v.trim() || info.defaultModel;
							await ctx.plugin.persist();
						}),
				),
		});
	}

	ai.push({
		name: "Persona & instructions",
		desc: "Grill's character, and how you want to be tested and answered, in a note you can edit.",
		aliases: ["prompt", "tone"],
		build: (setting) =>
			setting.addButton((b) =>
				b
					.setButtonText("Manage")
					.setTooltip("Create Grill/Instructions.md if needed and open it")
					.onClick(() => void ctx.plugin.openInstructions()),
			),
	});
	return ai;
}
