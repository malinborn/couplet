import { StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { quotePreview, splitThread, type CommentThread } from '../comment-format';

/**
 * What a comment widget can ask the app to do. Carried on the `addAiComment`
 * effect itself (see below), never through module-level mutable state — the
 * callbacks are stable across a session while the widget is rebuilt on every
 * thread change, exactly the shape `ai-ask.ts`'s `AskSpec.onAnswer` already
 * solves. `eq()` on the widget deliberately excludes this field.
 */
export interface CommentActions {
  /**
   * Called on every keystroke in the comment box. The app debounces and
   * writes it to the sidecar — there is no send action, what is typed is
   * saved (#23).
   */
  save: (id: string, text: string) => void;
  /** Write whatever is pending for this thread now, without waiting for the
   * debounce. Fired on blur and when the widget's DOM goes away. */
  flush: (id: string) => void;
  resolve: (id: string) => void;
  handoff: (id: string) => void;
  insertIntoText: (id: string, text: string) => void;
}

export interface CommentSpec {
  thread: CommentThread;
  /** Quote not found in the document — thread is shown at its stored line. */
  orphaned: boolean;
  actions: CommentActions;
  /**
   * Text to put in the box, overriding what the file says. Set while an edit
   * is still in flight, so a rebuild — the agent answering, the draft turning
   * into a real thread — cannot swallow characters typed a moment ago.
   * Excluded from `eq()`: including it would rebuild the card on every
   * keystroke, which is the one thing that must not happen while typing.
   */
  draft?: string;
  /**
   * Put the caret in the box at this offset once it is on screen. Carries both
   * "focus the box the hotkey just opened" (#22) and "the card was rebuilt
   * under the user's hands, put them back where they were".
   */
  focusAt?: number;
}

/** Adds a comment-thread widget, anchored at the end of the line containing `pos`. */
export const addAiComment = StateEffect.define<{
  thread: CommentThread;
  pos: number;
  /** End of the quoted fragment, for the in-document highlight. Equal to
   * `pos` when the anchor could not be found, i.e. nothing to mark. */
  to: number;
  orphaned: boolean;
  actions: CommentActions;
  /** In-flight text for the box — see `CommentSpec.draft`. */
  draft?: string;
  /** Caret offset to focus the box at — see `CommentSpec.focusAt`. */
  focusAt?: number;
}>();

/**
 * Marks the fragment a thread is about. Without it the card states its quote
 * but the reader has to find those words themselves — the whole point of
 * anchoring is lost. Deliberately a `mark`, not a `replace`: the document text
 * must stay exactly as authored.
 *
 * Carries the thread id in its spec, because removal filters on identity and a
 * mark has no widget to recognise — without the id, closing a thread would
 * leave its highlight behind on the text forever.
 */
function anchorMark(threadId: string): Decoration {
  return Decoration.mark({
    class: 'cm-ai-comment-anchor',
    // Also on the DOM, so the attention plugin can find the spans belonging to
    // one thread without walking the decoration set.
    attributes: { 'data-comment-anchor': threadId },
    threadId,
  });
}

/** True for an anchor highlight belonging to `threadId`. */
function isAnchorOf(spec: unknown, threadId: string): boolean {
  return (spec as { threadId?: string })?.threadId === threadId;
}

/** Removes the comment widget with the given thread id. A no-op if that id
 * isn't present (e.g. a reload racing an already-resolved thread). */
export const removeAiComment = StateEffect.define<string>();

/** Removes every comment widget — used when the sidecar file is reloaded wholesale. */
export const clearAiComments = StateEffect.define<null>();

const STATUS_LABEL: Record<CommentThread['status'], string> = {
  open: 'waiting for agent',
  answered: 'answered',
  resolved: 'resolved',
};

export class CommentWidget extends WidgetType {
  constructor(readonly spec: CommentSpec) {
    super();
  }

  /**
   * Only the finished part of the thread is compared.
   *
   * The text in the box is deliberately not: autosave rewrites the user's own
   * trailing reply in the file, so including it would make every save a
   * rebuild, and every rebuild would replace the textarea the user is typing
   * into. Comparing the frozen part means a save changes nothing CM6 can see,
   * while an agent's answer — which moves a turn into the frozen part — is
   * caught immediately.
   */
  eq(other: CommentWidget): boolean {
    const a = this.spec.thread;
    const b = other.spec.thread;
    const mine = splitThread(a).frozen;
    const theirs = splitThread(b).frozen;
    return (
      a.id === b.id &&
      a.status === b.status &&
      a.quote === b.quote &&
      this.spec.orphaned === other.spec.orphaned &&
      mine.length === theirs.length &&
      mine.every(
        (reply, i) =>
          reply.author === theirs[i].author &&
          reply.at === theirs[i].at &&
          reply.text === theirs[i].text
      )
    );
  }

  toDOM(view?: EditorView): HTMLElement {
    const { thread, orphaned, actions } = this.spec;
    const { frozen, editable } = splitThread(thread);

    // CM6 measures a block widget's height from its root element's DOM box,
    // which does not include CSS margin (see ai-ask.ts's AskWidget for the
    // full explanation). Vertical spacing therefore lives on this outer
    // wrapper's padding; `.cm-ai-comment` itself carries no margin.
    const wrap = document.createElement('div');
    wrap.className = 'cm-ai-comment-wrap';

    const card = document.createElement('div');
    card.className = orphaned ? 'cm-ai-comment cm-ai-comment-orphaned' : 'cm-ai-comment';
    // Lets the attention plugin find this card by thread without holding a
    // reference to the DOM it built.
    card.setAttribute('data-comment-thread', thread.id);

    const head = document.createElement('div');
    head.className = 'cm-ai-comment-head';
    head.textContent = orphaned
      ? `${thread.id} · anchor lost`
      : `${thread.id} · ${STATUS_LABEL[thread.status]}`;

    // The quoted fragment, right-aligned in the header. With several cards
    // stacked under one paragraph, the id and status alone do not say which
    // one is about what — and the highlight in the text only helps once you
    // have already found the right card.
    if (thread.quote) {
      const excerpt = document.createElement('span');
      excerpt.className = 'cm-ai-comment-excerpt';
      excerpt.textContent = quotePreview(thread.quote);
      excerpt.title = thread.quote;
      head.appendChild(excerpt);
    }
    card.appendChild(head);

    // Finished turns. Outlined and left alone — the visual difference from the
    // live box below is the whole signal that a turn has been answered and can
    // no longer be edited.
    for (const reply of frozen) {
      const item = document.createElement('div');
      item.className = 'cm-ai-comment-reply';

      const who = document.createElement('div');
      who.className = 'cm-ai-comment-author';
      who.textContent = `${reply.author} · ${reply.at}`;
      item.appendChild(who);

      const body = document.createElement('div');
      body.className = 'cm-ai-comment-text';
      body.textContent = reply.text;
      item.appendChild(body);

      card.appendChild(item);
    }

    // The live area. A textarea, not an input: a comment is prose, and Enter
    // has to make a new line rather than mean "send" — there is no send.
    const input = document.createElement('textarea');
    input.className = 'cm-ai-comment-input';
    input.rows = 1;
    input.placeholder = frozen.length ? 'Reply — saved as you type' : 'Comment — saved as you type';
    input.value = this.spec.draft ?? editable;
    // Lets the app find this box by thread after a rebuild.
    input.setAttribute('data-comment-input', thread.id);

    /** Grow to fit the text. A block widget that changes height behind CM6's
     * back leaves the height map wrong, hence the requestMeasure. */
    const grow = (): void => {
      const style = (input as { style?: { height: string } }).style;
      if (!style) return; // DOM-less test harness
      style.height = '0px';
      style.height = `${Math.max(input.scrollHeight || 0, 24)}px`;
      view?.requestMeasure();
    };

    // ignoreEvent() (below) only tells CM6's own handling to leave widget
    // events alone — it does not stop the DOM event from bubbling past
    // contentDOM to document-level listeners (e.g. the Escape-clears-
    // highlights keymap, or table.ts's own Escape handlers). A real,
    // focusable, editable control needs an explicit stopPropagation on every
    // key event. mousedown must stop propagation too, but NOT
    // preventDefault — preventDefault there would block the browser from
    // focusing/placing the caret in the box at all, and would also stop a
    // drag from selecting the text inside it (#28).
    input.addEventListener('mousedown', (event) => event.stopPropagation());
    input.addEventListener('keypress', (event) => event.stopPropagation());
    input.addEventListener('keyup', (event) => event.stopPropagation());
    input.addEventListener('input', () => {
      grow();
      actions.save(thread.id, input.value);
    });
    // Clicking away is what used to lose the text. Now it is just another
    // moment to write.
    input.addEventListener('blur', () => actions.flush(thread.id));
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        // Back to the document, without the keymap that clears AI highlights
        // ever seeing this key.
        input.blur?.();
        view?.focus();
        return;
      }
      // Nothing needs sending, but "I am done, write it now" is still a useful
      // thing to be able to say.
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        actions.flush(thread.id);
      }
    });
    card.appendChild(input);

    const row = document.createElement('div');
    row.className = 'cm-ai-comment-actions';

    const button = (label: string, onClick: () => void, confirmLabel?: string) => {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'cm-ai-comment-button';
      element.textContent = label;
      // Keep the editor selection from moving to a click in the widget.
      element.addEventListener('mousedown', (event) => event.preventDefault());
      element.addEventListener('click', () => {
        onClick();
        // Copying to the clipboard is invisible — without a reply the button
        // looks like it did nothing at all. Say what happened, and say what to
        // do next, since the clipboard is only half the action.
        if (!confirmLabel) return;
        element.textContent = confirmLabel;
        // `className` rather than `classList`, matching `ai-ask.ts` — and the
        // DOM-less test harness in this repo models className only.
        element.className = 'cm-ai-comment-button cm-ai-comment-button-done';
        // Bare `setTimeout`, not `window.setTimeout`: the DOM-less test
        // harness stubs `document` but there is no `window` in that
        // environment at all. If the widget is rebuilt before this fires it
        // just relabels a detached element, which is harmless.
        setTimeout(() => {
          element.textContent = label;
          element.className = 'cm-ai-comment-button';
        }, 5000);
      });
      row.appendChild(element);
    };

    button(
      'send to agent',
      () => {
        // Whatever is in the box is part of what the agent is being handed,
        // so it has to be in the file before the prompt leaves.
        actions.flush(thread.id);
        actions.handoff(thread.id);
      },
      'paste it into your agent'
    );
    const answer = frozen[frozen.length - 1];
    if (thread.status === 'answered' && answer) {
      button('insert into text', () => actions.insertIntoText(thread.id, answer.text));
    }
    if (thread.status !== 'resolved') {
      button('resolve', () => actions.resolve(thread.id));
    }

    // Autosave is invisible, and invisible saving is exactly what people did
    // not believe was happening. The app writes "saved" in here.
    const saved = document.createElement('span');
    saved.className = 'cm-ai-comment-saved';
    row.appendChild(saved);
    card.appendChild(row);

    wrap.appendChild(card);

    // Focus is requested by whoever built this spec, never taken on its own —
    // a card rebuilt while the user is in the document must not steal the
    // caret out of it. A frame later, because CM6 is still settling its own
    // focus in the frame the widget is inserted in (#22).
    const caret = this.spec.focusAt;
    if (caret !== undefined && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        input.focus?.();
        const at = Math.min(caret, input.value.length);
        input.setSelectionRange?.(at, at);
        grow();
      });
    } else if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(grow);
    }

    return wrap;
  }

  /** The DOM is going away — rebuild, resolve, document switch. Anything still
   * unwritten is written now rather than lost. */
  destroy(): void {
    this.spec.actions.flush(this.spec.thread.id);
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function isCommentWidget(widget: WidgetType): widget is CommentWidget {
  return widget instanceof CommentWidget;
}

/**
 * Holds one block widget per comment thread, keyed by thread id. Widgets are
 * anchored at a line boundary — the end of the line containing the requested
 * position — so inserting one never splits a table or mermaid block line.
 * Ranges map through edits, so a widget stays attached to its line as the
 * user types elsewhere.
 */
export const aiCommentField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(addAiComment)) {
        const { thread, pos, to, orphaned, actions, draft, focusAt } = effect.value;
        const clamped = Math.max(0, Math.min(pos, tr.state.doc.length));
        const anchor = tr.state.doc.lineAt(clamped).to;
        const widget = Decoration.widget({
          widget: new CommentWidget({ thread, orphaned, actions, draft, focusAt }),
          block: true,
          side: 1,
        });
        // Ranges handed to `update` must be sorted by `from`, and the mark
        // always starts at or before the widget's line-end anchor, so it goes
        // first. An empty range is skipped rather than added: CM6 rejects a
        // zero-length mark, and a detached thread has nothing to highlight.
        const markEnd = Math.max(clamped, Math.min(to, tr.state.doc.length));
        const add =
          markEnd > clamped
            ? [anchorMark(thread.id).range(clamped, markEnd), widget.range(anchor)]
            : [widget.range(anchor)];
        deco = deco.update({ add });
      } else if (effect.is(removeAiComment)) {
        const id = effect.value;
        deco = deco.update({
          filter: (_from, _to, value) => {
            if (isCommentWidget(value.spec.widget) && value.spec.widget.spec.thread.id === id) {
              return false;
            }
            // Drop the thread's anchor highlight too, or the text stays marked
            // after its card is gone.
            return !isAnchorOf(value.spec, id);
          },
        });
      } else if (effect.is(clearAiComments)) {
        deco = Decoration.none;
      }
    }
    return deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const CARD_ATTENTION = 'cm-ai-comment-attention';
