# Troubleshooting

Most of what looks like a bug is Grill's scheduling being stricter than it feels like it should
be. This explains the actual mechanics behind the common ones, not just "try toggling it."

---

## "Couldn't find concepts to quiz in these notes"

No-key ("From my notes") mode builds questions only from structure it can find: bold terms,
`==highlights==`, headings with real prose under them, `Term: definition` lines, formulas, and
any flashcards you've already written (Obsidian Spaced Repetition or Anki cloze syntax). A note
that's mostly unstructured prose gives it nothing to work with. Either add some structure, or
switch **Where questions come from** to AI, which can write questions from prose directly.

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

Two separate mechanisms can cause this, and they stack:

1. **Caching.** Once the AI writes a question for a concept, Grill reuses that exact text on the
   concept's next review instead of paying for a fresh model call every time. Settings →
   **"Reuse generated questions"** controls this: at its default of "Always reuse," you'll see the
   literal same question every time that concept resurfaces. Raise it (try 3-5) and a fresh
   variant gets written after that many repeats. A "fresh" variant used to only mean a new model
   call, not necessarily different wording — the model had no memory of what it had already
   written for that concept, so a regenerated question could land as a near-restatement of the one
   it was replacing. Fixed in a recent update: the model is now shown what it's already asked and
   told to write a genuinely different angle, with a second check that catches near-duplicates even
   if it doesn't comply.
2. **A small studied slice.** If your session scope (or the vault) is large but only a handful of
   notes ever actually get selected into a session, the same few concepts recur simply because
   they're the only ones in rotation. This was also a real bug — the note-selection order wasn't
   spread across folders/topics, so a scope spanning several chapters could quietly collapse onto
   whichever one sorted first — fixed in a recent update. If you're still seeing heavy repetition
   after updating and raising the reuse setting, your studied notes may genuinely be a small
   fraction of your vault; the fix helps it spread out over more sessions, not instantly.

## A model quizzed me on a chapter title or section name, not real material

Fixed: a sparse note (almost no extractable structure) used to fall back to one concept labelled
with the note's own file name, and the model sometimes asked about that label as if it were the
topic. The fallback now labels itself from the actual first line of real content instead, and the
prompt explicitly tells the model never to test a title, heading, or filename as if it were the
subject. If you still hit this on a current version, the note likely has close to no real content
at all (an empty note, or one that's essentially just a link) — give it some real structure, or
some real prose, so there's actual material to test.

## A model isn't reading the images in my note

Not every model can. Settings → **"Send images to the model"** only does anything for models that
actually support vision (Claude, GPT-4o/GPT-5, Gemini, and vision-tagged Ollama models like
`llava` or `qwen2.5vl`); everything else silently gets text only, even with the toggle on. Grill
now shows a notice at the start of a session when this happens, naming the model and why. If you
want images included, switch to one of the vision-capable models above.

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
