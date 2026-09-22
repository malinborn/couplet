# md-mini is now couplet

**Powerful for you and your AI, yet minimalistic.**

Same app, same documents, new name. Everything you had came across on its own: open windows, caret positions, unsaved drafts, crash copies, your theme and your recent files.

## Why we renamed

**The name was taken twice.** Another app is also called mdmini and owns mdmini.com. Two small editors sharing one name means confused searches, the odd wrong download and bug reports about someone else's app. We would rather not make that your problem, so we stepped aside instead of fighting over it.

**And the old name had stopped telling the truth.** md-mini started as a minimal markdown editor. What it has become is a page you and your AI agent work on together. The agent jumps you to a line, rewrites the live buffer while you watch, asks with real buttons and answers the comments you leave in the margin. A couplet is two lines that read as one, and that is the idea now. Minimalism stays: it is how we build, just no longer the whole point.

## Nothing breaks

| | |
|---|---|
| **Terminal** | `mdmini` still works, alongside `couplet` and the short `coup`. Scripts, aliases and `$EDITOR` need no change. |
| **AI agents** | An agent that knows couplet as `mdmini` keeps working: the MCP server, its tools and the note in your agent's config are all unchanged. For a fresh setup: `claude mcp add --scope user couplet -- couplet mcp`. |
| **Homebrew** | `brew upgrade` moved you over. `brew upgrade --cask mdmini` keeps working too. |
| **Your data** | Moved from md-mini's folder to couplet's on first launch. md-mini's folder keeps a note saying where it went. |

## Where to find us

The site is now **couplet.pro**, and md-mini.com redirects there. The code stays where it was, on GitHub.

Thank you for being here from the start. The notebook is the same, it just has a better name for what it does now.