const ANCHOR_ATTENTION = 'cm-ai-comment-anchor-attention';

/** Thread ids whose anchored fragment contains one of the caret positions. */
function threadsUnderCaret(view: EditorView): Set<string> {
  const out = new Set<string>();
  const set = view.state.field(aiCommentField, false);
  if (!set) return out;
  const heads = view.state.selection.ranges.map((r) => r.head);
  set.between(0, view.state.doc.length, (from, to, value) => {
    const id = (value.spec as { threadId?: string }).threadId;
    // Widgets carry no threadId and are zero-length anyway; only the anchor
    // marks answer here.
    if (!id || to <= from) return;
    if (heads.some((head) => head >= from && head <= to)) out.add(id);
  });
  return out;
}

/**
 * Links a comment card and the text it is about, in both directions.
 *
 * Put the caret in a commented fragment and its cards shimmer; work inside a
 * card and its fragment shimmers back. Several cards stacked under one
 * paragraph are otherwise indistinguishable — the header excerpt says what
 * each is about, and this says which one you are touching.
 *
 * Implemented by toggling classes on existing DOM, never by rebuilding the
 * widget. A rebuild per caret move would be wasteful, and worse, it would
 * discard whatever the user had typed into the reply input.
 */
class CommentAttentionPlugin {
  private highlighted = new Set<string>();
  private cardFocused: string | null = null;

