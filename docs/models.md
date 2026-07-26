# Which model should I use with Grill?

Grill asks a model to do two jobs, and they need different amounts of muscle:

1. **Write questions** from your notes. Easier. Most models do this well.
2. **Grade your answers** generously on wording but strictly on substance, and name the
   misconception when you slip. Harder. This is where weak models get it wrong, either by
   marking a correct answer wrong or by waving through a vague one.

So pick for the grading. Everything below is about getting grading you can trust for the least
money, or for free.

Two questions decide it: **do you have an API key?** and **what can your machine run?**

---

## If you have a key

You give Grill the key in settings; it talks only to that provider, and it costs tokens per
session (more notes and more questions cost more). Any of these are a good default. They're
ordered roughly cheap → sharp within each provider.

| Provider | Cheap & fine | Best grading | Notes |
|---|---|---|---|
| **Anthropic** | `claude-haiku-4-5` | `claude-sonnet-5` | Sonnet 5 is the sharpest grader of the lot. Haiku is plenty for generation. |
| **OpenAI** | `gpt-5-mini` | `gpt-5` | Reasoning models are set to low effort so they stay fast and cheap. |
| **Google** | `gemini-2.5-flash` | `gemini-2.5-pro` | Flash is very cheap and good enough for most study. |
| **DeepSeek** | `deepseek-chat` | `deepseek-reasoner` | Roughly a twentieth of Sonnet's price. A strong value pick. |

**Cheapest sensible setup:** let the cheap model write the questions and grade, or mix modes,
AI writes questions and you grade yourself, to roughly halve a session's cost.

**Best-for-money:** `deepseek-chat` if you want a hosted key that barely costs anything;
`claude-sonnet-5` if you want the grading to be as good as it gets.

---

## If you have no key: run it locally

Set the provider to **Ollama** and Grill runs entirely on your machine. Nothing leaves it,
nothing is billed. Install [Ollama](https://ollama.com), `ollama pull` one of the models
below, and pick it in settings. Grill turns off these models' "thinking" mode automatically,
which is the difference between a grade in seconds and a grade in a minute.

The honest trade: small local models grade less sharply than the paid ones. They're right most
of the time and occasionally too harsh on a borderline answer. For daily review that's fine;
for high-stakes prep, a cheap hosted key (DeepSeek, Gemini Flash) grades noticeably better.

Pick by how much RAM you have. Bigger is better at grading; the tags are Ollama model names.

| Your RAM | Pull this | Reality |
|---|---|---|
| **8 GB** | `qwen3:4b` or `llama3.2:3b` | Runs, but grading is rough. Consider self-grade mode instead. |
| **16 GB** | **`qwen3:8b`** | The sweet spot for a laptop. Verified on an M4/16GB: valid structured grades in **3–9s** each, correct misconception tags, sane verdicts. This is the recommended no-key model. |
| **24–32 GB** | `qwen3:14b` or `gpt-oss:20b` | Meaningfully better grading, still comfortable. |
| **32 GB+** | `qwen3:32b`, `gpt-oss:20b`, or `glm-4:9b` | Closest a local model gets to the hosted ones. |

`qwen3` (Alibaba) and `glm-4` (Zhipu) are open-weight models you can run with no account and no
key at all. The frontier open-weight models people rave about, DeepSeek-V3, Kimi K2, GLM-4.5,
are datacenter-sized and won't fit on a laptop; you'd reach those through a hosted key, which
puts you back in the section above.

---

## The truly free option: no model at all

You don't even need a local model. In settings set **Where questions come from** to *From my
notes* and **Grading** to *I mark myself*. Grill builds questions from your notes' own
structure (bold terms, highlights, headings, `Term: definition` lines, existing flashcards)
and you grade yourself Again / Hard / Good / Easy. Same spaced-repetition schedule as AI mode,
nothing sent anywhere, nothing to run. It's only as good as your notes are structured, but it
costs nothing and works offline.

You can also mix: AI (or local) writes the questions, you grade yourself. Half the model work,
and you still see your own answer judged against the expected one.

---

## Quick answer

- **Want the best, don't mind paying:** `claude-sonnet-5`.
- **Want cheap and hosted:** `deepseek-chat` or `gemini-2.5-flash`.
- **Want no key, have a normal laptop:** Ollama + `qwen3:8b`.
- **Want nothing to install or pay:** self-grade mode with local question generation.
