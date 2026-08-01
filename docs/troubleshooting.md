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
   variant gets written after that many repeats.
2. **A small studied slice.** If your session scope (or the vault) is large but only a handful of
   notes ever actually get selected into a session, the same few concepts recur simply because
   they're the only ones in rotation. This was also a real bug — the note-selection order wasn't
   spread across folders/topics, so a scope spanning several chapters could quietly collapse onto
   whichever one sorted first — fixed in a recent update. If you're still seeing heavy repetition
   after updating and raising the reuse setting, your studied notes may genuinely be a small
   fraction of your vault; the fix helps it spread out over more sessions, not instantly.

## A model quizzed me on a chapter title or section name, not real material

Should be rare and is guarded against in the prompt, but can still happen on a very sparse note
(a note with almost no extractable structure falls back to treating the whole note as one
concept, labelled by the note's own title). If you hit this, the fix is the same as for
"couldn't find concepts": give the note some real structure — a heading with a sentence or two
under it, a bold term, a definition line — so there's actual material to test instead of just a
label.

## A model isn't reading the images in my note

Not every model can. Settings → **"Send images to the model"** only does anything for models that
actually support vision (Claude, GPT-4o/GPT-5, Gemini, and vision-tagged Ollama models like
`llava` or `qwen2.5vl`); everything else silently gets text only, even with the toggle on. Grill
now shows a notice at the start of a session when this happens, naming the model and why. If you
want images included, switch to one of the vision-capable models above.

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
