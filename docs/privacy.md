# Privacy and data use

Grill sends your notes to one place: the model you chose to run it on. It has no analytics, no telemetry and no account, and no server of mine is involved unless you choose Grill Cloud. What follows sets out what is sent in each case, and what Grill stores.

## What is sent

**In a test**, Grill sends the text of the notes in scope (including the extracted text of any PDFs they embed, see [Features: PDFs](features.md#pdfs)), the questions it writes, your typed answers and, when the model supports vision, the images those notes embed.

**In Chat**, Grill sends your message, the note the conversation is about, the notes that note links to or that match your words, a list of the names of the notes in the vault with how each stands (known, learning, not tested yet), and Grill's record on the note: how its concepts have gone, your recent answers to questions on it, and what you asked about before. A question about the vault as a whole sends as many notes in full as fit. In turn, when the engine can use tools, the model may ask to read or search further notes, and what it reads is sent to it as well. Notes outside the folders you gave Grill are never read or sent.

## Where it goes

**With your own key**, everything above goes straight from your machine to the provider you configured, under that provider's privacy and retention terms. A Chat reply is requested directly from Obsidian so that it can be shown as it is written; the destination is the same.

**With Grill Cloud**, the same things go through my server to Anthropic, and you need no key of your own. My server does not store them; Anthropic keeps them for up to 30 days. Grill Cloud is off unless you pick it, and it has its own page: the [Grill Cloud privacy policy](https://grill.onbridger.com/privacy), with the [terms](https://grill.onbridger.com/terms) beside it.

**With Claude Code or Codex**, Grill starts the program installed on your computer, in your vault, and passes it your message with a short brief: the path of the open note, Grill's record on it, and your study preferences. The program then reads files and contacts Anthropic or OpenAI itself, under the account you signed in with and that provider's terms. Importantly, Grill never reads, stores or forwards that sign-in, and the program is run unmodified. Unlike Grill's own note tools, these programs are bounded by their own permission system, which Grill passes through, and they can run shell commands when you allow them.

**With opencode**, the same holds: Grill starts the program in your vault and passes it your message and the brief. opencode then sends them to the model picked under the chat box: its own free models (run through opencode's service, which may keep what is sent to improve a model while it is free), an Ollama model on your computer, or an account you signed in to with `opencode auth login`. Installing it from Grill downloads one pinned build from registry.npmjs.org, checks it against the published checksum, and keeps it in `~/.grill/opencode`.

**Your record, in Chat.** On every engine, Chat can read Grill's record through its own tools: the concepts you missed or are due, and what the record holds on a topic. For Claude Code these run inside the plugin. Codex calls them as tools Grill registered with it. opencode reaches them at an address on your own computer (`127.0.0.1`), which only accepts requests that carry a random id for the current chat turn, refuses any request from a web page, and closes the route when the turn ends.

**Other agents, when you connect them.** Connect an agent adds grill-mcp to Claude Code or Codex on your computer. It reads the record files in your vault and writes each answer the agent grades into `Grill/Inbox/`; it makes no network requests of its own. What the agent then sends to its provider is governed by that agent's account and terms, as with any other file it reads. The grill-test skill, outside a vault, keeps its record in `~/.grill/record/`, and Grill reads that file to show it on the Progress screen.

**Tests without a model.** When no Grill Cloud, key or Ollama is set up, questions are written and marked by the program Chat runs on, in an empty folder of Grill's own and with no permission to change anything. The note text and your answer are sent the same way as above.

**With Ollama**, the model runs on your machine and nothing leaves it. Smaller local models write weaker questions than hosted ones; 8B or larger is a reasonable floor.

## Other calls

**The natural voice sends what it reads.** On Grill Cloud, or with your own OpenAI key, pressing a speaker button sends the text being read to OpenAI's speech model: through my server on Grill Cloud, or straight from your machine with your own key. Nothing is sent until you press one. With Natural voice off in settings, read-aloud uses your device's own voice and sends nothing.

**The arc makes its own occasional call.** The Progress screen's arc (see [Features: what it keeps track of](features.md#what-it-keeps-track-of)) is refreshed on Obsidian launch, or at the end of a session on Grill Cloud so that its cost shows in that session's receipt. It sends your misconception counts and labels and past session headlines, never note text.

**Grill checks once a day whether a newer version is out.** It asks GitHub for the latest Grill release and sends nothing else. When there is a newer one, the home screen says so in one line, with Update and Not now.

**Two features download a model once, if you accept the offer.** At the end of a session where they would have applied, Grill offers to quiz you on diagrams it can read on-device (an OCR engine of about 10 MB) and to pick prompt context by meaning (an embedding model of about 25 MB). Accepting fetches the file once and caches it; both then run on your machine and send nothing. Declining is remembered.

## What Grill stores, and where

Everything Grill tracks about you is written as plain files inside your own vault and syncs however you already sync it: the schedule (`Grill/concepts.json`), your per-note history (`Grill/mastery.json`), the misconception registry (`Grill/misconceptions.json`), each test's transcript (`Grill/Sessions/`) and each Chat conversation (`Grill/Learn/`). Deleting the `Grill` folder removes all of it. Your settings, the arc and the small log of study days it is built from live in the plugin's own `data.json`.

A change Chat makes to a note is an ordinary edit to that note. For the Undo under the reply, Grill keeps each changed note as it was before the turn, in memory and for as long as the conversation is open; nothing is written for it. Changes made by Codex or opencode, and any change after the conversation is closed, are undone through Obsidian's file recovery, your sync history or version control.

An API key is kept in Obsidian's keychain (Settings → Keychain), under a name that includes this vault's id. The keychain belongs to one device and does not sync, so each device needs the key entered once. On Obsidian older than 1.11.4, which has no keychain, the key stays in `data.json`, a plaintext file that should not be synced somewhere untrusted. A Grill Cloud key is the exception: it stays in `data.json` on purpose, so that it follows the vault, because it is the only handle on a prepaid balance. A copy is also kept in Obsidian's local storage on the device, which is how other vaults on the same device share the balance.

## Cost

With your own key, a test costs API tokens in proportion to the notes it covers and the questions asked, both of which you control in settings. A Chat turn that uses tools is several requests, each resending the conversation so far, and costs accordingly. The arc adds one call roughly every three days you study. Model recommendations by budget and by machine are in [models.md](models.md).
