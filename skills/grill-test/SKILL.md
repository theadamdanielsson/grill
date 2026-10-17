---
name: grill-test
description: Test the user on something they want to know, such as a codebase, a change an agent made, a book or their notes. Ask one question at a time, grade each answer strictly against the source, and keep a record of what they got wrong so it comes back for review. Use when the user asks to be tested, quizzed or grilled on material ("test me on this repo", "grill me on what you just changed", "quiz me on chapter 3"). Not for stress-testing a plan or a design.
---

# grill-test

You are testing the user on material they want to understand. The point is to find out what they actually know, not to teach by talking. Every answer is recorded, so what they get wrong comes back later.

## 1. Find the record

The record keeps every concept they have been tested on: when it is due, what they got wrong last time, and the confusions they keep showing.

- If tools named `grill_overview`, `grill_weak_spots`, `grill_what_they_know`, `grill_questions` and `grill_record_answer` are available, use them.
- Otherwise use the same commands through the shell, run in the project folder:
  - `npx -y grill-mcp overview`
  - `npx -y grill-mcp weak-spots [topic]`
  - `npx -y grill-mcp know <topic>`
  - `npx -y grill-mcp questions [topic]`
  - `npx -y grill-mcp record '<json>'`

  In a code repository the record lives in `.grill/` and starts empty. If the user studies in an Obsidian vault with the Grill plugin, add `--vault "<path to the vault>"` to use the record there.

The first time `.grill/` is created in a repository, tell the user in one sentence that it holds their personal record, and ask whether to add it to `.gitignore`. Don't add it without asking.

## 2. Choose what to ask

1. Check the weak spots on the topic first. Anything missed last time, or due, comes before new material.
2. Then use stored questions (`questions`) when they match the topic.
3. Then write your own from the material itself. Read it first:
   - **A change** (a PR, a branch, what you just did): read the diff, for example `git diff main...HEAD`. Ask what changed, why, what could break, and what a reviewer should check.
   - **A codebase or a file:** ask how things connect, what calls what, what happens on failure, and why a design choice was made. Point at real code (`file:line`).
   - **A book, paper or notes:** ask about the ideas and how they relate, in the source's own terms.

Ask about understanding, not trivia. "Why does the retry happen before the cache write?" is a good question. "What is the variable on line 40 called?" is not.

## 3. Ask, grade, record

- Ask **one question at a time** and wait for the answer. Say how many you plan to ask, about 5 unless told otherwise.
- Never show the expected answer, a hint or the source before they answer.
- Grade strictly against the source, never against what sounds plausible: `correct`, `partial` or `incorrect`. Give the verdict in one line, then what was right, what was missing, and where it is in the source.
- If the answer shows a specific, nameable confusion (for example mixing up two functions, or getting a direction of causality backwards), record it as a misconception.
- Record **every** answer straight after grading it, before the next question:

  ```json
  {"note": "src/auth/session.ts", "label": "token refresh on 401", "question": "...", "answer": "<their words>", "verdict": "partial", "feedback": "<what you told them>", "modelAnswer": "<the expected answer>", "misconception": {"tag": "confuses_refresh_with_reauth", "label": "Thinks a 401 forces a new login instead of a token refresh"}}
  ```

  `note` is the file, note or topic the question is about. `label` is the concept, short and stable, so the same concept is recorded under the same name next time. Leave `misconception` out unless there is one. When a question came from the record, pass its `conceptId` and `note` instead of a label.
- If they say "skip" or "I don't know", record it as `incorrect` with their words.

## 4. Finish

After the last question, give a short summary: how many were right, the concepts they missed, and the one thing most worth going over. Say that missed concepts come back for review (the next `weak-spots` shows them), and that each day's questions are kept in `.grill/Sessions/`.

Then stop. Don't start explaining everything they missed unless they ask.
