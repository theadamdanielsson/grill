# Features

How Grill's features work. The [README](../README.md) covers what Grill is and how to start; this page gives the detail.

## Chat

Chat is a conversation about your notes in which nothing is graded. It opens on the note you have beside it, shown as a chip on the message that you can remove, and it answers from four sources: that note, the notes it links to or that match your words, a map of every note in the vault, and Grill's record of how you have done on the note. Specifically, the record carries how each concept has gone, what you answered in past sessions and how it was marked, and what you have asked about before. A reply can therefore begin from the step you keep missing, which a general explanation would have no way of knowing.

Chat can also act. Where the engine supports it, the model may read a note, search the vault, list notes, change part of a note, rewrite a note, or create one. Each of these is listed above the reply as it happens, and a finished reply carries one line summing them up. In turn, a change to a note passes through a permission card that shows the lines to be removed and the lines to be added, with three answers: Allow once, Always allow in this chat, and Deny.

Three levels decide when the card appears. Safe asks before any change to a note and before any command. Plan lets the engine read and propose, and nothing is changed. Auto lets it edit notes in the vault without asking. The level is set with the button beside the engine's name under the chat box.

A reply is written to the screen as the model produces it. Under each reply, Insert at cursor places it in the note you are editing and Save as note keeps it as a note of its own beside the one it was about. Every conversation is saved under `Grill/Learn/`, and Test me on this starts a test on the note the conversation concerned.

Chat can be started from text selected in a note. A right-click on the selection opens a Grill entry with four actions, which are also in the command list: Ask about this holds the passage above the chat box for a question to be typed, Explain and Rewrite send at once, and Make a note asks for a note written from the passage. In turn, the two actions under each reply complete the last two, since Insert at cursor replaces the text still selected and Save as note keeps the reply as a note of its own.

A saved prompt is a note in `Grill/Prompts/`, named for what it does, whose text is sent as written. The command New saved prompt creates one, and Run a saved prompt sends one in a Chat about the open note, with any selected text quoted beneath it or placed where the prompt says `{{selection}}`. Once a prompt exists, a Prompts button under the chat box places one in the box, where it can be changed before it is sent.

## Engines

An engine is what answers in Chat, and the button under the chat box steps through the ones available. Four kinds exist. Grill Cloud needs no setup and runs on a monthly plan once the free credits are used. A key of your own sends requests straight to the provider you chose. Claude Code, Codex and opencode run the program installed on your computer, under the sign-in you made there, with the vault as the working folder. Grill can install opencode, whose free models need no account. Ollama runs a model on your own machine.

Where an engine offers a choice of model, a second button under the chat box names the model in use and opens the list. With a key of your own, the list is the one on your account, and the model chosen there also writes and marks tests. With Claude Code, the choice is among its default, Opus, Sonnet and Haiku. Grill Cloud and Codex offer no choice here.

The engines differ in what they can do in the vault. Grill Cloud and keys for Anthropic, OpenAI, DeepSeek and OpenAI-compatible endpoints use Grill's own note tools, which the plugin carries out through Obsidian; these work on a phone as on a desktop, and they cannot reach outside the vault or into Grill's own folder. Claude Code, Codex and opencode bring their own tools, shell commands included, and their own permission systems, which Grill passes through unchanged; they run on desktop only. Gemini and Ollama answer in text and change nothing.

Tests are a separate matter. Questions are written and graded by Grill Cloud, your own key or Ollama, whichever is chosen as the provider in settings. Only when none of these is set up are tests written and graded by the program Chat runs on.

## Tests

A test is the part that counts. Grill writes questions from the notes in scope, you answer from memory, and each answer is marked against a rubric written with the question, with partial credit, specific feedback and the expected answer. The home screen's Test tab offers a few starting points drawn from the record: Retry my misses, Review what is due, Something new, the note you have open, and Catch up when a backlog has built. You can also type what to be tested on, and Grill matches it to your notes.

The answer box accepts a question as well as an answer. When what you type is a question about the material, Grill answers it under the question in hand and the record notes that help was needed. Hints are off by default, since a test is meant to show what you can recall unaided; a setting turns them on, and using one lowers what a correct answer counts for.

The Questions screen lists every question Grill has written, with a view of those last missed. A question can be edited there: its text, expected answer, hints and rubric, and for multiple-choice, select-all and matching questions the choices or pairs as well. Saving an edit leaves the concept's schedule as it was. A question you wrote yourself in a `> [!grill]` callout is text in your note and is edited there.

## What it keeps track of

