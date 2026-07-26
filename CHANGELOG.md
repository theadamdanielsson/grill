# Changelog

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
