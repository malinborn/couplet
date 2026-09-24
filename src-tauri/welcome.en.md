# Welcome to md-mini

A markdown editor that renders while you type — and that your AI agent can drive.

## Start here: hand it to your agent

1. Open **AI → Teach Your AI mdmini**.
2. Copy the prompt in that document and give it to your agent.
3. That is the whole setup. The agent registers md-mini as an MCP server, writes itself a skill on how to use it well, and adds a short note to its own config so it knows when to reach for it.

From then on it can:

| | |
|---|---|
| **show** | Jump you to a line or a phrase, with a brief pulse. |
| **edit** | Rewrite the live buffer; the changed span stays lit until you press **Esc**. |
| **ask** | Put real buttons in the document — one choice, several, or a text field — and wait for your answer. |
| **question** / **answer** | Read the comments you leave on a fragment (**⇧⌘M**) and reply in the thread. |

Nothing happens behind your back: **⌘Z** undoes an AI edit exactly like your own typing, and comment threads live in a plain-markdown file beside the document, not inside it.

## Make it yours

**Themes** — the **Theme** menu. Six families, each with a light and a dark half: Classic, Aurora, Blueprint, Phosphor, Paper, Ink. Family and half are separate choices, so changing one keeps the other. Tick **Follow System** and the half follows your Mac from day into night, staying in the family you picked.

**Editor engine** — **View → Editor Engine**. *Live Render* hides markdown syntax entirely; *Preview* styles the text but leaves the markers in place; *Raw* is the source exactly as written. **⌘E** flips between the source and whichever renderer you chose — it never swaps one renderer for the other.

**OCD Alignment** — **View → OCD Alignment**. The tick in a checked box sits a hair off centre. That is not sloppiness: `✓` is not a symmetrical glyph, so it never looks centred anywhere, whatever you do to it. If that hair is going to follow you around for the rest of the day, this switch replaces it with a cross drawn as two strokes rotated around one point — symmetrical by construction, with nothing left to drift. We like the ✓. We also know how it is.

## Good to know

- Windows, caret positions and unsaved drafts all come back after a restart.
- **⇧⌘M** comments on the selection, **⌘=** and **⌘−** zoom, **⌘E** shows the source.
- `mdmini` works from a terminal as well — `mdmini help` lists everything it can do.
