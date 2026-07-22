# Grill

Grill quizzes you on your own notes and keeps track of what you get wrong.

It reads the notes in your vault, has a model you pick (Claude, GPT, Gemini, DeepSeek,
or a local Ollama model) write questions about them, and grades what you type back. After
each answer it records how you did on that note, so the next session spends its questions
on the material you're shakiest on rather than the things you already know. There are no
flashcards to write. Your notes are the source.

![Grill: open it, start a session, answer, get graded with specific feedback](docs/grill-demo.gif)

## What a session looks like

Open the panel and start a session. Grill picks a handful of notes (the ones you've been
getting wrong, then the ones due for review, then ones you haven't seen) and writes
questions from them two at a time, so the first one shows up in a few seconds instead of
after the whole set is ready. You answer from memory and submit.

![A question drawn from a note, with the vault's graph alongside it](docs/screenshot-question.png)

Grading is done by the same model against a short rubric it wrote alongside the question.
It gives partial credit, and it won't claim you made a mistake it can't point to in your
answer. When you get something wrong it names the specific misconception, and that gets
handed to the next question about that note so the same confusion comes up again. If
you're stuck there are three hints that stop short of the answer, and "I don't know" shows
you the expected answer and moves on.

![A partially correct answer, graded with specific feedback and the expected answer](docs/screenshot-feedback.png)

## What it remembers

Each note carries a review schedule. Grill uses FSRS-4.5, the algorithm Anki's newer
scheduler is built on: a stability and difficulty estimate per note rather than a fixed
interval. Answer correctly and the note comes back later; miss it and it comes back next
session. The counts, the schedule, and the misconception tags live in `Grill/mastery.json`
in your vault. Each session is also written out as an ordinary note under
`Grill/Sessions/`, wiki-linked to the notes it covered, so a note's backlinks show its quiz
history.

Your API keys and the plugin's settings stay in the plugin's local data, not in your notes.

## Mastery in the graph

Turn on "Write mastery to note properties" and Grill adds `grill-status` (known,
struggling, or untested) and `grill-due` to the frontmatter of notes it has quizzed. Add
three graph groups and the graph colours itself by what you know:

- `["grill-status":known]` green
- `["grill-status":struggling]` red
- `["grill-status":untested]` grey

Dataview and Bases can read the same properties. To keep session transcripts out of the
graph, add `-path:"Grill/"` to the graph filter.

## Providers and cost

Grill calls whichever provider you set a key for. Nothing goes anywhere else, and there's
no account or server of ours in between. The notes it selects, the questions, and your
answers are sent to that provider so it can write and grade questions, so it costs API
tokens; how much depends on how many notes you send as context and how many questions you
ask for, both of which are settings.

Ollama is the exception. It runs on your own machine, so nothing leaves it. The trade is
speed and quality: small local models write noticeably weaker questions than the cloud
ones. 8B and up is usable.

## Limits worth knowing

- It needs an API key, or a local Ollama install. There is no free hosted option.
- Question quality tracks your notes. Thin or messy notes make thin or messy questions.
- Grading is a model's judgement, not an answer key. It is usually fair but can be wrong;
  the expected answer is always shown, so you can overrule it in your head.
- Local models are the weak point. Use them for privacy, not for the best questions.

## Appearance

Grill uses your theme's colours and spacing. The settings cover the common tweaks (compact
layout, progress bar, hiding the note name while you answer). For finer control it exposes
CSS variables (`--grill-max-width`, `--grill-progress-height`, and the three verdict
colours) and a Style Settings block, so you can restyle it from a snippet or the Style
Settings plugin.

## Install

Search for "Grill" in Settings, Community plugins, Browse.

To build from source:

```sh
npm install
npm run build
```

Then copy `main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/grill/`.

## License

MIT
