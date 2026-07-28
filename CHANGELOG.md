# Changelog

## 2.1.1

- Shortened the plugin description to fit Obsidian's 250-character limit so the 2.1.0
  update reaches the community list. No functional change from 2.1.0.

## 2.1.0

Grill leans into the thing a flashcard app can't do: it works *inside your knowledge graph*.

- **Find the links you're missing.** In an AI session Grill now looks for two of your notes
  that clearly belong together but aren't linked, quizzes you on the connection, and offers a
  one-tap "Link these notes" button that writes the `[[link]]` into your note for you. The
  candidate pairs come from a cheap, offline check over your notes' vocabulary; a model call
  then confirms only the pairs with a real relationship, so it stays precise. It's on by
  default (AI mode only) and tunable under Sessions, and the dashboard counts the connections
  you've made.
- **Write your own questions.** Drop a `> [!grill]` callout into any note with your question,
  an optional `A:` answer, and an optional `rubric:`, and Grill asks it verbatim, schedules it
  like everything else, and grades your typed answer against your rubric (or, without one,
  against the note). It's a callout, so it folds away and never clutters your prose. Your
  existing `Question:: answer` flashcards still work exactly as before.
- **Questions are cached now.** A generated question is saved per concept and reused when that
  concept comes back up for review, instead of a fresh API call (and a fresh question) every
  single time. It regenerates automatically when you edit the note; set "Reuse generated
  questions" above zero if you'd rather it write a new variant now and then for variety.
- **Careful grading (opt-in).** Turn it on and Grill grades an answer with a small consensus
  of calls and keeps the stricter verdict, cutting the chance of being marked correct when you
  weren't, at a higher per-answer cost.

## 2.0.4

- Housekeeping for the plugin safety scorecard: the confetti canvas now uses
  Obsidian's element helpers and a CSS class instead of raw DOM and inline styles,
  the image-resize canvas uses the same helper, and a couple of type casts are
  replaced with proper `instanceof` checks. No behaviour change.

## 2.0.3

- **Sound and celebration.** Grill now plays a short cue on every answer (a bright
  ding for correct, a soft tone for partial, a gentle low blip for wrong), a finish
  cue at the end of a session, and a triumphant fanfare with a confetti burst when
  you get a whole session right. All synthesized on the fly, so no audio files ship
  with the plugin, and it's off with a single toggle ("Sound & celebration") if you'd
  rather study in silence.

## 2.0.2

- **Persona can't touch your grades.** The grader now applies its verdict bands
  regardless of the persona you set, so a "lenient" (or hostile, in a shared vault)
  persona can only change the wording of feedback, never whether an answer is marked
  correct. Scoring stays fixed, as promised.
- **Reference notes from your instructions with `[[links]]`.** Point at another note
  in `Grill/Instructions.md` and Grill reads it in, so a longer style guide or marking
  rubric can live in its own note. Referenced text is capped (and rides along in every
  session), so keep it lean.

## 2.0.1

- Dashboard accuracy now reads "0%" on a fresh vault instead of a lone dash, so it
  lines up with the other stats (which already show 0 when you haven't studied yet).

## 2.0.0

Grill 2.0 turns your link graph and your answer history into a real tutor, not just a
question generator.

- **It reacts when you miss something.** Get a question wrong and Grill now routes you
  straight to a weak note it builds on, so you shore up the foundation before carrying on,
  then returns to where you were. It reads your own `[[wikilinks]]` as the prerequisite
  map, picks the shakiest foundation, and shows you why you were sent there. Bounded, so a
  run of wrong answers can't send you down a rabbit hole.
- **Mastery is harder to fake.** A single lucky answer no longer marks a concept known;
  Grill waits for a second, corroborating recall. A note only counts as mastered once
  enough of its concepts are genuinely confirmed, so the colour you see is the state you're
  in. (Your notes will read "known" more slowly than before, on purpose.)
- **Weak questions get dropped before you see them.** A new deterministic check throws out
  slop a model sometimes produces: yes/no questions, multiple-choice stems with no options,
  hints that give the answer away, near-duplicates, and questions ungrounded in your note,
  with no extra model call. This matters most on small local models.
- **New notes start at the right level.** A brand-new concept in a note whose foundations
  you've already mastered starts a rung harder, instead of always lobbing you the easiest
  possible question.
- **A persona you can rewrite.** Grill's default character is now shown, and editable, in
  `Grill/Instructions.md`: make it a strict examiner, a gentle guide, a blunt drill
  sergeant, whatever you like. Only the voice changes; how questions are built and graded is
  fixed, so your marks stay consistent.
- **Local models are much faster.** Grill now turns off "thinking" mode for local models
  like Qwen, which were spending fifteen-plus seconds per answer on hidden reasoning. Grades
  come back in a second or two now, with no loss in quality.
- **Confidence check (optional, off by default).** Turn it on and Grill asks how sure you
  were after each answer, then tells you in the debrief when you lean over- or
  underconfident. No extra model cost.
- **A model guide.** New `docs/models.md` recommends what to run by budget and by how much
  memory your machine has, with or without a key.

## 1.9.0

- **Connections review.** A new session mode that quizzes you on how your linked notes
  relate, bridging concepts across `[[wikilinks]]` instead of one note at a time. Grill
  picks notes that are joined by links, pairs each concept with a linked neighbour
  (favouring a weak one), and asks questions that test the relationship between the two,
  not either note alone. Start it from the "Connections review" button on the start
  screen or the command of the same name; it respects the study-scope dropdown.
- Each connection question shows an "A to B" bridge badge (hidden note names are still
  honoured), and the end-of-session summary recaps the note-pairs you were tested on.
- Scheduling is unchanged: every question is still anchored to a single concept on the
  same FSRS schedule.

## 1.8.2

- Drop the clipboard fallback in graph-colour setup (shows manual instructions instead),
  removing an unnecessary clipboard-access capability.
- List vault tags via the public metadata API instead of an undocumented internal call.

## 1.8.1

- Shorten the plugin description to fit Obsidian's 250-character manifest limit.

## 1.8.0

- **Custom (OpenAI-compatible) provider.** Point Grill at any OpenAI-compatible endpoint:
  OpenRouter, Groq, Together, Fireworks, LM Studio, Kimi, and more. Set a base URL, add a
  key (or leave it blank for local servers), pick a model, done. No plugin update needed
  when a new provider launches.
