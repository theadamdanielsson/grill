# Troubleshooting

Most of what looks like a bug is Grill's scheduling being stricter than it feels like it should
be. This explains the actual mechanics behind the common ones, not just "try toggling it."

---

## "Couldn't find concepts to quiz in these notes"

The notes in scope have too little in them to ask about. Grill draws concepts from headings with prose under them, bold terms, `==highlights==`, `Term: definition` lines, formulas, and any flashcards you have already written. A note of a sentence or two yields too few for a session, and the home screen says so when the open note is too short to test. Add to the note, or widen the scope.

## Chat says it cannot edit my notes

The engine answering has no tools. Gemini and Ollama answer in text only, so they can offer a version to paste and nothing more. Grill Cloud, keys for Anthropic, OpenAI and DeepSeek, OpenAI-compatible endpoints, Claude Code and Codex can all change notes. Switch with the engine button under the chat box, and check that the level beside it is Safe or Auto: at Plan, nothing may be changed.

## The engine button opens settings, or Claude Code or Codex will not start

The button steps through the engines found on this computer, and opens settings when only the model is available. Grill looks for Claude Code and Codex in the usual install folders. If yours is elsewhere, give the full path under Claude Code location or Codex location in settings; `which claude` or `which codex` in a terminal prints it.

A message that the program is not signed in means what it says: open a terminal, run `claude` or `codex`, and sign in there. Grill uses that sign-in and has none of its own. These engines run on desktop only.

## Chat changed a note and I want the old text back

A change made through Chat is an ordinary edit, shown on the permission card before it is made unless the level is Auto. Grill keeps no copy of the earlier text. Obsidian's File recovery (Settings → Core plugins) holds snapshots of recent versions, and your sync history or version control holds more.

## A Chat reply arrives all at once

Replies are shown as they are written wherever the provider allows a request to be read in pieces from inside Obsidian. Where it does not (some OpenAI-compatible endpoints and local proxies), Grill falls back to fetching the reply whole. Nothing is lost; it appears later.

## A note I aced doesn't turn green

Grill schedules per *concept*, not per note — a note is "known" only once most of its individual
concepts (headings, terms, definitions, formulas) have each been answered correctly **twice in a
row**, not once. One correct answer is deliberately treated as provisional, not proof: a
multi-concept note shouldn't read as mastered off one lucky question. On top of that, FSRS never
re-shows something the same day you got it right — the minimum gap before a second confirmation
is about a day. So on a note you're actively studying right now, "green" genuinely can't happen
yet no matter how well you're doing; it needs a second pass, on a later day, on each of its parts.

If you want to see the real numbers behind the colour, open the progress dashboard — it shows
concepts tested vs. confirmed-known per note, not just a status dot.

## Due count doesn't shrink, or looks like it grew after a due session

This was a real bug in versions before the fix landed: "Review N due now" was silently capped by
the same small per-sitting question count as a regular study session (5 by default), so clicking
it only ever reviewed a handful of the N it promised, and a note doesn't leave the due pile until
*all* of its due concepts are re-cleared, not just one. Meanwhile other concepts keep lapsing into
due status in the background. Net effect: the due count barely moved, or looked like it grew,
no matter how many due sessions you ran. Update to the latest version — due sessions now size
themselves to the actual backlog instead of the generic session-length setting.

## The same question keeps coming back

This is by design: once Grill writes a question for a concept, it reuses that
exact text on every later review of it, indefinitely — never silently reworded. If you want to
change how a specific question reads, edit it directly (see below); if you want everything to get
a fresh pass, the command palette's **"Grill: Clear cached questions"** forces the next review of
every concept to write a new one.

This used to work differently, and the difference is worth knowing if you're returning to Grill
after a while: a due concept older than a day used to always get a freshly *written* variant
instead of reusing the cached text, on the theory that recognizing an identical sentence from days
ago isn't a real memory test. In practice this reliably drifted the actual *content* being tested,
not just its phrasing — on precision material (an exact grammar rule, a specific number, a formula)
a "fresher" variant could land as a genuinely different, sometimes wrong, question. Removed outright
in a recent update, not made optional: the model now only ever writes a question once per concept.

If you're still seeing heavy repetition after updating, check whether your session scope (or the
vault) is large but only a handful of notes ever actually get selected into a session — the same
few concepts recur simply because they're the only ones in rotation. That was also a real bug (the
note-selection order wasn't spread across folders/topics, so a scope spanning several chapters
could quietly collapse onto whichever one sorted first) fixed in a recent update; if it's still
happening, your studied notes may genuinely be a small fraction of your vault, and the fix helps
that spread out over more sessions, not instantly.

## A cached question is wrong, and I don't want to just delete it

Open **Questions** from the foot of the home screen. It lists every question Grill has written, with a view of those last missed, each editable in place: the question text, the expected answer, hints and rubric, and for multiple-choice, select-all and matching questions the choices or pairs. Editing leaves that concept's progress and schedule as they were. Questions you wrote yourself in a `> [!grill]` callout are text in your note and are edited there. "Bad question"
mid-review is still the fastest path if you just want it gone rather than fixed.

