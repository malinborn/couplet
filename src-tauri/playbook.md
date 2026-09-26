# AI Playbook

Practical ways to put couplet's AI interface to work once an agent is connected (via CLI snippet or MCP).

## Live review of AI edits

Instead of reading a diff after the fact, watch it happen. The agent edits your open document directly — the changed span shimmers with a highlight until you press **Esc** or edit near it again. You stay in control the whole time: **Cmd+Z** undoes an AI edit exactly like any other change, and nothing is final until you say so by moving on.

## Decisions without leaving the flow

An agent that needs a decision from you doesn't have to interrupt the chat — it can `ask` right at the spot in the document the decision concerns, anchored with `--line` or `--find`. A single-choice question gets buttons; `--multi` gets checkboxes for picking several; `--free-text` adds a field for when your own words matter more than a preset option. The question sits where the context already is, so you never lose your place figuring out what's being asked.

## The document as a channel

Meeting notes, runbooks, checklists — let the agent maintain the document while you read it live. It pushes updates with `edit`, points you at the part that changed with `show`, and checks in with `ask` when it needs a call only you can make. The document becomes the shared surface, not a file you occasionally re-open to see what happened.

## Spec-driven development with couplet

The spec-first loop — idea → spec written by AI → **human reviews the spec** → plan → implementation — lives or dies on that review step actually happening, carefully, rather than being a skim before an "LGTM." This is where couplet earns its keep:

- The spec stays open in couplet while the agent walks you through it section by section, using `show` to bring each one into view as it comes up.
- Instead of asking for a blanket approval, the agent asks per-section: a plain approval, a `--multi` pick when a section has several options for scope, `--free-text` when you want to redirect a section rather than just approve or reject it.
- Your feedback lands back in the document as a highlighted `edit`, right where it applies — so you can see exactly what changed before the next section starts.

The review gate becomes a real reading experience — one section, one decision, one visible change at a time — instead of scrolling through terminal output trying to hold the whole spec in your head.

Works with any agent that has the CLI snippet or an MCP connection to couplet.
