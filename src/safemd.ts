/** Text a model wrote is rendered as Markdown by Obsidian itself, with everything that
 * comes with it: remote images are fetched, raw HTML is laid out, and a fenced block
 * is handed to whichever plugin registered its language, which for some (Dataview's
 * `dataviewjs`) means running it as code. A model writes what its prompt leads it to,
 * and the prompt includes the note being studied, which the student may not have
 * written: a shared pack, a web clipping, an imported PDF. So what a model wrote is
 * made inert here before it reaches the renderer, and before it is written into a
 * note in the vault, where it would be rendered again on every opening.
 *
 * What still works afterwards: text, emphasis, lists, tables, links, math, callouts,
 * code blocks in ordinary languages, images and embeds from the vault itself.
 *
 * What is stopped:
 *  - a picture fetched from anywhere but the vault (its address can carry note text out);
 *  - HTML, apart from a few tags that only change how text looks;
 *  - a fenced block in any language but the plain ones listed below, which is shown
 *    as plain code instead of being handed to a plugin;
 *  - inline code that begins the way Dataview's inline queries do.
 *
 * It works on the text alone and does not try to follow Markdown's structure: a rule
 * that depended on knowing "this part is code" could be led into disagreeing with the
 * renderer about where code ends. Each change is therefore one that is harmless
 * wherever it lands. Most are an invisible character (a zero-width space) put where it
 * stops a construct being recognised and changes nothing that is seen.
 *
 * Running it twice changes nothing more.
 */

const ZW = "​";

/** Tags that only change how text looks, allowed when written with no attributes at
 * all. Models use them, in chemistry and maths above all (H<sub>2</sub>O). */
const INERT_TAGS = "br|sub|sup|b|i|u|em|strong|mark|kbd|s|del|small";

/** Languages a fenced block may name: ones Obsidian only highlights. Anything else is
 * a language some plugin may have registered to act on. */
const PLAIN_LANGUAGES = new Set([
	"text", "txt", "plain", "plaintext", "none", "output", "console", "pseudo", "pseudocode", "math",
	"python", "py", "r", "javascript", "js", "jsx", "typescript", "ts", "tsx", "java", "c", "h", "cpp", "c++", "hpp",
	"csharp", "cs", "c#", "go", "golang", "rust", "rs", "swift", "kotlin", "kt", "scala", "ruby", "rb", "php", "perl",
	"lua", "dart", "haskell", "hs", "ocaml", "fsharp", "f#", "elixir", "erlang", "clojure", "lisp", "scheme", "julia",
	"matlab", "octave", "fortran", "pascal", "assembly", "asm", "nasm", "vb", "vba", "vbnet", "basic", "objectivec",
	"sql", "mysql", "postgresql", "postgres", "plsql", "tsql", "sqlite", "graphql", "cypher", "sparql",
	"bash", "sh", "shell", "zsh", "fish", "powershell", "ps1", "bat", "cmd", "batch", "makefile", "make", "cmake",
	"dockerfile", "docker", "nginx", "apache", "terraform", "hcl",
	"html", "xml", "svg", "css", "scss", "sass", "less", "json", "jsonc", "json5", "yaml", "yml", "toml", "ini",
	"csv", "tsv", "properties", "env", "diff", "patch", "git", "regex", "http",
	"markdown", "md", "latex", "tex", "bibtex", "stata", "sas", "spss", "excel", "dax", "solidity", "verilog",
	"vhdl", "prolog", "nix", "zig", "nim", "groovy", "gradle", "protobuf", "proto", "wasm", "abap", "cobol",
]);

/** A picture written in the one plain form, pointing inside the vault: a caption and
 * a relative path. The path may hold nothing that could make it an address elsewhere
 * once the renderer has read it: no colon (a scheme), no "&" or backslash (either can
 * spell a colon, since Markdown decodes both in an address), no space or bracket, and
 * no two slashes at its start. */
const LOCAL_IMAGE = /^!\[[^\[\]\n]*\]\((?![/]{2})[^()\s<>&\\:]+\)/;
/** An embed of something in the vault, held to the same rule. */
const LOCAL_EMBED = /^!\[\[(?![/]{2})[^\[\]\n&\\:]+\]\]/;

/** A "<" that would open a tag. The harmless tags are let through only when written
 * whole on one line: across a line break, a quote's ">" marker on the next line could
 * pass for the tag's end while the renderer reads on to the attributes after it. */
const HTML_OPEN = new RegExp(String.raw`<(?!/?(?:${INERT_TAGS})[ \t]*/?>)(?=[A-Za-z/!?])`, "gi");

/** The opening line of a fenced block, wherever it sits: at the margin, in a quote, in
 * a callout, in a list. */
const FENCE_LINE = /^((?:[ \t]*(?:>|[-*+]|\d{1,9}[.)]))*[ \t]*)(`{3,}|~{3,})(.*)$/;

function safeFences(text: string): string {
	return text
		.split("\n")
		.map((line) => {
			const m = FENCE_LINE.exec(line.replace(/\r$/, ""));
			if (!m) return line;
			const [, lead, fence, rest] = m;
			// Backticks later on the line: this is inline code, not a fence. Left to the
			// inline rule.
			if (fence[0] === "`" && rest.includes("`")) return line;
			const info = rest.trim();
			if (!info) return line;
			const language = info.split(/\s+/)[0].toLowerCase();
			// The language alone if it is a plain one, with whatever followed it dropped;
			// otherwise no language at all, which makes it plain code.
			return lead + fence + (PLAIN_LANGUAGES.has(language) ? language : "");
		})
		.join("\n");
}

/** Make text a model wrote safe to render as Markdown, or to write into a note. */
export function safeMarkdown(text: string): string {
	if (!text) return text;
	return (
		safeFences(text)
			// HTML: a "<" that would open a tag no longer does.
			.replace(HTML_OPEN, "<" + ZW)
			// Pictures and embeds: kept when they plainly point inside the vault, otherwise
			// the "!" is parted from its bracket, which leaves a link nobody has to follow.
			.replace(/!(?=\[)/g, (bang, at: number, whole: string) => {
				const here = whole.slice(at, at + 2000);
				return LOCAL_EMBED.test(here) || LOCAL_IMAGE.test(here) ? bang : bang + ZW;
			})
			// Inline code that begins as a Dataview inline query ("= ..." or "$= ...", the
			// second of which runs as JavaScript where that is switched on).
			// It may begin on the next line, past a quote's ">" marker.
			.replace(/(`+)([\s>]*)(\$?=)/g, `$1$2${ZW}$3`)
	);
}

/** Make a Mermaid diagram a model wrote safe to render: no directives (which can
 * loosen Mermaid's own safety settings or restyle the page), no click actions, no
 * script addresses, no HTML in labels beyond a line break. A diagram that tries to
 * close its own code block is dropped whole. */
export function safeDiagram(body: string): string {
	if (!body) return "";
	if (/```|~~~/.test(body)) return "";
	return body
		.replace(/%%\{[\s\S]*?\}%%/g, "")
		.split("\n")
		.filter((line) => !/^\s*click\b/i.test(line) && !/%%\{/.test(line))
		.join("\n")
		.replace(/(?:java|vb)script\s*:/gi, "")
		.replace(HTML_OPEN, "<" + ZW)
		.trim();
}
