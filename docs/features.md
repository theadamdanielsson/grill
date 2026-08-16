# Features

The full explanation of how Grill's features actually work. The [README](../README.md) covers the pitch and quick start; this is the detail.

## What it keeps track of

Grill schedules you per concept, not per note. It pulls the concepts out of a note (its headings, definitions, bold terms, formulas, and any flashcards you've already written) and tracks each one on its own. That matters for anything bigger than a one-idea note: a chapter note doesn't count as "known" because you got one lucky question right, it keeps coming back until you've actually been tested across its parts. Each concept rides FSRS, the spaced-repetition algorithm Anki switched to: get it right and it won't come up again for a while, get it wrong and it's back next time. The questions climb in difficulty as you go, easy while a concept is new, harder once you've recalled it a few times spaced out. And if you edit a note, only the concepts you actually changed re-open for review; the rest stay put.

The schedule lives in `Grill/concepts.json`, and your per-note history and the misconception notes in `Grill/mastery.json`, both plain files in your vault. Each session also gets saved as a normal note under `Grill/Sessions/`, linked to whatever it quizzed you on, so a note's backlinks show its quiz history. The "Open progress dashboard" command puts it together: your arc, what you keep getting wrong, your coverage per folder, and a heatmap of your reviews.

**Your arc** is a short, synthesized read on how you've actually changed, not just a stat readout: what used to trip you up and doesn't anymore, what's still recurring, and one sentence naming a real shift if there is one. It needs a few days of real history before it has anything honest to say, so it stays quiet until you've studied on at least 3 separate days, then refreshes every 3 study days after that — never on a timer, and never just from opening the dashboard. It only runs with a configured AI provider (no key, no arc), and it only ever looks at your already-computed misconception counts and past session headlines, never raw note text, so it stays cheap and fast regardless of how much you've studied.

Your API key, settings, and the arc's own small log of recent study days sit in the plugin's own data, not scattered through your notes.

## How it adapts

Miss a question and Grill doesn't just mark it wrong and move on. If the note you missed builds on another through your `[[links]]`, and you're shaky on that foundation, Grill pulls it in next, quizzes you on it, and tells you why you were sent there, then carries on where you left off. A wrong answer is a signal about what you're missing underneath, not just a score.

It's also fussy about its own questions. Before one reaches you it's checked for the usual model slop, yes/no questions, hints that give the game away, questions that aren't actually grounded in your note, and quietly dropped if it fails. No extra model call, so it works the same on a local model as on a paid one.

## Links you haven't made yet

Because your notes live in a graph, Grill can also find the links you *haven't* made. In an AI session it looks for two of your notes that clearly belong together but aren't linked, quizzes you on the connection, and offers a one-tap **Link these notes** button that writes the `[[link]]` into the note for you. Answer it and your graph gets a little denser: the AI working *inside* your graph, not beside it. You can turn it off, or change how many it adds per session, in settings.

## Writing your own questions

Sometimes you know exactly what you want to be asked. Drop a callout into any note:

```
> [!grill] Why does IFRS 16 move operating leases on-balance-sheet?
> A: They become a right-of-use asset and a lease liability.
> rubric: mentions right-of-use asset, lease liability, on-balance-sheet
```

Grill asks it verbatim, schedules it alongside everything else, and marks your typed answer against your rubric (or, when you don't write one, against the note). The `A:` and `rubric:` lines are both optional. Because it's a callout it folds away and never clutters your prose, and if you already keep `Question:: answer` flashcards, those still work as they always did.

If the answer is exactly `Vero`, `Falso`, `True`, or `False`, Grill notices and renders it as a proper True/False button pair instead of a free-text box. Add a `choices:` line to get multiple-choice or select-all-that-apply the same way:

```
> [!grill] Which standard covers leases?
> choices: IFRS 9, IFRS 15, IFRS 16
> A: IFRS 16
```

One answer among the choices renders as multiple-choice; list two or more (comma-separated, all of them among `choices:`) and it becomes select-all. An answer that doesn't cleanly match the listed choices just falls back to the ordinary free-text box rather than showing a broken button set.

## Fixing a cached question

A question the AI wrote you can edit rather than just delete. The pencil icon on the home screen (present once you've reviewed anything at all, even at zero currently due) opens **Manage questions**: every cached question, grouped by note, searchable, collapsed to a one-line preview until you open one. Editing covers the question text, the expected answer, hints, and rubric, plus — for multiple-choice, select-all, and match questions — the full choice or pair list, not just their text. Saving doesn't reset that concept's schedule or mastery, the same as editing the source note doesn't. It only covers what the AI (or no-key mode) generated; a question you wrote yourself in a `> [!grill]` callout is just text in your note, so edit it there.

## PDFs

A lot of real study material lives in a PDF, not a note: an exercise sheet, a lecture slide deck, a scanned reading. Embed one in a note (`![[worksheet.pdf]]`, not just a plain `[[link]]` — the `!` is what makes it an embed) and Grill pulls its text out and quizzes on it exactly like anything you'd typed yourself, no separate setup. If the PDF is itself a worksheet with its own numbered questions, Grill notices and prefers asking those over inventing new ones, using any worked solution in the PDF as the answer key.

A few limits worth knowing: it reads up to 40 pages per PDF, text only (a scanned page with no real text layer under it, or a password-protected file, is invisible to it), and it's read via Obsidian's own PDF engine, so nothing extra gets installed.

## Telling it how to quiz you

There's a file at `Grill/Instructions.md` (open it from the settings, or the "Open persona & instructions" command) with two parts. **Persona** is who Grill is and how it talks: the default is shown there, editable, so you can turn it into a strict examiner, a gentle Socratic guide, a blunt drill sergeant, whatever you like. **Instructions** is how you want to be quizzed and graded, in plain sentences: "Prefer numeric problems." "Ask me to explain things in my own words." "Be strict on terminology." "Accept bullet-point answers." Both get folded into every session; leave them blank for the defaults.

Changing the persona only changes Grill's voice. How questions are built and how answers are scored is fixed by the engine, so your grades stay consistent no matter what you write.

## Your knowledge graph

Open Grill and you land on your **knowledge graph**: every note Grill studies, drawn as a map. It starts grey. As you practise, each note colours in by how well you know it (green known, amber shaky) and grows with how durably you know it, and the links between notes you've both learned brighten. It's the same idea as a fill-in-the-map game: you're colouring in your own knowledge by proving you've learned it. Pick a folder or tag and that slice lights up so you can see exactly what a session will cover; finish the session and watch the map change.

This is a *learning* graph (what you've proven), which is a different thing from Obsidian's own graph of what you've written. On first run Grill asks which folders are its territory (leave it blank for the whole vault); change it any time under settings.

## Look and feel

Grill borrows your theme's colours and spacing so it doesn't clash. The settings cover the usual stuff (compact layout, the progress bar, hiding the note name so it doesn't give the answer away). If you want to fiddle further it exposes a few CSS variables and works with the Style Settings plugin.
