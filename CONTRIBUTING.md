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

- **It builds clean.** `npm run build` must pass with no type errors.
- **No `any`.** The Obsidian review bot flags `@typescript-eslint/no-unsafe-*`, so the
  code is fully typed and I'd like to keep it that way. If you're reaching for `any`,
  there's usually a real type for it in `obsidian.d.ts`.
- **Match the surrounding style.** Tabs, plain punctuation, comments that say *why* not
  *what*. Look at a nearby file and copy its shape.
- **Keep it local-first.** No accounts, no servers of mine, no telemetry. The only network
  calls Grill makes are to the model provider the user chose, with the user's own key.
  Anything that phones home somewhere else won't get merged.
- **Don't touch a user's notes unless they asked for it.** Writes to note frontmatter and
  session files are opt-in and stay that way.

## The rough layout

- `src/main.ts` — plugin entry, commands, settings tab.
- `src/view.ts` — the session panel: asking, answering, grading, the flow between them.
- `src/llm.ts` — the multi-provider model layer and the question/grading prompts.
- `src/mastery.ts` — FSRS scheduling and which notes to pick next.
- `src/store.ts` — reading and writing the Grill folder (mastery, sessions, instructions).
- `src/images.ts` — pulling embedded images out of notes for vision models.

## Reporting bugs

Tell me your Obsidian version, your OS, which model provider you're on, and what you did.
If the console has an error (Ctrl/Cmd-Shift-I), paste it. A screenshot of the panel usually
helps more than a paragraph describing it.

## License

By contributing you agree your work is released under the [MIT License](LICENSE) that
covers the rest of the project.