  private readonly onFocusIn = (event: FocusEvent): void => this.claim(event.target);
  private readonly onPointerDown = (event: MouseEvent): void => this.claim(event.target);

  constructor(private readonly view: EditorView) {
    view.dom.addEventListener('focusin', this.onFocusIn);
    // Capture phase: the widget's own handlers call preventDefault/
    // stopPropagation, so a bubbling listener would never see the click.
    view.dom.addEventListener('mousedown', this.onPointerDown, true);
    this.syncCards();
  }

  /** Mark the fragment of whichever card the interaction landed in. */
  private claim(target: EventTarget | null): void {
    const el = target as Element | null;
    const card = el && 'closest' in el ? el.closest('[data-comment-thread]') : null;
    const id = card?.getAttribute('data-comment-thread') ?? null;
    if (id === this.cardFocused) return;
    this.cardFocused = id;
    this.syncAnchors();
  }

  update(update: ViewUpdate): void {
    // A decoration rebuild replaces the DOM, so the classes must be reapplied
    // even when the selection itself did not move.
    if (!update.selectionSet && !update.docChanged && !update.viewportChanged) return;
    this.syncCards();
    this.syncAnchors();
  }

  /** Caret → cards. */
  private syncCards(): void {
    const active = threadsUnderCaret(this.view);
    for (const id of this.highlighted) {
      if (!active.has(id)) this.setCardAttention(id, false);
    }
    for (const id of active) this.setCardAttention(id, true);
    this.highlighted = active;
  }

  /** Card → fragment. */
  private syncAnchors(): void {
    for (const el of this.view.dom.querySelectorAll('[data-comment-anchor]')) {
      el.classList.toggle(
        ANCHOR_ATTENTION,
        el.getAttribute('data-comment-anchor') === this.cardFocused
      );
    }
  }

  private setCardAttention(id: string, on: boolean): void {
    const card = this.view.dom.querySelector(`[data-comment-thread="${CSS.escape(id)}"]`);
    card?.classList.toggle(CARD_ATTENTION, on);
  }

  destroy(): void {
    this.view.dom.removeEventListener('focusin', this.onFocusIn);
    this.view.dom.removeEventListener('mousedown', this.onPointerDown, true);
  }
}

/** Bidirectional attention link between a card and its fragment. */
export const aiCommentAttention = ViewPlugin.fromClass(CommentAttentionPlugin);
