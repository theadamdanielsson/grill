/** The Agents tab: Grill's tools and skills for Chat, the record for agents outside
 * Grill, and opencode. */

import { Notice, Platform } from "obsidian";
import { canInstall, findOpencode, isGrillInstall, OPENCODE_VERSION, uninstallOpencode } from "../opencode";
import { type Row, type SettingsCtx } from "./ctx";

/** The MCP servers Claude Code has for every project (~/.claude.json) and Claude
 * Desktop has, by name. Empty on a phone or when there are none. */
function importClaudeServers(): Record<string, unknown> {
	const req = (window as unknown as { require?: (m: string) => unknown }).require;
	if (!req) return {};
	const fs = req("fs") as { readFileSync(p: string, e: "utf8"): string };
	const home = (req("os") as { homedir(): string }).homedir();
	const out: Record<string, unknown> = {};
	for (const file of [`${home}/Library/Application Support/Claude/claude_desktop_config.json`, `${home}/.claude.json`]) {
		try {
			const servers = (JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> }).mcpServers;
			if (servers && typeof servers === "object") Object.assign(out, servers);
		} catch {
			// Not there.
		}
	}
	// Grill's own server: Chat here has its record tools already.
	for (const [name, v] of Object.entries(out)) if (JSON.stringify(v).includes("grill-mcp")) delete out[name];
	return out;
}

/** MCP servers and skills for Chat on Grill Cloud or a key of one's own. Claude Code,
 * Codex and opencode bring their own. */
export function toolRows(ctx: SettingsCtx): Row[] {
	const s = ctx.plugin.data.settings;
	const says = (el: HTMLElement): void => {
		el.empty();
		const over = ctx.plugin.mcp.leftOut();
		if (over > 0) el.createDiv({ cls: "mod-warning", text: `${over} ${over === 1 ? "tool is" : "tools are"} left out: more than one message can carry.` });
		for (const st of ctx.plugin.mcp.status()) {
			const line = el.createDiv({ text: st.error ? `${st.name}: ${st.error}` : `${st.name}: ${st.tools} ${st.tools === 1 ? "tool" : "tools"}`, cls: st.error && !st.signIn ? "mod-warning" : "" });
			if (!st.signIn) continue;
			const go = line.createEl("button", { text: `Sign in to ${st.name}`, cls: "grill-inline-btn" });
			go.onclick = async () => {
				go.disabled = true;
				go.setText("Waiting for the browser...");
				const failed = await ctx.plugin.mcp.signIn(st.name, (url) => window.open(url));
				if (failed) new Notice(`Grill: ${st.name}: ${failed}`, 8000);
				says(el);
			};
		}
	};
	return [
		{
			name: "MCP servers",
			desc: "Written as in Claude Code's .mcp.json. Kept in Obsidian's keychain on this device. Claude Code, Codex and opencode use their own.",
			aliases: ["mcp", "tools", "servers", "connectors", "integrations"],
			build: (setting) => {
				setting.settingEl.addClass("grill-setting-tall");
				const status = setting.descEl.createDiv({ cls: "grill-meta" });
				says(status);
				let area: HTMLTextAreaElement | null = null;
				setting.addTextArea((t) => {
					area = t.inputEl;
					t.inputEl.rows = 8;
					t.inputEl.addClass("grill-mono");
					t.setPlaceholder('{\n  "mcpServers": {\n    "name": { "url": "https://..." }\n  }\n}');
					t.setValue(ctx.plugin.mcpConfig()).onChange(async (v) => {
						await ctx.plugin.setMcpConfig(v);
					});
				});
				const connect = async (): Promise<void> => {
					status.setText("Connecting...");
					await ctx.plugin.mcp.close();
					await ctx.plugin.mcp.ready(ctx.plugin.mcpConfig());
					says(status);
					if (!ctx.plugin.mcp.status().length) status.setText("No servers.");
				};
				if (Platform.isDesktopApp) {
					setting.addButton((b) =>
						b.setButtonText("Import from Claude Code").onClick(async () => {
							const found = importClaudeServers();
							if (!Object.keys(found).length) return void new Notice("Grill: Claude Code has no MCP servers set up for all projects.", 6000);
							const had = (() => {
								try {
									const v = JSON.parse(ctx.plugin.mcpConfig() || "{}") as { mcpServers?: Record<string, unknown> };
									return v.mcpServers ?? v;
								} catch {
									return {};
								}
							})();
							const merged = JSON.stringify({ mcpServers: { ...found, ...had } }, null, 2);
							await ctx.plugin.setMcpConfig(merged);
							if (area) area.value = merged;
							await ctx.plugin.persist();
							await connect();
						}),
					);
				}
				setting.addButton((b) => b.setButtonText("Connect").onClick(() => void connect()));
			},
		},
		{
			name: "Web",
			desc: "Chat reads web pages and searches the web. Reading a page asks first at the Safe level.",
			aliases: ["web", "internet", "search", "browse", "fetch", "url"],
			build: (setting) =>
				setting.addToggle((t) =>
					t.setValue(s.useWeb).onChange(async (v) => {
						await ctx.plugin.settings.update({ useWeb: v });
					}),
				),
		},
		{
			name: "Search by meaning",
			desc: "",
			aliases: ["semantic", "embeddings", "vault search", "vault qa", "meaning"],
			build: (setting) => {
				if (!Platform.isDesktopApp) return setting.setDesc("Desktop only.");
				setting.setDesc("Lets Chat find notes by what they are about, not only by their words. A model (about 130 MB) is downloaded once and runs on this device; your notes never leave it.");
				const st = setting.descEl.createDiv({ cls: "grill-meta" });
				const show = (): void => {
					const p = ctx.plugin.searchProgress;
					st.setText(s.searchByMeaning && p.total ? `${p.indexed} of ${p.total} notes indexed.` : "");
				};
				show();
				setting.addToggle((t) =>
					t.setValue(s.searchByMeaning).onChange(async (v) => {
						await ctx.plugin.settings.update({ searchByMeaning: v });
						if (v) {
							st.setText("Indexing...");
							const tick = window.setInterval(show, 1000);
							try {
								await ctx.plugin.indexForSearch();
							} finally {
								window.clearInterval(tick);
							}
						}
						show();
					}),
				);
			},
		},
		{
			name: "Skills",
			desc: "",
			aliases: ["skills", "skill", "agent skills", "skills.sh"],
			build: (setting) => {
				const where = ctx.plugin.skillPlaces().map((p) => p.shown).join(", ");
				setting.setDesc(`Grill reads them from ${where}.`);
				const found = setting.descEl.createDiv({ cls: "grill-meta" });
				void ctx.plugin.findSkills().then((all) => found.setText(s.useSkills ? (all.length ? `${all.length} found: ${all.slice(0, 8).map((k) => k.name).join(", ")}${all.length > 8 ? ", ..." : ""}` : "None found.") : ""));
				setting.addToggle((t) =>
					t.setValue(s.useSkills).onChange(async (v) => {
						await ctx.plugin.settings.update({ useSkills: v });
						ctx.display();
					}),
				);
			},
		},
	];
}

