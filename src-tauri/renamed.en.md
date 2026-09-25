# md-mini is now couplet

**Powerful for you and your AI, yet minimalistic.**

Same app, same AI features, new name. Everything you had came across on its own: open windows, caret positions, unsaved drafts, crash copies, your theme and your recent files.

## What to do — once, a couple of minutes

1. **Restart your AI agent sessions.** A session opened before the update is still wired to the old md-mini and will not see couplet until you restart it.
2. **Re-teach your agent.** Open **AI → Teach Your AI couplet**, copy the prompt and give it to your agent. It registers the `couplet` MCP server in place of `mdmini`, replaces the `mdmini` skill with `couplet`, updates the note in `CLAUDE.md` (or your agent's config) and tells you at the end what it changed.
3. **If you installed from the DMG rather than Homebrew,** delete `/Applications/md-mini.app`. Your data is already in couplet, and the old app, if you open it by accident, starts empty.

## Why we renamed

**There are two apps called mdmini.** The other one owns mdmini.com. Two small editors sharing one name means confused searches, the odd wrong download and bug reports about someone else's app. We would rather not make that your problem, so we stepped aside instead of fighting over it.

**And the old name had stopped telling the truth.** md-mini started as a minimal markdown editor. What it has become is a page you and your AI agent work on together. The agent jumps you to a line, rewrites the live buffer while you watch, asks with real buttons and answers the comments you leave in the margin. A couplet is two lines that read as one, and that is the idea now. Minimalism stays: it is how we build, just no longer the whole point.

## What keeps working even without that

| | |
|---|---|
| **Terminal** | `mdmini` keeps working as a second name for `couplet`, next to the short `coup`. Scripts, aliases and `$EDITOR` need no change. |
| **AI agents** | An MCP registration named `mdmini` keeps working once you restart the agent, as long as it calls the `mdmini` command — which is how "Teach Your AI" set it up. A registration with the full path to `md-mini.app` stops working: step 2 fixes it. |
| **Homebrew** | `brew upgrade --cask mdmini` moves you over to couplet and keeps working after that. |
| **Your data** | Moved from md-mini's folder to couplet's on first launch. md-mini's folder keeps a note saying where it went. |

## Where to find us

The site is now **couplet.pro**, and the old md-mini.com address leads there too. The code stays where it was, on GitHub.

Thank you for being here from the start. The notebook is the same, it just has a better name for what it does now.
