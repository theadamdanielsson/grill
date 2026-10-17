# grill-test

grill-test is an agent skill that tests you on something you want to know: a codebase, a change an agent made, a book or your notes. It asks one question at a time, grades each answer against the source, and records every answer. A concept you got wrong therefore comes back the next time you ask to be tested, in any project, even in a new session.

![A Claude Code session with grill-test: a wrong answer is recorded, and a new session starts from it](grill-test.gif)

## Install

```
npx skills add theadamdanielsson/grill --skill grill-test
```

It works with Claude Code, Codex, Cursor, opencode and the other agents that read Agent Skills. Then ask your agent to test you, for instance `/grill-test how this handles preflight requests`, or simply "grill me on what you just changed".

## Where the record is kept

The record is yours, so it is kept in your home folder (`~/.grill/record/`) and never in the project. Each concept is named by its project, and each project sees only its own. The skill reads and writes it through [grill-mcp](https://www.npmjs.com/package/grill-mcp), which it runs with `npx`; nothing is sent anywhere except to the agent you use.

grill-test is part of [Grill](https://github.com/theadamdanielsson/grill), a study plugin for Obsidian.
