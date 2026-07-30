# Changelog

## 2.5.2

- Fixed the progress bar and "Question N of X" sometimes counting one more question
  than the session could actually deliver, so it looked stuck one short at the end.
  When the AI generator dropped a question during quality filtering (it already does
  this deliberately for slop/yes-no/ungrounded questions), the promised total never
  shrank to match, so the last slot was never filled. The total now adjusts down
  whenever that happens, instead of leaving a phantom question in the count.

## 2.5.1

- Fixed "Review N due now" (the status bar click, the panel button, and the "Review
  due notes" command) starting a full questionsPerSession-length session instead of
  covering only the actually-due/struggling items. The due queue was scoping notes
  correctly but the concept picker underneath still padded the session with
  untested and already-known concepts from those same notes to hit the usual
  session length. "Grill this note/folder" is unaffected: that's meant to be a full
  session and still is.

## 2.5.0

- **Reactive routing now prefers your most-connected weak note.** When you miss a
  question and Grill routes you to a shaky prerequisite, it used to just grab the
  first one it found. Now, among equally-weak candidates, it prefers the one your
  other notes most depend on, shoring it up pays off across the whole session,
  not just the one note you missed. In a sparsely-linked vault this changes
  nothing; the effect only shows up once there's real structure to prefer.
- **Misconception contagion.** When you show a specific confusion on one note
  (AI grading only), Grill now checks whether that same mistake might apply to a
  linked, not-yet-known neighbor, and tests it there before you naturally hit it
  yourself. Bounded to 2 probes per session, and it's honest about not having a
  no-key-mode equivalent yet (no model in the loop to judge whether a raw tag
  actually transfers). Same consent rule as reactive routing: silent mid-session,
  asked first if it would extend a session past its agreed length.
- Fixed a bug found while building the above: a cached question could leak its
  original "you missed X" routing banner into a completely unrelated later
  session if reused through the normal question cache. Cache reuse now always
  reflects why *this* serving was inserted, never a stale one from whenever the
  question was first generated.

## 2.4.2

- Dropped "tutor" from how Grill describes itself: the README tagline and the
  default AI persona now say quizzes/quizmaster instead. Grill tests what you
  already wrote; it doesn't teach new material, so "tutor" overclaimed what it
  does. No change to grading, question generation, or scheduling.

## 2.4.1

- Removed the word "Obsidian" from the plugin description (it's redundant inside
  the plugin directory), required by Obsidian's automated community plugin
  review, which failed the 2.4.0 release over it. No functional change from 2.4.0.

## 2.4.0

- **Study scope is now checkboxes.** Tick any combination of folders, tags, or the
  current note on the start screen instead of picking one from a dropdown; nothing
  ticked studies the whole vault as before.
- **Multiple-choice and fill-in-the-blank questions.** Alongside the usual write-in-
  the-box recall, Grill can now ask real multiple-choice (click an option, graded
  instantly, no model round-trip) and fill-in-the-blank (an inline input in the
  sentence) questions, in both AI and no-key modes. New "Question formats" setting
  (Sessions) to switch back to write-only; AI-mode mixed formats costs a little extra
  prompt per batch, so it's a real toggle, not silently always on.
- **A consent step before a session runs long.** Missing the very last question of a
  session used to silently insert one more (a weak prerequisite check) with no way to
  say no. Now Grill asks first ("one more" or straight to your review) and leaves
  mid-session organic growth exactly as it was.
- **Faster, cheaper AI sessions.** Question generation used to resend every note in
  the whole session on every 2-question batch; it now sends only the 1-2 notes that
  batch's concepts actually come from. Anthropic requests also use real prompt
  caching now (notes/links and the engine rules), so repeat calls in a session cost
  less and respond faster.
- **The no-key (deterministic) generator is meaningfully better.** It was missing
  most of a typical note's testable content: plain sentences with no bold text
  produced nothing at all. It now also treats `[[wikilinks]]` as fill-in-the-blank
  candidates (not just bold), recognizes "is/are called" and "is a/an" as definitions
  alongside the narrower forms it already knew, and no longer lets a bolded term
  steal a line that would have made a cleaner definition card. Heading- and
  formula-derived questions also no longer leak raw `[[wikilink]]` syntax into the
  question text.
- Loading now shows an animated flame in Grill's orange instead of a generic spinner,
  everywhere a wait can happen.
- Cleaned up the end-of-session screen: clearer section spacing and dividers, dropped
  the "missed/skipped notes come back" footnote, and the bottom buttons ("Study
  again" / "Redo these" / "Back to menu") now fill the panel width with distinct
  primary/secondary/tertiary styling instead of three look-alike buttons.
- Fixed a formatting glitch where the "you missed X, checking a foundation it builds
  on" prerequisite banner could show a stray double-dash.

## 2.3.2

- Clearer, more accurate description and README: Grill *colours in* your knowledge graph as
  you learn (it doesn't build it), and it's for learning what's in your own Obsidian notes.
  Rewrote the README opening around a "How to use it" walkthrough and a scannable feature list.

## 2.3.1

- Removed the separate "Connections review" mode (its button and command). Relationship
  questions are becoming part of normal sessions and the graph, so a dedicated mode was
  redundant. The missing-link finder ("Links you haven't made yet") is unchanged.

## 2.3.0

Grill is now built around your **knowledge graph**.

- **Your learning graph.** Opening Grill lands you on a map of your notes, drawn by Grill
  itself. It starts grey; as you practise, each note colours in by how well you know it
  (green known, amber shaky) and grows with how durably you know it, and links between notes
  you've both learned brighten. Pick a folder or tag and that slice lights up so you can see
  what a session will cover, then watch the map change afterwards. This is a *learning* graph
  (what you've proven), separate from Obsidian's graph of what you've written.
- **Grill's folders.** On first run Grill asks which folders are its study material and map
  (leave blank for the whole vault); change it any time in settings. This also keeps the map
  fast on big vaults.
- **Removed:** the old "colour your Obsidian graph" setting and the `grill-status` frontmatter
  it wrote. The new in-app graph replaces it (and does far more). Any `grill-status`/`grill-due`
  properties already written to your notes are left as-is; Grill just stops touching them.

## 2.2.0

- **Redo this quiz.** Every session note now ends with a "Redo this quiz" button. It re-serves
  the exact same questions with no model call to regenerate them (grading still follows your
  setting: AI marks your answers, or you mark yourself). It's practice, so it doesn't change
  your schedule or stats. There's a "Redo these" button on the end-of-session summary too.
- **A proper look.** New retro-arcade hero banner, and the settings page now has an orange rule
  between each section. The README was also reflowed so it reads cleanly inside Obsidian (the
  old hard wrapping showed up as mid-sentence line breaks in reading view).

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
