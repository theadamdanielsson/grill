import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";
import { readFile, stat } from "node:fs/promises";

const MAX_BYTES = 5_000_000;

const prod = process.argv[2] === "production";

// The Agent SDK asks where its own file is (to load Node modules with), which a bundle
// has no answer to: the plugin is one file, run by Obsidian, with no path of its own.
// It is given a stand-in address under the user's home folder. Only the SDK's file is
// rewritten; other libraries read the same question differently and are left alone.
const sdkHasAnAddress = {
  name: "sdk-has-an-address",
  setup(build) {
    build.onLoad({ filter: /claude-agent-sdk[\\/]sdk\.mjs$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      // A new SDK that asks some other way would build fine and break on first use.
      if (!source.includes("import.meta.url")) throw new Error("The Agent SDK no longer reads import.meta.url: check sdkHasAnAddress");
      return { contents: source.replaceAll("import.meta.url", "__grillSdkUrl()"), loader: "js" };
    });
  },
};
const sdkAddress =
  'function __grillSdkUrl(){try{return require("url").pathToFileURL(require("path").join(require("os").homedir(),"grill-sdk.js")).href}catch(e){return "file:///grill-sdk.js"}}';

const ctx = await esbuild.context({
  plugins: [sdkHasAnAddress],
  banner: { js: sdkAddress },
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Node's own modules are left as they are: only the Claude Code engine asks for them,
  // it is loaded on first use, and only on desktop, where Obsidian can supply them.
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  format: "cjs",
  // @huggingface/transformers ships conditional exports: a "node" build pulling in
  // native onnxruntime-node/sharp bindings esbuild can't bundle, and a browser build
  // (dist/transformers.web.js, pure WASM via onnxruntime-web) that's the only one
  // that can run inside Obsidian's renderer anyway. platform:"browser" is what makes
  // esbuild's export-condition resolution pick the latter — see embed-local.ts.
  platform: "browser",
  target: "es2022",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  // Under 5 MB, or Obsidian Sync Standard won't carry main.js.
  minify: prod,
  outfile: "main.js",
});

if (prod) {
  await ctx.rebuild();
  const size = (await stat("main.js")).size;
  if (size >= MAX_BYTES) {
    console.error(`main.js is ${size} bytes; Obsidian Sync Standard carries files under ${MAX_BYTES}.`);
    process.exit(1);
  }
  process.exit(0);
} else {
  await ctx.watch();
}
