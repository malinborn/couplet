# Getting Started with AI in md-mini

md-mini can be driven by an AI agent. Instead of writing a file to disk and hoping you notice, your agent points at a spot in the document you already have open, pushes an edit into the live buffer with the change highlighted, and asks you questions with real buttons right there in the text.

It also runs the other way: you can comment on a fragment the way you would in a shared document, and your agent answers in the thread — in the session it is already working in, with all of its context.

## Where this lives

Everything about this is in the **AI** menu, in the menu bar. Nothing here is one-time — come back to it whenever you need it:

```
AI
├── Connect Your AI               ← one prompt; your agent does the setup
├── Comment on Selection          ← ⇧⌘M — ask your agent about a fragment
├── Connect Agent to Doc Questions ← copies the prompt that starts it watching
└── AI Playbook                   ← what to actually do with it
```

You never have to remember a command. You only have to remember the menu.

## Connect in a minute

Open **Connect Your AI** and hand the prompt in it to your agent. It registers md-mini over MCP, writes itself a skill on how to use it well, and adds one short paragraph to your main config saying when to reach for md-mini. There is a second prompt in the same document for the case where you would rather it left your main config alone.

The agent is told to prefer MCP and fall back to the `mdmini` CLI if MCP is unavailable — the capabilities are the same either way.

## Check that it worked

Ask your agent, in its own chat:

> Open this file in mdmini and highlight the first heading.

A window should come to the front with the heading pulsing. If nothing happens, **Connect Your AI** in the AI menu has the prompt again — and `mdmini agent` prints the same instructions in the terminal.

## What your agent can do

| | |
|---|---|
| **show** | Jumps you to a line or a piece of text, with a brief pulse highlight. |
| **edit** | Rewrites the live buffer — the changed span stays highlighted until you dismiss it. |
| **ask** | Puts buttons in the document: single choice, checkboxes, or a free-text field. Blocks until you answer. |
| **question** | Reads the comments you have left, so it can answer them. |
| **answer** | Replies in a comment thread and marks it answered. |

## Asking your agent about the document

Select a fragment and press **⇧⌘M** (or use **Comment on Selection**, or the 💬 in the formatting toolbar). Type your question and press Enter.

The fragment gets marked in the text, and the card shows which words it is about. Put the caret in a commented fragment and its card lights up; click into a card and its fragment lights up back — with several comments in one paragraph, that is how you tell which is which.

**Your document is never touched.** Threads live in a plain-markdown file beside it, named `.mdmini_comments_<name>.md`. Committing that file is a reasonable choice — review threads then travel with the branch — and so is adding `.mdmini_comments_*` to `.gitignore`. md-mini does not decide for you.

### Getting an agent to notice

md-mini cannot make your agent watch for comments: that has to happen in the agent's own session. **Connect Agent to Doc Questions** copies a prompt that does it — paste it in once per session.

- **Claude Code** gets woken the moment you comment, in the session it is already working in.
- **Anything else** can be handed a single comment at a time with **send to agent** on the card, which copies a ready prompt. That path needs no setup at all, and no MCP — the comment file is readable markdown.

If nobody is watching, nothing is lost: comments sit in the file until an agent picks them up.

## Good to know

- **Esc** hides an AI-edit highlight.
- **Cmd+Z** undoes an AI edit exactly like any change of your own — nothing is final until you move on.
- Questions time out after five minutes by default, and you can dismiss one early with ✕.
- Everything is per-window, so several documents can each have their own question waiting.

Once it's connected, **AI Playbook** in the AI menu is the interesting part — it's about what to do with this, not how to switch it on.
