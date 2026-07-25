# Changelog

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
