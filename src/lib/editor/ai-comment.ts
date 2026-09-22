import { StateEffect, StateField, type EditorState } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { quotePreview, splitThread, type CommentThread } from '../comment-format';
import { makeWidgetTextSelectable } from './widget-text-selection';
import { t } from '../i18n';

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
  /**
   * End the pause now instead of waiting out the countdown: write what is in
   * the box and hand the thread to the agent. The button behind it exists
   * because the twenty seconds are for the person who is still writing, and
   * someone who has finished should not have to sit through them (#36).
   */
  sendNow: (id: string) => void;
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
 * Class of the in-document highlight over a commented fragment.
 *
 * Exported because a table draws its own: a table row's source line is hidden
 * at zero height, so the decoration below is painted onto nothing and the
 * widget has to repeat the highlight on the characters that are actually on
 * screen (#62). Same class, so the two look identical and the attention
 * shimmer covers both.
 */
export const COMMENT_ANCHOR_CLASS = 'cm-ai-comment-anchor';

/** Attribute naming which thread a highlight belongs to — see above. */
export const COMMENT_ANCHOR_ATTR = 'data-comment-anchor';

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
    class: COMMENT_ANCHOR_CLASS,
    // Also on the DOM, so the attention plugin can find the spans belonging to
    // one thread without walking the decoration set.
    attributes: { [COMMENT_ANCHOR_ATTR]: threadId },
    threadId,
  });
}

/** A commented fragment, in document coordinates. */
export interface CommentAnchorSpan {
  id: string;
  from: number;
  to: number;
}

/**
 * The commented fragments overlapping `[from, to]`.
 *
 * The field is the single source of truth for where a thread is anchored — it
 * maps through every edit — so anything that wants to draw its own highlight
 * asks here rather than keeping a copy. Used by the table widget, whose source
 * lines are hidden and whose cells therefore have to paint the highlight
 * themselves (#62).
 */
