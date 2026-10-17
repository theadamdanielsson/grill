# grill-mcp

grill-mcp gives any AI agent access to [Grill](https://grill.onbridger.com)'s record of what you know. The record holds every concept from your notes you have been tested on, your chance of recalling each one today, what you got wrong last time, and the misconceptions you keep showing. An agent connected to it can therefore pitch an explanation at your level, name the specific confusion behind a mistake, and test you on what is fading. Answers given to the agent count in Grill as well.

## Setup

In Obsidian, open Settings → Grill → Agents and copy the line for your agent. It has this form:

```
claude mcp add --scope user grill -- npx -y grill-mcp --vault "/path/to/your/vault"
codex mcp add grill -- npx -y grill-mcp --vault "/path/to/your/vault"
```

Any other MCP client runs the same command, `npx -y grill-mcp --vault <path>`, over stdio. It requires Node.js 18 or later.

## Tools

| Tool | What it returns |
|---|---|
| `grill_overview` | Counts of tested, known and struggling concepts, what is due now or fading this week, the weakest notes and active misconceptions. |
| `grill_weak_spots` | Concepts missed last time, struggling or likely forgotten, weakest first, optionally for one topic. |
| `grill_what_they_know` | Everything the record holds on a topic, for pitching an explanation. |
| `grill_questions` | Questions Grill already wrote for the concepts most worth testing, with expected answers for grading. |
| `grill_record_answer` | Records one graded answer, which then moves that concept's schedule. |

The server also tells the agent how to test: one question at a time, the expected answer kept back until you have answered, and every answer recorded.

## How answers reach Grill

grill-mcp never writes to the record files themselves, since the plugin may hold them open. Each graded answer is instead written as one file in the `Inbox` folder inside your Grill folder. The next time Grill is open, it folds these answers into the record, writes a session note for each agent session, and removes the files.

## Outside a vault

Run in a folder that is not an Obsidian vault, for instance a code repository, grill-mcp keeps a record of its own in `.grill/` and updates it directly. A readable log of each day's questions and answers is kept in `.grill/Sessions/`.

## Privacy

grill-mcp makes no network requests. It reads and writes files in your vault, or in `.grill/`, and nothing else. What the agent does with the record is subject to that agent's own terms.

MIT licence.