Grill schedules you per concept, not per note. It pulls the concepts out of a note (its headings, definitions, bold terms, formulas, and any flashcards you've already written) and tracks each one on its own. That matters for anything bigger than a one-idea note: a chapter note doesn't count as "known" because you got one lucky question right, it keeps coming back until you've actually been tested across its parts. Each concept rides FSRS, the spaced-repetition algorithm Anki switched to: get it right and it won't come up again for a while, get it wrong and it's back next time. The questions climb in difficulty as you go, easy while a concept is new, harder once you've recalled it a few times spaced out. And if you edit a note, only the concepts you actually changed re-open for review; the rest stay put.

The schedule lives in `Grill/concepts.json`, and your per-note history and the misconception notes in `Grill/mastery.json`, both plain files in your vault. Each session also gets saved as a normal note under `Grill/Sessions/`, linked to whatever it quizzed you on, so a note's backlinks show its quiz history. The Progress screen, opened from the home screen or with the "Open progress dashboard" command, puts it together: your arc, what you keep getting wrong, your coverage per folder, the map of your notes, and a heatmap of your reviews.

**Your arc** is a short, synthesized read on how you've actually changed, not just a stat readout: what used to trip you up and doesn't anymore, what's still recurring, and one sentence naming a real shift if there is one. It needs a few days of real history before it has anything honest to say, so it stays quiet until you've studied on at least 3 separate days, then refreshes every 3 study days after that — never on a timer, and never just from opening the dashboard. It only ever looks at your already-computed misconception counts and past session headlines, never raw note text, so it stays cheap and fast regardless of how much you've studied.

Your API key, settings, and the arc's own small log of recent study days sit in the plugin's own data, not scattered through your notes.

## How it adapts

Miss a question and Grill doesn't just mark it wrong and move on. If the note you missed builds on another through your `[[links]]`, and you're shaky on that foundation, Grill pulls it in next, quizzes you on it, and tells you why you were sent there, then carries on where you left off. A wrong answer is a signal about what you're missing underneath, not just a score.

It tunes itself, too, rather than asking you to. Grading double-checks itself only on the
answers where a model actually tends to be too generous (a partial verdict, or a "correct"
on an answer visibly thinner than the expected one), so the accuracy costs a fraction of what
checking everything would. Every fourth question asks how sure you were, enough to tell you in
the debrief when you're leaning over- or underconfident without taxing every answer. And once
you've built up enough review history, Grill fits the spaced-repetition weights to how *you*
actually forget, instead of the population average the algorithm ships with. There is no button to
find, it just happens and tells you.

It's also fussy about its own questions. Before one reaches you it's checked for the usual model slop, yes/no questions, hints that give the game away, questions that aren't actually grounded in your note, and quietly dropped if it fails. No extra model call, so it works the same on a local model as on a paid one.

## Links you haven't made yet

Because your notes live in a graph, Grill can also find the links you *haven't* made. In a session it looks for two of your notes that clearly belong together but aren't linked, quizzes you on the connection, and offers a one-tap **Link these notes** button that writes the `[[link]]` into the note for you. Answer it and your graph gets a little denser: the AI working *inside* your graph, not beside it. How many appear depends on how many pairs Grill confirms are related in that session, and a session with none shows none.

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

## PDFs

A lot of real study material lives in a PDF, not a note: an exercise sheet, a lecture slide deck, a scanned reading. Embed one in a note (`![[worksheet.pdf]]`, not just a plain `[[link]]`; the `!` is what makes it an embed) and Grill pulls its text out and quizzes on it exactly like anything you'd typed yourself, no separate setup. If the PDF is itself a worksheet with its own numbered questions, Grill notices and prefers asking those over inventing new ones, using any worked solution in the PDF as the answer key.

A few limits worth knowing: it reads up to 40 pages per PDF, text only (a scanned page with no real text layer under it, or a password-protected file, is invisible to it), and it's read via Obsidian's own PDF engine, so nothing extra gets installed.

## Telling it how to quiz you

There's a file at `Grill/Instructions.md` (open it from the settings, or the "Open persona & instructions" command) with two parts. **Persona** is who Grill is and how it talks: the default is shown there, editable, so you can turn it into a strict examiner, a gentle Socratic guide, a blunt drill sergeant, whatever you like. **Instructions** is how you want to be quizzed and graded, in plain sentences: "Prefer numeric problems." "Ask me to explain things in my own words." "Be strict on terminology." "Accept bullet-point answers." Both get folded into every session; leave them blank for the defaults.

Changing the persona only changes Grill's voice. How questions are built and how answers are scored is fixed by the engine, so your grades stay consistent no matter what you write.

## Your knowledge graph

The Progress screen draws every note Grill studies as a map. It starts grey. As you practise, each note takes a colour for how well you know it (green for known, amber for shaky) and grows with how durably you know it, and the links between notes you have both learned brighten. This is a graph of what you have shown you know, which differs in kind from Obsidian's graph of what you have written. Grill studies your whole vault unless you pick folders on first run, and the choice can be changed in settings.

## Look and feel

Grill borrows your theme's colours and spacing so it doesn't clash. There's nothing to configure: the layout tightens itself when the pane is narrow, and a note's name is hidden during a question only when its own words would give that question's answer away, rather than always or never. If you want to fiddle further it exposes a few CSS variables and works with the Style Settings plugin.
