// Bundle each test/*.test.ts with `obsidian` (and the WASM-heavy libraries) aliased
// to stubs, then run them all under node's built-in test runner.
import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const out = join(here, ".build");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const tests = readdirSync(here).filter((f) => f.endsWith(".test.ts"));
await esbuild.build({
	entryPoints: tests.map((f) => join(here, f)),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	outdir: out,
	outExtension: { ".js": ".mjs" },
	logLevel: "warning",
	alias: {
		obsidian: join(here, "obsidian-stub.ts"),
		"tesseract.js": join(here, "empty-stub.ts"),
		"@huggingface/transformers": join(here, "empty-stub.ts"),
	},
});

const files = readdirSync(out).filter((f) => f.endsWith(".mjs")).map((f) => join(out, f));
const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