export function commentAnchorsIn(
  state: EditorState,
  from: number,
  to: number
): CommentAnchorSpan[] {
  const set = state.field(aiCommentField, false);
  if (!set) return [];
  const out: CommentAnchorSpan[] = [];
  set.between(from, to, (spanFrom, spanTo, value) => {
    const id = (value.spec as { threadId?: string }).threadId;
    // Widgets carry no threadId and are zero-length anyway; only anchors answer.
    if (!id || spanTo <= spanFrom) return;
    out.push({ id, from: spanFrom, to: spanTo });
  });
  return out;
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

/**
 * A function, not a module-level table: this module is imported through
 * `App.svelte`'s static graph, which is evaluated before `main.ts` installs
 * the catalog (`installCatalog` runs after `mount()`'s dependencies, not
 * before them). A `Record` built at module scope would freeze in whatever
 * language happened to be active at import time — normally none yet, so
 * every key. Called from `toDOM()`, well after boot.
 */
function statusLabel(status: CommentThread['status']): string {
  // 'paused' says the true thing even when the countdown next to it is not
  // running — after a reload, or once the card has been rebuilt for another
  // reason.
  switch (status) {
    case 'open':
      return t('editor.ai_comment.status.open');
    case 'paused':
      return t('editor.ai_comment.status.paused');
    case 'answered':
      return t('editor.ai_comment.status.answered');
    case 'resolved':
      return t('editor.ai_comment.status.resolved');
  }
}

/**
 * Class on the countdown label and the "send now" button while there is no
 * pause running. The app toggles it; the widget never rebuilds for it.
 */
export const COMMENT_IDLE = 'cm-ai-comment-idle';

/**
 * Class on the verb inside the "send now" button, so the app can rewrite it
 * without touching the countdown span that sits next to it (#61).
 */
export const COMMENT_SEND_LABEL = 'cm-ai-comment-send-label';

/**
 * What the send-now button says while a pause is running. A function, for
 * the same reason `statusLabel` above is: this module's exports are read by
 * both this file and `App.svelte`, at module-evaluation time in the latter's
 * case, which is before `main.ts` installs the catalog.
 */
export function commentSendText(): string {
  return t('editor.ai_comment.send_now');
}

/**
 * Class on the button between "it fired" and "the card was rebuilt". Visible
 * where {@link COMMENT_IDLE} is not, so the button can stay on screen for that
 * moment instead of disappearing under the pointer.
 */
export const COMMENT_SENDING = 'cm-ai-comment-sending';

/**
 * What it says between the moment it fires and the rebuild that takes it away.
 *
 * The card is reloaded once the commit lands — the thread turns `open` and its
 * header reads "waiting for agent", which is the lasting answer to "what
 * happened". This covers the second in between, where a button that simply
 * vanished under the pointer would read as a misclick.
 */
export function commentSendingText(): string {
  return t('editor.ai_comment.sending');
}

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
      ? `${thread.id} · ${t('editor.ai_comment.anchor_lost')}`
      : `${thread.id} · ${statusLabel(thread.status)}`;

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
    makeWidgetTextSelectable(head, { swallowKeys: true });
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
      makeWidgetTextSelectable(who, { swallowKeys: true });
      item.appendChild(who);

      const body = document.createElement('div');
      body.className = 'cm-ai-comment-text';
      body.textContent = reply.text;
      // The formulation in here is the thing people want to carry off into a
      // task, a chat or a commit message.
      makeWidgetTextSelectable(body, { swallowKeys: true });
      item.appendChild(body);

      card.appendChild(item);
    }

    // The live area. A textarea, not an input: a comment is prose, and Enter
    // has to make a new line rather than mean "send" — there is no send.
    const input = document.createElement('textarea');
    input.className = 'cm-ai-comment-input';
    input.rows = 1;
    input.placeholder = frozen.length
      ? t('editor.ai_comment.placeholder_reply')
      : t('editor.ai_comment.placeholder_comment');
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
      const element: HTMLButtonElement = document.createElement('button');
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
      return element;
    };

    // "send now" is rendered for every card and hidden until a pause is
    // actually running — the app shows it by toggling a class, never by
    // rebuilding the widget. A rebuild is what replaces the textarea, and
    // replacing a textarea once a second (which is what a countdown held in
    // state would do) drops the caret and kills IME composition mid-word.
    const sendNow = button(commentSendText(), () => actions.sendNow(thread.id));
    sendNow.className = `cm-ai-comment-button cm-ai-comment-send-now ${COMMENT_IDLE}`;
    sendNow.setAttribute('data-comment-send-now', thread.id);
    sendNow.title = t('editor.ai_comment.send_now_title');

    // The countdown lives *inside* the button (#61). Next to it, at the far
    // edge of the card, the number stated a fact ("sending in 13s") while the
    // button stated an action, and nothing said the two were the same event —
    // people read the button as unrelated and wondered what it was for. In the
    // button they are one sentence: press it, or wait this long and it goes on
    // its own.
    //
    // The two are separate elements so the app can rewrite either one without
    // the other: the verb changes once, when the pause ends, and the seconds
    // change every tick. Both are plain DOM writes — see the note above.
    sendNow.textContent = '';
    const sendLabel = document.createElement('span');
    sendLabel.className = COMMENT_SEND_LABEL;
    sendLabel.textContent = commentSendText();
    sendNow.appendChild(sendLabel);

    const countdown = document.createElement('span');
    countdown.className = `cm-ai-comment-countdown ${COMMENT_IDLE}`;
    countdown.setAttribute('data-comment-countdown', thread.id);
    sendNow.appendChild(countdown);

    button(
      t('editor.ai_comment.send_to_agent'),
      () => {
        // Whatever is in the box is part of what the agent is being handed,
        // so it has to be in the file before the prompt leaves.
        actions.flush(thread.id);
        actions.handoff(thread.id);
      },
      t('editor.ai_comment.paste_confirm')
    );
    const answer = frozen[frozen.length - 1];
    if (thread.status === 'answered' && answer) {
      button(t('editor.ai_comment.insert_into_text'), () => actions.insertIntoText(thread.id, answer.text));
    }
    if (thread.status !== 'resolved') {
      button(t('editor.ai_comment.resolve'), () => actions.resolve(thread.id));
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
    // Covers the marks over ordinary prose and the spans a table widget draws
    // inside its cells alike — both carry the attribute (#62).
    for (const el of this.view.dom.querySelectorAll(`[${COMMENT_ANCHOR_ATTR}]`)) {
      el.classList.toggle(
        ANCHOR_ATTENTION,
        el.getAttribute(COMMENT_ANCHOR_ATTR) === this.cardFocused
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
