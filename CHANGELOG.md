# Changelog

## 4.5.2

- Fixed the note-image shown in "Explain this" being effectively random: it used to
  grab the first image embed in the note by document order, with no relation to the
  actual question. Now the model is shown the note's images and asked which one (if
  any) actually matches this specific question — "" for the common case of none,
  instead of an arbitrary unrelated diagram or screenshot.
- Fixed that image not being clickable to enlarge: it was a plain `<img>` tag, which
  has none of Obsidian's native click-to-zoom wiring. Now rendered as a real embed
  first (so zoom works like anywhere else in the vault), only falling back to a plain
  tag if that embed fails to hydrate.

## 4.5.1

- Fixed a plugin-review failure: the off-screen scratch element used to test-render
  Mermaid diagrams (added in 4.5.0) set its styles directly instead of through a CSS
  class, which the Obsidian review linter flags as unsafe regardless of how static the
  values are. Moved it to a real class.

## 4.5.0

- **"Explain this" can now draw a diagram and show your own images.** When a diagram
  would actually clarify the concept, the explanation includes a small Mermaid flowchart
  alongside the usual three fields — grounded in the note, not decorative, and dropped
  silently if it fails to render rather than showing broken output. If the note itself
  embeds an image, up to two of them are pulled in alongside the explanation too — your
  own diagram or screenshot, not a generated one, resolved directly from the vault
  rather than through Obsidian's embed renderer (which doesn't reliably hydrate embeds
  inside a custom view).

## 4.4.2

- "Untested" on the map no longer jumps straight into a session on click. It now
  selects the scope instead — highlights on the map, "Get grilled" becomes "Grill N
  selected" — the same choose-then-commit flow the Scope checkboxes already use.
  Click again to revert to the whole vault.

## 4.4.1

- Fixed three different "due" counts disagreeing at once (e.g. 17 on the start screen's
  "Review due now" vs. 21 in the status bar): `dueFiles` — which picks the actual notes
  for a due session, the "Scope: Due" option, and the start-screen button's count — was
  reading the note-level `mastery.dueAt` rollup, a cache only refreshed when a note is
  next answered. A note whose concept became due since its last visit could silently
  miss it. Rewrote it to compute live from concept data directly, the same way the
  map's own due-highlighting already did correctly.
- "Untested" is now a plain chip identical to Due/Learning/etc. (no count in the label,
  no distinct border color), positioned right after Due instead of a visually distinct
  chip before it.

## 4.4.0

- **"Mark correct."** When the deterministic or AI grader gets one wrong, a quiet
  "Mark correct" button next to the verdict badge fixes it properly: the concept's
  FSRS schedule is restored to its pre-answer state and replayed as a correct answer
  (not just relabeled), note-level stats and any misconception tally are corrected too,
  and the session summary/debrief reflect the fix. Only offered right after the answer
  that produced it, and only for AI/deterministic grading — self-grade mode's own
  Again/Hard/Good/Easy is already the ground truth, nothing to override.
- Fixed "Grill N untested" (4.3.0) rendering as a big banner above the map's filter
  chips instead of sitting in that row as a small chip like the others.
- "Get grilled" now reads **"Grill N selected"** once you've ticked a folder/tag/note
  in Scope, so the button says what it's actually about to do instead of a generic
  label that looked the same whether or not a scope was active.

## 4.3.0

