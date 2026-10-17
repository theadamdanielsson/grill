---
name: grill-test
description: Use whenever the user asks to be grilled, tested or quizzed on material they want to know ("grill me on this repo", "test me on what you just changed", "quiz me on chapter 3"), such as a codebase, a change an agent made, a book or their notes. Asks one question at a time, grades each answer strictly against the source, and records every answer so what they got wrong comes back for review. Not for stress-testing a plan or a design.
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

  The record is the person's own, kept in `~/.grill/record/` and never in the project, so nothing needs adding to `.gitignore`. Concepts are named by project (`cors/lib/index.js`), and each project sees its own. If the user studies in an Obsidian vault with the Grill plugin, add `--vault "<path to the vault>"` to use the record there.

## 2. Choose what to ask

1. Check the weak spots on the topic first. Anything missed last time, or due, comes before new material.
2. Then use stored questions (`questions`) when they match the topic.
3. Then write your own from the material itself. Read it first:
   - **A change** (a PR, a branch, what you just did): read the diff, for example `git diff main...HEAD`. Ask what changed, why, what could break, and what a reviewer should check.
   - **A codebase or a file:** ask how things connect, what calls what, what happens on failure, and why a design choice was made. Point at real code (`file:line`).
   - **A book, paper or notes:** ask about the ideas and how they relate, in the source's own terms.

Ask about understanding, not trivia. "Why does the retry happen before the cache write?" is a good question. "What is the variable on line 40 called?" is not.

## 3. Ask, grade, record

Ask **one question at a time** and wait for the answer. Say how many you plan to ask, about 5 unless told otherwise. Never show the expected answer, a hint or the source before they answer. Ask about understanding, not trivia.

Each time they answer, do these in order:

1. **Grade it** against the source, never against what sounds plausible: `correct`, `partial` or `incorrect`. If they say "skip" or "I don't know", it is `incorrect`.
2. **Record it before you write anything back.** Recording is the point of this skill: it is how what they got wrong comes back for review. An answer you didn't record is lost. Use the `grill_record_answer` tool, or the command with the answer on stdin, so quotes in their words can't break it:

   ```bash
   npx -y grill-mcp record <<'EOF'
   {"note": "src/auth/session.ts", "label": "token refresh on 401", "question": "...", "answer": "<their words, exactly>", "verdict": "partial", "feedback": "<what you are about to tell them>", "modelAnswer": "<the expected answer>", "misconception": {"tag": "confuses_refresh_with_reauth", "label": "Thinks a 401 forces a new login instead of a token refresh"}}
   EOF
   ```

   `note` is the file, note or topic the question is about. `label` is the concept in 2 to 5 plain words, with no brackets or file names ("preflight handling", not "default preflight handling (OPTIONS short-circuit)"). Keep it stable, so the same concept is recorded under the same name next time. Leave `misconception` out unless the answer showed a specific, nameable confusion (mixing up two functions, getting a direction of causality backwards). When a question came from the record, pass its `conceptId` and `note` instead of a label.
3. **Then reply:** the verdict in one line, what was right, what was missing and where it is in the source (`file:line`), then the next question.

## 4. Finish

After the last question, give a short summary: how many were right, the concepts they missed, and the one thing most worth going over. Say that missed concepts come back for review (the next `weak-spots` shows them), and that each day's questions are kept in `~/.grill/record/Sessions/`.

Then stop. Don't start explaining everything they missed unless they ask.
