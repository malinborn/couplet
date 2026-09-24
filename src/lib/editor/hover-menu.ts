import { computePosition, flip, offset } from '@floating-ui/dom';
import { GutterMarker, gutter } from '@codemirror/view';
import type { EditorView, BlockInfo } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { blockTemplates, resolveTemplateInsert, type BlockTemplate } from './block-templates';
import { t } from '../i18n';

let activePopup: HTMLElement | null = null;
let activeView: EditorView | null = null;

function hidePopup(): void {
  if (activePopup) {
    activePopup.remove();
    activePopup = null;
  }
  document.removeEventListener('click', onOutsideClick, true);
}

/** Close the gutter "+" popup, if open. Called before the window swaps documents. */
export function hideHoverMenu(): void {
  hidePopup();
  activeView = null;
}

function onOutsideClick(e: MouseEvent): void {
  if (activePopup && !activePopup.contains(e.target as Node)) {
    hidePopup();
  }
}

function showPopup(button: HTMLElement, view: EditorView, linePos: number): void {
  hidePopup();

  activeView = view;

  const popup = document.createElement('div');
  popup.className = 'cm-hover-menu-popup';

  for (const tpl of blockTemplates) {
    const item = document.createElement('button');
    item.className = 'cm-hover-menu-item';
    item.type = 'button';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'cm-hover-menu-item-label';
    labelSpan.textContent = t(tpl.labelKey);

    const detailSpan = document.createElement('span');
    detailSpan.className = 'cm-hover-menu-item-detail';
    detailSpan.textContent = tpl.id;

    item.appendChild(labelSpan);
    item.appendChild(detailSpan);

    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      applyCommand(view, linePos, tpl);
      hidePopup();
    });

    popup.appendChild(item);
  }

  document.body.appendChild(popup);
  activePopup = popup;

  computePosition(button, popup, {
    placement: 'right-start',
    middleware: [offset(4), flip()],
  }).then(({ x, y }) => {
    Object.assign(popup.style, {
      left: `${x}px`,
      top: `${y}px`,
    });
  });

  // Defer to avoid immediately triggering the outside-click handler
  setTimeout(() => {
    document.addEventListener('click', onOutsideClick, true);
  }, 0);
}

function applyCommand(view: EditorView, linePos: number, cmd: BlockTemplate): void {
  const line = view.state.doc.lineAt(linePos);
  const lineText = line.text;

  // If line is empty, replace it; otherwise prepend the insert text
  const insertText = resolveTemplateInsert(cmd);
  let from: number;
  let to: number;

  if (lineText.trim() === '') {
    from = line.from;
    to = line.to;
  } else {
    from = line.from;
    to = line.from;
  }

  const anchor = cmd.cursorOffset
    ? from + insertText.length + cmd.cursorOffset
    : from + insertText.length;

  view.dispatch({
    changes: { from, to, insert: insertText },
    selection: { anchor },
  });

  view.focus();
}

class BlockMenuMarker extends GutterMarker {
  private readonly linePos: number;

  constructor(linePos: number) {
    super();
    this.linePos = linePos;
  }

  override toDOM(view: EditorView): Node {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-hover-menu-btn';
    btn.textContent = '+';
    btn.setAttribute('aria-label', t('editor.hover_menu.insert_block'));

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showPopup(btn, view, this.linePos);
    });

    return btn;
  }

  override eq(other: GutterMarker): boolean {
    return other instanceof BlockMenuMarker && other.linePos === this.linePos;
  }

  override destroy(_dom: Node): void {
    hidePopup();
  }
}

export function hoverBlockMenu(): Extension {
  return gutter({
    class: 'cm-hover-gutter',
    lineMarker(view: EditorView, line: BlockInfo): GutterMarker | null {
      return new BlockMenuMarker(line.from);
    },
    lineMarkerChange(): boolean {
      return false;
    },
    renderEmptyElements: true,
  });
}