- **"Grill N untested"** on the map: a one-tap button that starts a session over every
  untested note, vault-wide (not just whatever's rendered on a possibly-capped graph).
  Unlike the filter chips next to it, which only highlight matching notes in place, this
  one leaves the map and starts quizzing.

## 4.2.1

- Fixed the verdict flame icon (4.2.0) failing Obsidian's plugin review: it was set via
  `innerHTML`, which the reviewer flags as unsafe even for fully static, hardcoded
  markup. It's now built as real SVG DOM nodes instead of an HTML string.
- Fixed "select all that apply" questions restating their own options as a numbered
  list inside the question text, duplicating the same options shown right below as
  clickable buttons — looked like the question was listed twice because it was. The
  generation prompt now explicitly says not to, with a cheap deterministic check
  dropping any question that does it anyway.

## 4.2.0

- **A real Grill icon on the verdict badge**, replacing the generic Lucide circle-check/
  circle-x every other app uses: a small pixel flame (same crisp-block technique as the
  hero art), one shape, colored per verdict. No pill background on any verdict anymore —
  the flame itself carries the color now, so a tinted background behind it was redundant.
- Fixed the "select all that apply" and matching question types' feedback: a wrong
  answer used to just repeat the full correct answer a second time (already shown right
  below in "Expected answer"), which read as two parts of the screen disagreeing rather
  than one useful diagnosis. It now names exactly what you picked that didn't belong and
  what you missed, for free, no LLM call.

## 4.1.0

- **Using a hint now caps the rating at Hard.** A correct answer reached only after a
  hint was real assistance, not independent recall — previously it scheduled exactly
  like an unassisted correct answer, identically to the "how sure are you?" confidence
  gap this closes the same way, but unconditionally (no setting needed).
- **No-key and self-authored (`> [!grill]`) questions can now reach "hard" difficulty**
  and therefore earn an Easy rating on a well-established concept, matching how
  AI-generated questions already work. Previously every no-key/authored question was
  hardcoded to "medium" forever, regardless of how solid the concept was.

## 4.0.1

- The "Correct" badge no longer has a tinted pill background — it read as a generic
  "AI-generated app" cliché; it's now an understated icon + label, while partial/
  incorrect keep the tinted pill.
- **"Explain this" now works on correct answers too**, not just wrong ones — sometimes
  you want the fuller "why" even when you got it right.
- Renamed the "The rule" field to "Key concept": not every question has a rule (plain
  factual recall doesn't), so the label was overspecific for what the field actually
  covers.
- The session debrief's "To review" list now links each concept's note inline as a
  real `[[wikilink]]` in parentheses, instead of a separate chip after the text.

## 4.0.0

- **Redesigned the feedback screen.** The verdict is now a colored badge with an icon
  instead of a plain text line, and "your answer" plus the grader's feedback sit
  together inside a bordered card. The expected answer and "Explain this" now live in
  a second card underneath — real visual grouping instead of one long stack of
  undifferentiated text.
- **"Explain this" now returns three short, labeled parts** — What went wrong, The
  rule, and an Example — instead of one 2-4 paragraph block of prose, so a fuller
  explanation reads as a structured breakdown instead of a wall of text.

## 3.9.0

- **Editing a note no longer resets its scheduling.** Previously, any change to a
  concept's tested text (even a typo fix) wiped its stability, difficulty, and streak
  back to "never tested" and forced it due immediately. Editing your own notes is your
  call, not a signal to distrust your prior recall of them — a content change now only
  updates what's asked next time; your schedule for it is untouched.
- **A guessed-but-correct answer can now land as "Hard."** In AI-graded mode, a correct
  answer previously could only ever be scored Good or Easy — there was no way to record
  "I got it right, but I was guessing," unlike self-grade mode's native Again/Hard/
  Good/Easy buttons. With the "how sure are you?" confidence check on, a correct answer
  you rated "Guessing" now earns Hard instead, a smaller stability gain reflecting the
  shakier recall.
- Concepts now log raw review history (elapsed time + rating per review) going forward.
  Not used by anything yet — groundwork for eventually fitting FSRS's scheduling
  parameters to your own review data instead of the fixed global defaults.

## 3.8.1

- Fixed "Explain this" (3.8.0) leaking internal grading jargon into the explanation
  text itself — a stray `verdict: partial` line, or a bare `misconceptionTag` value
  like `auxiliary_choice_reflexives` with no label at all. Caused by reusing the
  grader's own system prompt to ride its prompt cache; it now has its own prompt
  (losing that cache hit, which is the right trade) plus a defensive filter for
  either leak shape.
- "Explain this" now shows a specific, staged status ("Reading your answer and the
  note...", then "Writing an explanation...") instead of a static "Explaining..."
  frozen for the whole wait.

## 3.8.0

- **"Explain this."** When the feedback, hints, and expected answer on a wrong (or
  skipped) answer still don't clear things up, an "Explain this" button on the feedback
  screen gets a fuller, grounded explanation without leaving Obsidian — one contextual
  call using the question, your answer, and the note itself, not a chat. Needs an LLM
  configured; hidden otherwise, and independent of your question/grading mode settings,
  since this is exactly the rescue path for a stuck local-questions or self-grading user
  who has a key configured.

## 3.7.2

Cleanup only, no behaviour change — addresses warnings from the Obsidian plugin
review that had degraded the listing to "Caution":
- Replaced four `:has()` CSS selectors (flagged for potential selector-invalidation
  performance cost) with plain classes set at render time, since in every case the
  condition was already known in JS when the element was created.
- Removed three unnecessary type assertions and one unhandled/floating promise.

## 3.7.1

- **"End session for now."** A long due queue (50, 100+ questions) had no way out
  short of closing the pane outright — which actually saved your progress, but gave no
  confirmation or summary, so it read as abandoning it. This link, shown next to the
  note name on every question and feedback screen, closes out the session normally
  (session note, summary, debrief) using whatever you've answered so far; the rest
  just stays due for next time.

## 3.7.0

- **Accurate "due" counts.** The status bar, dashboard, and start-screen "Review due
  now" button all counted notes with at least one due concept, not the concepts
  themselves — a note due on its earliest concept but sitting on several due ones
  showed as 1 while the queue it launched quizzed all of them. All three now show the
  real number of concepts about to be reviewed.
- **"Bad question."** Every AI-generated question now has a "Bad question" button next
  to "I don't know": a wrong, broken, or nonsensical question gets deleted from the
  cache for good (a fresh one is generated next time), doesn't count as an answer, and
  doesn't touch that concept's schedule. Previously a bad cached question could keep
  rotating back into review indefinitely.

## 3.6.0

- **Load-balanced review scheduling.** Fuzzed due dates now prefer whichever day
  within the jitter window already has the fewest reviews landing on it, instead of
  picking randomly — spreads review load across days instead of just avoiding an
  exact same-day pileup.
- **Keyboard shortcut**: Enter/Space now advances past the feedback screen once
  you've been graded, instead of needing to click "Next question" every time.

## 3.5.0

- Faster-feeling sessions: the loading screen between questions and while grading now
  only appears if the wait actually runs past a third of a second, so a quick response
  never flashes a loading screen just to immediately swap it away again. When it does
  show, it now names what it's actually writing a question about instead of a generic
  "just a moment."
- Submit, Next, and the other answer-submission controls now give instant feedback the
  moment you click (or hit Cmd/Ctrl+Enter) instead of nothing happening until the
  response comes back, and can no longer be double-clicked into a duplicate submission.

## 3.4.0

- **Reads embedded PDFs.** A `![[worksheet.pdf]]` embed now gets its text pulled in and quizzed on
  like any other note content, via Obsidian's own PDF engine — no new dependency, no bundled
  worker. Worksheet-style PDFs get chunked on their own numbered items ("Question 7", "Problem 3")
  when detectable, one concept per exercise, instead of arbitrary fixed-size slices; AI mode also
  now actively prefers reusing a PDF's own question wording and worked solution over inventing a
  new one, when the source material already has one.
- Fixed a real crash: any prompt-bound text got hard-truncated at a fixed character count, which
  could split a Unicode character in half (common in PDF-extracted math notation, e.g. italic
  variables like 𝑌, 𝑃, 𝐺) and corrupt the request, surfacing as an opaque "failed to parse JSON"
  API error. Truncation is now surrogate-pair-safe everywhere it happens, and one redundant,
  overly-tight cap was removed rather than widened, trusting content that's already been sensibly
  chunked upstream instead of cutting it again.
- Fixed a misleading error when a specifically-picked note or folder came back empty: it used to
  say "no markdown notes in this vault" even when the real cause was the selection sitting outside
  Grill's configured folders. Now says so directly.

## 3.3.0

- Fixed two silent bugs in the FSRS-4.5 scheduling math: initial stability for a
  first Good/Easy answer was computed from a 2-point interpolation instead of the
  real 4-point lookup, and difficulty was rescaled onto the wrong range, which
  nearly zeroed out its intended effect on how fast stability grows after a correct
  answer and dropped the mean-reversion term entirely. Existing concepts self-heal
  on their next review; no reset needed.
- Fixed a note's mastery status getting silently overwritten by a linked
  prerequisite's status. It's still tracked, just as its own separate "rests on a
  shaky prerequisite" signal (shown on the dashboard) instead of masquerading as the
  note's own FSRS-derived status.
- Fixed the AI question generator sometimes asking about a note's own title or
  organizational placement instead of its content, when the note didn't parse into
  structured concepts.
- Added a "Dismiss" action on the dashboard's recurring-mistakes list, for when the
  tag itself is a bad grading call rather than a real recurring confusion.
- Fixed calibration (the "how sure are you" tracking) permanently freezing at your
  last 100 confidence-tracked answers instead of reflecting your full history.

## 3.2.1

- Fixed hub/index notes (mostly links to other notes) generating quiz questions about
  the link list itself instead of the knowledge those links point to. Headings and
  lines dominated by wikilinks are no longer treated as content.
- Fixed sessions getting stuck reviewing the same small set of notes indefinitely on
  larger vaults: "struggling" notes had no limit on how much of a session's candidate
  pool they could claim, so a real review backlog could crowd out untested material
  forever. Untested notes and concepts now always get a guaranteed share of each
  session.
- Fixed "Notes considered per session" silently truncating sessions you scope
  yourself (a chosen note/folder, or due review) — those now always consider
  everything you picked. The cap only applies to the unscoped auto-session, and its
  setting description no longer wrongly implies it affects API cost.
- Removed dead note-level scheduling and prompt-building code left over from the
  concept-level scheduling migration, plus an unused scope-encoding helper.

## 3.2.0

- **"Review frequency" setting**: controls how aggressively the schedule keeps things
  fresh (FSRS's "desired retention," 70-97%). Lower brings concepts back sooner for
  faster-feeling progress at the cost of more reviews; higher spaces them further apart.
  Previously fixed at 90% with no way to adjust it.
- **"New concepts per day" setting**: caps how many never-before-tested concepts a
  session will introduce per calendar day, independent of the per-session limits. Once
  hit, sessions fill remaining slots by reviewing what's already due instead, so a few
  missed days can't leave the due queue permanently outrunning what's reviewable. Off
  (no cap) by default.
- **A new "Stuck" filter on the graph**: flags concepts that keep failing no matter how
  much they've been reviewed, distinct from ordinary "Learning" (not yet durable) —
  Anki's leech concept, scaled to Grill's spaced, AI-generated concepts.

## 3.1.0

- **Three new question formats**: true/false, select-all-that-apply, and matching, joining
  the existing write/multiple-choice/fill-in-the-blank. All three grade instantly, no AI
  round-trip needed. Format is now assigned deterministically per concept rather than left
  to the model's own judgment — left to itself, a model reliably regresses to only
  multiple-choice and fill-in-the-blank even when explicitly offered the rest; forcing an
  assignment (the same way question difficulty is already forced, not suggested) fixed it in
  live testing. Fill-in-the-blank can now also carry up to three blanks in one sentence
  instead of exactly one.
- **The mastery/graph score is rebuilt on the FSRS memory strength Grill already computes**,
  instead of a raw answer streak (wiped to zero by a single miss) and lifetime-cumulative
  accuracy (an old mistake could drag a note's score down forever, even long after you'd
  since re-learned it properly). A lapse now degrades a concept's score rather than erasing
  it, and coverage no longer scales with however many concepts a dense note happens to
  contain — a long vocabulary list doesn't need proportionally more before it reads
  "covered" than a short one. The "Grade weighting" setting's default shifts from
  coverage-heavy to mastery-first accordingly (existing vaults migrate automatically).
- Fixed a real cap that silently limited every note to its first 12 extractable concepts,
  in document order, forever — content past that point in a long or dense note was never
  reachable by any session, no matter how many you ran. Raised well past realistic note
  sizes.
- Fixed the "reuse generated questions" cache: once a concept had accumulated its maximum
  stored variants, it would keep rotating the same ones indefinitely and never generate a
  fresh question again, regardless of the reuse setting — meaning a generator improvement
  (a new format, a prompt fix) could never reach an already-mature concept. Added a
  "Clear cached questions" button (Settings) as an immediate escape hatch.
- Question generation now retries once automatically on an empty or garbled model response
  before surfacing it as a failure — a known occasional flakiness with reasoning models that
  a second identical request usually doesn't repeat.
- Multi-selecting several notes (or folders) in the file explorer and right-clicking now
  offers "Grill these N notes," alongside the existing single-note/single-folder options.

## 3.0.0

- **The full arcade redesign.** Grill's look used to stop at the banner: the rest of the
  plugin fell back to generic Obsidian styling with an orange accent layered on top. Every
  screen now wears the same identity pulled directly from `docs/hero.svg`'s actual palette:
  the gold/ember double frame with square corner rivets, the dot-grid CRT ground, scanlines,
  and a slow flame glow rising from the base. The start screen, progress dashboard,
  first-run onboarding, and the session summary ("high score" screen) all get the full
  cabinet treatment. The question/answer flow and post-answer feedback screen get a lighter
  touch on purpose: they stay on your own Obsidian theme and just pick up Grill's accent
  color on the progress bar and the Submit/Hint buttons, since legibility while actually
  studying matters more than brand consistency there.
- The learning graph now uses the same fixed arcade palette as everything else instead of
  theme-derived colors, so it no longer looks like a different, more "modern" app bolted
  onto the cabinet. Practised nodes get a soft glow in their own color, the numeric overlay
  uses the pixel face, and note-name labels only fade in once you've genuinely zoomed into
  a small cluster instead of showing all of them at once as an unreadable wall of
  overlapping text. Nodes also got more collision clearance now that they carry a badge and
  sometimes a glow on top of what used to be a bare dot.
- Fixed the cabinet not actually filling its pane: there were two separate layers of
  padding fighting it (the wrap's own, and Obsidian's native pane padding underneath), a
  `max-width` cap left over from the reading-width question flow, and an outset gold
  border that needed a pixel of room beyond its own edge to render, which doesn't exist
  once an element fills the pane exactly, so it was quietly getting clipped on the sides
  with no margin left to spare.
- Fixed interactive elements (filter chips, the "Back to menu" button) losing their
  background on `:focus`/`:active`, which persists after a click unlike `:hover`, which
  just fades when the cursor leaves. Obsidian's own button styling sets a theme-dependent
  background on both, so on a light Obsidian theme these were going gold-text-on-white:
  invisible. Also fixed a related bug this introduced: an active/selected filter chip
  losing its gold "on" state right at the moment you clicked it, since `:focus`/`:active`
  have higher CSS specificity than a single `.is-active` class.
- Filter chips no longer wrap to a second line (a lone "Unlinked" stranded by itself) and
  the settings page picked up the same accent language (a gold/ember gradient section
  rule) without the full cabinet treatment, since you're configuring the plugin there, not
  looking at the banner.

## 2.5.5

- Fixed a due-only session ("Review N due now", the status bar, "Review due
  notes") being silently capped by the same `questionsPerSession` (default 5)
  and `maxNotesPerSession` settings as a regular study session. A note doesn't
  leave the due pile until *all* its due concepts are re-cleared, not just
  one, so a backlog bigger than 5 could never actually shrink, no matter how
  many due sessions you ran, and the button's "N due" promise silently only
  reviewed a handful of them. Due sessions now size themselves to the actual
  backlog instead.
- Fixed session note-selection collapsing onto whichever folder happened to
  sort first when a scope spanned several folders. The untested-notes bucket
  picked candidates in raw vault order with no shuffling or topic-awareness,
  so a broad scope could fill its whole session cap from one folder before a
  second was ever reached. Notes are now interleaved by folder before
  priority-bucketing.
- Changed the default for "Reuse generated questions" from 0 (reuse the exact
  same cached question forever) to 3, so a recurring concept gets a fresh
  phrasing after a few repeats instead of the literal same text every time.
  Existing installs keep whatever value they already have; this only changes
  the default for new ones.
- The AI question-writer now explicitly avoids testing a concept's own label,
  title, heading, or section name — only the substantive content under it —
  closing a gap where a sparse note's fallback concept (labelled by the note's
  own title) could get quizzed as if the title itself were the material.
- The AI question-writer now translates plain-text math notation from a
  note's own writing (`pi^e`, `r_n`) into real LaTeX (`$\pi^e$`, `$r_n$`)
  instead of copying it verbatim. Obsidian renders LaTeX natively; the old
  instruction to use it "where it helps" was too soft for models to act on
  when the source note itself wasn't already using it.
- A due-only session's saved note and live summary now say so ("due review"),
  instead of reading identically to a regular study session.
- Session transcripts now write into monthly subfolders under `Grill/Sessions/`
  instead of one flat folder, so daily use doesn't turn it into hundreds of
  files.
- The "What you keep getting wrong" and "Beaten" lists on the progress
  dashboard are now capped to the ten most-relevant entries shown at once
  (worst/most-recurring first), with a "+N more" indicator, instead of
  growing to a permanent, ever-scrolling list. Nothing is deleted from the
  underlying data.
- Grill now shows a notice at the start of a session when "Send images to the
  model" is on but the chosen model can't actually read images, instead of
  silently degrading to text-only with no visible sign the toggle isn't doing
  anything for that model.
- Fixed multiple-choice answer buttons visually centering a short choice's
  text while a longer, wrapped choice read left-aligned in the same question.
  Buttons weren't given an explicit width, so a short choice's button shrank
  to fit its own text, which centers the label inside a tight box even with
  left alignment set.
- Added Requirements, Installation, and an expanded Privacy and data use
  section to the README, and a new `docs/troubleshooting.md` covering the
  common issues above (and others) with what's actually happening under the
  hood, not just a generic FAQ.

## 2.5.4

- Fixed the knowledge graph getting stuck red instead of progressing red/grey to
  amber to green. The graph's colour logic claimed to mirror the dashboard's
  "struggling" definition (missed at least once, not yet re-confirmed) but
  actually used a looser one: any concept not yet confirmed twice in a row,
  including one that's never been wrong, just answered correctly for the first
  time. So the first correct answer on any fresh concept in a note could paint
  the whole note red, and a multi-concept note could stay red indefinitely as
  each new concept got its first (correct) exposure. Graph colour now uses the
  same "actually missed" definition as the dashboard and due queue.

## 2.5.3

- Fixed the due queue (status bar, "Review N due now", "Review due notes" command)
  not dropping a card after you answered it correctly. Due-ness was checking two
  things: whether the review date had arrived, and whether the item was still
  flagged "struggling", but that flag only clears after two correct answers in a
  row (the anti-luck rule for the "known" streak), so a card you'd just gotten
  right stayed glued to the pile until you answered it right a second time.
  `dueAt` alone already correctly reflects a correct answer by pushing the review
  date out, so due-ness now goes by that alone. The knowledge graph's own
  struggling/red status (which is meant to be sticky until re-confirmed) is
  unchanged.

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
