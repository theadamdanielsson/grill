import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
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
  outfile: "main.js",
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
