# Contributing

Thanks for looking. Grill is a small plugin and I'm happy to take patches, but a few
notes will save us both some back-and-forth.

## Before you open a PR

- **Open an issue first for anything non-trivial.** A quick "I want to add X, planning to
  do it like Y" saves you writing code I might not merge. Typos and one-line fixes don't
  need this.
- **One change per PR.** A focused diff gets reviewed and merged faster than a grab-bag.

## Running it locally

```sh
npm install
npm run build      # type-check + bundle to main.js
npm run dev        # watch mode while you work
```

To try your build, copy `main.js`, `manifest.json`, and `styles.css` into a vault at
`<vault>/.obsidian/plugins/grill/` and reload Obsidian (or use the Hot-Reload plugin).
I keep a throwaway test vault for this so I'm not quizzing myself on my real notes while
debugging.

## What I care about in a patch

- **It builds clean and the tests pass.** `npm run build` must pass with no type errors,
  and `npm test` must stay green. The tests run against fakes, so they need no key and
  spend nothing.
- **No `any`.** The Obsidian review bot flags `@typescript-eslint/no-unsafe-*`, so the
  code is fully typed and I'd like to keep it that way. If you're reaching for `any`,
  there's usually a real type for it in `obsidian.d.ts`.
- **Match the surrounding style.** Tabs, plain punctuation, comments that say *why* not
  *what*. Look at a nearby file and copy its shape.
- **Keep it local-first.** No accounts, no analytics, no telemetry. Grill talks to the
  model provider the user chose. The one server of mine is Grill Cloud, and only when
  the user turns it on. Anything that phones home somewhere else won't get merged.
- **Don't change a user's notes without their say.** Chat edits notes through the
  permission levels, and on Safe every change is shown on a card first. Anything else
  that writes into a note (like adding a `[[link]]`) is button-gated. Grill's own state
  and session files stay in its folder.
- **Model text is untrusted.** Anything a model wrote goes through `src/safemd.ts` before
  it is rendered.

## The rough layout

- `src/main.ts`: plugin entry, commands, settings tab.
- `src/view.ts`: the panel: the home screen, Chat, and the test session from question
  to grade.
- `src/home.ts`, `src/suggest.ts`, `src/thread.ts`: the home screen's suggestions and the
  session shown as a thread.
- `src/llm.ts`: the multi-provider model layer and the question, grading and chat prompts.
- `src/stream.ts`: replies read as they are written.
- `src/vaulttools.ts`: the note tools Chat uses on Grill Cloud and on your own key.
- `src/agent.ts`, `src/codex.ts`: Claude Code and Codex as the engine behind Chat.
- `src/learn.ts`: what a conversation about a note is given to read.
- `src/concepts.ts`, `src/mastery.ts`: per-concept FSRS scheduling and what to ask next.
- `src/store.ts`: reading and writing the Grill folder (schedule, questions, sessions).
- `src/cloud.ts`: the Grill Cloud client.
- `src/safemd.ts`: makes model text inert before it is rendered.
- `src/graph.ts`, `src/mapview.ts`: the map on the Progress screen.
- `src/images.ts`, `src/pdf.ts`: embedded images and PDFs as note content.
- `test/`: the test suite, run with `npm test`.

## Reporting bugs

[Open an issue](https://github.com/theadamdanielsson/grill/issues/new/choose). Tell me your
Obsidian version, your OS, which engine or provider you're on, and what you did. If the
console has an error (Ctrl/Cmd-Shift-I), paste it. A screenshot of the panel usually helps
more than a paragraph describing it. Never paste a key.

Questions and ideas go in
[Discussions](https://github.com/theadamdanielsson/grill/discussions). Security problems
are reported privately: see [SECURITY.md](SECURITY.md).

## License

By contributing you agree your work is released under the [MIT License](LICENSE) that
covers the rest of the project.
