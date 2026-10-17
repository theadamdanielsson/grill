# grill-mcp

grill-mcp gives any AI agent access to [Grill](https://grill.onbridger.com)'s record of what you know. The record holds every concept from your notes you have been tested on, your chance of recalling each one today, what you got wrong last time, and the misconceptions you keep showing. An agent connected to it can therefore pitch an explanation at your level, name the specific confusion behind a mistake, and test you on what is fading. Answers given to the agent count in Grill as well.

## Setup

In Obsidian, open Settings → Grill → Agents and copy the line for your agent. It has this form:

```
claude mcp add --scope user grill -- npx -y grill-mcp --vault "/path/to/your/vault"
codex mcp add grill -- npx -y grill-mcp --vault "/path/to/your/vault"
```

Any other MCP client runs the same command, `npx -y grill-mcp --vault <path>`, over stdio. It requires Node.js 18 or later.

Without `--vault`, grill-mcp uses the vault it is started in, including from one of the vault's subfolders, or the folder named by the `GRILL_VAULT` environment variable. `--dir <path>` keeps a record in that folder instead.

## Tools

| Tool | What it returns |
|---|---|
| `grill_overview` | Counts of tested, known and still-learning concepts, what is due now or fading this week, the weakest notes and active misconceptions. |
| `grill_weak_spots` | Concepts missed last time, missed repeatedly, or likely forgotten, weakest first, optionally for one topic. |
| `grill_what_they_know` | Everything the record holds on a topic, for pitching an explanation. |
| `grill_questions` | Questions Grill already wrote for the concepts most worth testing, with expected answers for grading. |
| `grill_record_answer` | Records one graded answer, which then moves that concept's schedule. |

The server also tells the agent how to test: one question at a time, the expected answer kept back until you have answered, and every answer recorded.

## Commands

The same queries are available as plain commands, for an agent that has a shell but no MCP set up. Each prints JSON. The `grill-test` skill uses them.

```
npx -y grill-mcp overview
npx -y grill-mcp weak-spots [topic]
npx -y grill-mcp know <topic>
npx -y grill-mcp questions [topic]
npx -y grill-mcp record '{"note": "...", "question": "...", "answer": "...", "verdict": "partial"}'
```

## How answers reach Grill

grill-mcp never writes to the record files themselves, since the plugin may hold them open. Each graded answer is instead written as one file in the `Inbox` folder inside your Grill folder. While Grill is open, it adds these answers to the record within a few seconds, writes a session note for each agent session, and removes the files. Each answer is counted once, including when the vault syncs to a second device.

## Outside a vault

Run outside an Obsidian vault, for instance in a code repository, grill-mcp keeps the record in `~/.grill/record/` (or the folder `GRILL_HOME` names), never in the project itself. There is one record for the person across all their projects. Each concept is named by its project (`cors/lib/index.js`), and each project's reads show only its own. A project that already has a `.grill/` folder, or a `--dir`, keeps a record of its own instead.

Answers are written one at a time, and a readable log of each day's questions and answers is kept in the record's `Sessions/` folder. A record file that cannot be read is reported as an error and never written over.

## Privacy

grill-mcp makes no network requests. It reads and writes files in your vault, or in `.grill/`, and nothing else. What the agent does with the record is subject to that agent's own terms.

MIT licence.
