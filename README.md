# Grill

Get grilled on your own notes.

Every AI plugin for Obsidian is a chatbot over your vault: ask it something, it answers,
it forgets. That's fine for lookup, but it's not studying — a tutor that doesn't track
what you already know just re-asks the same things forever. Grill tracks it. It writes
quiz questions from your notes, grades what you type back, and remembers the result per
note, so sessions concentrate on what you actually get wrong instead of drifting.

![Grill: open it, start a session, answer, get graded with specific feedback](docs/grill-demo.gif)

## How it works

Grill picks the notes most worth quizzing — struggling first, then due for review, then
untested — and has your model write a handful of questions, each with a grading rubric
and three tiers of hints generated alongside it. You answer from memory. Hints never give
away the answer; giving up costs nothing and shows the expected answer immediately.
Grading is strict on substance and generous on wording, gives explicit partial credit, and
won't invent an error it can't point to in your answer. A miss is tagged with the specific
misconception behind it, and that tag gets fed into the next question that targets the
same note.

Scheduling is FSRS-4.5: each note has a stability and difficulty estimate that determines
when it comes back, not a fixed interval. A correct answer pushes the note further out; a
miss brings it back immediately.

Works with Anthropic, OpenAI, Gemini, DeepSeek, or a local Ollama model — bring your own
key, model lists are fetched live from whichever provider you pick.

## Mastery on your graph

Turn on "Write mastery to note properties" and Grill mirrors each quizzed note's state
into frontmatter (`grill-status: known | struggling | untested`, `grill-due`). Three graph
view groups turn that into a heatmap of what you actually know:

- `["grill-status":known]` in green
- `["grill-status":struggling]` in red
- `["grill-status":untested]` in gray

The same properties are queryable from Dataview and Bases. Session transcripts wiki-link
the notes they quizzed, so a note's backlinks show its quiz history; add
`-path:"Grill/"` to the graph filter if you'd rather keep sessions out of the graph.

## Storage

Two kinds of state, kept separately:

- API keys and UI settings live in the plugin's own local data, never in your notes.
- Mastery (`Grill/mastery.json`) and session transcripts (`Grill/Sessions/*.md`) are plain
  files in your vault — read them, edit them, sync them like any note.

## Network use and privacy

Grill sends requests only to the provider you configure, on your own key: the selected
notes' text, the generated questions, and your answers, so it can generate and grade
questions. With Ollama, requests go only to your local server and nothing leaves your
machine — at the cost of slower sessions and weaker questions from small local models.
There's no telemetry, no account, and no server of ours in the loop.

## Appearance

Grill follows your theme by default. Beyond the built-in Appearance settings (compact
layout, progress bar, hiding the note name during questions), it exposes CSS variables
(`--grill-max-width`, `--grill-progress-height`, `--grill-correct`, `--grill-partial`,
`--grill-incorrect`) and a Style Settings block, so its look is configurable the same way
an Obsidian theme is.

## Install

Not yet in the community plugin directory. Until then:

```sh
npm install
npm run build        # typecheck + bundle to main.js
```

Copy `main.js`, `manifest.json`, `styles.css` into
`<vault>/.obsidian/plugins/grill/` and enable it under Community plugins.

## License

MIT