## A model quizzed me on a chapter title or section name, not real material

Fixed: a sparse note (almost no extractable structure) used to fall back to one concept labelled
with the note's own file name, and the model sometimes asked about that label as if it were the
topic. The fallback now labels itself from the actual first line of real content instead, and the
prompt explicitly tells the model never to test a title, heading, or filename as if it were the
subject. If you still hit this on a current version, the note likely has close to no real content
at all (an empty note, or one that's essentially just a link) — give it some real structure, or
some real prose, so there's actual material to test.

## A model isn't reading the images in my note

Not every model can. Grill sends a note's images automatically, but only to models that actually
support vision (Claude, GPT-4o/GPT-5, Gemini, and vision-tagged Ollama models like `llava` or
`qwen2.5vl`); everything else silently gets text only. Grill shows a notice at the start of a
session when this happens, naming the model and why. If you want images included, switch to one of
the vision-capable models above.

## A PDF I embedded isn't being quizzed on

Two separate requirements, either one missing means nothing gets extracted:

1. **It has to be embedded, not just linked.** `![[worksheet.pdf]]` (with the `!`) is an embed;
   `[[worksheet.pdf]]` (no `!`) is a plain link, and Grill only reads embeds, the same way Obsidian
   only *renders* embeds inline. A note whose only content is that single embed line has nothing
   else for Grill's parser to find, so it falls back to treating the PDF's own extracted text as
   the note's content — see the next section for how that gets broken into questions.
2. **It needs a real text layer.** Grill reads a PDF's text exactly the way you'd copy-paste it —
   through Obsidian's own PDF engine (`loadPdfJs`), not OCR. A scanned page that's actually just a
   picture of text, or a password-protected PDF, has no extractable text at all, so it's invisible
   to Grill the same way it would be to Cmd/Ctrl-F inside Obsidian's own PDF viewer. If you can't
   search the text in Obsidian's native PDF view, Grill can't read it either.

It also only reads the first 40 pages of any single PDF — a safety cap against someone embedding
an entire textbook, not something you'll hit on a normal worksheet or article.

## A worksheet PDF only produced one or two questions, not one per exercise

If the extracted text doesn't parse into headings/terms/definitions Grill recognizes (the common
case for a PDF — it's flat prose to the parser, whatever visual structure the original PDF had),
it falls back to chunking the raw text into schedulable pieces. If the worksheet numbers its own
items in a recognizable way — "Question 7", "Problem 3", "Exercise 2" — Grill detects that and
chunks on those boundaries, one concept per exercise. If it doesn't (a different numbering style,
a different language, or just plain prose with no numbered items), it falls back to even-sized
slices instead — still fully covers the document, just not aligned to its own structure. Either
way, AI mode also actively prefers reusing the PDF's own question wording (and its worked solution
as the answer key, if there is one) over inventing a new question from scratch, so a worksheet
that's already well-posed tends to get asked close to verbatim regardless of which chunking path
it went through.

## Math/formulas look like plain text (`pi^e`) instead of rendering properly

Grill asks the model to write real LaTeX (`$...$`) for any formula, even when your own notes
write math in plain text — Obsidian renders LaTeX natively, so this should show as proper
notation, not literal carets and underscores. If you're still seeing plain text after updating,
it's a specific model not following the instruction reliably; sharper models (Claude, GPT-5,
Gemini) are more consistent about this than small local ones.

## Session notes / "What you keep getting wrong" piling up

Session transcripts are grouped into monthly subfolders under `Grill/Sessions/` so a daily-use
vault doesn't dump hundreds of files into one flat folder. The "What you keep getting wrong" and
"Beaten" lists in the progress dashboard are capped to the ten most-relevant entries on screen
(worst/most-recurring first) — the underlying data isn't deleted, just not all rendered at once,
since a canonical misconception is marked resolved rather than removed.

## API errors, or grading looks wrong

Double-check the API key and the exact model name in settings — a typo'd model ID is the usual
cause of an outright error. Grading is a model's opinion, not gospel: it's usually right but not
infallible, which is why the expected answer is always shown alongside any non-correct verdict —
trust your own judgment over it when they disagree. If a specific provider is erroring
consistently, check that provider's status page and that your key hasn't expired or hit a quota.

## Where is my data, and how do I reset it

Everything Grill knows about you lives in plain files inside your vault's `Grill/` folder
(`mastery.json`, `concepts.json`, `Sessions/`), not anywhere external. Delete the whole `Grill`
folder to wipe everything and start fresh. To reset just one note, find and remove its entry from
`mastery.json` and any `<note>::...` keyed entries from `concepts.json` — back both files up
first, since this is a direct edit with no undo.

## Still stuck

Open an issue with your Obsidian version, OS, which model provider you're on, and what you did.
If the console (Ctrl/Cmd-Shift-I) has an error, paste it — that narrows things down far faster
than a description of the symptom.
