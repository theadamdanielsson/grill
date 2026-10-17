// One file with everything in it, so `npx grill-mcp` installs nothing else.
import esbuild from "esbuild";
import { chmodSync, readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const out = new URL("./dist/grill-mcp.js", import.meta.url).pathname;

await esbuild.build({
	entryPoints: [new URL("./src/server.ts", import.meta.url).pathname],
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node18",
	outfile: out,
	banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
	define: { GRILL_MCP_VERSION: JSON.stringify(version) },
	// The plugin's own modules are bundled from ../src; none of them may need Obsidian.
	external: ["obsidian"],
	minify: true,
	logLevel: "warning",
});
chmodSync(out, 0o755);
