import { Decoration, WidgetType } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import type { RangeSetBuilder } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { shouldReveal } from './flavour';
import type { DecoSink } from './utils';
import { t } from '../../i18n';

class CodeBlockHeaderWidget extends WidgetType {
  constructor(
    private language: string,
    private codeFrom: number,
    private codeTo: number
  ) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const header = document.createElement('div');
    header.className = 'cm-md-code-header';

    if (this.language) {
      const lang = document.createElement('span');
      lang.className = 'cm-md-code-lang';
      lang.textContent = this.language;
      header.appendChild(lang);
    }

    const copyBtn = document.createElement('button');
    copyBtn.className = 'cm-md-code-copy';
    copyBtn.textContent = t('ui.copy');
    copyBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const code = view.state.doc.sliceString(this.codeFrom, this.codeTo);
      navigator.clipboard.writeText(code);
      copyBtn.textContent = t('ui.copied');
      setTimeout(() => {
        copyBtn.textContent = t('ui.copy');
      }, 1500);
    });
    header.appendChild(copyBtn);

    return header;
  }

  eq(other: CodeBlockHeaderWidget): boolean {
    return (
      this.language === other.language &&
      this.codeFrom === other.codeFrom &&
      this.codeTo === other.codeTo
    );
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export function decorateHorizontalRule(
  view: EditorView,
  node: SyntaxNode,
  builder: DecoSink
): void {
  if (shouldReveal(view, 'horizontalRule', node.from, node.to, true)) return;

  const line = view.state.doc.lineAt(node.from);
  builder.add(line.from, line.from, Decoration.line({ class: 'cm-md-hr' }));
  builder.add(line.from, line.to, Decoration.replace({}));
}

export function decorateFencedCode(
  view: EditorView,
  node: SyntaxNode,
  builder: DecoSink
): void {
  if (shouldReveal(view, 'fencedCode', node.from, node.to, true)) return;

  const doc = view.state.doc;
  const startLine = doc.lineAt(node.from);
  const endLine = doc.lineAt(node.to);

  // Extract language from the opening fence line (e.g., ```javascript)
  const fenceText = doc.sliceString(startLine.from, startLine.to);
  const langMatch = fenceText.match(/^`{3,}(\w+)/);
  const language = langMatch ? langMatch[1] : '';

  // Content range: lines between the fence markers (exclusive)
  const firstContentLineNum = startLine.number + 1;
  const lastContentLineNum = endLine.number - 1;
  const hasContent = firstContentLineNum <= lastContentLineNum;

  const codeFrom = hasContent ? doc.line(firstContentLineNum).from : startLine.to;
  const codeTo = hasContent ? doc.line(lastContentLineNum).to : startLine.to;

  // Collect all line numbers in this code block
  const totalLines = endLine.number - startLine.number + 1;

  for (let i = startLine.number; i <= endLine.number; i++) {
    const line = doc.line(i);
    const isFirst = i === startLine.number;
    const isLast = i === endLine.number;

    if (isFirst || isLast) {
      // Hide opening and closing fence lines via CSS
      builder.add(line.from, line.from, Decoration.line({ class: 'cm-md-code-fence-hidden' }));
    } else {
      // Code content lines — apply background + optional radius classes
      const isFirstCode = i === startLine.number + 1;
      const isLastCode = i === endLine.number - 1;

      let cls = 'cm-md-code-line';
      if (isFirstCode && totalLines > 2) cls += ' cm-md-code-block-start';
      if (isLastCode && totalLines > 2) cls += ' cm-md-code-block-end';
      // Single-line code block (only content between fences)
      if (totalLines === 3 && isFirstCode) cls = 'cm-md-code-line cm-md-code-block-start cm-md-code-block-end';

      // Line decoration FIRST (lower startSide), then widget
      builder.add(line.from, line.from, Decoration.line({ class: cls }));

      // Add header widget on the first content line
      if (isFirstCode) {
        builder.add(
          line.from,
          line.from,
          Decoration.widget({
            widget: new CodeBlockHeaderWidget(language, codeFrom, codeTo),
            side: -1,
          })
        );
      }
    }
  }
}
