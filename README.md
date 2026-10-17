![Grill: your notes, your AI, your weak spots](docs/hero.svg)

I take a lot of notes to learn new material, and I needed a way to learn them more deeply. Grill is a chat that works inside your Obsidian vault and keeps a record of what you know. It tests you on your own notes, grades what you write, and schedules each concept with spaced repetition. In turn, the chat answers from that record: it knows which questions you missed, which you skipped, and what you asked about last week. The record is not confined to Obsidian either. Claude Code, Codex and other AI agents can read it, test you on it and add what you answer them, so what you get wrong comes back wherever you study.

![Grill's home screen: suggestions from your record above the chat box](docs/screenshot-home-8.png)

## <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/theadamdanielsson/grill/main/docs/icons/play-dark.svg"><img src="docs/icons/play.svg" height="20" alt="" style="display:inline;height:20px;width:auto"></picture> How to use it

1. **Start free.** On first run, press Start free. That is Grill Cloud: no API key, no sign-up, and a few free credits to try it. If Claude Code, Codex or opencode is on your computer, Grill offers to start on it instead. You can also use your own API key or Ollama.
2. **Chat.** Ask about the note you have open, or tell Grill what to do with it. It can explain, summarise, find things across the vault, and edit or create notes, asking your permission before a change.
3. **Test.** Switch to Test and press **Get grilled**. Grill writes questions from your notes and marks what you type back, with partial credit and specific feedback. What you get wrong is what Chat and the suggestions point at next.
4. **Bring your agents in.** Settings → Agents → Connect an agent gives Claude Code or Codex your record, in one line pasted in a terminal. See [In your other agents](#in-your-other-agents).

The home screen suggests where to go from your record: the questions you last missed, the notes not yet tested, the note you have open. Specifically, each suggestion states a fact (how many concepts are known, what was missed last time) and leaves the choice of what matters to you.

![A reply built from the record: what was answered correctly, what was skipped, and what to understand next](docs/screenshot-chat-record.png)

## <img src="docs/icons/flame.svg" height="24" alt="" style="display:inline;height:24px;width:auto"> What you get

- **An agentic chat in your vault:** it reads, searches, edits and creates notes over several steps, and shows each step as it happens. Three permission levels decide when it has to ask: Safe, Plan and Auto.
- **Study straight from the chat:** when Chat recommends something, a button under the reply starts it, whether that is the reviews due, a retry of what you missed, or a test on the notes it named. Chat explains; Test is where you are graded.
- **Undo a turn:** a reply that changed notes lists them, and one Undo puts all of them back.
- **`@` and `/` in the box:** `@` brings a note into the message and `/` picks a prompt. On Claude Code, your own commands and skills are in the list too.
- **Your record in other agents:** Claude Code, Codex, Cursor and other agents can see your weak spots, explain at your level, and test you. Their answers count here, and what you are tested on outside the vault shows on the Progress screen.
- **A record behind every reply:** per-concept scheduling, your past answers and the confusions Grill has named are given to the chat, so an explanation starts from what you got wrong.
- **Nothing to set up:** [Grill Cloud](#grill-cloud) answers, writes questions and grades with no API key and no account. It works on your phone, reads the images in your notes, and your notes are not trained on. Free to try.
- **Or a program on your computer:** [Claude Code, Codex or opencode](#with-claude-code-or-codex), with your own sign-in. opencode has free models and needs no account.
- **Or your own key:** Claude, GPT, Gemini, DeepSeek, any OpenAI-compatible endpoint (OpenRouter, Groq, LM Studio), or a local model through Ollama.
- **Questions from your own notes:** recall questions written from what you wrote, in free text, multiple choice, true or false, fill-in and matching.
- **Fair grading:** answers are marked against a rubric written with the question, with partial credit and the expected answer always shown.
- **Ask in the middle of a test:** type a question in the answer box and Grill answers it; the record notes that you needed help.
- **Replies as they are written:** Chat streams its answer, and a reply can be inserted at the cursor or saved as a note.
- **A map of what you know:** on the Progress screen, your notes as a graph coloured by how well you know each.
- **A natural voice:** questions, feedback and explanations read aloud in a natural AI voice on Grill Cloud or an OpenAI key, or in your device's voice anywhere.
- **Finds links you are missing:** spots notes that belong together and offers to add the `[[link]]`.
- **Works with the cards you already have:** Spaced Repetition's `==cloze==` and `::`/`?` cards and Anki's `{{c1::…}}` clozes are used as they are.
- **Your own questions:** a `> [!grill]` callout in any note is asked verbatim.
- **Every question editable:** the Questions screen lists what was last missed and everything Grill has written, for fixing in place.
- **Reads embedded PDFs:** a `![[worksheet.pdf]]` embed is read and quizzed on like any other note content.
- **Real spaced repetition:** FSRS scheduling per concept; edit a note and only the changed parts re-open.
- **A theme to match:** [Grill, the theme](https://github.com/theadamdanielsson/grill-theme) puts the rest of Obsidian in the same colours, dark and light.

How each of these works is described in **[docs/features.md](docs/features.md)**.

![Chat reading across the vault: six notes read, with links back to the ones the answer draws on](docs/screenshot-chat-vault.png)

![A partially correct answer, graded with specific feedback and the expected answer](docs/screenshot-feedback.png)

<a name="grill-cloud"></a>
## <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/theadamdanielsson/grill/main/docs/icons/cloud-dark.svg"><img src="docs/icons/cloud.svg" height="20" alt="" style="display:inline;height:20px;width:auto"></picture> Grill Cloud

Grill Cloud is the easiest way to use Grill. Press Start free and it answers in Chat, writes the questions, grades your answers and explains them, with no API key and no sign-up. Grill makes a key on your device and, while each day's free credits last, you get some to try it.

What Grill Cloud gives you that the free options do not:

- **It works on your phone.** Claude Code, Codex and opencode need a computer. Grill Cloud chats, edits notes and tests you on a phone or tablet too.
- **It reads your images.** Diagrams, graphs, screenshots and photos of handwritten pages in your notes are read, and the questions cover them.
- **It reads aloud in a natural voice,** for studying away from the screen.
- **Your notes are not trained on.** Free models may keep what you send to improve the model. Anthropic, behind Grill Cloud, does not.
- **One model, chosen for grading.** You do not pick between free models of uneven quality. Grill picks the model for how well it marks, and keeps it current.
- **Nothing to install or sign in to.** No program, no terminal, no key. One balance for every vault, which follows a synced vault to your other devices.

After that Grill Cloud is a monthly plan: $7.99 a month, plus tax where it applies, and you can cancel it whenever you like. The plan covers Chat and tests up to usage limits, which apply to any five hours, to any week and to each month. The limits are not given as figures, because what a session uses depends on how long your notes are and how much you ask of it. Importantly, a Chat turn that works in the vault takes several steps, and each step counts as a reply, so editing through Chat uses more than asking a question. When a limit is reached, Grill says so and roughly when it frees up. For anyone who wants to keep going at once, credit packs come up at that point: 400 credits for $3.99 or 1,100 for $9.99. Credits are used only past a limit, and they do not expire.

The checkout is run by Stripe, so the page says "Sold through Link" and your card statement shows Link. The plan starts in Grill a few seconds after you pay. You cancel it at link.com, signed in with the email address you paid with, and it stays usable until the end of the month already paid for. Buying happens in Grill and nowhere else.

Grill Cloud runs on two of Anthropic's Claude models, each chosen by testing it on real notes and kept current. A fast model writes the test questions. A stronger one marks your answers and runs Chat, because marking is where the stronger model was clearly better.

One thing differs from every other way of running Grill. With Grill Cloud, the notes in a session, the images in them, your answers and your custom instructions go through my server to Anthropic. In Chat, the notes the model asks to read go the same way. My server does not keep them: it does not store or log your notes, the questions, or your answers. Anthropic keeps them for up to 30 days to watch for abuse and does not train on them. If you turn on the natural voice, the text being read aloud goes to OpenAI the same way. What my server does store is a short list, set out in the privacy policy.

- [Privacy policy](https://grill.onbridger.com/privacy)
- [Terms](https://grill.onbridger.com/terms)

There is nothing to look after. Grill makes a key on your device when you press Start free, and that key is your balance. Every vault on the same device shares it, and it follows a synced vault to your other devices. If you ever lose them all, email inquiries@onbridger.com from the address you paid with and I will move your plan and your purchased credits to your new install. Settings has the rest under Account, including a Delete account button that erases your balance and usage from my server. Deleting the account does not cancel a plan, so cancel the plan first.

The first month of a plan is refunded if you ask within 14 days of subscribing. Used credits cannot be refunded, and unused ones can if you ask within 14 days. Grill Cloud is for people 18 and over.

<a name="with-claude-code-or-codex"></a>
## <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/theadamdanielsson/grill/main/docs/icons/screen-dark.svg"><img src="docs/icons/screen.svg" height="20" alt="" style="display:inline;height:20px;width:auto"></picture> With Claude Code, Codex or opencode

Chat can run on the Claude Code or Codex already installed on your computer. Grill starts the program as it is, in your vault, and shows what it does; the sign-in is the one you made in a terminal, and Grill never sees it. As a result, Chat draws on the plan you already pay Anthropic or OpenAI for, within whatever that plan allows for use outside the provider's own apps.

The button under the chat box steps through the engines found on your computer, and the button beside it sets the permission level. Safe asks before a note is changed or a command is run. Plan reads and proposes, and changes nothing. Auto edits notes in the vault without asking. These are the programs' own permission systems, passed through; Grill adds none of its own.

The program runs with your own setup: your skills, MCP servers, hooks and `CLAUDE.md` come along, as they would in a terminal, and on Claude Code typing `/` lists your own commands and skills beside Grill's prompts. Grill adds its record to each of them. Claude Code, Codex and opencode can read your weak spots and offer a test as a button under the reply, as Grill Cloud can. What they cannot do in Grill is quiz you themselves, since testing belongs in Test, where answers are graded and scheduled.

[opencode](https://github.com/anomalyco/opencode) is an open-source program of the same kind that works with many models. Grill can install it: the Install button in the Agents tab of Grill's settings, or on the first run, downloads one pinned build (about 80 MB) from npm, where opencode publishes it, checks it against the published checksum, and keeps it in `~/.grill/opencode`, outside your vault. Without an account it offers free models and any Ollama models on your computer; `opencode auth login` in a terminal adds your own accounts. Note that opencode's free models may keep what you send them to improve the model while they are free. For notes you would rather keep private, use a model with your own account, Ollama, or Grill Cloud.

Two limits apply. First, this works on desktop only, since there is a program to run. Second, tests are written and graded by Grill Cloud, your own key or Ollama when one is set up; only without one do they run on the program Chat uses.

<a name="in-your-other-agents"></a>
## <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/theadamdanielsson/grill/main/docs/icons/play-dark.svg"><img src="docs/icons/play.svg" height="20" alt="" style="display:inline;height:20px;width:auto"></picture> In your other agents

Grill's record is useful beyond Obsidian, so 8.5 opens it to the agents you already use. Settings → Agents → Connect an agent copies one line for Claude Code or Codex; pasted in a terminal, it adds [grill-mcp](https://www.npmjs.com/package/grill-mcp), a small program that reads the record in your vault and writes back what you answer. From then on, an agent can call up your weak spots before explaining something, and test you when you ask it to. Its answers are added to the record while Grill is open, each agent session gets a session note like any other, and the schedule moves as it would after a test in Grill.

For anything outside a vault, such as a code repository or a book, there is the **grill-test** skill:

```
npx skills add theadamdanielsson/grill --skill grill-test
```

It works in Claude Code, Codex, Cursor and the other agents that read Agent Skills. It asks one question at a time, grades each answer against the source, and records every answer, so a concept you missed comes back the next time you ask to be tested, even in a new session. That record is kept in your home folder (`~/.grill/record/`), never in the project, and Grill's Progress screen shows it under Tested in other agents.

![A Claude Code session with grill-test: a wrong answer is recorded, and a new session starts from it](skills/grill-test/grill-test.gif)

## <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/theadamdanielsson/grill/main/docs/icons/key-dark.svg"><img src="docs/icons/key.svg" height="20" alt="" style="display:inline;height:20px;width:auto"></picture> With your own key

To pay a model provider directly, pick "use my own API key or Ollama" on first run, or choose a provider in settings. Grill works the same on Claude, GPT, Gemini, DeepSeek or any OpenAI-compatible endpoint, and on a local model through Ollama, where nothing leaves your machine. Your notes go straight from your machine to the provider you chose; my server is not involved. On Anthropic, OpenAI, DeepSeek and OpenAI-compatible endpoints, Chat can also read, search and change notes. Which model to pick is covered in [docs/models.md](docs/models.md).

## <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/theadamdanielsson/grill/main/docs/icons/page-dark.svg"><img src="docs/icons/page.svg" height="20" alt="" style="display:inline;height:20px;width:auto"></picture> Documentation

- **[docs/features.md](docs/features.md)**: how Chat, the permission levels, scheduling, the record, custom questions and PDFs work.
- **[docs/privacy.md](docs/privacy.md)**: what leaves your machine, where it goes, and what Grill stores.
- **[docs/models.md](docs/models.md)**: which model to use, by budget and by how much RAM your machine has.
- **[docs/troubleshooting.md](docs/troubleshooting.md)**: the mechanics behind the common "is this a bug" questions.

## <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/theadamdanielsson/grill/main/docs/icons/ask-dark.svg"><img src="docs/icons/ask.svg" height="20" alt="" style="display:inline;height:20px;width:auto"></picture> Worth knowing before you install

- Grill needs a model: [Grill Cloud](#grill-cloud), your own API key, Ollama, or Claude Code, Codex or opencode on your computer. Earlier versions had a mode with no AI; 8.0 removes it.
- It is only as good as your notes. Half-written notes make half-baked questions.
- The grading is a model's judgement. It is usually right, and it always shows you the expected answer so that you can judge for yourself.
- A chat that can edit your notes can edit them badly. Safe is the default level, every change is shown before it is made, and on Grill Cloud, your own key and Claude Code a turn's changes can be undone from the reply. Otherwise, version control or sync history can undo one.
- Local models are the weak link: good for privacy, weaker on questions and grading.

## <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/theadamdanielsson/grill/main/docs/icons/check-dark.svg"><img src="docs/icons/check.svg" height="20" alt="" style="display:inline;height:20px;width:auto"></picture> Requirements

- **Obsidian 1.8.0 or newer.** Grill checks this on load and won't run on an older build.
- **Desktop or mobile.** Writing long answers is easier with a keyboard, and Claude Code, Codex and opencode are desktop only.
- **One of these, for questions and grading:**
  - [Grill Cloud](#grill-cloud): nothing to install or sign up for. Press Start free.
  - An API key from Anthropic, OpenAI, Google, DeepSeek, or any OpenAI-compatible endpoint (OpenRouter, Groq, LM Studio).
  - [Ollama](https://ollama.com) installed locally: no key, no cost, nothing leaving your machine.
  - On desktop, Claude Code or Codex installed and signed in, or opencode, which Grill can install.
- No account with Grill itself.

## <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/theadamdanielsson/grill/main/docs/icons/install-dark.svg"><img src="docs/icons/install.svg" height="20" alt="" style="display:inline;height:20px;width:auto"></picture> Installation

Website: [grill.onbridger.com](https://grill.onbridger.com)

**From Obsidian (recommended):** Settings → Community plugins → Browse, search "Grill", Install, then Enable. If Community plugins are off, Settings → Community plugins → turn on "Turn on community plugins" first.

**Manual install (a specific version, or before it's live in the community list):** download `main.js`, `manifest.json`, and `styles.css` from a [release](https://github.com/theadamdanielsson/grill/releases) and place all three in `<vault>/.obsidian/plugins/grill/` (create the folder if it doesn't exist), then reload Obsidian and enable Grill in Community plugins. [BRAT](https://github.com/TfTHacker/obsidian42-brat) automates this if you want to track updates without waiting for the community list.

**Build it yourself:**

```sh
npm install
npm run build
```

then drop `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/grill/`.

After installing, open Grill (the flame icon, or the "Open Grill" command). First run asks which model Grill should use, then shows what you can do with your notes.

## <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/theadamdanielsson/grill/main/docs/icons/cross-dark.svg"><img src="docs/icons/cross.svg" height="20" alt="" style="display:inline;height:20px;width:auto"></picture> Troubleshooting

The common ones are below; the full list is in [docs/troubleshooting.md](docs/troubleshooting.md).

- **"Couldn't find concepts to quiz in these notes."** The note has too little in it to ask about. Add to it, or pick a longer note.
- **Chat says it cannot edit my notes.** The engine answering has no tools: Gemini and Ollama answer in text only. Switch the engine under the chat box, or use Grill Cloud, an Anthropic or OpenAI key, Claude Code, Codex or opencode.
- **The engine button opens settings.** No installed Claude Code, Codex or opencode was found. Set its location in the Agents tab of Grill's settings, or install opencode there.
- **A note I aced does not turn green.** Green requires most of a note's concepts to each be answered correctly twice, spaced out. One pass is not enough to call a note known.
- **The same question keeps coming back.** This is by design: a concept's question is written once and reused on every later review, so that what is tested is the answer and never the wording. The "Clear cached questions" command forces a new one.
- **A model is not reading the images in my notes.** Grill sends images to models that support vision, and says in the session when the chosen model cannot read them.
- **A PDF is not being quizzed on.** Check that it is embedded, `![[file.pdf]]` with the `!`. A scanned PDF with no text layer, or a password-protected one, has nothing for Grill to extract.
- **API errors, or grading looks wrong.** Check the key and the model name in settings; a mistyped model ID is the usual cause.
- **An agent's answers don't show up.** Grill adds them while it is open, within a few seconds, or when it next starts. They wait in `Grill/Inbox/` until then.

Something broken? [Open an issue](https://github.com/theadamdanielsson/grill/issues). A question or an idea? [Start a discussion](https://github.com/theadamdanielsson/grill/discussions).

## Privacy and cost

Grill talks only to the model provider you configure. There are no analytics, there is no account, and no server of mine sits in the middle. The one exception is [Grill Cloud](#grill-cloud), if you turn it on: the session then goes through my server to Anthropic. Installing opencode downloads it from npm (registry.npmjs.org), once, when you press Install. Connecting an agent runs grill-mcp from npm on your computer, and it makes no network requests of its own. When Chat runs on opencode, Grill's record reaches it through an endpoint on your own computer (127.0.0.1), open only for that chat turn. What leaves your machine and what Grill stores locally is set out in **[docs/privacy.md](docs/privacy.md)**.

## License

MIT

<picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/theadamdanielsson/grill/main/docs/fire-dark.svg"><img src="docs/fire.svg" alt=""></picture>
