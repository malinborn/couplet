# mdmini
You and your agent, editing the same open document. mdmini ships no AI of its own — it works with the one you already use. **Spec-driven has never been so easy!**

## Ask your agent inside the text
Select anything, hit `⇧⌘M`, write. Click the AI button in the top-left corner, send the prompt to your agent — and the document is now powered by it.
> The thread lives in .mdmini_comments_sample.md beside this file. 
Plain markdown, not a database.

## Your agent drives the editor via CLI or local MCP

## Live Render
Markers hide as you type — **bold**, *italic*, ~~struck~~, `code` — and the markup underneath stays valid. The caret thickens inside **bold**, leans inside *italic*. `Esc` leaves the format.

## Tables you can use
Click lands the caret in **that** cell. Hover the ⓘ for the rest.
| Keys | Does |
|---|---|
| `Tab` `⇧Tab` | across columns, wraps in the row |
| `↵` | down a row; last row leaves the table |
| `⌘⇧↵` | new row below |
| `⌘B` `⌘I` | format the cell text |

## Diagrams — have your agent draw things
```mermaid
flowchart LR
  You[You ask] --> Agent[Your agent]
  Agent --> A[Answers in place]
  A --> You
```

## Some handy features
- [x] Secrets in `.env` and shell dotfiles stay masked until the caret enters the line.
- [x] mdmini prettifies valid JSON if you like 
- [x] You can drop docs onto mdmini icon if you prefer GUI 
- [x] Session restore and crash recovery
- [ ] Use it on Windows and Linux — not yet 

And yes, it's open-source and will always be free✌️