/** grill-mcp: the record for Claude Code, Codex and other agents outside Grill. One
 * command to paste in a terminal; their answers come back through the Inbox folder. */
export function recordForAgentsRow(ctx: SettingsCtx): Row {
	const base = (ctx.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? "";
	const server = `npx -y grill-mcp --vault "${base.replace(/"/g, '\\"')}"`;
	const commands = [
		{ agent: "Claude Code", text: `claude mcp add --scope user grill -- ${server}` },
		{ agent: "Codex", text: `codex mcp add grill -- ${server}` },
	];
	return {
		name: "Connect an agent",
		desc: "Lets the agent see what you know and test you. Its answers count in Grill. Paste the copied line in a terminal.",
		aliases: ["mcp", "claude code", "codex", "cursor", "record", "memory"],
		build: (setting) => {
			for (const c of commands) {
				setting.addButton((b) =>
					b.setButtonText(`Copy for ${c.agent}`).onClick(async () => {
						await navigator.clipboard.writeText(c.text);
						new Notice(`Grill: copied. Paste it in a terminal, then start a new ${c.agent} session.`, 6000);
					}),
				);
			}
		},
	};
}

/** opencode: installed by Grill, or found where it already is. */
export function opencodeRows(ctx: SettingsCtx): Row[] {
	const s = ctx.plugin.data.settings;
	return [
		{
			name: "opencode",
			desc: "",
			aliases: ["opencode", "free models", "agent", "ollama", "install", "download"],
			build: (setting) => {
				if (!Platform.isDesktopApp) return setting.setDesc("Runs on desktop only.");
				const found = findOpencode(s.opencodePath);
				const mb = ctx.plugin.opencodeDownloadSize();
				if (ctx.opencodeBusy) return setting.setDesc(`Downloading opencode${mb ? ` (${mb} MB)` : ""} and checking it...`);
				if (found) {
					setting.setDesc(
						`${isGrillInstall(found) ? `Installed by Grill (${OPENCODE_VERSION})` : `Found at ${found}`}. Free models work without signing in, and may keep what you send them to improve the model. To use an account of yours, run opencode auth login in a terminal.`,
					);
					if (isGrillInstall(found)) {
						setting.addButton((b) =>
							b.setButtonText("Remove").onClick(() => {
								uninstallOpencode();
								if (s.chatEngine === "opencode") s.chatEngine = "model";
								void ctx.plugin.persist();
								ctx.rerender();
							}),
						);
					}
					return setting;
				}
				if (!canInstall()) return setting.setDesc("Not installed, and there is no build of it for this computer.");
				setting.setDesc(`An agent that can read and change the vault, with free models of its own. Grill downloads opencode's build${mb ? ` (${mb} MB)` : ""} and checks it before installing.`);
				return setting.addButton((b) =>
					b
						.setButtonText("Install")
						.setCta()
						.onClick(async () => {
							ctx.opencodeBusy = true;
							ctx.rerender();
							try {
								await ctx.plugin.installOpencode();
							} finally {
								ctx.opencodeBusy = false;
								ctx.rerender();
							}
						}),
				);
			},
		},
		{
			name: "opencode location",
			desc: "Leave empty to have it found. Fill in the full path to use a copy of your own.",
			aliases: ["opencode path", "binary", "executable"],
			build: (setting) =>
				setting.addText((t) =>
					t
						.setPlaceholder("Found automatically")
						.setValue(s.opencodePath)
						.onChange(async (v) => {
							await ctx.plugin.settings.update({ opencodePath: v.trim() });
						}),
				),
		},
	];
}
